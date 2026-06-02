import type { ConnectionPool } from '../cdp/connection-pool.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('page-info');

export interface FrameInfo {
  id: string;
  url: string;
  securityOrigin: string;
  mimeType: string;
  children?: FrameInfo[];
}

export interface PageInfo {
  url: string;
  title: string;
  frameTree: FrameInfo[];
  viewport: { width: number; height: number };
  documentReady: boolean;
  loadTime?: number;
}

export async function getPageInfo(
  pool: ConnectionPool
): Promise<PageInfo> {
  const client = await pool.getActiveTab();

  // Get page info via Runtime.evaluate
  const pageData = await client.send<{
    result: { value: { url: string; title: string; readyState: string } };
  }>('Runtime.evaluate', {
    expression: `({ url: document.URL, title: document.title, readyState: document.readyState })`,
    returnByValue: true,
  });

  // Get frame tree
  const frameTreeResult = await client.send<{
    frameTree: {
      frame: { id: string; url: string; securityOrigin: string; mimeType: string };
      childFrames?: Array<{
        frame: { id: string; url: string; securityOrigin: string; mimeType: string };
        childFrames?: any[];
      }>;
    };
  }>('Page.getFrameTree', {});

  // Get viewport
  const metrics = await client.send<{
    layoutViewport: { clientWidth: number; clientHeight: number };
  }>('Page.getLayoutMetrics', {});

  // Convert frame tree
  const frameTree = convertFrameTree(frameTreeResult.frameTree);

  const { url, title, readyState } = pageData.result.value;

  logger.info(`Page info: ${title} (${url})`);

  return {
    url,
    title,
    frameTree: [frameTree],
    viewport: {
      width: metrics.layoutViewport.clientWidth,
      height: metrics.layoutViewport.clientHeight,
    },
    documentReady: readyState === 'complete',
  };
}

function convertFrameTree(tree: any): FrameInfo {
  const frame: FrameInfo = {
    id: tree.frame.id,
    url: tree.frame.url,
    securityOrigin: tree.frame.securityOrigin,
    mimeType: tree.frame.mimeType,
  };

  if (tree.childFrames && tree.childFrames.length > 0) {
    frame.children = tree.childFrames.map(convertFrameTree);
  }

  return frame;
}
