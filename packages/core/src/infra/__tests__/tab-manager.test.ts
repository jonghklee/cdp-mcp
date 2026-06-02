import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TabManager } from '../tab-manager.js';
import { TabNotFoundError } from '@cdp-mcp/shared';
import type { TargetInfoCdp } from '../../cdp/protocol-types.js';

function createMockPool() {
  const mockSend = vi.fn();
  const mockReleaseConnection = vi.fn();
  const mockBrowserClient = { send: mockSend, connected: true };

  return {
    getBrowserClient: vi.fn().mockReturnValue(mockBrowserClient),
    releaseConnection: mockReleaseConnection,
    mockSend,
    mockReleaseConnection,
  };
}

function makeTarget(overrides: Partial<TargetInfoCdp> = {}): TargetInfoCdp {
  return {
    targetId: 'target-1',
    type: 'page',
    title: 'Test Page',
    url: 'https://example.com',
    attached: false,
    ...overrides,
  };
}

describe('TabManager', () => {
  let tabManager: TabManager;
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
    tabManager = new TabManager(pool as any);
  });

  describe('listTabs()', () => {
    it('returns page type targets as TabInfo', async () => {
      const pageTarget = makeTarget({ targetId: 'page-1', type: 'page' });
      const workerTarget = makeTarget({ targetId: 'worker-1', type: 'service_worker' });
      const bgTarget = makeTarget({ targetId: 'bg-1', type: 'background_page' });

      pool.mockSend.mockResolvedValue({
        targetInfos: [pageTarget, workerTarget, bgTarget],
      });

      const tabs = await tabManager.listTabs();

      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toEqual({
        id: 'page-1',
        url: 'https://example.com',
        title: 'Test Page',
        type: 'page',
        attached: false,
      });
    });

    it('filters by url', async () => {
      const tab1 = makeTarget({ targetId: 't1', url: 'https://example.com/page1' });
      const tab2 = makeTarget({ targetId: 't2', url: 'https://other.com/page2' });

      pool.mockSend.mockResolvedValue({ targetInfos: [tab1, tab2] });

      const tabs = await tabManager.listTabs({ url: 'example.com' });

      expect(tabs).toHaveLength(1);
      expect(tabs[0].id).toBe('t1');
    });

    it('filters by title (case-insensitive)', async () => {
      const tab1 = makeTarget({ targetId: 't1', title: 'My Dashboard' });
      const tab2 = makeTarget({ targetId: 't2', title: 'Settings Page' });

      pool.mockSend.mockResolvedValue({ targetInfos: [tab1, tab2] });

      const tabs = await tabManager.listTabs({ title: 'dashboard' });

      expect(tabs).toHaveLength(1);
      expect(tabs[0].id).toBe('t1');
    });
  });

  describe('getActiveTab()', () => {
    it('returns non-chrome:// tab preferentially', async () => {
      const chromeTab = makeTarget({ targetId: 'chrome-1', url: 'chrome://newtab' });
      const extensionTab = makeTarget({ targetId: 'ext-1', url: 'chrome-extension://abc/popup.html' });
      const userTab = makeTarget({ targetId: 'user-1', url: 'https://example.com' });

      pool.mockSend.mockResolvedValue({
        targetInfos: [chromeTab, extensionTab, userTab],
      });

      const tab = await tabManager.getActiveTab();

      expect(tab.id).toBe('user-1');
    });

    it('falls back to chrome:// tab if no user tabs', async () => {
      const chromeTab = makeTarget({ targetId: 'chrome-1', url: 'chrome://newtab' });

      pool.mockSend.mockResolvedValue({ targetInfos: [chromeTab] });

      const tab = await tabManager.getActiveTab();

      expect(tab.id).toBe('chrome-1');
    });

    it('throws TabNotFoundError when no tabs exist', async () => {
      pool.mockSend.mockResolvedValue({ targetInfos: [] });

      await expect(tabManager.getActiveTab()).rejects.toThrow(TabNotFoundError);
    });

    it('throws TabNotFoundError when only non-page targets exist', async () => {
      const worker = makeTarget({ targetId: 'w1', type: 'service_worker' });

      pool.mockSend.mockResolvedValue({ targetInfos: [worker] });

      await expect(tabManager.getActiveTab()).rejects.toThrow(TabNotFoundError);
    });
  });

  describe('switchTab()', () => {
    it('switches by tabId in background by default (no activateTarget)', async () => {
      const target = makeTarget({ targetId: 'tab-123' });

      pool.mockSend
        .mockResolvedValueOnce({ targetInfos: [target] }); // Target.getTargets

      const tab = await tabManager.switchTab({ tabId: 'tab-123' });

      expect(pool.mockSend).not.toHaveBeenCalledWith('Target.activateTarget', expect.anything());
      expect(tab.id).toBe('tab-123');
    });

    it('switches by tabId with background=false calls activateTarget', async () => {
      const target = makeTarget({ targetId: 'tab-123' });

      pool.mockSend
        .mockResolvedValueOnce(undefined) // Target.activateTarget
        .mockResolvedValueOnce({ targetInfos: [target] }); // Target.getTargets

      const tab = await tabManager.switchTab({ tabId: 'tab-123', background: false });

      expect(pool.mockSend).toHaveBeenCalledWith('Target.activateTarget', { targetId: 'tab-123' });
      expect(tab.id).toBe('tab-123');
    });

    it('switches by url in background by default', async () => {
      const target = makeTarget({ targetId: 'url-tab', url: 'https://example.com/page' });

      pool.mockSend
        .mockResolvedValueOnce({ targetInfos: [target] }); // Target.getTargets (for listTabs)

      const tab = await tabManager.switchTab({ url: 'example.com' });

      expect(pool.mockSend).not.toHaveBeenCalledWith('Target.activateTarget', expect.anything());
      expect(tab.id).toBe('url-tab');
    });

    it('throws TabNotFoundError when tabId not found', async () => {
      pool.mockSend
        .mockResolvedValueOnce({ targetInfos: [] }); // Target.getTargets returns empty

      await expect(tabManager.switchTab({ tabId: 'nonexistent' })).rejects.toThrow(TabNotFoundError);
    });

    it('throws TabNotFoundError when no tab matches url/title filter', async () => {
      pool.mockSend.mockResolvedValue({ targetInfos: [] });

      await expect(tabManager.switchTab({ url: 'nonexistent.com' })).rejects.toThrow(TabNotFoundError);
    });
  });

  describe('createTab()', () => {
    it('calls Target.createTarget and returns TabInfo', async () => {
      const createdTarget = makeTarget({
        targetId: 'new-tab',
        url: 'https://new-page.com',
        title: 'New Page',
      });

      pool.mockSend
        .mockResolvedValueOnce({ targetId: 'new-tab' }) // Target.createTarget
        .mockResolvedValueOnce({ targetInfos: [createdTarget] }); // Target.getTargets

      const tab = await tabManager.createTab('https://new-page.com');

      expect(pool.mockSend).toHaveBeenCalledWith('Target.createTarget', { url: 'https://new-page.com', background: true });
      expect(tab).toEqual({
        id: 'new-tab',
        url: 'https://new-page.com',
        title: 'New Page',
        type: 'page',
        attached: false,
      });
    });

    it('throws TabNotFoundError when created tab not found in targets', async () => {
      pool.mockSend
        .mockResolvedValueOnce({ targetId: 'new-tab' }) // Target.createTarget
        .mockResolvedValueOnce({ targetInfos: [] }); // Target.getTargets — not found → TabNotFoundError

      await expect(tabManager.createTab('https://new-page.com')).rejects.toThrow(TabNotFoundError);
    });

    it('falls back to window.open() when Target.createTarget not supported', async () => {
      const mockSession = { send: vi.fn().mockResolvedValueOnce({ result: { value: true } }) };
      (pool as any).getActiveTab = vi.fn().mockResolvedValue(mockSession);

      const createdTarget = makeTarget({
        targetId: 'fallback-tab',
        url: 'https://new-page.com',
        title: 'New Page',
      });

      pool.mockSend
        .mockRejectedValueOnce(new Error('Not supported')) // Target.createTarget fails
        .mockResolvedValueOnce({ targetInfos: [createdTarget] }) // Target.getTargets (fallback lookup)
        .mockResolvedValueOnce(undefined); // Target.activateTarget (optional)

      const tab = await tabManager.createTab('https://new-page.com', false);

      expect(tab.url).toBe('https://new-page.com');
    });
  });

  describe('closeTab()', () => {
    it('calls Target.closeTarget and releases connection', async () => {
      pool.mockSend.mockResolvedValue(undefined);

      await tabManager.closeTab('tab-to-close');

      expect(pool.mockSend).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'tab-to-close' });
      expect(pool.mockReleaseConnection).toHaveBeenCalledWith('tab-to-close');
    });
  });
});
