import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screenshot, getImageDimensionsFromPng, MAX_SCREENSHOT_DIMENSION } from '../screenshot.js';

function createMockClient() {
  return { send: vi.fn(), connected: true };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return { getActiveTab: vi.fn().mockResolvedValue(mockClient) };
}

describe('screenshot', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
  });

  it('captures screenshot with default options', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } }) // viewport check
      .mockResolvedValueOnce({ data: 'base64data' }); // captureScreenshot

    const result = await screenshot(mockPool as any);

    expect(result.data).toBe('base64data');
    expect(result.format).toBe('png');
    expect(result.width).toBe(1280);
    expect(result.height).toBe(800);
    expect(result.resized).toBeUndefined();
  });

  it('captures screenshot of specific selector', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } }) // viewport check
      .mockResolvedValueOnce({ result: { value: { x: 10, y: 20, width: 200, height: 100 } } }) // evaluate
      .mockResolvedValueOnce({ data: 'elementdata' }); // captureScreenshot

    const result = await screenshot(mockPool as any, { selector: '#target' });

    expect(result.data).toBe('elementdata');
    expect(result.width).toBe(200);
    expect(result.height).toBe(100);
    expect(mockClient.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
      clip: expect.objectContaining({ x: 10, y: 20, width: 200, height: 100, scale: 1 }),
    }));
  });

  it('throws when selector element not found', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } }) // viewport check
      .mockResolvedValueOnce({ result: { value: null } });
    await expect(screenshot(mockPool as any, { selector: '#missing' })).rejects.toThrow('Element not found');
  });

  it('captures full page screenshot', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } }) // viewport check
      .mockResolvedValueOnce({ contentSize: { width: 1280, height: 800 } }) // getLayoutMetrics (fullPage)
      .mockResolvedValueOnce(undefined) // setDeviceMetricsOverride
      .mockResolvedValueOnce({ data: 'fullpagedata' }) // captureScreenshot
      .mockResolvedValueOnce(undefined); // clearDeviceMetricsOverride

    const result = await screenshot(mockPool as any, { fullPage: true });

    expect(result.data).toBe('fullpagedata');
    expect(result.width).toBe(1280);
    expect(result.height).toBe(800);
    expect(result.resized).toBeUndefined();
  });

  it('auto-resizes full page screenshot when content exceeds max dimensions', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1920, clientHeight: 1080 } }) // viewport check
      .mockResolvedValueOnce({ contentSize: { width: 1920, height: 5000 } }) // getLayoutMetrics (fullPage)
      .mockResolvedValueOnce(undefined) // setDeviceMetricsOverride
      .mockResolvedValueOnce({ data: 'resizeddata' }) // captureScreenshot
      .mockResolvedValueOnce(undefined); // clearDeviceMetricsOverride

    const result = await screenshot(mockPool as any, { fullPage: true });

    expect(result.resized).toBe(true);
    expect(result.originalWidth).toBe(1920);
    expect(result.originalHeight).toBe(5000);
    // Should be scaled down to fit within 1280x800 defaults
    expect(result.width).toBeLessThanOrEqual(1280);
    expect(result.height).toBeLessThanOrEqual(800);

    // Verify clip.scale was reduced
    const captureCall = mockClient.send.mock.calls.find(c => c[0] === 'Page.captureScreenshot');
    expect(captureCall).toBeDefined();
    expect(captureCall![1].clip.scale).toBeLessThan(1);
  });

  it('auto-resizes viewport screenshot when viewport exceeds max dimensions', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 2560, clientHeight: 1440 } }) // viewport check
      .mockResolvedValueOnce({ data: 'resizeddata' }); // captureScreenshot

    const result = await screenshot(mockPool as any);

    expect(result.resized).toBe(true);
    expect(result.originalWidth).toBe(2560);
    expect(result.originalHeight).toBe(1440);
    expect(result.width).toBeLessThanOrEqual(1280);
    expect(result.height).toBeLessThanOrEqual(800);
  });

  it('respects custom maxWidth/maxHeight', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1920, clientHeight: 1080 } }) // viewport check
      .mockResolvedValueOnce({ data: 'data' }); // captureScreenshot

    const result = await screenshot(mockPool as any, { maxWidth: 1920, maxHeight: 1080 });

    // 1920x1080 fits within maxWidth=1920, maxHeight=1080 → no resize
    expect(result.resized).toBeUndefined();
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it('hard-caps maxWidth/maxHeight at MAX_SCREENSHOT_DIMENSION', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 2500, clientHeight: 1500 } }) // viewport check
      .mockResolvedValueOnce({ data: 'data' }); // captureScreenshot

    // Even with maxWidth=3000, it should be capped at 2000
    const result = await screenshot(mockPool as any, { maxWidth: 3000, maxHeight: 3000 });

    expect(result.resized).toBe(true);
    expect(result.width).toBeLessThanOrEqual(MAX_SCREENSHOT_DIMENSION);
    expect(result.height).toBeLessThanOrEqual(MAX_SCREENSHOT_DIMENSION);
  });

  it('passes quality for jpeg', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 800, clientHeight: 600 } }) // viewport check
      .mockResolvedValueOnce({ data: 'jpegdata' }); // captureScreenshot

    await screenshot(mockPool as any, { format: 'jpeg', quality: 80 });

    expect(mockClient.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({
      format: 'jpeg',
      quality: 80,
    }));
  });

  it('sets device metrics override when viewport is 0x0', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 0, clientHeight: 0 } }) // viewport check → 0x0
      .mockResolvedValueOnce(undefined) // setDeviceMetricsOverride
      .mockResolvedValueOnce({ data: 'fixeddata' }) // captureScreenshot
      .mockResolvedValueOnce(undefined); // clearDeviceMetricsOverride

    const result = await screenshot(mockPool as any);

    expect(result.data).toBe('fixeddata');
    expect(mockClient.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    expect(mockClient.send).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride', {});
  });

  it('forces DPR=1 via explicit clip for normal viewport captures', async () => {
    mockClient.send
      .mockResolvedValueOnce({ layoutViewport: { clientWidth: 1280, clientHeight: 800 } }) // viewport check
      .mockResolvedValueOnce({ data: 'data' }); // captureScreenshot

    await screenshot(mockPool as any);

    // Should use explicit clip with scale=1 to prevent DPR inflation
    const captureCall = mockClient.send.mock.calls.find(c => c[0] === 'Page.captureScreenshot');
    expect(captureCall![1].clip).toEqual({
      x: 0, y: 0,
      width: 1280, height: 800,
      scale: 1,
    });
  });
});

describe('getImageDimensionsFromPng', () => {
  it('reads dimensions from valid PNG header', () => {
    // Construct a minimal PNG header: signature + IHDR with 800x600
    const header = Buffer.alloc(24);
    // PNG signature
    header[0] = 0x89; header[1] = 0x50; header[2] = 0x4e; header[3] = 0x47;
    header[4] = 0x0d; header[5] = 0x0a; header[6] = 0x1a; header[7] = 0x0a;
    // IHDR chunk: length + type
    header.writeUInt32BE(13, 8); // chunk length
    header[12] = 0x49; header[13] = 0x48; header[14] = 0x44; header[15] = 0x52; // "IHDR"
    // Width and height
    header.writeUInt32BE(800, 16);
    header.writeUInt32BE(600, 20);

    const base64 = header.toString('base64');
    const dims = getImageDimensionsFromPng(base64);

    expect(dims).toEqual({ width: 800, height: 600 });
  });

  it('returns null for non-PNG data', () => {
    const notPng = Buffer.from('not a png file at all');
    expect(getImageDimensionsFromPng(notPng.toString('base64'))).toBeNull();
  });

  it('returns null for too-short data', () => {
    const short = Buffer.from('abc');
    expect(getImageDimensionsFromPng(short.toString('base64'))).toBeNull();
  });
});
