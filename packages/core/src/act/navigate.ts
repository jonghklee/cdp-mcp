import type { ConnectionPool } from '../cdp/connection-pool.js';
import { CdpTimeoutError, createLogger } from '@cdp-mcp/shared';

const logger = createLogger('navigate');

export interface NavigateOptions {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export interface NavigateResult {
  url: string;
  statusCode?: number;
  loadTime: number;
}

export async function navigate(
  pool: ConnectionPool,
  options: NavigateOptions
): Promise<NavigateResult> {
  const { url, waitUntil = 'load', timeout: timeoutMs = 30000 } = options;
  const client = await pool.getActiveTab();
  const startTime = Date.now();

  // Enable required domains
  await client.send('Page.enable', {});
  await client.send('Page.setLifecycleEventsEnabled', { enabled: true });
  await client.send('Network.enable', {});

  const isChromePage = url.startsWith('chrome://') || url.startsWith('chrome-extension://');

  // Track status code from network response
  let statusCode: number | undefined;

  const statusPromise = new Promise<void>((resolve) => {
    const handler = (params: { response: { url: string; status: number }; type: string }) => {
      if (params.type === 'Document' || params.response.url === url) {
        statusCode = params.response.status;
        client.off('Network.responseReceived', handler);
        resolve();
      }
    };
    client.on('Network.responseReceived', handler);
    setTimeout(resolve, timeoutMs);
  });

  // lifecycle 리스너를 navigate 전에 등록 (race condition 방지)
  let lifecyclePromise: Promise<void> | undefined;

  if (!isChromePage) {
    const lifecycleEventName = waitUntil === 'domcontentloaded' ? 'DOMContentLoaded'
      : waitUntil === 'networkidle' ? 'networkIdle'
      : 'load';

    lifecyclePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.off('Page.lifecycleEvent', handler);
        reject(new CdpTimeoutError(`Navigation timed out after ${timeoutMs}ms waiting for '${waitUntil}'`, timeoutMs));
      }, timeoutMs);

      const handler = (params: { name: string; frameId: string }) => {
        if (params.name === lifecycleEventName) {
          clearTimeout(timer);
          client.off('Page.lifecycleEvent', handler);
          resolve();
        }
      };

      client.on('Page.lifecycleEvent', handler);
    });
  }

  // Navigate
  const navResult = await client.send<{ frameId: string; errorText?: string }>('Page.navigate', { url });

  if (navResult.errorText) {
    throw new Error(`Navigation failed: ${navResult.errorText}`);
  }

  // Wait for lifecycle event (이미 위에서 리스너 등록됨)
  if (lifecyclePromise) {
    await lifecyclePromise;
    await Promise.race([statusPromise, new Promise(r => setTimeout(r, 1000))]);
  }

  const loadTime = Date.now() - startTime;
  logger.info(`Navigated to ${url} in ${loadTime}ms (status: ${statusCode ?? 'unknown'})`);

  return {
    url,
    statusCode,
    loadTime,
  };
}
