import { describe, it, expect, beforeEach, vi } from 'vitest';
import { navigate } from '../navigate.js';
import { CdpTimeoutError } from '@cdp-mcp/shared';

function createMockClient() {
  const eventHandlers = new Map<string, Set<Function>>();

  return {
    send: vi.fn(),
    on: vi.fn().mockImplementation((event: string, handler: Function) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
      eventHandlers.get(event)!.add(handler);
    }),
    off: vi.fn().mockImplementation((event: string, handler: Function) => {
      eventHandlers.get(event)?.delete(handler);
    }),
    connected: true,
    // Helper for tests
    _emit(event: string, data: any) {
      eventHandlers.get(event)?.forEach(h => h(data));
    },
  };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(mockClient),
  };
}

describe('navigate', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
  });

  it('navigates to URL and waits for load event', async () => {
    mockClient.send
      .mockResolvedValueOnce(undefined) // Page.enable
      .mockResolvedValueOnce(undefined) // Page.setLifecycleEventsEnabled
      .mockResolvedValueOnce(undefined) // Network.enable
      .mockResolvedValueOnce({ frameId: 'frame1' }); // Page.navigate

    // Simulate lifecycle event after a tick
    setTimeout(() => {
      mockClient._emit('Page.lifecycleEvent', { name: 'load', frameId: 'frame1' });
    }, 10);

    const result = await navigate(mockPool as any, { url: 'https://example.com', timeout: 5000 });

    expect(result.url).toBe('https://example.com');
    expect(result.loadTime).toBeGreaterThanOrEqual(0);
    expect(mockClient.send).toHaveBeenCalledWith('Page.navigate', { url: 'https://example.com' });
  });

  it('waits for DOMContentLoaded when specified', async () => {
    mockClient.send
      .mockResolvedValueOnce(undefined) // Page.enable
      .mockResolvedValueOnce(undefined) // Page.setLifecycleEventsEnabled
      .mockResolvedValueOnce(undefined) // Network.enable
      .mockResolvedValueOnce({ frameId: 'frame1' }); // Page.navigate

    setTimeout(() => {
      mockClient._emit('Page.lifecycleEvent', { name: 'DOMContentLoaded', frameId: 'frame1' });
    }, 10);

    const result = await navigate(mockPool as any, {
      url: 'https://example.com',
      waitUntil: 'domcontentloaded',
      timeout: 5000,
    });

    expect(result.url).toBe('https://example.com');
  });

  it('captures status code from network response', async () => {
    mockClient.send
      .mockResolvedValueOnce(undefined) // Page.enable
      .mockResolvedValueOnce(undefined) // Page.setLifecycleEventsEnabled
      .mockResolvedValueOnce(undefined) // Network.enable
      .mockResolvedValueOnce({ frameId: 'frame1' }); // Page.navigate

    setTimeout(() => {
      mockClient._emit('Network.responseReceived', {
        response: { url: 'https://example.com', status: 200 },
        type: 'Document',
      });
      mockClient._emit('Page.lifecycleEvent', { name: 'load', frameId: 'frame1' });
    }, 10);

    const result = await navigate(mockPool as any, { url: 'https://example.com', timeout: 5000 });
    expect(result.statusCode).toBe(200);
  });

  it('throws on navigation error', async () => {
    mockClient.send
      .mockResolvedValueOnce(undefined) // Page.enable
      .mockResolvedValueOnce(undefined) // Page.setLifecycleEventsEnabled
      .mockResolvedValueOnce(undefined) // Network.enable
      .mockResolvedValueOnce({ frameId: 'frame1', errorText: 'net::ERR_NAME_NOT_RESOLVED' });

    await expect(navigate(mockPool as any, { url: 'https://invalid.example', timeout: 5000 }))
      .rejects.toThrow('Navigation failed');
  });

  it('throws CdpTimeoutError when lifecycle event does not arrive', async () => {
    mockClient.send
      .mockResolvedValueOnce(undefined) // Page.enable
      .mockResolvedValueOnce(undefined) // Page.setLifecycleEventsEnabled
      .mockResolvedValueOnce(undefined) // Network.enable
      .mockResolvedValueOnce({ frameId: 'frame1' }); // Page.navigate

    // Don't emit any lifecycle event
    await expect(navigate(mockPool as any, { url: 'https://slow.example', timeout: 100 }))
      .rejects.toThrow(CdpTimeoutError);
  });
});
