import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExtensionManager } from '../extension-manager.js';
import { ExtensionNotFoundError } from '@cdp-mcp/shared';

function createMockPool() {
  const mockSession = {
    send: vi.fn().mockResolvedValue({ result: { type: 'string', value: 'Test Extension' } }),
    connected: true,
  };
  const mockBrowserClient = {
    send: vi.fn(),
    connected: true,
  };
  return {
    pool: {
      getBrowserClient: vi.fn().mockReturnValue(mockBrowserClient),
      getConnection: vi.fn().mockResolvedValue(mockSession),
      getExtensionWorker: vi.fn().mockResolvedValue(mockSession),
      listTargets: vi.fn(),
    },
    mockBrowserClient,
    mockSession,
  };
}

// HTTP /json 형식
const MOCK_HTTP_TARGETS = [
  {
    id: 'sw-1',
    type: 'service_worker',
    title: 'ChatLens',
    url: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/service-worker.js',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9250/devtools/page/sw-1',
  },
  {
    id: 'page-1',
    type: 'page',
    title: 'Popup',
    url: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/popup.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9250/devtools/page/page-1',
  },
  {
    id: 'sw-2',
    type: 'service_worker',
    title: 'Other Extension',
    url: 'chrome-extension://zyxwvutsrqponmlkjihgfedcbazyxwvu/sw.js',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9250/devtools/page/sw-2',
  },
  {
    id: 'page-2',
    type: 'page',
    title: 'Google',
    url: 'https://www.google.com',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9250/devtools/page/page-2',
  },
];

describe('ExtensionManager', () => {
  let manager: ExtensionManager;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockPool = createMockPool();
    manager = new ExtensionManager(mockPool.pool as any);
    mockPool.pool.listTargets.mockResolvedValue(MOCK_HTTP_TARGETS);
  });

  describe('listExtensions', () => {
    it('uses HTTP /json to list targets and groups by extension ID', async () => {
      const exts = await manager.listExtensions();
      expect(exts).toHaveLength(2);
      expect(mockPool.pool.listTargets).toHaveBeenCalled();

      expect(exts[0].id).toBe('abcdefghijklmnopqrstuvwxyzabcdef');
      expect(exts[0].serviceWorkerTargetId).toBe('sw-1');
      expect(exts[0].popupUrl).toContain('popup.html');
    });

    it('enriches with manifest name from service worker', async () => {
      mockPool.pool.getConnection.mockResolvedValue({
        send: vi.fn().mockResolvedValue({ result: { type: 'string', value: 'Chat Lens Pro' } }),
      });

      const exts = await manager.listExtensions();
      expect(exts[0].name).toBe('Chat Lens Pro');
      expect(exts[0].title).toBe('ChatLens');
    });

    it('falls back to extension ID when manifest fetch fails', async () => {
      mockPool.pool.getConnection.mockRejectedValue(new Error('connection failed'));

      const exts = await manager.listExtensions();
      expect(exts[0].name).toBe(exts[0].id);
    });

    it('excludes non-extension targets', async () => {
      const exts = await manager.listExtensions();
      const ids = exts.map(e => e.id);
      expect(ids).not.toContain('page-2');
    });
  });

  describe('resolveExtension', () => {
    it('resolves by exact 32-char ID', async () => {
      const ext = await manager.resolveExtension('abcdefghijklmnopqrstuvwxyzabcdef');
      expect(ext.id).toBe('abcdefghijklmnopqrstuvwxyzabcdef');
    });

    it('resolves by name (partial match, case-insensitive)', async () => {
      // Ensure manifest name is enriched
      mockPool.pool.getConnection.mockResolvedValue({
        send: vi.fn().mockResolvedValue({ result: { type: 'string', value: 'Chat Lens Pro' } }),
      });

      const ext = await manager.resolveExtension('chat lens');
      expect(ext.id).toBe('abcdefghijklmnopqrstuvwxyzabcdef');
    });

    it('resolves by title (partial match)', async () => {
      const ext = await manager.resolveExtension('ChatLens');
      expect(ext.title).toBe('ChatLens');
    });

    it('throws for unknown name', async () => {
      await expect(manager.resolveExtension('NonExistent')).rejects.toThrow(ExtensionNotFoundError);
    });

    it('throws for unknown ID', async () => {
      await expect(manager.resolveExtension('aaaabbbbccccddddeeeeffffgggghhhh')).rejects.toThrow(ExtensionNotFoundError);
    });

    it('returns first extension when no arg', async () => {
      const ext = await manager.resolveExtension();
      expect(ext).toBeDefined();
    });

    it('remembers last resolved extension', async () => {
      await manager.resolveExtension('abcdefghijklmnopqrstuvwxyzabcdef');
      expect(manager.getLastResolvedId()).toBe('abcdefghijklmnopqrstuvwxyzabcdef');

      // Now omit arg → should return last resolved
      const ext = await manager.resolveExtension();
      expect(ext.id).toBe('abcdefghijklmnopqrstuvwxyzabcdef');
    });

    it('prefers exact name match over partial', async () => {
      // Return different names for each extension's service worker
      let callCount = 0;
      mockPool.pool.getConnection.mockImplementation(async () => ({
        send: vi.fn().mockImplementation(async () => {
          callCount++;
          // First call → sw-1 (ChatLens), Second call → sw-2 (Other Extension)
          const name = callCount === 1 ? 'Chat Lens Pro' : 'Other Extension';
          return { result: { type: 'string', value: name } };
        }),
      }));

      const ext = await manager.resolveExtension('Other Extension');
      expect(ext.id).toBe('zyxwvutsrqponmlkjihgfedcbazyxwvu');
    });
  });

  describe('findExtension (deprecated)', () => {
    it('finds extension by ID', async () => {
      const ext = await manager.findExtension('abcdefghijklmnopqrstuvwxyzabcdef');
      expect(ext).not.toBeNull();
      expect(ext!.title).toBe('ChatLens');
    });

    it('returns null for unknown extension', async () => {
      const ext = await manager.findExtension('nonexistent');
      expect(ext).toBeNull();
    });

    it('returns first extension when no ID specified', async () => {
      const ext = await manager.findExtension();
      expect(ext).not.toBeNull();
    });
  });

  describe('attachToWorker', () => {
    it('attaches to service worker target', async () => {
      await manager.attachToWorker('abcdefghijklmnopqrstuvwxyzabcdef');
      expect(mockPool.pool.getConnection).toHaveBeenCalledWith('sw-1');
    });

    it('throws when extension not found', async () => {
      await expect(manager.attachToWorker('nonexistent')).rejects.toThrow(ExtensionNotFoundError);
    });

    it('wakes dormant service worker and retries', async () => {
      const dormantTargets = [
        {
          id: 'page-1',
          type: 'page',
          title: 'Popup',
          url: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/popup.html',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9250/devtools/page/page-1',
        },
      ];
      const awakenedTargets = [...dormantTargets, {
        id: 'sw-1',
        type: 'service_worker',
        title: 'ChatLens',
        url: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/service-worker.js',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9250/devtools/page/sw-1',
      }];

      let listCallCount = 0;
      mockPool.pool.listTargets.mockImplementation(async () => {
        listCallCount++;
        return listCallCount <= 1 ? dormantTargets : awakenedTargets;
      });

      mockPool.mockBrowserClient.send.mockImplementation(async (method: string) => {
        if (method === 'Target.createTarget') return { targetId: 'temp-tab' };
        if (method === 'Target.closeTarget') return {};
        return {};
      });

      await manager.attachToWorker('abcdefghijklmnopqrstuvwxyzabcdef');
      expect(mockPool.mockBrowserClient.send).toHaveBeenCalledWith('Target.createTarget', expect.objectContaining({
        url: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/manifest.json',
      }));
      expect(mockPool.pool.getConnection).toHaveBeenCalledWith('sw-1');
    });

    it('updates lastResolvedId on successful attach', async () => {
      await manager.attachToWorker('abcdefghijklmnopqrstuvwxyzabcdef');
      expect(manager.getLastResolvedId()).toBe('abcdefghijklmnopqrstuvwxyzabcdef');
    });
  });

  describe('openPopupAsTab', () => {
    it('creates tab with extension popup URL', async () => {
      mockPool.mockBrowserClient.send.mockResolvedValueOnce({ targetId: 'new-tab' });

      const tabId = await manager.openPopupAsTab('abcdefghijklmnopqrstuvwxyzabcdef');
      expect(tabId).toBe('new-tab');
      expect(mockPool.mockBrowserClient.send).toHaveBeenCalledWith('Target.createTarget', {
        url: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/popup.html',
        background: true,
      });
    });

    it('uses custom page name', async () => {
      mockPool.mockBrowserClient.send.mockResolvedValueOnce({ targetId: 'new-tab' });

      await manager.openPopupAsTab('abcdefghijklmnopqrstuvwxyzabcdef', 'options.html');
      expect(mockPool.mockBrowserClient.send).toHaveBeenCalledWith('Target.createTarget', {
        url: 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/options.html',
        background: true,
      });
    });
  });
});
