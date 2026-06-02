import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock node:fs before importing the module
vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('// bridge code\nglobalThis.__qaqcBridge = { manifest: {}, execute: () => {} };'),
}));

import { readFileSync } from 'node:fs';
import { registerQaqcTools, _resetBridgeCache } from '../qaqc-tools.js';

// --- Mock helpers ---

const TEST_EXT_ID = 'abcdefghijklmnopqrstuvwxyz012345';
const TEST_EXT_INFO = { id: TEST_EXT_ID, name: 'Test Extension', title: 'Test', attached: true };

function createMockSession() {
  return {
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    connected: true,
  };
}

function createMockExtensionManager(session: ReturnType<typeof createMockSession>) {
  return {
    attachToWorker: vi.fn().mockResolvedValue(session),
    listExtensions: vi.fn().mockResolvedValue([]),
    resolveExtension: vi.fn().mockResolvedValue(TEST_EXT_INFO),
  };
}

function createMockLazy(extensionManager: ReturnType<typeof createMockExtensionManager>) {
  return {
    ensure: vi.fn().mockResolvedValue({
      pool: {},
      router: {},
      tabManager: {},
      extensionManager,
    }),
    chromeManager: {},
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

describe('qaqc-tools', () => {
  let mockSession: ReturnType<typeof createMockSession>;
  let mockExtMgr: ReturnType<typeof createMockExtensionManager>;
  let mockLazy: ReturnType<typeof createMockLazy>;
  let mockServer: ReturnType<typeof createMockServer>;

  const TEST_BRIDGE_PATH = '/path/to/qaqc-bridge.js';
  const TEST_MANIFEST = {
    name: 'test-extension',
    version: '1.0.0',
    commands: [
      { name: 'get_data', description: 'Get data', params: {} },
      { name: 'set_config', description: 'Set config', params: { key: 'string', value: 'string' } },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetBridgeCache();

    mockSession = createMockSession();
    mockExtMgr = createMockExtensionManager(mockSession);
    mockLazy = createMockLazy(mockExtMgr);
    mockServer = createMockServer();

    registerQaqcTools(mockServer as any, mockLazy as any);
  });

  describe('ext_qaqc_list', () => {
    it('registers both tools', () => {
      expect(mockServer._tools.has('ext_qaqc_list')).toBe(true);
      expect(mockServer._tools.has('ext_qaqc_invoke')).toBe(true);
    });

    it('injects bridge and returns manifest when bridgePath is provided', async () => {
      // Runtime.evaluate for injection (returns void-like)
      mockSession.send.mockResolvedValueOnce({ result: { type: 'undefined' } });
      // Runtime.evaluate for getManifest
      mockSession.send.mockResolvedValueOnce({ result: { type: 'object', value: TEST_MANIFEST } });

      const result = await mockServer._call('ext_qaqc_list', {
        extension: TEST_EXT_ID,
        bridgePath: TEST_BRIDGE_PATH,
      });

      // Should read bridge file
      expect(readFileSync).toHaveBeenCalledWith(TEST_BRIDGE_PATH, 'utf-8');

      // Should inject via Runtime.evaluate
      expect(mockExtMgr.attachToWorker).toHaveBeenCalledWith(TEST_EXT_ID);
      expect(mockSession.send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({
        awaitPromise: true,
        returnByValue: false,
      }));

      // Should return manifest with extension info
      const content = JSON.parse(result.content[0].text);
      expect(content.manifest).toEqual(TEST_MANIFEST);
      expect(content.injected).toBe(true);
      expect(content.extension.id).toBe(TEST_EXT_ID);
      expect(content.extension.name).toBe('Test Extension');
    });

    it('uses cache and returns manifest when already injected', async () => {
      // First call: inject
      mockSession.send
        .mockResolvedValueOnce({ result: { type: 'undefined' } }) // inject
        .mockResolvedValueOnce({ result: { type: 'object', value: TEST_MANIFEST } }); // manifest

      await mockServer._call('ext_qaqc_list', {
        extension: TEST_EXT_ID,
        bridgePath: TEST_BRIDGE_PATH,
      });

      vi.clearAllMocks();

      // Re-setup resolveExtension mock after clearAllMocks
      mockExtMgr.resolveExtension.mockResolvedValue(TEST_EXT_INFO);
      mockExtMgr.attachToWorker.mockResolvedValue(mockSession);

      // Second call: no bridgePath → use cache
      mockSession.send
        .mockResolvedValueOnce({ result: { type: 'boolean', value: true } }) // bridge exists check
        .mockResolvedValueOnce({ result: { type: 'object', value: TEST_MANIFEST } }); // manifest

      const result = await mockServer._call('ext_qaqc_list', {
        extension: TEST_EXT_ID,
      });

      // Should NOT read file again
      expect(readFileSync).not.toHaveBeenCalled();

      // Should check bridge existence
      expect(mockSession.send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({
        expression: 'typeof globalThis.__qaqcBridge !== "undefined"',
        returnByValue: true,
      }));

      const content = JSON.parse(result.content[0].text);
      expect(content.manifest).toEqual(TEST_MANIFEST);
      expect(content.injected).toBe(true);
    });

    it('re-injects bridge when it has disappeared from SW', async () => {
      // First call: inject
      mockSession.send
        .mockResolvedValueOnce({ result: { type: 'undefined' } }) // inject
        .mockResolvedValueOnce({ result: { type: 'object', value: TEST_MANIFEST } }); // manifest

      await mockServer._call('ext_qaqc_list', {
        extension: TEST_EXT_ID,
        bridgePath: TEST_BRIDGE_PATH,
      });

      vi.clearAllMocks();
      mockExtMgr.resolveExtension.mockResolvedValue(TEST_EXT_INFO);
      mockExtMgr.attachToWorker.mockResolvedValue(mockSession);

      // Second call: bridge missing → re-inject
      mockSession.send
        .mockResolvedValueOnce({ result: { type: 'boolean', value: false } }) // bridge NOT exists
        .mockResolvedValueOnce({ result: { type: 'undefined' } }) // re-inject
        .mockResolvedValueOnce({ result: { type: 'object', value: TEST_MANIFEST } }); // manifest

      const result = await mockServer._call('ext_qaqc_list', {
        extension: TEST_EXT_ID,
      });

      // Should read file for re-injection
      expect(readFileSync).toHaveBeenCalledWith(TEST_BRIDGE_PATH, 'utf-8');

      const content = JSON.parse(result.content[0].text);
      expect(content.manifest).toEqual(TEST_MANIFEST);
    });

    it('returns error when extension resolved but bridge not registered', async () => {
      // resolveExtension succeeds but no bridge registered for this extension
      const otherExt = { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', name: 'Other', title: 'Other', attached: true };
      mockExtMgr.resolveExtension.mockResolvedValue(otherExt);

      const result = await mockServer._call('ext_qaqc_list', {
        extension: 'Other',
      });

      expect(result.isError).toBe(true);
      const content = JSON.parse(result.content[0].text);
      expect(content.error).toContain('Bridge not registered');
    });
  });

  describe('ext_qaqc_invoke', () => {
    // Helper: register bridge first
    async function registerBridge() {
      mockSession.send
        .mockResolvedValueOnce({ result: { type: 'undefined' } }) // inject
        .mockResolvedValueOnce({ result: { type: 'object', value: TEST_MANIFEST } }); // manifest

      await mockServer._call('ext_qaqc_list', {
        extension: TEST_EXT_ID,
        bridgePath: TEST_BRIDGE_PATH,
      });

      vi.clearAllMocks();
      mockExtMgr.resolveExtension.mockResolvedValue(TEST_EXT_INFO);
      mockExtMgr.attachToWorker.mockResolvedValue(mockSession);
    }

    it('executes command and returns result', async () => {
      await registerBridge();

      // ensureBridge check
      mockSession.send.mockResolvedValueOnce({ result: { type: 'boolean', value: true } });
      // execute
      mockSession.send.mockResolvedValueOnce({
        result: { type: 'object', value: { conversations: [{ id: 1 }] } },
      });

      const result = await mockServer._call('ext_qaqc_invoke', {
        extension: TEST_EXT_ID,
        command: 'get_data',
        params: { limit: 10 },
      });

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.result).toEqual({ conversations: [{ id: 1 }] });
      expect(content.extension.id).toBe(TEST_EXT_ID);

      // Verify execute expression
      expect(mockSession.send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({
        expression: expect.stringContaining('globalThis.__qaqcBridge.execute'),
        awaitPromise: true,
        returnByValue: true,
      }));
    });

    it('returns error when extension resolved but bridge not registered', async () => {
      const otherExt = { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', name: 'Other', title: 'Other', attached: true };
      mockExtMgr.resolveExtension.mockResolvedValue(otherExt);

      const result = await mockServer._call('ext_qaqc_invoke', {
        extension: 'Other',
        command: 'get_data',
      });

      expect(result.isError).toBe(true);
      const content = JSON.parse(result.content[0].text);
      expect(content.error).toContain('Bridge not registered');
    });

    it('re-injects bridge if missing then executes', async () => {
      await registerBridge();

      // ensureBridge → bridge missing
      mockSession.send.mockResolvedValueOnce({ result: { type: 'boolean', value: false } });
      // re-inject
      mockSession.send.mockResolvedValueOnce({ result: { type: 'undefined' } });
      // execute
      mockSession.send.mockResolvedValueOnce({
        result: { type: 'string', value: 'ok' },
      });

      const result = await mockServer._call('ext_qaqc_invoke', {
        extension: TEST_EXT_ID,
        command: 'set_config',
        params: { key: 'theme', value: 'dark' },
      });

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.result).toBe('ok');

      // Verify re-injection happened
      expect(readFileSync).toHaveBeenCalledWith(TEST_BRIDGE_PATH, 'utf-8');
    });

    it('returns error when bridge execute throws', async () => {
      await registerBridge();

      // ensureBridge check
      mockSession.send.mockResolvedValueOnce({ result: { type: 'boolean', value: true } });
      // execute → exception
      mockSession.send.mockResolvedValueOnce({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught Error',
          exception: { description: 'Error: Command not found: bad_cmd' },
        },
      });

      const result = await mockServer._call('ext_qaqc_invoke', {
        extension: TEST_EXT_ID,
        command: 'bad_cmd',
      });

      expect(result.isError).toBe(true);
      const content = JSON.parse(result.content[0].text);
      expect(content.error).toContain('Command not found');
    });

    it('uses default empty params when params not provided', async () => {
      await registerBridge();

      mockSession.send.mockResolvedValueOnce({ result: { type: 'boolean', value: true } });
      mockSession.send.mockResolvedValueOnce({
        result: { type: 'object', value: { count: 5 } },
      });

      await mockServer._call('ext_qaqc_invoke', {
        extension: TEST_EXT_ID,
        command: 'get_data',
      });

      // Verify params defaults to {}
      const evalCall = mockSession.send.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'object' && (c[1] as Record<string, unknown>).expression?.toString().includes('execute')
      );
      expect(evalCall).toBeDefined();
      expect(evalCall![1].expression).toContain('{}');
    });
  });
});
