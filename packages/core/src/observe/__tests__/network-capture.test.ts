import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startNetworkCapture,
  stopNetworkCapture,
  getNetworkRequests,
  waitForNetworkRequest,
  clearAllNetworkCaptures,
} from '../network-capture.js';

// ── Mock CdpSession ──

function createMockSession() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    connected: true,
    send: vi.fn().mockResolvedValue(undefined),
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return this;
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      const fns = handlers.get(event);
      if (fns) {
        for (const fn of fns) fn(...args);
      }
    },
    _handlers: handlers,
  };
}

type MockSession = ReturnType<typeof createMockSession>;

// ── Helpers ──

function emitRequest(session: MockSession, id: string, url: string, method = 'GET') {
  session.emit('Network.requestWillBeSent', {
    requestId: id,
    loaderId: 'loader-1',
    documentURL: url,
    request: { url, method, headers: {} },
    timestamp: Date.now() / 1000,
    wallTime: Date.now(),
    type: 'Fetch',
  });
}

function emitResponse(session: MockSession, id: string, url: string, status = 200, mimeType = 'application/json') {
  session.emit('Network.responseReceived', {
    requestId: id,
    loaderId: 'loader-1',
    timestamp: Date.now() / 1000 + 0.1,
    type: 'Fetch',
    response: { url, status, statusText: 'OK', headers: {}, mimeType },
  });
}

function emitFinished(session: MockSession, id: string) {
  session.emit('Network.loadingFinished', {
    requestId: id,
    timestamp: Date.now() / 1000 + 0.2,
    encodedDataLength: 100,
  });
}

function emitFailed(session: MockSession, id: string, errorText = 'net::ERR_FAILED') {
  session.emit('Network.loadingFailed', {
    requestId: id,
    timestamp: Date.now() / 1000 + 0.1,
    type: 'Fetch',
    errorText,
  });
}

// ── Tests ──

describe('network-capture', () => {
  let session: MockSession;

  beforeEach(() => {
    clearAllNetworkCaptures();
    session = createMockSession();
  });

  describe('startNetworkCapture', () => {
    it('enables Network and subscribes to events', async () => {
      const result = await startNetworkCapture(session as any, 'target-1');

      expect(result.captureId).toMatch(/^net_/);
      expect(result.targetId).toBe('target-1');
      expect(result.status).toBe('capturing');
      expect(session.send).toHaveBeenCalledWith('Network.enable');
      expect(session._handlers.get('Network.requestWillBeSent')?.size).toBe(1);
      expect(session._handlers.get('Network.responseReceived')?.size).toBe(1);
      expect(session._handlers.get('Network.loadingFinished')?.size).toBe(1);
      expect(session._handlers.get('Network.loadingFailed')?.size).toBe(1);
      expect(session._handlers.get('disconnected')?.size).toBe(1);
    });
  });

  describe('request capture', () => {
    it('captures a basic request', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://api.example.com/data');

      const { requests, total } = getNetworkRequests({ captureId });
      expect(total).toBe(1);
      expect(requests[0].url).toBe('https://api.example.com/data');
      expect(requests[0].method).toBe('GET');
      expect(requests[0].isComplete).toBe(false);
    });

    it('updates request with response', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://api.example.com/data');
      emitResponse(session, 'req-1', 'https://api.example.com/data', 200, 'application/json');

      const { requests } = getNetworkRequests({ captureId });
      expect(requests[0].responseStatus).toBe(200);
      expect(requests[0].responseMimeType).toBe('application/json');
    });

    it('marks request as complete on loadingFinished', async () => {
      // Mock getResponseBody
      session.send.mockImplementation(async (method: string) => {
        if (method === 'Network.getResponseBody') {
          return { body: '{"ok":true}', base64Encoded: false };
        }
        return undefined;
      });

      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://api.example.com/data');
      emitResponse(session, 'req-1', 'https://api.example.com/data');
      emitFinished(session, 'req-1');

      // Wait for async body capture
      await vi.waitFor(() => {
        const { requests } = getNetworkRequests({ captureId });
        expect(requests[0].isComplete).toBe(true);
        expect(requests[0].responseBody).toBe('{"ok":true}');
      });
    });

    it('marks request as failed with error', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://api.example.com/fail');
      emitFailed(session, 'req-1', 'net::ERR_CONNECTION_REFUSED');

      const { requests } = getNetworkRequests({ captureId });
      expect(requests[0].isComplete).toBe(true);
      expect(requests[0].error).toBe('net::ERR_CONNECTION_REFUSED');
    });

    it('detects SSE streams', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://api.example.com/stream');
      emitResponse(session, 'req-1', 'https://api.example.com/stream', 200, 'text/event-stream');

      const { requests } = getNetworkRequests({ captureId });
      expect(requests[0].isSSE).toBe(true);
    });

    it('detects ndjson as SSE', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://api.example.com/stream');
      emitResponse(session, 'req-1', 'https://api.example.com/stream', 200, 'application/x-ndjson');

      const { requests } = getNetworkRequests({ captureId });
      expect(requests[0].isSSE).toBe(true);
    });
  });

  describe('ring buffer', () => {
    it('evicts oldest when at capacity', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1', {
        maxRequests: 3,
      });

      for (let i = 0; i < 5; i++) {
        emitRequest(session, `req-${i}`, `https://example.com/${i}`);
      }

      const { requests, total } = getNetworkRequests({ captureId });
      expect(total).toBe(3);
      expect(requests[0].url).toContain('/2');
      expect(requests[2].url).toContain('/4');

      const result = stopNetworkCapture(captureId);
      expect(result.stats.dropped).toBe(2);
      expect(result.stats.total).toBe(5);
    });
  });

  describe('filters', () => {
    it('filters by domain', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1', {
        filterDomains: ['api.example.com'],
      });

      emitRequest(session, 'req-1', 'https://api.example.com/data');
      emitRequest(session, 'req-2', 'https://cdn.other.com/style.css');

      const { total } = getNetworkRequests({ captureId });
      expect(total).toBe(1);
    });

    it('filters by method', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1', {
        filterMethods: ['POST'],
      });

      emitRequest(session, 'req-1', 'https://example.com/get', 'GET');
      emitRequest(session, 'req-2', 'https://example.com/post', 'POST');

      const { total } = getNetworkRequests({ captureId });
      expect(total).toBe(1);
    });

    it('filters by resource type', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1', {
        filterResourceTypes: ['XHR'],
      });

      session.emit('Network.requestWillBeSent', {
        requestId: 'req-1',
        loaderId: 'l',
        documentURL: 'https://example.com',
        request: { url: 'https://example.com/api', method: 'GET', headers: {} },
        timestamp: 1,
        wallTime: 1,
        type: 'XHR',
      });
      session.emit('Network.requestWillBeSent', {
        requestId: 'req-2',
        loaderId: 'l',
        documentURL: 'https://example.com',
        request: { url: 'https://example.com/style.css', method: 'GET', headers: {} },
        timestamp: 2,
        wallTime: 2,
        type: 'Stylesheet',
      });

      const { total } = getNetworkRequests({ captureId });
      expect(total).toBe(1);
    });
  });

  describe('getNetworkRequests', () => {
    it('filters by urlPattern', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://example.com/api/users');
      emitRequest(session, 'req-2', 'https://example.com/api/posts');
      emitRequest(session, 'req-3', 'https://example.com/static/style.css');

      const { total } = getNetworkRequests({ captureId, urlPattern: '/api/' });
      expect(total).toBe(2);
    });

    it('filters by status range', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://example.com/ok');
      emitResponse(session, 'req-1', 'https://example.com/ok', 200);
      emitRequest(session, 'req-2', 'https://example.com/not-found');
      emitResponse(session, 'req-2', 'https://example.com/not-found', 404);

      const { total } = getNetworkRequests({ captureId, statusRange: '4xx' });
      expect(total).toBe(1);
    });

    it('sorts by latest', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      session.emit('Network.requestWillBeSent', {
        requestId: 'req-1', loaderId: 'l', documentURL: '',
        request: { url: 'https://example.com/first', method: 'GET', headers: {} },
        timestamp: 1, wallTime: 1,
      });
      session.emit('Network.requestWillBeSent', {
        requestId: 'req-2', loaderId: 'l', documentURL: '',
        request: { url: 'https://example.com/second', method: 'GET', headers: {} },
        timestamp: 2, wallTime: 2,
      });

      const { requests } = getNetworkRequests({ captureId, sort: 'latest' });
      expect(requests[0].url).toContain('/second');
    });

    it('applies limit', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      for (let i = 0; i < 10; i++) {
        emitRequest(session, `req-${i}`, `https://example.com/${i}`);
      }

      const { requests, total } = getNetworkRequests({ captureId, limit: 3 });
      expect(requests).toHaveLength(3);
      expect(total).toBe(10);
    });

    it('throws for unknown captureId', () => {
      expect(() => getNetworkRequests({ captureId: 'nonexistent' })).toThrow('Network capture not found');
    });
  });

  describe('waitForNetworkRequest', () => {
    it('resolves immediately when request already present', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://api.example.com/data');
      emitResponse(session, 'req-1', 'https://api.example.com/data');
      emitFinished(session, 'req-1');

      const result = await waitForNetworkRequest(captureId, '/data', { timeout: 1000 });
      expect(result.found).toBe(true);
      expect(result.request?.url).toContain('/data');
    });

    it('waits for request to appear', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      // Emit after a short delay
      setTimeout(() => {
        emitRequest(session, 'req-1', 'https://api.example.com/delayed');
        emitResponse(session, 'req-1', 'https://api.example.com/delayed');
        emitFinished(session, 'req-1');
      }, 150);

      const result = await waitForNetworkRequest(captureId, '/delayed', { timeout: 2000 });
      expect(result.found).toBe(true);
    });

    it('returns false on timeout', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      const result = await waitForNetworkRequest(captureId, '/nonexistent', { timeout: 200 });
      expect(result.found).toBe(false);
    });

    it('returns false for unknown captureId', async () => {
      const result = await waitForNetworkRequest('nonexistent', '/test', { timeout: 100 });
      expect(result.found).toBe(false);
    });

    it('waits for completion when onlyComplete=true', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      // Emit request without finishing
      emitRequest(session, 'req-1', 'https://api.example.com/slow');

      // Complete after delay
      setTimeout(() => {
        emitResponse(session, 'req-1', 'https://api.example.com/slow');
        emitFinished(session, 'req-1');
      }, 150);

      const result = await waitForNetworkRequest(captureId, '/slow', { timeout: 2000, onlyComplete: true });
      expect(result.found).toBe(true);
      expect(result.request?.isComplete).toBe(true);
    });
  });

  describe('stopNetworkCapture', () => {
    it('returns all requests and cleans up', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://example.com/a');
      emitResponse(session, 'req-1', 'https://example.com/a');
      emitFinished(session, 'req-1');

      const result = stopNetworkCapture(captureId);
      expect(result.requests).toHaveLength(1);
      expect(result.stats.completed).toBe(1);

      // Handlers removed
      expect(session._handlers.get('Network.requestWillBeSent')?.size ?? 0).toBe(0);
      expect(session._handlers.get('Network.responseReceived')?.size ?? 0).toBe(0);

      // Cannot query again
      expect(() => getNetworkRequests({ captureId })).toThrow('Network capture not found');
    });

    it('throws for unknown captureId', () => {
      expect(() => stopNetworkCapture('nonexistent')).toThrow('Network capture not found');
    });
  });

  describe('disconnect', () => {
    it('stops capturing on disconnect', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      session.emit('disconnected');

      // New events should be ignored
      emitRequest(session, 'req-1', 'https://example.com/after');

      const { total } = getNetworkRequests({ captureId });
      expect(total).toBe(0);
    });
  });

  describe('clearAllNetworkCaptures', () => {
    it('clears all captures', async () => {
      const r1 = await startNetworkCapture(session as any, 'target-1');
      await startNetworkCapture(session as any, 'target-2');

      clearAllNetworkCaptures();

      expect(() => getNetworkRequests({ captureId: r1.captureId })).toThrow('Network capture not found');
    });
  });

  describe('body capture', () => {
    it('skips body when captureBody=false', async () => {
      const { captureId } = await startNetworkCapture(session as any, 'target-1', {
        captureBody: false,
      });

      emitRequest(session, 'req-1', 'https://example.com/data');
      emitResponse(session, 'req-1', 'https://example.com/data');
      emitFinished(session, 'req-1');

      const { requests } = getNetworkRequests({ captureId });
      expect(requests[0].isComplete).toBe(true);
      // Network.getResponseBody should not be called
      expect(session.send).not.toHaveBeenCalledWith('Network.getResponseBody', expect.anything());
    });

    it('handles body capture failure gracefully', async () => {
      session.send.mockImplementation(async (method: string) => {
        if (method === 'Network.getResponseBody') {
          throw new Error('No resource with given identifier found');
        }
        return undefined;
      });

      const { captureId } = await startNetworkCapture(session as any, 'target-1');

      emitRequest(session, 'req-1', 'https://example.com/data');
      emitResponse(session, 'req-1', 'https://example.com/data');
      emitFinished(session, 'req-1');

      await vi.waitFor(() => {
        const { requests } = getNetworkRequests({ captureId });
        expect(requests[0].responseBody).toBeNull();
      });
    });
  });
});
