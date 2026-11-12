import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectionPool } from './cdp/connection-pool.js';
import { ContextRouter } from './context/context-router.js';
import { TabManager } from './infra/tab-manager.js';
import { ExtensionManager } from './infra/extension-manager.js';
import {
  acquireSharedChrome, releaseSharedChrome, restartSharedChrome, sweepLeases, syncCookies, writeLease,
} from './infra/shared-chrome.js';
import { registerActTools } from './tools/act-tools.js';
import { registerObserveTools } from './tools/observe-tools.js';
import { registerInfraTools } from './tools/infra-tools.js';
import { registerTabTools } from './tools/tab-tools.js';
import { registerExtensionTools } from './tools/extension-tools.js';
import { registerWorkflowTools } from './tools/workflow-tools.js';
import { registerQaqcTools } from './tools/qaqc-tools.js';
import { registerNetworkTools } from './tools/network-tools.js';
import { registerIdbTools } from './tools/idb-tools.js';
import { CdpConnectionError, createLogger } from '@cdp-mcp/shared';

const logger = createLogger('server');

/**
 * 공유 크롬 연결을 lazy 하게 관리한다. 첫 도구 호출 때 공유 크롬을 쓰기 시작하고(꺼져 있으면 띄움),
 * 이 에이전트 전용 창을 하나 만든다. 서버가 끝나면 그 창을 닫고, 마지막 에이전트였으면 크롬을 끈다.
 */
export class LazyConnectionManager {
  private pool: ConnectionPool | null = null;
  private router: ContextRouter | null = null;
  private tabManager: TabManager | null = null;
  private extensionManager: ExtensionManager | null = null;
  private connecting: Promise<void> | null = null;
  private connectedPort: number | null = null;

  private async connect(): Promise<void> {
    const { port } = await acquireSharedChrome();
    const pool = new ConnectionPool(port);
    await pool.connectBrowser();

    for (const dead of sweepLeases().dead) {
      if (dead.windowId === undefined) continue;
      const n = await pool.closeWindowById(dead.windowId).catch(() => 0);
      logger.info(`Closed ${n} tab(s) left by exited agent pid ${dead.pid}`);
    }

    const windowId = await pool.initWindow();
    writeLease({ pid: process.pid, windowId, startedAt: Date.now() });

    this.connectedPort = port;
    this.pool = pool;
    this.router = new ContextRouter(pool);
    this.tabManager = new TabManager(pool);
    this.extensionManager = new ExtensionManager(pool);
    logger.info(`Connected to shared Chrome :${port}, own window ${windowId}`);
  }

  private reset(): void {
    this.pool = null;
    this.router = null;
    this.tabManager = null;
    this.extensionManager = null;
  }

  private async isAlive(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const browserClient = this.pool.getBrowserClient();
      if (!browserClient.connected) return false;
      await browserClient.send('Target.getTargets', {});
      return true;
    } catch {
      return false;
    }
  }

  /** 연결 보장 후 리소스 반환. 크롬이 죽었으면 다시 띄우고 창도 다시 만든다. */
  async ensure(): Promise<{
    pool: ConnectionPool;
    router: ContextRouter;
    tabManager: TabManager;
    extensionManager: ExtensionManager;
  }> {
    if (!(this.pool && await this.isAlive())) {
      if (this.pool) {
        logger.info('Chrome connection lost, reconnecting...');
        this.reset();
      }
      if (!this.connecting) {
        this.connecting = this.connect().finally(() => { this.connecting = null; });
      }
      await this.connecting;
      if (!this.pool) throw new CdpConnectionError('Failed to connect to Chrome');
    }

    // 평소 크롬에서 바뀐 로그인을 뒤에서 가져온다(바뀐 게 없거나 최근에 했으면 바로 끝남).
    syncCookies().catch(err => logger.warn(`Background cookie sync failed: ${err}`));

    return {
      pool: this.pool!,
      router: this.router!,
      tabManager: this.tabManager!,
      extensionManager: this.extensionManager!,
    };
  }

  getPort(): number | null {
    return this.connectedPort;
  }

  /** 다른 에이전트가 없을 때만 크롬을 다시 켜서 저장 비밀번호까지 새로 복사한다. */
  async restartChrome(): Promise<{ restarted: boolean; reason?: string; otherAgents?: number }> {
    const result = await restartSharedChrome();
    if (result.restarted) {
      if (this.pool) await this.pool.closeAll().catch(() => {});
      this.reset();
      await this.ensure();
    }
    return result;
  }

  /** 서버 종료: 내 창을 닫고 lease 를 반납한다. */
  async shutdown(): Promise<void> {
    if (this.pool) {
      await this.pool.closeOwnWindow().catch(() => {});
      await this.pool.closeAll().catch(() => {});
      this.reset();
    }
    if (this.connectedPort !== null) await releaseSharedChrome().catch(() => {});
  }
}

let shuttingDown = false;
function installShutdown(lazy: LazyConnectionManager): void {
  const stop = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const hardExit = setTimeout(() => process.exit(code), 5000);
    lazy.shutdown().finally(() => { clearTimeout(hardExit); process.exit(code); });
  };
  process.stdin.on('end', () => stop(0));
  process.stdin.on('close', () => stop(0));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => stop(0));
}

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: 'cdp-mcp',
    version: '0.1.0',
  });

  const lazy = new LazyConnectionManager();
  installShutdown(lazy);

  registerActTools(server, lazy);
  registerObserveTools(server, lazy);
  registerInfraTools(server, lazy);
  registerTabTools(server, lazy);
  registerExtensionTools(server, lazy);
  registerWorkflowTools(server, lazy);
  registerQaqcTools(server, lazy);
  registerNetworkTools(server, lazy);
  registerIdbTools(server, lazy);

  logger.info('CDP-MCP server initialized (shared headless Chrome, own window per agent)');

  return server;
}

// CLI entry point
async function main(): Promise<void> {
  try {
    const server = await createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('CDP-MCP server running on stdio');
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
}

main().catch(console.error);
