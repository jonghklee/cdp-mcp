import { ExtensionNotFoundError, createLogger, sleep } from '@cdp-mcp/shared';
import type { ConnectionPool } from '../cdp/connection-pool.js';
import type { CdpSession } from '../cdp/cdp-session.js';

const logger = createLogger('extension-manager');

export interface ExtensionInfo {
  id: string;
  name: string;           // manifest.json name (falls back to title)
  title: string;          // raw target title from CDP
  serviceWorkerTargetId?: string;
  popupUrl?: string;
  attached: boolean;
}

export class ExtensionManager {
  /** 마지막으로 resolve된 익스텐션 ID — 생략 시 자동 사용 */
  private lastResolvedId: string | null = null;

  constructor(private readonly pool: ConnectionPool) {}

  /**
   * 이름 또는 ID로 익스텐션을 찾는다.
   * - 32자 hex → ID로 직접 매칭
   * - 그 외 → name/title 부분 일치 (대소문자 무시)
   * - 생략 → lastResolvedId 사용, 없으면 첫 번째 익스텐션
   *
   * 찾은 익스텐션의 ID를 lastResolvedId에 저장한다.
   */
  async resolveExtension(idOrName?: string): Promise<ExtensionInfo> {
    const extensions = await this.listExtensions();

    if (!idOrName) {
      // 생략: lastResolved → 첫 번째
      const fallbackId = this.lastResolvedId;
      const ext = fallbackId
        ? extensions.find(e => e.id === fallbackId)
        : extensions[0];
      if (!ext) {
        throw new ExtensionNotFoundError('No extensions found');
      }
      this.lastResolvedId = ext.id;
      return ext;
    }

    // 32자 hex → ID 직접 매칭
    if (/^[a-z0-9]{32}$/.test(idOrName)) {
      const ext = extensions.find(e => e.id === idOrName);
      if (ext) {
        this.lastResolvedId = ext.id;
        return ext;
      }
      throw new ExtensionNotFoundError(`Extension not found by ID: ${idOrName}`);
    }

    // 이름 검색 (부분 일치, 대소문자 무시)
    const query = idOrName.toLowerCase();
    const matches = extensions.filter(e =>
      e.name.toLowerCase().includes(query) ||
      e.title.toLowerCase().includes(query)
    );

    if (matches.length === 0) {
      throw new ExtensionNotFoundError(`Extension not found: "${idOrName}". Available: ${extensions.map(e => e.name).join(', ')}`);
    }

    // 정확 일치 우선
    const exact = matches.find(e =>
      e.name.toLowerCase() === query ||
      e.title.toLowerCase() === query
    );
    const ext = exact ?? matches[0];
    this.lastResolvedId = ext.id;
    return ext;
  }

  /** lastResolvedId 조회 (tool layer에서 참조용) */
  getLastResolvedId(): string | null {
    return this.lastResolvedId;
  }

  /**
   * HTTP /json 엔드포인트로 익스텐션 목록 조회.
   * Target.getTargets() (WebSocket)보다 /json이 dormant service worker를 더 잘 반환한다.
   */
  async listExtensions(): Promise<ExtensionInfo[]> {
    const targets = await this.pool.listTargets();

    // Group by extension ID
    const extensionMap = new Map<string, ExtensionInfo>();

    for (const target of targets) {
      const extId = this.extractExtensionId(target.url);
      if (!extId) continue;

      if (!extensionMap.has(extId)) {
        extensionMap.set(extId, {
          id: extId,
          name: extId,
          title: target.title || extId,
          attached: false,
        });
      }

      const info = extensionMap.get(extId)!;

      if (target.type === 'service_worker') {
        info.serviceWorkerTargetId = target.id;
        info.attached = true; // /json에 나타나면 활성 상태
        if (target.title) info.title = target.title;
      }

      if (target.type === 'page' && target.url.includes('popup')) {
        info.popupUrl = target.url;
      }
    }

    // Enrich with manifest names from active service workers
    await this.enrichWithManifestNames(Array.from(extensionMap.values()));

    return Array.from(extensionMap.values());
  }

  /** @deprecated Use resolveExtension() instead */
  async findExtension(extensionId?: string): Promise<ExtensionInfo | null> {
    try {
      return await this.resolveExtension(extensionId);
    } catch {
      return null;
    }
  }

  async attachToWorker(extensionId: string): Promise<CdpSession> {
    let ext = await this.findExtension(extensionId);

    // If SW is dormant (no serviceWorkerTargetId), try to wake it
    if (ext && !ext.serviceWorkerTargetId) {
      logger.info(`Service worker dormant for ${extensionId}, attempting wake-up`);
      await this.wakeServiceWorker(extensionId);
      ext = await this.findExtension(extensionId);
    }

    if (!ext || !ext.serviceWorkerTargetId) {
      throw new ExtensionNotFoundError(`Extension worker not found: ${extensionId}`);
    }

    this.lastResolvedId = ext.id;
    return this.pool.getConnection(ext.serviceWorkerTargetId);
  }

  async reloadExtension(extensionId: string, waitMs: number = 1000): Promise<void> {
    const client = await this.attachToWorker(extensionId);
    await client.send('Runtime.evaluate', {
      expression: 'chrome.runtime.reload()',
      awaitPromise: true,
    });

    await sleep(waitMs);
    logger.info(`Extension reloaded: ${extensionId}`);
  }

  async openPopupAsTab(extensionId: string, page: string = 'popup.html'): Promise<string> {
    const browserClient = this.pool.getBrowserClient();
    const url = `chrome-extension://${extensionId}/${page}`;

    const { targetId } = await browserClient.send<{ targetId: string }>('Target.createTarget', { url, background: true });

    logger.info(`Opened extension popup as tab: ${url} (targetId: ${targetId})`);
    return targetId;
  }

  /**
   * Enrich extensions with manifest name by calling chrome.runtime.getManifest()
   * on active service workers. Falls back to title for dormant workers.
   */
  private async enrichWithManifestNames(extensions: ExtensionInfo[]): Promise<void> {
    const tasks = extensions
      .filter(ext => ext.serviceWorkerTargetId)
      .map(async (ext) => {
        try {
          const session = await this.pool.getConnection(ext.serviceWorkerTargetId!);
          const result = await session.send<{ result: { type: string; value?: string } }>(
            'Runtime.evaluate',
            { expression: 'chrome.runtime.getManifest().name', returnByValue: true },
          );
          if (result.result?.value) {
            ext.name = result.result.value;
          }
        } catch (e) {
          logger.debug(`Failed to get manifest name for ${ext.id}: ${e}`);
        }
      });

    await Promise.allSettled(tasks);
  }

  /**
   * Wake a dormant service worker by briefly navigating to the extension URL.
   */
  private async wakeServiceWorker(extensionId: string): Promise<void> {
    const browserClient = this.pool.getBrowserClient();
    try {
      const url = `chrome-extension://${extensionId}/manifest.json`;
      const { targetId } = await browserClient.send<{ targetId: string }>(
        'Target.createTarget',
        { url, background: true },
      );
      await sleep(500);
      await browserClient.send('Target.closeTarget', { targetId });
    } catch (e) {
      logger.debug(`Failed to wake service worker for ${extensionId}: ${e}`);
    }
  }

  private extractExtensionId(url: string): string | null {
    const match = url.match(/chrome-extension:\/\/([a-z0-9]{32})/);
    return match ? match[1] : null;
  }
}
