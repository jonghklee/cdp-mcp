import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerInfraTools } from '../infra-tools.js';

// --- Mock helpers ---

function createMockPool() {
  return {
    closeAll: vi.fn().mockResolvedValue(undefined),
    connectBrowser: vi.fn().mockResolvedValue(undefined),
    getBrowserClient: vi.fn().mockReturnValue({ connected: true, send: vi.fn() }),
  };
}

function createMockChromeManager() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue('ws://127.0.0.1:9222/devtools/browser/xxx'),
    launch: vi.fn().mockResolvedValue({ port: 9222, wsUrl: 'ws://...' }),
    getSessionId: vi.fn().mockReturnValue('test-session'),
  };
}

function createMockLazy() {
  const pool = createMockPool();
  const chromeManager = createMockChromeManager();
  let port: number | null = 9222;
  let targetPort: number | null = null;
  let disconnected = false;

  return {
    ensure: vi.fn().mockResolvedValue({
      pool,
      router: {},
      tabManager: {},
      extensionManager: {
        findExtension: vi.fn().mockResolvedValue(null),
        resolveExtension: vi.fn().mockResolvedValue({
          id: 'abcdefghijklmnopqrstuvwxyz012345',
          name: 'Test Extension',
          title: 'Test',
          attached: true,
          serviceWorkerTargetId: 'sw-1',
        }),
        attachToWorker: vi.fn(),
      },
    }),
    getPort: vi.fn(() => disconnected ? null : port),
    disconnect: vi.fn(async () => {
      disconnected = true;
    }),
    softDisconnect: vi.fn(async () => {
      disconnected = true;
    }),
    setTargetPort: vi.fn((p: number | null) => {
      targetPort = p;
    }),
    chromeManager,
    _pool: pool,
    _getTargetPort: () => targetPort,
    _setPort: (p: number | null) => { port = p; disconnected = false; },
  };
}

function createMockServer() {
  const tools = new Map<string, { description: string; schema: unknown; handler: Function }>();
  return {
    tool: vi.fn().mockImplementation(
      (name: string, description: string, schema: unknown, handler: Function) => {
        tools.set(name, { description, schema, handler });
      }
    ),
    _tools: tools,
    _call: async (name: string, params: Record<string, unknown>) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
  };
}

// --- Tests ---

describe('infra-tools', () => {
  let mockLazy: ReturnType<typeof createMockLazy>;
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLazy = createMockLazy();
    mockServer = createMockServer();
    registerInfraTools(mockServer as any, mockLazy as any);
  });

  it('registers cdp_ext_attach and cdp_reconnect tools', () => {
    expect(mockServer._tools.has('cdp_ext_attach')).toBe(true);
    expect(mockServer._tools.has('cdp_reconnect')).toBe(true);
  });

  describe('cdp_reconnect', () => {
    it('calls disconnect() and ensure() with killChrome=true (default)', async () => {
      const result = await mockServer._call('cdp_reconnect', { killChrome: true });

      expect(mockLazy.disconnect).toHaveBeenCalledOnce();
      expect(mockLazy.softDisconnect).not.toHaveBeenCalled();
      expect(mockLazy.ensure).toHaveBeenCalledOnce();

      const content = JSON.parse(result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.killChrome).toBe(true);
    });

    it('calls softDisconnect() when killChrome=false', async () => {
      const result = await mockServer._call('cdp_reconnect', { killChrome: false });

      expect(mockLazy.softDisconnect).toHaveBeenCalledOnce();
      expect(mockLazy.disconnect).not.toHaveBeenCalled();
      expect(mockLazy.ensure).toHaveBeenCalledOnce();

      const content = JSON.parse(result.content[0].text);
      expect(content.killChrome).toBe(false);
    });

    it('sets targetPort when port is specified', async () => {
      const result = await mockServer._call('cdp_reconnect', { port: 9333, killChrome: true, confirm: true });

      expect(mockLazy.setTargetPort).toHaveBeenCalledWith(9333);
      expect(mockLazy.disconnect).toHaveBeenCalledOnce();
      expect(mockLazy.ensure).toHaveBeenCalledOnce();

      const content = JSON.parse(result.content[0].text);
      expect(content.targetPortRequested).toBe(9333);
    });

    it('does not set targetPort when port is not specified', async () => {
      await mockServer._call('cdp_reconnect', { killChrome: true });

      expect(mockLazy.setTargetPort).not.toHaveBeenCalled();
    });

    it('returns previousPort and newPort in response', async () => {
      mockLazy._setPort(9222);
      // After disconnect, getPort returns null until ensure sets it again
      // But our mock: first call returns 9222, after disconnect returns null
      // After ensure, the lazy mock still returns null (disconnected state)
      // We need to simulate the ensure restoring the port
      let callCount = 0;
      mockLazy.getPort.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 9222 : 9333;
      });

      const result = await mockServer._call('cdp_reconnect', { port: 9333, killChrome: true, confirm: true });

      const content = JSON.parse(result.content[0].text);
      expect(content.previousPort).toBe(9222);
      expect(content.newPort).toBe(9333);
    });

    it('calls disconnect → setTargetPort → ensure in correct order', async () => {
      const callOrder: string[] = [];
      mockLazy.disconnect.mockImplementation(async () => { callOrder.push('disconnect'); });
      mockLazy.setTargetPort.mockImplementation(() => { callOrder.push('setTargetPort'); });
      mockLazy.ensure.mockImplementation(async () => {
        callOrder.push('ensure');
        return { pool: {}, router: {}, tabManager: {}, extensionManager: {} };
      });

      await mockServer._call('cdp_reconnect', { port: 9333, killChrome: true, confirm: true });

      expect(callOrder).toEqual(['disconnect', 'setTargetPort', 'ensure']);
    });

    it('refreshProfile=true forces disconnect and refreshes profile', async () => {
      // Mock the dynamic import of ChromeManager
      const mockRefresh = vi.fn().mockReturnValue({ deleted: true, copied: true });
      vi.doMock('../../infra/chrome-pool.js', () => ({
        ChromeManager: vi.fn().mockImplementation(() => ({
          refreshProfile: mockRefresh,
        })),
      }));

      const result = await mockServer._call('cdp_reconnect', { refreshProfile: true });

      // refreshProfile forces disconnect (not softDisconnect)
      expect(mockLazy.disconnect).toHaveBeenCalledOnce();
      expect(mockLazy.softDisconnect).not.toHaveBeenCalled();
      expect(mockLazy.ensure).toHaveBeenCalledOnce();

      const content = JSON.parse(result.content[0].text);
      expect(content.killChrome).toBe(true);
      expect(content.refreshProfile).toEqual({ deleted: true, copied: true });

      vi.doUnmock('../../infra/chrome-pool.js');
    });
  });
});
