import { EventEmitter } from 'events';
import type { CdpClient } from './cdp-client.js';

/**
 * CdpSession — a thin wrapper around a per-target CdpClient.
 *
 * In the per-target WebSocket model, each CdpSession owns a dedicated
 * CdpClient connected directly to the target's WebSocket URL.
 * No session routing is needed — commands go straight to the target.
 *
 * CdpSession exposes the same send/on/off interface as CdpClient,
 * so tools don't need to know they're talking through a session.
 */
export class CdpSession extends EventEmitter {
  constructor(private readonly client: CdpClient) {
    super();
  }

  get connected(): boolean {
    return this.client.connected;
  }

  /**
   * Send a CDP command directly to this target.
   */
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.client.send<T>(method, params);
  }

  /**
   * Subscribe to a CDP event on this target's connection.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): this {
    this.client.on(event, handler);
    return this;
  }

  /**
   * Unsubscribe from a CDP event on this target's connection.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): this {
    this.client.off(event, handler);
    return this;
  }

  /** Close the per-target WebSocket connection. */
  async close(): Promise<void> {
    await this.client.close();
  }
}
