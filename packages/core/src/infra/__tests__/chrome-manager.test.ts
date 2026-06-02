import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CdpConnectionError } from '@cdp-mcp/shared';

// Mock port-store to avoid creating real lock files during tests
vi.mock('../port-store.js', () => ({
  acquireLock: vi.fn().mockReturnValue(true),
  releaseLock: vi.fn().mockReturnValue(true),
  isMyLock: vi.fn().mockReturnValue(false),
  readLock: vi.fn().mockReturnValue(null),
  isPortLocked: vi.fn().mockReturnValue({ locked: false }),
  EXCLUDED_PORTS: new Set([9229]),
}));

import { ChromeManager } from '../chrome-pool.js';

// We test connect() by mocking global fetch
describe('ChromeManager', () => {
  let manager: ChromeManager;

  beforeEach(() => {
    manager = new ChromeManager();
  });

  afterEach(async () => {
    await manager.close();
    vi.restoreAllMocks();
  });

  describe('connect()', () => {
    it('returns webSocketDebuggerUrl on success', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
          Browser: 'Chrome/120.0.0.0',
        }),
      }));

      const wsUrl = await manager.connect(9222);
      expect(wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc');
    });

    it('throws CdpConnectionError on non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      await expect(manager.connect(9222)).rejects.toThrow(CdpConnectionError);
    });

    it('throws CdpConnectionError on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      await expect(manager.connect(9222)).rejects.toThrow(CdpConnectionError);
    });
  });

  describe('status()', () => {
    it('returns connected false when no port set', async () => {
      const status = await manager.status();
      expect(status.connected).toBe(false);
    });

    it('returns connected true after successful connect', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
          Browser: 'Chrome/120.0.0.0',
        }),
      }));

      await manager.connect(9222);
      const status = await manager.status();
      expect(status.connected).toBe(true);
      expect(status.port).toBe(9222);
      expect(status.version).toBe('Chrome/120.0.0.0');
    });
  });

  describe('close()', () => {
    it('resets state', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        }),
      }));

      await manager.connect(9222);
      await manager.close();
      const status = await manager.status();
      expect(status.connected).toBe(false);
    });
  });
});
