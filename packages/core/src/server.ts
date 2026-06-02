import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectionPool } from './cdp/connection-pool.js';
import { ContextRouter } from './context/context-router.js';
import { ChromeManager } from './infra/chrome-pool.js';
import { PortManager } from './infra/port-manager.js';
import { TabManager } from './infra/tab-manager.js';
import { ExtensionManager } from './infra/extension-manager.js';
import { SessionInfoTabManager } from './infra/session-info-tab.js';
import { readLock } from './infra/port-store.js';
import { saveSession, loadSession, clearSession } from './infra/session-store.js';
import { CdpCard } from './infra/cdp-card.js';
import type { ConnectionMode, SessionDescriptor } from '@cdp-mcp/shared';
import { registerActTools } from './tools/act-tools.js';
import { registerObserveTools } from './tools/observe-tools.js';
import { registerInfraTools } from './tools/infra-tools.js';
import { registerTabTools } from './tools/tab-tools.js';
import { registerExtensionTools } from './tools/extension-tools.js';
import { registerWorkflowTools } from './tools/workflow-tools.js';
import { registerQaqcTools } from './tools/qaqc-tools.js';
import { registerNetworkTools } from './tools/network-tools.js';
import { registerIdbTools } from './tools/idb-tools.js';
import { cleanupStaleAssignments } from './infra/port-store.js';
import { CdpConnectionError, createLogger } from '@cdp-mcp/shared';

const logger = createLogger('server');

/**
 * Chrome + CDP 연결을 lazy하게 관리.
 * 첫 tool 호출 시 Chrome 탐색/실행 → ConnectionPool 생성.
 *
 * mode:
 * - owner (기본): Chrome launch/lock/close 전체 관리
 * - shared: 기존 세션에 연결만 (lock 없음, Chrome lifecycle 안 건드림)
 */
export class LazyConnectionManager {
  private pool: ConnectionPool | null = null;
  private router: ContextRouter | null = null;
  private tabManager: TabManager | null = null;
  private extensionManager: ExtensionManager | null = null;
  private connecting: Promise<void> | null = null;
  private connectedPort: number | null = null;
  private targetPort: number | null = null;

  readonly chromeManager = new ChromeManager();
  readonly mode: ConnectionMode;
  private readonly sharedDescriptor?: SessionDescriptor;

  constructor(opts?: { mode?: ConnectionMode; descriptor?: SessionDescriptor }) {
    this.mode = opts?.mode ?? 'owner';
    this.sharedDescriptor = opts?.descriptor;
  }

  /** Owner mode: Chrome 탐색/실행 → 연결 */
  private async connectOwner(): Promise<void> {
    const portManager = new PortManager();
    let port: number;
    let isReconnect = false;

    if (this.targetPort) {
      // 특정 포트 지정됨 → 해당 포트에 연결 시도, 실패 시 launch
      const tp = this.targetPort;
      this.targetPort = null; // 1회용
      try {
        await this.chromeManager.connect(tp);
        port = tp;
        isReconnect = true;
        logger.info(`Connected to Chrome on target port ${tp}`);
      } catch {
        logger.info(`Failed to connect to target port ${tp}, launching new Chrome...`);
        const result = await this.chromeManager.launch({ port: tp });
        port = result.port;
      }
    } else {
      // 기존 로직: 자동 탐색 → 연결/실행
      const existingPort = await portManager.findChromeDebugPort();
      if (existingPort) {
        isReconnect = true;
        try {
          await this.chromeManager.connect(existingPort);
          port = existingPort;
          logger.info(`Connected to Chrome on port ${existingPort}`);
        } catch {
          logger.info(`Failed to connect to port ${existingPort}, launching new Chrome...`);
          const result = await this.chromeManager.launch();
          port = result.port;
        }
      } else {
        logger.info('No running Chrome found, launching new instance...');
        const result = await this.chromeManager.launch();
        port = result.port;
      }
    }

    this.connectedPort = port;
    this.pool = new ConnectionPool(port);
    await this.pool.connectBrowser();
    this.router = new ContextRouter(this.pool);
    this.tabManager = new TabManager(this.pool);
    this.extensionManager = new ExtensionManager(this.pool);

    logger.info('Chrome connected (owner mode)');

    // 세션 정보 탭 설정 (실패해도 연결 차단하지 않음)
    try {
      const lockInfo = readLock(port);
      const sessionInfoMgr = new SessionInfoTabManager(this.pool);
      await sessionInfoMgr.ensureSessionInfoTab({
        port,
        sessionId: lockInfo?.sessionId ?? `cdp-mcp_${port}`,
        sessionName: lockInfo?.sessionName ?? `cdp-mcp-${port}`,
        mcpPid: process.pid,
        ownerPid: lockInfo?.ownerPid,
        chromePid: lockInfo?.chromePid,
        startedAt: lockInfo?.startedAt ?? Date.now(),
        status: isReconnect ? 'RECONNECTED' : 'CONNECTED',
      });
    } catch (err) {
      logger.warn(`Failed to set up session info tab: ${err}`);
    }

    // active.json에 세션 정보 저장 (subagent가 발견할 수 있도록)
    try {
      const lockInfo = readLock(port);
      saveSession({
        port,
        sessionId: lockInfo?.sessionId ?? `cdp-mcp_${port}`,
        ownerPid: lockInfo?.ownerPid ?? process.ppid,
        chromePid: lockInfo?.chromePid,
        exportedAt: Date.now(),
      });
    } catch (err) {
      logger.warn(`Failed to save session descriptor: ${err}`);
    }
  }

  /** Shared mode: 기존 Chrome에 연결만 */
  private async connectShared(): Promise<void> {
    // 1. 명시적으로 전달된 descriptor 사용
    // 2. 없으면 active.json에서 자동 발견
    const descriptor = this.sharedDescriptor ?? loadSession();
    if (!descriptor) {
      throw new CdpConnectionError(
        'Shared mode: no session descriptor provided and no active session found. ' +
        'Owner must start first.'
      );
    }

    const port = descriptor.port;
    await this.chromeManager.connectShared(port);

    this.connectedPort = port;
    this.pool = new ConnectionPool(port);
    await this.pool.connectBrowser();
    this.router = new ContextRouter(this.pool);
    this.tabManager = new TabManager(this.pool);
    this.extensionManager = new ExtensionManager(this.pool);

    logger.info(`Chrome connected (shared mode, port=${port})`);
  }

  private async connect(): Promise<void> {
    if (this.mode === 'shared') {
      await this.connectShared();
    } else {
      await this.connectOwner();
    }
  }

  /** 기존 연결 정리 */
  private reset(): void {
    this.pool = null;
    this.router = null;
    this.tabManager = null;
    this.extensionManager = null;
  }

  /** Chrome이 살아있는지 확인 */
  private async isAlive(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const browserClient = this.pool.getBrowserClient();
      if (!browserClient.connected) return false;
      // 실제 통신 가능한지 확인
      await browserClient.send('Target.getTargets', {});
      return true;
    } catch {
      return false;
    }
  }

  /** 연결 보장 후 리소스 반환. Chrome이 죽었으면 재연결. */
  async ensure(): Promise<{
    pool: ConnectionPool;
    router: ContextRouter;
    tabManager: TabManager;
    extensionManager: ExtensionManager;
  }> {
    // 기존 연결이 살아있으면 그대로 사용
    if (this.pool && await this.isAlive()) {
      return {
        pool: this.pool,
        router: this.router!,
        tabManager: this.tabManager!,
        extensionManager: this.extensionManager!,
      };
    }

    // 죽었거나 없으면 (재)연결
    if (this.pool) {
      logger.info('Chrome connection lost, reconnecting...');
      this.reset();
    }

    if (!this.connecting) {
      this.connecting = this.connect().finally(() => { this.connecting = null; });
    }
    await this.connecting;

    if (!this.pool) {
      throw new CdpConnectionError('Failed to connect to Chrome');
    }

    return {
      pool: this.pool,
      router: this.router!,
      tabManager: this.tabManager!,
      extensionManager: this.extensionManager!,
    };
  }

  /**
   * 현재 세션 정보를 SessionDescriptor로 내보내기.
   * subagent에게 전달하거나 파일로 저장할 때 사용.
   */
  exportSession(tags?: Record<string, string>): SessionDescriptor | null {
    if (!this.connectedPort) return null;
    const lockInfo = readLock(this.connectedPort);
    return {
      port: this.connectedPort,
      sessionId: lockInfo?.sessionId ?? this.chromeManager.getSessionId() ?? `cdp-mcp_${this.connectedPort}`,
      ownerPid: lockInfo?.ownerPid ?? process.ppid,
      chromePid: lockInfo?.chromePid,
      tags,
      exportedAt: Date.now(),
    };
  }

  /**
   * 이 포트에 대한 CdpCard 인스턴스 생성.
   */
  createCard(): CdpCard | null {
    if (!this.connectedPort) return null;
    return new CdpCard(this.connectedPort);
  }

  getPort(): number | null {
    return this.connectedPort;
  }

  /** 크롬 종료 + 연결 상태 초기화. disconnect() 후 ensure()로 재연결 가능. */
  async disconnect(): Promise<void> {
    if (this.pool) {
      try { await this.pool.closeAll(); } catch { /* ignore */ }
    }
    await this.chromeManager.close();
    this.reset();
    this.connectedPort = null;
  }

  /** 연결만 끊고 크롬은 유지 (pool/router 정리, lock/Chrome 프로세스 유지) */
  async softDisconnect(): Promise<void> {
    if (this.pool) {
      try { await this.pool.closeAll(); } catch { /* ignore */ }
    }
    this.reset();
    this.connectedPort = null;
  }

  /** 다음 connectOwner() 호출 시 사용할 포트 지정 (1회용) */
  setTargetPort(port: number | null): void {
    this.targetPort = port;
  }
}

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: 'cdp-mcp',
    version: '0.1.0',
  });

  // Shared mode: CDP_SHARED_PORT 환경변수가 설정되면 해당 포트에 shared 연결
  const sharedPort = process.env.CDP_SHARED_PORT ? parseInt(process.env.CDP_SHARED_PORT, 10) : null;
  const mode: ConnectionMode = sharedPort ? 'shared' : 'owner';

  if (mode === 'owner') {
    cleanupStaleAssignments();
  }

  const lazy = new LazyConnectionManager(
    sharedPort
      ? { mode: 'shared', descriptor: { port: sharedPort, sessionId: '', ownerPid: 0, exportedAt: 0 } }
      : undefined,
  );

  registerActTools(server, lazy);
  registerObserveTools(server, lazy);
  registerInfraTools(server, lazy);
  registerTabTools(server, lazy);
  registerExtensionTools(server, lazy);
  registerWorkflowTools(server, lazy);
  registerQaqcTools(server, lazy);
  registerNetworkTools(server, lazy);
  registerIdbTools(server, lazy);

  logger.info(`CDP-MCP server initialized with 29 tools (${mode} mode, lazy Chrome)`);

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
