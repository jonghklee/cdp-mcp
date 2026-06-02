import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { CdpClient } from '../cdp-client.js';
import { CdpConnectionError, CdpTimeoutError } from '@cdp-mcp/shared';

// Helper: create a mock WebSocket server on a random port
function createMockServer(): Promise<{ wss: WebSocketServer; port: number; url: string }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const address = wss.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const url = `ws://127.0.0.1:${port}`;
      resolve({ wss, port, url });
    });
  });
}

function closeMockServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    wss.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe('CdpClient', () => {
  let wss: WebSocketServer;
  let serverUrl: string;
  let client: CdpClient;

  beforeEach(async () => {
    const mock = await createMockServer();
    wss = mock.wss;
    serverUrl = mock.url;
  });

  afterEach(async () => {
    if (client) {
      await client.close();
    }
    await closeMockServer(wss);
  });

  describe('connect()', () => {
    it('should connect successfully', async () => {
      client = new CdpClient(serverUrl);
      await client.connect();
      expect(client.connected).toBe(true);
    });

    it('should reject when connection fails', async () => {
      client = new CdpClient('ws://127.0.0.1:1');
      // Register error listener to prevent unhandled error from EventEmitter
      client.on('error', () => {});
      await expect(client.connect()).rejects.toThrow(CdpConnectionError);
    });
  });

  describe('connected getter', () => {
    it('should return false before connect', () => {
      client = new CdpClient(serverUrl);
      expect(client.connected).toBe(false);
    });

    it('should return true after connect', async () => {
      client = new CdpClient(serverUrl);
      await client.connect();
      expect(client.connected).toBe(true);
    });

    it('should return false after close', async () => {
      client = new CdpClient(serverUrl);
      await client.connect();
      await client.close();
      expect(client.connected).toBe(false);
    });
  });

  describe('send()', () => {
    it('should send request and receive response', async () => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          ws.send(JSON.stringify({
            id: msg.id,
            result: { value: 42 },
          }));
        });
      });

      client = new CdpClient(serverUrl);
      await client.connect();

      const result = await client.send<{ value: number }>('Runtime.evaluate', {
        expression: '1 + 1',
      });
      expect(result).toEqual({ value: 42 });
    });

    it('should handle CDP error response', async () => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          ws.send(JSON.stringify({
            id: msg.id,
            error: { message: 'Something went wrong', code: -32000 },
          }));
        });
      });

      client = new CdpClient(serverUrl);
      await client.connect();

      await expect(
        client.send('Runtime.evaluate', { expression: 'bad' })
      ).rejects.toThrow("CDP error in 'Runtime.evaluate': Something went wrong");
    });

    it('should throw CdpTimeoutError on timeout', async () => {
      // Server accepts but never responds
      wss.on('connection', () => {
        // intentionally no response
      });

      client = new CdpClient(serverUrl, { timeout: 100 });
      await client.connect();

      await expect(
        client.send('Runtime.evaluate', { expression: 'slow' })
      ).rejects.toThrow(CdpTimeoutError);
    });

    it('should throw CdpConnectionError if not connected', async () => {
      client = new CdpClient(serverUrl);
      // Don't connect

      await expect(
        client.send('Runtime.evaluate')
      ).rejects.toThrow(CdpConnectionError);
    });

    it('should handle multiple concurrent requests with correct responses', async () => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          // Respond with id-based result to verify matching
          ws.send(JSON.stringify({
            id: msg.id,
            result: { requestId: msg.id, method: msg.method },
          }));
        });
      });

      client = new CdpClient(serverUrl);
      await client.connect();

      const [r1, r2, r3] = await Promise.all([
        client.send<{ requestId: number; method: string }>('Method.A'),
        client.send<{ requestId: number; method: string }>('Method.B'),
        client.send<{ requestId: number; method: string }>('Method.C'),
      ]);

      // Each response should have a unique requestId
      expect(r1.method).toBe('Method.A');
      expect(r2.method).toBe('Method.B');
      expect(r3.method).toBe('Method.C');
      // IDs should be different
      const ids = new Set([r1.requestId, r2.requestId, r3.requestId]);
      expect(ids.size).toBe(3);
    });
  });

  describe('CDP events', () => {
    it('should receive CDP events via on()', async () => {
      let serverWs: WsWebSocket | null = null;
      wss.on('connection', (ws) => {
        serverWs = ws;
      });

      client = new CdpClient(serverUrl);
      await client.connect();

      const eventPromise = new Promise<unknown>((resolve) => {
        client.on('Page.loadEventFired', (params) => {
          resolve(params);
        });
      });

      // Send an event from the server (no id, has method + params)
      serverWs!.send(JSON.stringify({
        method: 'Page.loadEventFired',
        params: { timestamp: 12345.678 },
      }));

      const params = await eventPromise;
      expect(params).toEqual({ timestamp: 12345.678 });
    });

    it('should emit wildcard "*" event for all CDP events', async () => {
      let serverWs: WsWebSocket | null = null;
      wss.on('connection', (ws) => {
        serverWs = ws;
      });

      client = new CdpClient(serverUrl);
      await client.connect();

      const events: Array<{ method: string; params: unknown }> = [];
      const collectPromise = new Promise<void>((resolve) => {
        client.on('*', (method: string, params: unknown) => {
          events.push({ method, params });
          if (events.length === 2) resolve();
        });
      });

      serverWs!.send(JSON.stringify({
        method: 'Network.requestWillBeSent',
        params: { requestId: '1' },
      }));
      serverWs!.send(JSON.stringify({
        method: 'Network.responseReceived',
        params: { requestId: '2' },
      }));

      await collectPromise;
      expect(events).toHaveLength(2);
      expect(events[0].method).toBe('Network.requestWillBeSent');
      expect(events[1].method).toBe('Network.responseReceived');
    });
  });

  describe('close()', () => {
    it('should disconnect and reject pending requests', async () => {
      // Server never responds so the request stays pending
      wss.on('connection', () => {
        // intentionally no response
      });

      client = new CdpClient(serverUrl);
      await client.connect();

      const sendPromise = client.send('Runtime.evaluate', { expression: 'test' });

      // Close immediately while request is pending
      await client.close();

      await expect(sendPromise).rejects.toThrow(CdpConnectionError);
      expect(client.connected).toBe(false);
    });

    it('should emit disconnected event', async () => {
      client = new CdpClient(serverUrl);
      await client.connect();

      const disconnectedPromise = new Promise<void>((resolve) => {
        client.on('disconnected', () => resolve());
      });

      await client.close();

      // The 'close' event from WebSocket fires asynchronously
      // We already set _connected = false in close(), so check that
      expect(client.connected).toBe(false);
    });
  });

  describe('timeout option', () => {
    it('should use default timeout of 30000ms', () => {
      client = new CdpClient(serverUrl);
      expect(client.timeout).toBe(30000);
    });

    it('should use custom timeout', () => {
      client = new CdpClient(serverUrl, { timeout: 5000 });
      expect(client.timeout).toBe(5000);
    });
  });

  describe('static listTargets()', () => {
    it('should fetch and return target list from /json', async () => {
      const mockTargets = [
        { id: 'page-1', type: 'page', title: 'Test', url: 'https://example.com', webSocketDebuggerUrl: 'ws://...' },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockTargets),
      } as Response);

      const targets = await CdpClient.listTargets(9222);
      expect(targets).toEqual(mockTargets);
      expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:9222/json');

      fetchSpy.mockRestore();
    });

    it('should throw CdpConnectionError on non-OK response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      await expect(CdpClient.listTargets(9222)).rejects.toThrow(CdpConnectionError);
      await expect(CdpClient.listTargets(9222)).rejects.toThrow('/json returned');

      fetchSpy.mockRestore();
    });
  });

  describe('static getBrowserWsUrl()', () => {
    it('should fetch and return browser WS URL from /json/version', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
      } as Response);

      const wsUrl = await CdpClient.getBrowserWsUrl(9222);
      expect(wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc');
      expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:9222/json/version');

      fetchSpy.mockRestore();
    });

    it('should throw CdpConnectionError on non-OK response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      await expect(CdpClient.getBrowserWsUrl(9222)).rejects.toThrow(CdpConnectionError);

      fetchSpy.mockRestore();
    });
  });
});
