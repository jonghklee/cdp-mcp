import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerIdbTools } from '../idb-tools.js';

// --- Mock helpers ---

function createMockSession() {
  return {
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    connected: true,
  };
}

const MOCK_EXT_INFO = {
  id: 'abcdefghijklmnopqrstuvwxyz012345',
  name: 'Test Extension',
  title: 'Test',
  attached: true,
  serviceWorkerTargetId: 'sw-1',
};

function createMockExtensionManager(session: ReturnType<typeof createMockSession>) {
  return {
    attachToWorker: vi.fn().mockResolvedValue(session),
    listExtensions: vi.fn().mockResolvedValue([]),
    resolveExtension: vi.fn().mockResolvedValue(MOCK_EXT_INFO),
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

describe('idb-tools', () => {
  let mockSession: ReturnType<typeof createMockSession>;
  let mockExtMgr: ReturnType<typeof createMockExtensionManager>;
  let mockLazy: ReturnType<typeof createMockLazy>;
  let mockServer: ReturnType<typeof createMockServer>;

  const EXT_ID = 'abcdefghijklmnopqrstuvwxyz012345';

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = createMockSession();
    mockExtMgr = createMockExtensionManager(mockSession);
    mockLazy = createMockLazy(mockExtMgr);
    mockServer = createMockServer();
    registerIdbTools(mockServer as any, mockLazy as any);
  });

  it('registers cdp_ext_idb tool', () => {
    expect(mockServer._tools.has('cdp_ext_idb')).toBe(true);
  });

  describe('list_databases', () => {
    it('returns database list', async () => {
      const dbList = [
        { name: 'ChatLensDB', version: 3 },
        { name: 'PromptDB', version: 1 },
      ];
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: dbList },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'list_databases',
      });

      expect(res.isError).toBeUndefined();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.action).toBe('list_databases');
      expect(parsed.result).toEqual(dbList);

      // Verify Runtime.evaluate was called
      expect(mockSession.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({
          awaitPromise: true,
          returnByValue: true,
        })
      );
    });
  });

  describe('list_stores', () => {
    it('returns store list with indexes', async () => {
      const stores = [
        {
          name: 'prompts',
          keyPath: 'id',
          autoIncrement: false,
          indexes: [{ name: 'by_date', keyPath: 'createdAt', unique: false, multiEntry: false }],
        },
      ];
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: stores },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'list_stores',
        dbName: 'ChatLensDB',
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.result).toEqual(stores);
    });

    it('errors when dbName missing', async () => {
      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'list_stores',
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toContain('dbName is required');
    });
  });

  describe('query', () => {
    it('queries records with default limit/offset', async () => {
      const records = [
        { key: 1, primaryKey: 1, value: { id: 1, title: 'Hello' } },
        { key: 2, primaryKey: 2, value: { id: 2, title: 'World' } },
      ];
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: { records, total: 2, offset: 0, limit: 100 } },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'query',
        dbName: 'TestDB',
        storeName: 'items',
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.result.records).toHaveLength(2);
      expect(parsed.result.limit).toBe(100);
    });

    it('queries with index filter', async () => {
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: { records: [], total: 0, offset: 0, limit: 100 } },
      });

      await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'query',
        dbName: 'TestDB',
        storeName: 'items',
        indexName: 'by_category',
        indexValue: 'prompt',
      });

      // Check that the expression includes index access
      const expr = mockSession.send.mock.calls[0][1].expression;
      expect(expr).toContain('store.index(');
      expect(expr).toContain('IDBKeyRange.only(');
    });

    it('errors when storeName missing', async () => {
      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'query',
        dbName: 'TestDB',
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toContain('storeName is required');
    });
  });

  describe('count', () => {
    it('returns record count', async () => {
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: { count: 42 } },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'count',
        dbName: 'TestDB',
        storeName: 'items',
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.result.count).toBe(42);
    });
  });

  describe('get', () => {
    it('returns single record by key', async () => {
      const record = { id: 'abc', title: 'Test Prompt', content: 'Hello world' };
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: { value: record } },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'get',
        dbName: 'TestDB',
        storeName: 'prompts',
        key: 'abc',
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.result.value).toEqual(record);
    });

    it('errors when key missing', async () => {
      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'get',
        dbName: 'TestDB',
        storeName: 'items',
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toContain('key is required');
    });
  });

  describe('put', () => {
    it('puts record with auto key', async () => {
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: { success: true, key: 1 } },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'put',
        dbName: 'TestDB',
        storeName: 'items',
        value: { title: 'New Item', category: 'test' },
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.result.success).toBe(true);
    });

    it('puts record with explicit key', async () => {
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: { success: true, key: 'custom-key' } },
      });

      await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'put',
        dbName: 'TestDB',
        storeName: 'items',
        key: 'custom-key',
        value: { title: 'Keyed Item' },
      });

      // Check expression includes both value and key
      const expr = mockSession.send.mock.calls[0][1].expression;
      expect(expr).toContain('"custom-key"');
    });

    it('errors when value missing', async () => {
      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'put',
        dbName: 'TestDB',
        storeName: 'items',
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toContain('value is required');
    });
  });

  describe('delete', () => {
    it('deletes record by key', async () => {
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: { success: true } },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'delete',
        dbName: 'TestDB',
        storeName: 'items',
        key: 'abc',
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.result.success).toBe(true);
    });
  });

  describe('clear', () => {
    it('clears all records in store', async () => {
      mockSession.send.mockResolvedValue({
        result: { type: 'object', value: { success: true } },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'clear',
        dbName: 'TestDB',
        storeName: 'items',
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.result.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns error when Runtime.evaluate throws exception', async () => {
      mockSession.send.mockResolvedValue({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'Error: DB not found' },
        },
      });

      const res = await mockServer._call('cdp_ext_idb', {
        extension: EXT_ID,
        action: 'list_databases',
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toContain('DB not found');
    });

    it('returns error when extension not found', async () => {
      mockExtMgr.resolveExtension.mockRejectedValue(
        new Error('Extension not found: "invalid"')
      );

      const res = await mockServer._call('cdp_ext_idb', {
        extension: 'invalid',
        action: 'list_databases',
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toContain('Extension not found');
    });
  });
});
