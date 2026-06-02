import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CdpConnectionError, TabNotFoundError, ExtensionNotFoundError } from '@cdp-mcp/shared';
import type { TargetInfoHttp } from '../protocol-types.js';

// Mock CdpClient module
const mockClientInstances: any[] = [];

vi.mock('../cdp-client.js', () => {
  return {
    CdpClient: Object.assign(
      vi.fn().mockImplementation((wsUrl: string) => {
        const handlers = new Map<string, Function[]>();
        const instance = {
          wsUrl,
          _connected: true,
          get connected() { return this._connected; },
          connect: vi.fn().mockResolvedValue(undefined),
          send: vi.fn().mockResolvedValue({}),
          close: vi.fn().mockResolvedValue(undefined),
          on: vi.fn().mockImplementation(function(this: any, event: string, handler: Function) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event)!.push(handler);
            return this;
          }),
          off: vi.fn(),
          _handlers: handlers,
          _triggerEvent(event: string, data: unknown) {
            const eventHandlers = handlers.get(event);
            if (eventHandlers) eventHandlers.forEach(h => h(data));
          },
        };
        mockClientInstances.push(instance);
        return instance;
      }),
      {
        // Static methods
        getBrowserWsUrl: vi.fn().mockResolvedValue('ws://127.0.0.1:9222/devtools/browser/test'),
        listTargets: vi.fn().mockResolvedValue([]),
      }
    ),
  };
});

import { ConnectionPool } from '../connection-pool.js';
import { CdpClient } from '../cdp-client.js';
import { CdpSession } from '../cdp-session.js';

// Helper to create a TargetInfoHttp object
function makeHttpTarget(overrides: Partial<TargetInfoHttp> & { id: string }): TargetInfoHttp {
  return {
    type: 'page',
    title: 'Test Page',
    url: 'https://example.com',
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${overrides.id}`,
    ...overrides,
  };
}

describe('ConnectionPool', () => {
  let pool: ConnectionPool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstances.length = 0;
    pool = new ConnectionPool(9222);
  });

  afterEach(async () => {
    await pool.closeAll();
  });

  describe('connectBrowser()', () => {
    it('should get browser WS URL and connect', async () => {
      await pool.connectBrowser();

      expect(CdpClient.getBrowserWsUrl).toHaveBeenCalledWith(9222);
      // First CdpClient instance is the browser client
      expect(mockClientInstances[0].connect).toHaveBeenCalledOnce();
      expect(mockClientInstances[0].wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/test');
    });

    it('should register Target.targetDestroyed listener', async () => {
      await pool.connectBrowser();

      const browserClient = mockClientInstances[0];
      const onCalls = browserClient.on.mock.calls.map((c: any[]) => c[0]);
      expect(onCalls).toContain('Target.targetDestroyed');
    });

    it('should enable target discovery', async () => {
      await pool.connectBrowser();

      const browserClient = mockClientInstances[0];
      expect(browserClient.send).toHaveBeenCalledWith('Target.setDiscoverTargets', { discover: true });
    });
  });

  describe('getBrowserClient()', () => {
    it('should throw CdpConnectionError when not connected', () => {
      expect(() => pool.getBrowserClient()).toThrow(CdpConnectionError);
    });

    it('should return browser client after connection', async () => {
      await pool.connectBrowser();
      const client = pool.getBrowserClient();
      expect(client).toBeDefined();
      expect(client.connected).toBe(true);
    });
  });

  describe('getConnection()', () => {
    it('should look up target via HTTP /json and create per-target WebSocket', async () => {
      await pool.connectBrowser();

      const pageTarget = makeHttpTarget({ id: 'page-1' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([pageTarget]);

      const session = await pool.getConnection('page-1');

      expect(CdpClient.listTargets).toHaveBeenCalledWith(9222);
      expect(session).toBeInstanceOf(CdpSession);
      expect(session.connected).toBe(true);

      // Second CdpClient instance is the per-target client (first is browser)
      const targetClient = mockClientInstances[1];
      expect(targetClient.wsUrl).toBe('ws://127.0.0.1:9222/devtools/page/page-1');
      expect(targetClient.connect).toHaveBeenCalledOnce();
    });

    it('should return cached session if still connected', async () => {
      await pool.connectBrowser();

      const pageTarget = makeHttpTarget({ id: 'page-1' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([pageTarget]);

      const conn1 = await pool.getConnection('page-1');
      const conn2 = await pool.getConnection('page-1');

      expect(conn1).toBe(conn2);
      // listTargets should only be called once (cached)
      expect(CdpClient.listTargets).toHaveBeenCalledTimes(1);
    });

    it('should throw CdpConnectionError when target not found in /json', async () => {
      await pool.connectBrowser();

      vi.mocked(CdpClient.listTargets).mockResolvedValue([]);

      await expect(pool.getConnection('unknown-target')).rejects.toThrow(CdpConnectionError);
      await expect(pool.getConnection('unknown-target')).rejects.toThrow('not found in /json');
    });

    it('CdpSession.send() should delegate to per-target CdpClient.send()', async () => {
      await pool.connectBrowser();

      const pageTarget = makeHttpTarget({ id: 'page-1' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([pageTarget]);

      const session = await pool.getConnection('page-1');
      await session.send('Runtime.evaluate', { expression: '1+1' });

      // The per-target client (index 1) should receive the send call
      const targetClient = mockClientInstances[1];
      expect(targetClient.send).toHaveBeenCalledWith('Runtime.evaluate', { expression: '1+1' });
    });

    it('should enable Page.enable and dialog auto-dismiss for page targets', async () => {
      await pool.connectBrowser();

      const pageTarget = makeHttpTarget({ id: 'page-1', type: 'page' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([pageTarget]);

      await pool.getConnection('page-1');

      const targetClient = mockClientInstances[1];
      expect(targetClient.send).toHaveBeenCalledWith('Page.enable', undefined);
      const onCalls = targetClient.on.mock.calls.map((c: any[]) => c[0]);
      expect(onCalls).toContain('Page.javascriptDialogOpening');
    });

    it('should NOT enable Page.enable for service_worker targets', async () => {
      await pool.connectBrowser();

      const workerTarget = makeHttpTarget({
        id: 'worker-1',
        type: 'service_worker',
        url: 'chrome-extension://abc/sw.js',
      });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([workerTarget]);

      await pool.getConnection('worker-1');

      const targetClient = mockClientInstances[1];
      const sendCalls = targetClient.send.mock.calls.map((c: any[]) => c[0]);
      expect(sendCalls).not.toContain('Page.enable');
    });
  });

  describe('getActiveTab()', () => {
    it('should return a CdpSession for a page target', async () => {
      await pool.connectBrowser();

      const pageTarget = makeHttpTarget({ id: 'page-1', url: 'https://example.com' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([pageTarget]);

      const session = await pool.getActiveTab();
      expect(session).toBeInstanceOf(CdpSession);
      expect(session.connected).toBe(true);
    });

    it('should prefer non-chrome:// pages', async () => {
      await pool.connectBrowser();

      const chromeTarget = makeHttpTarget({ id: 'chrome-1', url: 'chrome://extensions' });
      const normalTarget = makeHttpTarget({ id: 'page-1', url: 'https://example.com' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([chromeTarget, normalTarget]);

      await pool.getActiveTab();

      // The per-target client should connect to the normal page's WS URL
      const targetClient = mockClientInstances[1];
      expect(targetClient.wsUrl).toBe('ws://127.0.0.1:9222/devtools/page/page-1');
    });

    it('should fall back to chrome:// page when no regular pages exist', async () => {
      await pool.connectBrowser();

      const chromeTarget = makeHttpTarget({ id: 'chrome-1', url: 'chrome://newtab' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([chromeTarget]);

      const session = await pool.getActiveTab();
      expect(session).toBeInstanceOf(CdpSession);
    });

    it('should throw TabNotFoundError when no page targets exist', async () => {
      await pool.connectBrowser();

      const workerTarget = makeHttpTarget({
        id: 'worker-1',
        type: 'service_worker',
        url: 'chrome-extension://abc/sw.js',
      });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([workerTarget]);

      await expect(pool.getActiveTab()).rejects.toThrow(TabNotFoundError);
    });

    it('should throw TabNotFoundError when no targets at all', async () => {
      await pool.connectBrowser();

      vi.mocked(CdpClient.listTargets).mockResolvedValue([]);

      await expect(pool.getActiveTab()).rejects.toThrow(TabNotFoundError);
    });
  });

  describe('getExtensionWorker()', () => {
    it('should find service_worker by extensionId', async () => {
      await pool.connectBrowser();

      const workerTarget = makeHttpTarget({
        id: 'worker-1',
        type: 'service_worker',
        url: 'chrome-extension://abc123/service-worker.js',
      });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([workerTarget]);

      const session = await pool.getExtensionWorker('abc123');
      expect(session).toBeInstanceOf(CdpSession);
    });

    it('should find any extension service_worker when no extensionId given', async () => {
      await pool.connectBrowser();

      const workerTarget = makeHttpTarget({
        id: 'worker-1',
        type: 'service_worker',
        url: 'chrome-extension://xyz789/sw.js',
      });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([workerTarget]);

      const session = await pool.getExtensionWorker();
      expect(session).toBeInstanceOf(CdpSession);
    });

    it('should throw ExtensionNotFoundError when no workers found', async () => {
      await pool.connectBrowser();
      vi.mocked(CdpClient.listTargets).mockResolvedValue([]);

      await expect(pool.getExtensionWorker('nonexistent')).rejects.toThrow(ExtensionNotFoundError);
    });

    it('should throw with specific message for extensionId', async () => {
      await pool.connectBrowser();
      vi.mocked(CdpClient.listTargets).mockResolvedValue([]);

      await expect(pool.getExtensionWorker('abc123')).rejects.toThrow('Extension worker not found: abc123');
    });

    it('should throw with generic message when no extensionId', async () => {
      await pool.connectBrowser();
      vi.mocked(CdpClient.listTargets).mockResolvedValue([]);

      await expect(pool.getExtensionWorker()).rejects.toThrow('No extension workers found');
    });
  });

  describe('getPopupTab()', () => {
    it('should find extension popup page by extensionId', async () => {
      await pool.connectBrowser();

      const popupTarget = makeHttpTarget({
        id: 'popup-1',
        url: 'chrome-extension://abc123/popup.html',
      });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([popupTarget]);

      const session = await pool.getPopupTab('abc123');
      expect(session).toBeInstanceOf(CdpSession);
    });

    it('should find any extension popup when no extensionId given', async () => {
      await pool.connectBrowser();

      const popupTarget = makeHttpTarget({
        id: 'popup-1',
        url: 'chrome-extension://xyz789/popup.html',
      });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([popupTarget]);

      const session = await pool.getPopupTab();
      expect(session).toBeInstanceOf(CdpSession);
    });

    it('should throw ExtensionNotFoundError when no popups found', async () => {
      await pool.connectBrowser();
      vi.mocked(CdpClient.listTargets).mockResolvedValue([]);

      await expect(pool.getPopupTab('nonexistent')).rejects.toThrow(ExtensionNotFoundError);
    });

    it('should throw with specific message for extensionId', async () => {
      await pool.connectBrowser();
      vi.mocked(CdpClient.listTargets).mockResolvedValue([]);

      await expect(pool.getPopupTab('abc123')).rejects.toThrow('Extension popup not found: abc123');
    });

    it('should throw with generic message when no extensionId', async () => {
      await pool.connectBrowser();
      vi.mocked(CdpClient.listTargets).mockResolvedValue([]);

      await expect(pool.getPopupTab()).rejects.toThrow('No extension popups found');
    });
  });

  describe('releaseConnection()', () => {
    it('should close and remove cached session', async () => {
      await pool.connectBrowser();

      const pageTarget = makeHttpTarget({ id: 'page-1' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([pageTarget]);

      await pool.getConnection('page-1');
      pool.releaseConnection('page-1');

      // The per-target client should be closed
      const targetClient = mockClientInstances[1];
      expect(targetClient.close).toHaveBeenCalled();

      // Getting again should create a new connection
      await pool.getConnection('page-1');
      expect(CdpClient.listTargets).toHaveBeenCalledTimes(2);
    });

    it('should be safe to call for non-existent connection', () => {
      expect(() => pool.releaseConnection('nonexistent')).not.toThrow();
    });
  });

  describe('Target.targetDestroyed event', () => {
    it('should close and remove connection when target is destroyed', async () => {
      await pool.connectBrowser();

      const pageTarget = makeHttpTarget({ id: 'page-1' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([pageTarget]);

      await pool.getConnection('page-1');

      // Trigger targetDestroyed from browser client
      const browserClient = mockClientInstances[0];
      browserClient._triggerEvent('Target.targetDestroyed', { targetId: 'page-1' });

      // The per-target client should be closed
      const targetClient = mockClientInstances[1];
      expect(targetClient.close).toHaveBeenCalled();

      // Getting again should create a new connection
      await pool.getConnection('page-1');
      expect(mockClientInstances.length).toBe(3); // browser + original target + new target
    });

    it('should emit targetDestroyed event', async () => {
      await pool.connectBrowser();

      const eventPromise = new Promise<string>(resolve => {
        pool.on('targetDestroyed', resolve);
      });

      const browserClient = mockClientInstances[0];
      browserClient._triggerEvent('Target.targetDestroyed', { targetId: 'page-1' });

      const destroyedId = await eventPromise;
      expect(destroyedId).toBe('page-1');
    });
  });

  describe('closeAll()', () => {
    it('should close browser client and all connections', async () => {
      await pool.connectBrowser();

      const pageTarget = makeHttpTarget({ id: 'page-1' });
      vi.mocked(CdpClient.listTargets).mockResolvedValue([pageTarget]);
      await pool.getConnection('page-1');

      await pool.closeAll();

      const browserClient = mockClientInstances[0];
      const targetClient = mockClientInstances[1];
      expect(browserClient.close).toHaveBeenCalled();
      expect(targetClient.close).toHaveBeenCalled();
    });

    it('should be safe to call when not connected', async () => {
      await expect(pool.closeAll()).resolves.not.toThrow();
    });

    it('should make getBrowserClient throw after closeAll', async () => {
      await pool.connectBrowser();
      await pool.closeAll();

      expect(() => pool.getBrowserClient()).toThrow(CdpConnectionError);
    });
  });
});
