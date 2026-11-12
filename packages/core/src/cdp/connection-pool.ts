import { EventEmitter } from 'events';
import { CdpClient } from './cdp-client.js';
import { CdpSession } from './cdp-session.js';
import { CdpConnectionError, TabNotFoundError, ExtensionNotFoundError, createLogger } from '@cdp-mcp/shared';
import type { TargetInfoCdp, TargetInfoHttp } from './protocol-types.js';

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
      this.owned.delete(params.targetId);
      this.windowOfTarget.delete(params.targetId);
      if (this.activeId === params.targetId) this.activeId = null;
      this.emit('targetDestroyed', params.targetId);
    });

    // 내 탭이 연 팝업(홈택스 인증서 안내창 등)은 다른 창에 떠도 내 것이다.
    this.browserClient.on('Target.targetCreated', (params: { targetInfo: TargetInfoCdp }) => {
      const t = params.targetInfo;
      if (t.type === 'page' && t.openerId && this.owned.has(t.openerId)) this.owned.add(t.targetId);
    });

    await this.browserClient.send('Target.setDiscoverTargets', { discover: true });

    logger.info('Browser connected, target discovery enabled');
  }

  /* ── 에이전트별 창 ────────────────────────────────────────────
   * 크롬 하나를 여러 에이전트가 같이 쓴다. 에이전트(= 이 서버 프로세스)마다 창을 하나 만들고,
   * 그 창의 탭과 그 탭이 연 팝업만 «내 탭»으로 본다. 다른 에이전트의 탭은 목록에도 안 나온다.
   * 창 맨 앞의 빈 탭(home)은 새 탭을 내 창 안에 여는 데만 쓰고 목록에서는 뺀다.
   */
  private windowId: number | null = null;
  private homeId: string | null = null;
  private activeId: string | null = null;
  private readonly owned = new Set<string>();
  private readonly windowOfTarget = new Map<string, number>();

  getWindowId(): number | null {
    return this.windowId;
  }

  async initWindow(): Promise<number> {
    const browser = this.getBrowserClient();
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank', newWindow: true, background: true, width: 1400, height: 1000,
    });
    this.homeId = targetId;
    const windowId = await this.windowOf(targetId);
    if (windowId === undefined) throw new CdpConnectionError('Could not resolve own window id');
    this.windowId = windowId;
    this.activeId = null;
    logger.info(`Own window ${windowId} (home ${targetId})`);
    return windowId;
  }

  private async windowOf(targetId: string): Promise<number | undefined> {
    const cached = this.windowOfTarget.get(targetId);
    if (cached !== undefined) return cached;
    try {
      const { windowId } = await this.getBrowserClient().send<{ windowId: number }>('Browser.getWindowForTarget', { targetId });
      this.windowOfTarget.set(targetId, windowId);
      return windowId;
    } catch {
      return undefined;
    }
  }

  /** 내 탭 id 목록. 현재 탭이 맨 앞이다. */
  async ownedPageIds(): Promise<string[]> {
    const { targetInfos } = await this.getBrowserClient().send<{ targetInfos: TargetInfoCdp[] }>('Target.getTargets', {});
    const pages = targetInfos.filter(t => t.type === 'page' && t.targetId !== this.homeId);
    const ids: string[] = [];
    for (const p of pages) {
      if (!this.owned.has(p.targetId) && this.windowId !== null && (await this.windowOf(p.targetId)) === this.windowId) {
        this.owned.add(p.targetId);
      }
      if (this.owned.has(p.targetId)) ids.push(p.targetId);
    }
    if (this.activeId && ids.includes(this.activeId)) {
      return [this.activeId, ...ids.filter(id => id !== this.activeId)];
    }
    return ids;
  }

  isOwned(targetId: string): boolean {
    return this.owned.has(targetId);
  }

  setActive(targetId: string): void {
    if (!this.owned.has(targetId)) throw new TabNotFoundError(`내 창의 탭이 아닙니다: ${targetId}`);
    this.activeId = targetId;
  }

  /** 내 창 안에 새 탭을 연다. 창이 없어졌으면 창부터 다시 만든다. */
  async createOwnedTab(url: string): Promise<string> {
    const browser = this.getBrowserClient();
    const home = this.homeId ? (await this.listAllTargets()).find(t => t.id === this.homeId) : undefined;
    if (!home) await this.initWindow();

    const before = new Set((await this.listAllTargets()).filter(t => t.type === 'page').map(t => t.id));
    const homeSession = await this.getConnection(this.homeId!);
    await homeSession.send('Runtime.evaluate', {
      expression: `void window.open(${JSON.stringify(url)}, '_blank', 'noopener')`,
      userGesture: true,
    });

    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const fresh = (await this.listAllTargets()).filter(t => t.type === 'page' && !before.has(t.id));
      for (const t of fresh) {
        if ((await this.windowOf(t.id)) === this.windowId) {
          this.owned.add(t.id);
          this.activeId = t.id;
          return t.id;
        }
      }
    }

    // window.open 이 막힌 경우: 새 창으로라도 연다(그 창도 내 것으로 기록).
    logger.warn('window.open from home tab did not produce a tab, falling back to a new window');
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', {
      url, newWindow: true, background: true, width: 1400, height: 1000,
    });
    this.owned.add(targetId);
    this.activeId = targetId;
    return targetId;
  }

  /** 서버가 끝날 때 내 창과 내 팝업을 닫는다. */
  async closeOwnWindow(): Promise<void> {
    const browser = this.getBrowserClient();
    const ids = [...(await this.ownedPageIds()), ...(this.homeId ? [this.homeId] : [])];
    for (const id of ids) {
      await browser.send('Target.closeTarget', { targetId: id }).catch(() => {});
    }
  }

  /** 죽은 에이전트가 남긴 창을 닫는다. */
  async closeWindowById(windowId: number): Promise<number> {
    const browser = this.getBrowserClient();
    const { targetInfos } = await browser.send<{ targetInfos: TargetInfoCdp[] }>('Target.getTargets', {});
    let closed = 0;
    for (const t of targetInfos.filter(x => x.type === 'page')) {
      if ((await this.windowOf(t.targetId)) === windowId) {
        await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
        closed++;
      }
    }
    return closed;
  }

  private async listAllTargets(): Promise<TargetInfoHttp[]> {
    return CdpClient.listTargets(this.port);
  }

  /**
   * HTTP /json 으로 target 목록 조회. 페이지는 내 탭만(현재 탭이 맨 앞), 서비스 워커 등은 그대로.
   */
  async listTargets(): Promise<TargetInfoHttp[]> {
    const all = await this.listAllTargets();
    const mine = await this.ownedPageIds();
    const pages = mine.map(id => all.find(t => t.id === id)).filter((t): t is TargetInfoHttp => !!t);
    return [...pages, ...all.filter(t => t.type !== 'page')];
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

    // Page 타겟이면 dialog auto-dismiss 설정 + 백그라운드 스로틀 해제
    if (targetInfo.type === 'page') {
      await this.enableDialogAutoDismiss(session);
      await this.keepAwakeWithoutFocus(session);
    }

    this.connections.set(targetId, session);
    logger.debug(`Connected to target ${targetId} via per-target WebSocket`);

    return session;
  }

  /**
   * 활성 페이지 타겟 찾기 (HTTP /json 기반).
   */
  async getActiveTab(): Promise<CdpSession> {
    const mine = await this.ownedPageIds();
    const id = mine[0] ?? (await this.createOwnedTab('about:blank'));
    this.activeId = id;
    return this.getConnection(id);
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
   * 창을 앞으로 올리지 않고도 백그라운드 탭을 깨어 있게 한다.
   * 가려진 탭은 크롬이 타이머·rAF를 멈추고 페이지를 hidden으로 취급해서,
   * Figma 같은 앱은 내부 브리지가 잠들어 비동기 호출이 무한 대기한다.
   * 포커스 에뮬레이션 + lifecycle 'active' 로 OS 창 순서는 그대로 둔 채 이를 막는다.
   */
  private async keepAwakeWithoutFocus(session: CdpSession): Promise<void> {
    try { await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* 구버전 크롬 */ }
    try { await session.send('Page.setWebLifecycleState', { state: 'active' }); } catch { /* 이미 active */ }
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
