import { EventEmitter } from 'events';
import { CdpClient } from './cdp-client.js';
import { CdpSession } from './cdp-session.js';
import { CdpConnectionError, TabNotFoundError, ExtensionNotFoundError, createLogger } from '@cdp-mcp/shared';
import type { TargetInfoHttp } from './protocol-types.js';
import { isSessionInfoTab } from '../infra/session-info-tab.js';

const logger = createLogger('connection-pool');

/**
 * Per-target WebSocket 연결을 관리하는 ConnectionPool.
 *
 * 기존 flatten mode(단일 WS + sessionId 라우팅)와 달리,
 * 각 target에 별도 WebSocket을 연결한다.
 * target 연결이 죽으면 해당 연결만 버리고 새로 만들면 되므로
 * stale session 문제가 구조적으로 사라진다.
 */
export class ConnectionPool extends EventEmitter {
  private browserClient: CdpClient | null = null;
  private connections = new Map<string, CdpSession>();  // targetId → CdpSession (각각 별도 WS)

  constructor(private readonly port: number) {
    super();
  }

  /**
   * Browser-level WebSocket 연결 (Target domain 전용).
   * Target.getTargets, Target.createTarget 등 browser-level 명령에 사용.
   */
  async connectBrowser(): Promise<void> {
    const wsUrl = await CdpClient.getBrowserWsUrl(this.port);
    this.browserClient = new CdpClient(wsUrl);
    await this.browserClient.connect();

    // target 이벤트 구독
    this.browserClient.on('Target.targetDestroyed', (params: { targetId: string }) => {
      const session = this.connections.get(params.targetId);
      if (session) {
        session.close().catch(() => {});
        this.connections.delete(params.targetId);
        logger.info(`Target destroyed, connection closed: ${params.targetId}`);
      }
      this.emit('targetDestroyed', params.targetId);
    });

    await this.browserClient.send('Target.setDiscoverTargets', { discover: true });

    logger.info('Browser connected, target discovery enabled');
  }

  /**
   * HTTP /json 으로 target 목록 조회 (tool layer에서 targetId 확인용).
   */
  async listTargets(): Promise<TargetInfoHttp[]> {
    return CdpClient.listTargets(this.port);
  }

  getBrowserClient(): CdpClient {
    if (!this.browserClient || !this.browserClient.connected) {
      throw new CdpConnectionError('Browser not connected');
    }
    return this.browserClient;
  }

  /**
   * Per-target WebSocket 연결 생성/반환.
   * 캐시에 있고 connected면 그대로 반환, 아니면 새로 연결.
   */
  async getConnection(targetId: string): Promise<CdpSession> {
    // 캐시에 있고 connected → 반환
    const existing = this.connections.get(targetId);
    if (existing && existing.connected) {
      return existing;
    }

    // 캐시에 있지만 disconnected → 삭제
    if (existing) {
      this.connections.delete(targetId);
    }

    // HTTP /json 으로 target의 WS URL 조회
    const targets = await CdpClient.listTargets(this.port);
    const targetInfo = targets.find(t => t.id === targetId);
    if (!targetInfo) {
      throw new CdpConnectionError(`Target ${targetId} not found in /json`);
    }

    // Per-target WebSocket 연결
    const client = new CdpClient(targetInfo.webSocketDebuggerUrl);
    await client.connect();
    const session = new CdpSession(client);

    // Page 타겟이면 dialog auto-dismiss 설정
    if (targetInfo.type === 'page') {
      await this.enableDialogAutoDismiss(session);
    }

    this.connections.set(targetId, session);
    logger.debug(`Connected to target ${targetId} via per-target WebSocket`);

    return session;
  }

  /**
   * 활성 페이지 타겟 찾기 (HTTP /json 기반).
   */
  async getActiveTab(): Promise<CdpSession> {
    const targets = await CdpClient.listTargets(this.port);

    const allPages = targets.filter(t => t.type === 'page');
    if (allPages.length === 0) {
      throw new TabNotFoundError('No page targets found');
    }

    // 일반 웹 페이지 우선 (chrome://, chrome-extension://, 세션 정보 탭 제외)
    const regularPages = allPages.filter(
      t => !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !isSessionInfoTab(t.url)
    );

    // Fallback: 세션 정보 탭 제외한 모든 페이지
    const nonSessionPages = allPages.filter(t => !isSessionInfoTab(t.url));

    const target = regularPages.length > 0
      ? regularPages[0]
      : nonSessionPages.length > 0
        ? nonSessionPages[0]
        : allPages[0]; // Last resort: session info tab

    // getConnection 호출, 실패 시 다음 타겟으로 fallback
    try {
      return await this.getConnection(target.id);
    } catch (err) {
      // fallback: 다른 페이지 시도
      const remaining = allPages.filter(t => t.id !== target.id);
      for (const fallback of remaining) {
        try {
          return await this.getConnection(fallback.id);
        } catch {
          // continue
        }
      }
      throw err;
    }
  }

  /**
   * Extension service worker 타겟 연결.
   */
  async getExtensionWorker(extensionId?: string): Promise<CdpSession> {
    const targets = await CdpClient.listTargets(this.port);

    const workers = targets.filter(t => {
      if (t.type !== 'service_worker') return false;
      if (extensionId) {
        return t.url.includes(`chrome-extension://${extensionId}/`);
      }
      return t.url.startsWith('chrome-extension://');
    });

    if (workers.length === 0) {
      throw new ExtensionNotFoundError(
        extensionId ? `Extension worker not found: ${extensionId}` : 'No extension workers found'
      );
    }

    return this.getConnection(workers[0].id);
  }

  /**
   * Extension popup 타겟 연결.
   */
  async getPopupTab(extensionId?: string): Promise<CdpSession> {
    const targets = await CdpClient.listTargets(this.port);

    const popups = targets.filter(t => {
      if (t.type !== 'page') return false;
      if (extensionId) {
        return t.url.includes(`chrome-extension://${extensionId}/`);
      }
      return t.url.startsWith('chrome-extension://');
    });

    if (popups.length === 0) {
      throw new ExtensionNotFoundError(
        extensionId ? `Extension popup not found: ${extensionId}` : 'No extension popups found'
      );
    }

    return this.getConnection(popups[0].id);
  }

  /**
   * Per-target 연결 해제.
   */
  releaseConnection(targetId: string): void {
    const session = this.connections.get(targetId);
    if (session) {
      session.close().catch(() => {});
      this.connections.delete(targetId);
    }
  }

  /**
   * 모든 per-target 연결 닫기.
   */
  invalidateAllSessions(): void {
    for (const [targetId, session] of this.connections) {
      session.close().catch(() => {});
    }
    this.connections.clear();
    logger.info('All sessions invalidated');
  }

  async closeAll(): Promise<void> {
    this.invalidateAllSessions();
    if (this.browserClient) {
      await this.browserClient.close();
      this.browserClient = null;
    }
    logger.info('All connections closed');
  }

  /**
   * Page 세션에 JavaScript dialog 자동 dismiss 설정.
   * alert/confirm/prompt가 CDP 명령을 블로킹하는 것을 방지한다.
   */
  private async enableDialogAutoDismiss(session: CdpSession): Promise<void> {
    try {
      await session.send('Page.enable');
      session.on('Page.javascriptDialogOpening', async (params: { type: string; message: string }) => {
        logger.info(`Auto-dismissing ${params.type} dialog: "${params.message}"`);
        try {
          await session.send('Page.handleJavaScriptDialog', { accept: true });
        } catch {
          // dialog가 이미 닫혔을 수 있음
        }
      });
    } catch {
      // Page.enable 실패 시 무시 (service worker 등)
    }
  }
}
