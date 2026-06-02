import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextRouter } from '../context-router.js';
import { ContextError } from '@cdp-mcp/shared';
import { CONTEXT_REQUIRED_MESSAGE } from '../context-types.js';

// Create a mock CdpClient
function createMockClient() {
  return {
    send: vi.fn(),
    connected: true,
  };
}

// Create a mock ConnectionPool
function createMockPool() {
  const mockClient = createMockClient();
  return {
    pool: {
      getActiveTab: vi.fn().mockResolvedValue(mockClient),
      getExtensionWorker: vi.fn().mockResolvedValue(mockClient),
      getPopupTab: vi.fn().mockResolvedValue(mockClient),
    },
    mockClient,
  };
}

describe('ContextRouter', () => {
  let router: ContextRouter;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockPool = createMockPool();
    router = new ContextRouter(mockPool.pool as any);
  });

  describe('page context', () => {
    it('evaluates in page context via getActiveTab', async () => {
      mockPool.mockClient.send.mockResolvedValue({
        result: { type: 'string', value: 'hello' },
      });

      const result = await router.evaluate('page', 'document.title');

      expect(mockPool.pool.getActiveTab).toHaveBeenCalled();
      expect(mockPool.mockClient.send).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
        awaitPromise: true,
      });
      expect(result.value).toBe('hello');
      expect(result.type).toBe('string');
    });
  });

  describe('content context', () => {
    it('creates isolated world and evaluates', async () => {
      mockPool.mockClient.send
        .mockResolvedValueOnce({ frameTree: { frame: { id: 'frame1' } } }) // Page.getFrameTree
        .mockResolvedValueOnce({ executionContextId: 42 }) // Page.createIsolatedWorld
        .mockResolvedValueOnce({ result: { type: 'string', value: 'test' } }); // Runtime.evaluate

      const result = await router.evaluate('content', 'chrome.storage.local.get("key")');

      expect(mockPool.mockClient.send).toHaveBeenCalledWith('Page.getFrameTree', {});
      expect(mockPool.mockClient.send).toHaveBeenCalledWith('Page.createIsolatedWorld', {
        frameId: 'frame1',
        worldName: 'cdp-mcp-content',
      });
      expect(mockPool.mockClient.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({
          contextId: 42,
        })
      );
      expect(result.value).toBe('test');
    });
  });

  describe('worker context', () => {
    it('evaluates via getExtensionWorker', async () => {
      mockPool.mockClient.send.mockResolvedValue({
        result: { type: 'object', value: { key: 'value' } },
      });

      const result = await router.evaluate('worker', 'chrome.storage.local.get("key")');

      expect(mockPool.pool.getExtensionWorker).toHaveBeenCalled();
      expect(result.value).toEqual({ key: 'value' });
    });
  });

  describe('popup context', () => {
    it('evaluates via getPopupTab', async () => {
      mockPool.mockClient.send.mockResolvedValue({
        result: { type: 'string', value: 'popup content' },
      });

      const result = await router.evaluate('popup', 'document.title');

      expect(mockPool.pool.getPopupTab).toHaveBeenCalled();
      expect(result.value).toBe('popup content');
    });
  });

  describe('error handling', () => {
    it('throws ContextError with guide message when context is missing', async () => {
      await expect(router.evaluate(undefined as any, 'code')).rejects.toThrow(ContextError);
      await expect(router.evaluate(undefined as any, 'code')).rejects.toThrow(
        CONTEXT_REQUIRED_MESSAGE
      );
    });

    it('throws ContextError for unknown context', async () => {
      await expect(router.evaluate('invalid' as any, 'code')).rejects.toThrow(ContextError);
    });

    it('returns exception details when evaluation throws', async () => {
      mockPool.mockClient.send.mockResolvedValue({
        result: { type: 'object', subtype: 'error' },
        exceptionDetails: {
          text: 'Uncaught Error',
          exception: { description: 'Error: test error' },
        },
      });

      const result = await router.evaluate('page', 'throw new Error("test")');
      expect(result.exceptionDetails).toBeDefined();
      expect(result.exceptionDetails!.text).toBe('Uncaught Error');
      expect(result.exceptionDetails!.exception?.description).toBe('Error: test error');
    });
  });

  describe('options', () => {
    it('defaults returnByValue to true', async () => {
      mockPool.mockClient.send.mockResolvedValue({ result: { type: 'string', value: 'x' } });
      await router.evaluate('page', 'code');
      expect(mockPool.mockClient.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({ returnByValue: true })
      );
    });

    it('defaults awaitPromise to true', async () => {
      mockPool.mockClient.send.mockResolvedValue({ result: { type: 'string', value: 'x' } });
      await router.evaluate('page', 'code');
      expect(mockPool.mockClient.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({ awaitPromise: true })
      );
    });

    it('respects custom options', async () => {
      mockPool.mockClient.send.mockResolvedValue({ result: { type: 'string', value: 'x' } });
      await router.evaluate('page', 'code', { returnByValue: false, awaitPromise: false });
      expect(mockPool.mockClient.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({ returnByValue: false, awaitPromise: false })
      );
    });
  });
});
