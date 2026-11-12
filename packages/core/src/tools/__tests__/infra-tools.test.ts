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

  it('registers cdp_ext_attach and cdp_sync_profile tools', () => {
    expect(mockServer._tools.has('cdp_ext_attach')).toBe(true);
    expect(mockServer._tools.has('cdp_sync_profile')).toBe(true);
  });

});
