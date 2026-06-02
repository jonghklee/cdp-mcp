import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { CdpConnectionError, CdpTimeoutError } from '@cdp-mcp/shared';
import { createLogger } from '@cdp-mcp/shared';
import type { TargetInfoHttp } from './protocol-types.js';

const logger = createLogger('cdp-client');

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpClientOptions {
  timeout?: number;       // default 30000ms
  autoReconnect?: boolean; // default false
}

export class CdpClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pending = new Map<number, PendingRequest>();
  private _connected = false;
  private consecutiveTimeouts = 0;
  private static readonly MAX_CONSECUTIVE_TIMEOUTS = 3;

  constructor(
    private readonly wsUrl: string,
    private readonly options: CdpClientOptions = {}
  ) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  get timeout(): number {
    return this.options.timeout ?? 30000;
  }

  /** HTTP /json 으로 target 목록 조회 */
  static async listTargets(port: number): Promise<TargetInfoHttp[]> {
    const resp = await fetch(`http://127.0.0.1:${port}/json`);
    if (!resp.ok) throw new CdpConnectionError(`/json returned ${resp.status}`);
    return resp.json();
  }

  /** HTTP /json/version 으로 브라우저 WS URL 조회 */
  static async getBrowserWsUrl(port: number): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!resp.ok) throw new CdpConnectionError(`/json/version returned ${resp.status}`);
    const data = await resp.json();
    return data.webSocketDebuggerUrl;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        reject(new CdpConnectionError(`Failed to create WebSocket: ${err}`));
        return;
      }

      this.ws.on('open', () => {
        this._connected = true;
        logger.info(`Connected to ${this.wsUrl}`);
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', () => {
        this._connected = false;
        this.rejectAllPending(new CdpConnectionError('WebSocket closed'));
        this.emit('disconnected');
        logger.info('WebSocket disconnected');
      });

      this.ws.on('error', (err: Error) => {
        if (!this._connected) {
          reject(new CdpConnectionError(`WebSocket connection failed: ${err.message}`));
        }
        this.emit('error', err);
      });
    });
  }

  /**
   * Send a CDP command directly on this WebSocket connection.
   */
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || !this._connected) {
      throw new CdpConnectionError('Not connected');
    }

    const id = ++this.messageId;
    const wire: Record<string, unknown> = { id, method };
    if (params) wire.params = params;

    const message = JSON.stringify(wire);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.consecutiveTimeouts++;
        logger.warn(`CDP timeout #${this.consecutiveTimeouts}: '${method}' after ${this.timeout}ms`);
        if (this.consecutiveTimeouts >= CdpClient.MAX_CONSECUTIVE_TIMEOUTS) {
          logger.warn(`${this.consecutiveTimeouts} consecutive timeouts, force-closing WebSocket`);
          this.forceClose();
        }
        reject(new CdpTimeoutError(`CDP request '${method}' timed out after ${this.timeout}ms`, this.timeout));
      }, this.timeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
        timer,
      });

      this.ws!.send(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new CdpConnectionError(`Failed to send: ${err.message}`));
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.rejectAllPending(new CdpConnectionError('Client closed'));
      this.ws.close();
      this.ws = null;
      this._connected = false;
      this.consecutiveTimeouts = 0;
    }
  }

  /**
   * 연속 timeout 시 WebSocket을 강제로 끊어 재연결을 유도한다.
   */
  private forceClose(): void {
    if (this.ws) {
      this.rejectAllPending(new CdpConnectionError('Force closed due to consecutive timeouts'));
      this.ws.terminate(); // close()보다 즉시 끊김
      this.ws = null;
      this._connected = false;
      this.consecutiveTimeouts = 0;
      this.emit('disconnected');
    }
  }

  private handleMessage(raw: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string; code?: number; data?: unknown };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn('Failed to parse CDP message', raw);
      return;
    }

    // Response to a request
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        this.consecutiveTimeouts = 0; // 응답 성공 → 카운터 리셋
        if (msg.error) {
          pending.reject(new Error(`CDP error in '${pending.method}': ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // CDP event — emit directly by method name
    if (msg.method) {
      this.emit(msg.method, msg.params);
      this.emit('*', msg.method, msg.params);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
