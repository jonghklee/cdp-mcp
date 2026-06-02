import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getPageInfo } from '../page-info.js';

function createMockClient() {
  return { send: vi.fn(), connected: true };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return { getActiveTab: vi.fn().mockResolvedValue(mockClient) };
}

describe('getPageInfo', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
  });

  it('returns page info with all fields', async () => {
    mockClient.send
      .mockResolvedValueOnce({
        result: { value: { url: 'https://example.com', title: 'Example', readyState: 'complete' } }
      }) // evaluate
      .mockResolvedValueOnce({
        frameTree: {
          frame: { id: 'main', url: 'https://example.com', securityOrigin: 'https://example.com', mimeType: 'text/html' },
        }
      }) // getFrameTree
      .mockResolvedValueOnce({
        layoutViewport: { clientWidth: 1920, clientHeight: 1080 }
      }); // getLayoutMetrics

    const info = await getPageInfo(mockPool as any);

    expect(info.url).toBe('https://example.com');
    expect(info.title).toBe('Example');
    expect(info.documentReady).toBe(true);
    expect(info.viewport).toEqual({ width: 1920, height: 1080 });
    expect(info.frameTree).toHaveLength(1);
    expect(info.frameTree[0].id).toBe('main');
  });

  it('handles child frames', async () => {
    mockClient.send
      .mockResolvedValueOnce({
        result: { value: { url: 'https://example.com', title: 'Example', readyState: 'loading' } }
      })
      .mockResolvedValueOnce({
        frameTree: {
          frame: { id: 'main', url: 'https://example.com', securityOrigin: 'https://example.com', mimeType: 'text/html' },
          childFrames: [
            {
              frame: { id: 'iframe1', url: 'https://ads.example.com', securityOrigin: 'https://ads.example.com', mimeType: 'text/html' },
            },
          ],
        }
      })
      .mockResolvedValueOnce({
        layoutViewport: { clientWidth: 800, clientHeight: 600 }
      });

    const info = await getPageInfo(mockPool as any);

    expect(info.documentReady).toBe(false); // loading
    expect(info.frameTree[0].children).toHaveLength(1);
    expect(info.frameTree[0].children![0].url).toBe('https://ads.example.com');
  });
});
