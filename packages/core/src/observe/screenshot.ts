import type { ConnectionPool } from '../cdp/connection-pool.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('screenshot');

/** Claude's absolute dimension limit for multi-image requests */
export const MAX_SCREENSHOT_DIMENSION = 2000;
const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 800;

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
  selector?: string;
  clip?: { x: number; y: number; width: number; height: number };
  /** Max output width in pixels (default: 1280, hard cap: 2000) */
  maxWidth?: number;
  /** Max output height in pixels (default: 800, hard cap: 2000) */
  maxHeight?: number;
}

export interface ScreenshotResult {
  data: string;    // base64
  format: string;
  width: number;
  height: number;
  /** True if the image was auto-resized to fit within maxWidth/maxHeight */
  resized?: boolean;
  /** Original dimensions before resize (only set when resized=true) */
  originalWidth?: number;
  originalHeight?: number;
}

/**
 * Read image dimensions from PNG header (bytes 16-23).
 * Returns null for non-PNG or if header is too short.
 */
export function getImageDimensionsFromPng(base64Data: string): { width: number; height: number } | null {
  try {
    // We only need the first 24 bytes; 32 base64 chars decode to 24 bytes
    const buf = Buffer.from(base64Data.slice(0, 40), 'base64');
    if (buf.length < 24) return null;
    // PNG signature: 0x89 0x50 0x4E 0x47
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  } catch {
    return null;
  }
}

export async function screenshot(
  pool: ConnectionPool,
  options: ScreenshotOptions = {}
): Promise<ScreenshotResult> {
  const { format = 'png', quality, fullPage = false, selector, clip } = options;
  const client = await pool.getActiveTab();

  // Resolve max dimensions (user params → defaults, hard-capped at 2000)
  const maxW = Math.min(options.maxWidth ?? DEFAULT_MAX_WIDTH, MAX_SCREENSHOT_DIMENSION);
  const maxH = Math.min(options.maxHeight ?? DEFAULT_MAX_HEIGHT, MAX_SCREENSHOT_DIMENSION);

  // Check viewport size — if 0x0 (minimized/offscreen), force a reasonable viewport
  let viewportOverridden = false;
  let viewportWidth = 0;
  let viewportHeight = 0;
  try {
    const currentMetrics = await client.send<{
      layoutViewport: { clientWidth: number; clientHeight: number };
    }>('Page.getLayoutMetrics', {});
    viewportWidth = currentMetrics.layoutViewport.clientWidth;
    viewportHeight = currentMetrics.layoutViewport.clientHeight;

    if (viewportWidth === 0 || viewportHeight === 0) {
      logger.warn('Viewport is 0x0 (window minimized/offscreen). Setting device metrics override for screenshot.');
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      viewportWidth = 1280;
      viewportHeight = 900;
      viewportOverridden = true;
    }
  } catch (e) {
    logger.warn(`Failed to check viewport metrics: ${e}`);
  }

  let captureClip: { x: number; y: number; width: number; height: number; scale: number } | undefined;

  if (selector) {
    // Get element bounds
    const boundsResult = await client.send<{ result: { value: { x: number; y: number; width: number; height: number } | null } }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`,
      returnByValue: true,
    });

    const bounds = boundsResult.result.value;
    if (!bounds) {
      throw new Error(`Element not found for screenshot: ${selector}`);
    }
    captureClip = { ...bounds, scale: 1 };
  } else if (clip) {
    captureClip = { ...clip, scale: 1 };
  } else if (fullPage) {
    // Get full page dimensions
    const metrics = await client.send<{
      contentSize: { width: number; height: number };
    }>('Page.getLayoutMetrics', {});

    // Set viewport to full page size
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(metrics.contentSize.width),
      height: Math.ceil(metrics.contentSize.height),
      deviceScaleFactor: 1,
      mobile: false,
    });

    captureClip = {
      x: 0,
      y: 0,
      width: metrics.contentSize.width,
      height: metrics.contentSize.height,
      scale: 1,
    };
  }

  // --- Dimension constraint: scale down clip if output would exceed max ---
  let resized = false;
  let originalWidth: number | undefined;
  let originalHeight: number | undefined;

  if (captureClip) {
    // Output dimensions = clip.width * clip.scale, clip.height * clip.scale
    const expectedW = captureClip.width * captureClip.scale;
    const expectedH = captureClip.height * captureClip.scale;

    if (expectedW > maxW || expectedH > maxH) {
      const downscale = Math.min(maxW / expectedW, maxH / expectedH);
      originalWidth = Math.ceil(expectedW);
      originalHeight = Math.ceil(expectedH);
      captureClip.scale = captureClip.scale * downscale;
      resized = true;
      logger.info(`Screenshot auto-resize: ${originalWidth}x${originalHeight} → scale=${captureClip.scale.toFixed(3)} (max ${maxW}x${maxH})`);
    }
  } else {
    // No clip → viewport capture. Output = viewport × DPR.
    // Create explicit clip with scale=1 to prevent DPR inflation beyond maxW/maxH.
    const needsConstraint = viewportWidth > maxW || viewportHeight > maxH;
    if (needsConstraint) {
      const downscale = Math.min(maxW / viewportWidth, maxH / viewportHeight);
      originalWidth = viewportWidth;
      originalHeight = viewportHeight;
      captureClip = {
        x: 0, y: 0,
        width: viewportWidth,
        height: viewportHeight,
        scale: downscale,
      };
      resized = true;
      logger.info(`Screenshot auto-resize (viewport): ${viewportWidth}x${viewportHeight} → scale=${downscale.toFixed(3)} (max ${maxW}x${maxH})`);
    } else {
      // Force scale=1 to prevent DPR inflation (Retina displays)
      captureClip = {
        x: 0, y: 0,
        width: viewportWidth,
        height: viewportHeight,
        scale: 1,
      };
    }
  }

  // Capture screenshot
  const params: Record<string, unknown> = { format };
  if (quality !== undefined && (format === 'jpeg' || format === 'webp')) {
    params.quality = quality;
  }
  if (captureClip) {
    params.clip = captureClip;
  }

  const result = await client.send<{ data: string }>('Page.captureScreenshot', params);

  // Determine output dimensions
  let width: number;
  let height: number;

  if (captureClip) {
    width = Math.ceil(captureClip.width * captureClip.scale);
    height = Math.ceil(captureClip.height * captureClip.scale);
  } else {
    const metrics = await client.send<{
      layoutViewport: { clientWidth: number; clientHeight: number };
    }>('Page.getLayoutMetrics', {});
    width = metrics.layoutViewport.clientWidth;
    height = metrics.layoutViewport.clientHeight;
  }

  // Post-capture safety check: verify actual PNG dimensions
  if (format === 'png') {
    const actualDims = getImageDimensionsFromPng(result.data);
    if (actualDims && (actualDims.width > MAX_SCREENSHOT_DIMENSION || actualDims.height > MAX_SCREENSHOT_DIMENSION)) {
      logger.warn(`Post-capture safety: PNG is ${actualDims.width}x${actualDims.height}, exceeds ${MAX_SCREENSHOT_DIMENSION}px hard limit. This should not happen — check DPR handling.`);
      // Update width/height to actual values for accurate reporting
      width = actualDims.width;
      height = actualDims.height;
    }
  }

  // Reset viewport if we changed it for fullPage or 0x0 workaround
  if ((fullPage && !selector && !clip) || viewportOverridden) {
    await client.send('Emulation.clearDeviceMetricsOverride', {});
  }

  logger.info(`Screenshot captured: ${format}, ${width}x${height}${resized ? ' (resized)' : ''}`);

  return {
    data: result.data,
    format,
    width,
    height,
    resized: resized || undefined,
    originalWidth,
    originalHeight,
  };
}
