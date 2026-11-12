import type { TabInfo } from '@cdp-mcp/shared';
import { TabNotFoundError, createLogger } from '@cdp-mcp/shared';
import type { ConnectionPool } from '../cdp/connection-pool.js';
import type { TargetInfoCdp } from '../cdp/protocol-types.js';
import { navigate } from '../act/navigate.js';

const logger = createLogger('tab-manager');

/** 이 에이전트 창의 탭만 다룬다. 어떤 동작도 크롬을 화면 앞으로 올리지 않는다. */
export class TabManager {
  constructor(private readonly pool: ConnectionPool) {}

  async listTabs(filter?: { url?: string; title?: string }): Promise<TabInfo[]> {
    const ids = await this.pool.ownedPageIds();
    const { targetInfos } = await this.pool.getBrowserClient().send<{ targetInfos: TargetInfoCdp[] }>('Target.getTargets', {});
    let tabs = ids
      .map(id => targetInfos.find(t => t.targetId === id))
      .filter((t): t is TargetInfoCdp => !!t)
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
    if (tabs.length === 0) throw new TabNotFoundError('No tabs found');
    return tabs[0];
  }

  async switchTab(target: { tabId?: string; url?: string; title?: string }): Promise<TabInfo> {
    const tabs = target.tabId
      ? (await this.listTabs()).filter(t => t.id === target.tabId)
      : await this.listTabs({ url: target.url, title: target.title });
    if (tabs.length === 0) {
      throw new TabNotFoundError(`No tab matching in this agent's window: ${JSON.stringify(target)}`);
    }
    this.pool.setActive(tabs[0].id);
    return tabs[0];
  }

  /** 내 창에 빈 탭을 열고 그 탭에서 url 이 다 뜰 때까지 기다린 뒤 돌려준다. */
  async createTab(url: string): Promise<TabInfo> {
    const id = await this.pool.createOwnedTab('about:blank');
    if (url !== 'about:blank') {
      try {
        await navigate(this.pool, { url });
      } catch (err) {
        logger.warn(`createTab: page did not finish loading: ${err}`);
      }
    }
    const tab = (await this.listTabs()).find(t => t.id === id);
    if (!tab) throw new TabNotFoundError('Created tab not found');
    return tab;
  }

  async closeTab(tabId: string): Promise<void> {
    if (!this.pool.isOwned(tabId)) throw new TabNotFoundError(`내 창의 탭이 아닙니다: ${tabId}`);
    await this.pool.getBrowserClient().send('Target.closeTarget', { targetId: tabId });
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
