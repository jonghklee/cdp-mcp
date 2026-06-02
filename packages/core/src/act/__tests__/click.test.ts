import { describe, it, expect, beforeEach, vi } from 'vitest';
import { click } from '../click.js';

function createMockClient() {
  return {
    send: vi.fn(),
    connected: true,
  };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(mockClient),
  };
}

describe('click', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
  });

  it('clicks element at center coordinates', async () => {
    // Mock Runtime.evaluate response with element bounds
    mockClient.send.mockResolvedValueOnce({
      result: {
        value: { x: 100, y: 200, width: 50, height: 30, visible: true },
      },
    });
    // Mock mouse events (3 calls)
    mockClient.send.mockResolvedValue({});

    const result = await click(mockPool as any, { selector: '#btn' });

    expect(result.clicked).toBe(true);
    expect(result.position.x).toBe(125); // 100 + 50/2
    expect(result.position.y).toBe(215); // 200 + 30/2

    // Verify mouse event sequence
    expect(mockClient.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved' }));
    expect(mockClient.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }));
    expect(mockClient.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased' }));
  });

  it('throws when element not found', async () => {
    mockClient.send.mockResolvedValueOnce({
      result: { value: null },
    });

    await expect(click(mockPool as any, { selector: '#missing' })).rejects.toThrow('Element not found');
  });

  it('throws when element not visible', async () => {
    mockClient.send.mockResolvedValueOnce({
      result: {
        value: { x: 0, y: 0, width: 50, height: 30, visible: false },
      },
    });

    await expect(click(mockPool as any, { selector: '#hidden' })).rejects.toThrow('Element not visible');
  });

  it('supports right click', async () => {
    mockClient.send.mockResolvedValueOnce({
      result: {
        value: { x: 0, y: 0, width: 100, height: 100, visible: true },
      },
    });
    mockClient.send.mockResolvedValue({});

    await click(mockPool as any, { selector: '#ctx', button: 'right' });

    expect(mockClient.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mousePressed',
      button: 'right',
    }));
  });

  it('supports double click', async () => {
    mockClient.send.mockResolvedValueOnce({
      result: {
        value: { x: 0, y: 0, width: 100, height: 100, visible: true },
      },
    });
    mockClient.send.mockResolvedValue({});

    await click(mockPool as any, { selector: '#dbl', clickCount: 2 });

    expect(mockClient.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mousePressed',
      clickCount: 2,
    }));
  });

  it('delays between mousedown and mouseup', async () => {
    mockClient.send.mockResolvedValueOnce({
      result: {
        value: { x: 0, y: 0, width: 100, height: 100, visible: true },
      },
    });
    mockClient.send.mockResolvedValue({});

    const start = Date.now();
    await click(mockPool as any, { selector: '#slow', delay: 50 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some tolerance
  });
});
