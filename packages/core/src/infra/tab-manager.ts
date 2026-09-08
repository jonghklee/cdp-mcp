import type { TabInfo } from '@cdp-mcp/shared';
import { TabNotFoundError, createLogger } from '@cdp-mcp/shared';
import type { ConnectionPool } from '../cdp/connection-pool.js';
import type { TargetInfoCdp } from '../cdp/protocol-types.js';
import { isSessionInfoTab } from './session-info-tab.js';

const logger = createLogger('tab-manager');

export class TabManager {
  constructor(private readonly pool: ConnectionPool) {}

  async listTabs(filter?: { url?: string; title?: string }): Promise<TabInfo[]> {
    const browserClient = this.pool.getBrowserClient();
    const { targetInfos } = await browserClient.send<{ targetInfos: TargetInfoCdp[] }>('Target.getTargets', {});

    let tabs = targetInfos
      .filter(t => t.type === 'page')
      .map(this.toTabInfo);

    if (filter?.url) {
      tabs = tabs.filter(t => t.url.includes(filter.url!));
    }
    if (filter?.title) {
      tabs = tabs.filter(t => t.title.toLowerCase().includes(filter.title!.toLowerCase()));
    }

    return tabs;
  }

  async getActiveTab(): Promise<TabInfo> {
    const tabs = await this.listTabs();
    // Filter out internal pages and session info tab
    const userTabs = tabs.filter(
      t => !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !isSessionInfoTab(t.url),
    );
    if (userTabs.length > 0) return userTabs[0];
    // Fallback: any tab except session info tab
    const nonSessionTabs = tabs.filter(t => !isSessionInfoTab(t.url));
    if (nonSessionTabs.length > 0) return nonSessionTabs[0];
    // Last resort: session info tab as fallback if it's the only tab
    if (tabs.length > 0) return tabs[0];
    throw new TabNotFoundError('No tabs found');
  }

  async switchTab(target: { tabId?: string; url?: string; title?: string; background?: boolean }): Promise<TabInfo> {
    const browserClient = this.pool.getBrowserClient();
    const bg = target.background ?? true;

    if (target.tabId) {
      if (!bg) {
        await browserClient.send('Target.activateTarget', { targetId: target.tabId });
      }
      const { targetInfos } = await browserClient.send<{ targetInfos: TargetInfoCdp[] }>('Target.getTargets', {});
      const found = targetInfos.find(t => t.targetId === target.tabId);
      if (!found) throw new TabNotFoundError(`Tab not found: ${target.tabId}`);
      return this.toTabInfo(found);
    }

    // Find by URL or title
    const tabs = await this.listTabs({ url: target.url, title: target.title });
    if (tabs.length === 0) {
      throw new TabNotFoundError(`No tab matching: ${JSON.stringify(target)}`);
    }

    if (!bg) {
      await browserClient.send('Target.activateTarget', { targetId: tabs[0].id });
    }
    return tabs[0];
  }

  async createTab(url: string, background?: boolean): Promise<TabInfo> {
    const browserClient = this.pool.getBrowserClient();

    // Try Target.createTarget first
    let createTargetFailed = false;
    try {
      const { targetId } = await browserClient.send<{ targetId: string }>('Target.createTarget', { url, background: background ?? true });

      // Get the newly created target's info
      const { targetInfos } = await browserClient.send<{ targetInfos: TargetInfoCdp[] }>('Target.getTargets', {});
      const found = targetInfos.find(t => t.targetId === targetId);
      if (!found) throw new TabNotFoundError('Created tab not found');
      return this.toTabInfo(found);
    } catch (err) {
      // Only fallback if Target.createTarget itself failed (not subsequent errors)
      if (err instanceof TabNotFoundError) throw err;
      createTargetFailed = true;
      logger.warn(`Target.createTarget failed, falling back to window.open(): ${err}`);
    }

    if (createTargetFailed) {
      // Fallback: Target.createTarget not supported (e.g. some Chrome connection modes)
      // Use window.open() via the active tab's page context
      const session = await this.pool.getActiveTab();
      const openResult = await session.send<{ result: { value: boolean } }>('Runtime.evaluate', {
        expression: `(() => { window.open(${JSON.stringify(url)}, '_blank'); return true; })()`,
        returnByValue: true,
      });

      if (!openResult.result.value) {
        throw new Error('Failed to create tab via window.open() fallback');
      }

      // Wait briefly for the new tab to appear
      await new Promise(resolve => setTimeout(resolve, 500));

      // Find the newly created tab
      const { targetInfos } = await browserClient.send<{ targetInfos: TargetInfoCdp[] }>('Target.getTargets', {});
      const newTab = targetInfos
        .filter(t => t.type === 'page')
        .find(t => t.url.includes(new URL(url).hostname) || t.url === 'about:blank');

      if (!newTab) {
        // Return a best-effort result — the tab was opened but we can't find it yet
        logger.warn('Tab created via window.open() but not yet visible in target list');
        const allPages = targetInfos.filter(t => t.type === 'page');
        if (allPages.length > 0) {
          return this.toTabInfo(allPages[allPages.length - 1]);
        }
        throw new TabNotFoundError('Created tab not found after window.open() fallback');
      }

      if (!background) {
        await browserClient.send('Target.activateTarget', { targetId: newTab.targetId }).catch(() => {});
      }

      return this.toTabInfo(newTab);
    }

    // Should never reach here — createTargetFailed is always true at this point
    throw new Error('Unexpected state in createTab');
  }

  async activateTab(tabId: string): Promise<void> {
    const browserClient = this.pool.getBrowserClient();
    await browserClient.send('Target.activateTarget', { targetId: tabId });

    // Also bring the window to front via the page session
    try {
      const session = await this.pool.getConnection(tabId);
      await session.send('Page.bringToFront', {});
    } catch (e) {
      logger.warn(`Page.bringToFront failed (non-critical): ${e}`);
    }

    // On macOS, use Browser.getWindowForTarget + setWindowBounds to unminimize
    try {
      const { windowId, bounds } = await browserClient.send<{
        windowId: number;
        bounds: { windowState?: string };
      }>('Browser.getWindowForTarget', { targetId: tabId });

      if (bounds.windowState === 'minimized') {
        await browserClient.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' },
        });
        logger.info('Window unminimized');
      }
    } catch (e) {
      logger.warn(`Browser.getWindowForTarget/setWindowBounds failed (non-critical): ${e}`);
    }

    logger.info(`Tab activated (foreground): ${tabId}`);
  }

  async minimizeWindow(tabId: string): Promise<void> {
    const browserClient = this.pool.getBrowserClient();
    const { windowId } = await browserClient.send<{ windowId: number }>(
      'Browser.getWindowForTarget',
      { targetId: tabId },
    );
    await browserClient.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
    logger.info(`Window minimized for tab ${tabId}`);
  }

  async closeTab(tabId: string): Promise<void> {
    const browserClient = this.pool.getBrowserClient();
    await browserClient.send('Target.closeTarget', { targetId: tabId });
    this.pool.releaseConnection(tabId);
    logger.info(`Tab closed: ${tabId}`);
  }

  private toTabInfo(target: TargetInfoCdp): TabInfo {
    return {
      id: target.targetId,
      url: target.url,
      title: target.title,
      type: target.type,
      attached: target.attached,
    };
  }
}
