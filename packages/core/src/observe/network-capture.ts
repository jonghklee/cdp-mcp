import type { CdpSession } from '../cdp/cdp-session.js';
import type {
  NetworkRequestWillBeSentParams,
  NetworkResponseReceivedParams,
  NetworkLoadingFinishedParams,
  NetworkLoadingFailedParams,
  NetworkGetResponseBodyResult,
} from '../cdp/protocol-types.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('network-capture');

// ── Public types ──

export interface CapturedRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  requestBody?: string;
  resourceType?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
  responseMimeType?: string;
  timestamp: number;
  timing?: { duration?: number };
  isSSE: boolean;
  isComplete: boolean;
  error?: string;
}

export interface NetworkCaptureOptions {
  maxRequests?: number;       // default 500 (ring buffer)
  captureBody?: boolean;      // default true
  maxBodySize?: number;       // default 10MB
  filterDomains?: string[];   // hostname includes check
  filterMethods?: string[];
  filterResourceTypes?: string[];
}

export type NetworkCaptureStatus = 'capturing' | 'stopped' | 'stopped_disconnected';

export interface StartNetworkCaptureResult {
  captureId: string;
  targetId: string;
  status: NetworkCaptureStatus;
}

export interface StopNetworkCaptureResult {
  requests: CapturedRequest[];
  stats: {
    total: number;
    completed: number;
    failed: number;
    dropped: number;
  };
}

export interface GetNetworkRequestsOptions {
  captureId: string;
  urlPattern?: string;
  method?: string;
  contentType?: string;
  statusRange?: '2xx' | '3xx' | '4xx' | '5xx';
  limit?: number;
  sort?: 'oldest' | 'latest';
}

export interface GetNetworkRequestsResult {
  requests: CapturedRequest[];
  total: number;
}

export interface WaitForNetworkRequestResult {
  found: boolean;
  request?: CapturedRequest;
}

// ── Internal state ──

interface CaptureState {
  session: CdpSession;
  targetId: string;
  status: NetworkCaptureStatus;
  requests: Map<string, CapturedRequest>;
  requestOrder: string[];        // ring buffer order tracking
  options: Required<Pick<NetworkCaptureOptions, 'maxRequests' | 'captureBody' | 'maxBodySize'>> & NetworkCaptureOptions;
  totalReceived: number;
  dropped: number;
  requestWillBeSentHandler: (params: NetworkRequestWillBeSentParams) => void;
  responseReceivedHandler: (params: NetworkResponseReceivedParams) => void;
  loadingFinishedHandler: (params: NetworkLoadingFinishedParams) => void;
  loadingFailedHandler: (params: NetworkLoadingFailedParams) => void;
  disconnectHandler: () => void;
}

const captures = new Map<string, CaptureState>();
let captureCounter = 0;

const DEFAULT_MAX_REQUESTS = 500;
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

// ── Public API ──

export async function startNetworkCapture(
  session: CdpSession,
  targetId: string,
  options: NetworkCaptureOptions = {},
): Promise<StartNetworkCaptureResult> {
  const captureId = `net_${++captureCounter}`;
  const resolvedOptions = {
    maxRequests: options.maxRequests ?? DEFAULT_MAX_REQUESTS,
    captureBody: options.captureBody ?? true,
    maxBodySize: options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE,
    ...options,
  };

  const state: CaptureState = {
    session,
    targetId,
    status: 'capturing',
    requests: new Map(),
    requestOrder: [],
    options: resolvedOptions,
    totalReceived: 0,
    dropped: 0,
    requestWillBeSentHandler: (params) => handleRequestWillBeSent(captureId, params),
    responseReceivedHandler: (params) => handleResponseReceived(captureId, params),
    loadingFinishedHandler: (params) => handleLoadingFinished(captureId, params),
    loadingFailedHandler: (params) => handleLoadingFailed(captureId, params),
    disconnectHandler: () => handleDisconnect(captureId),
  };

  captures.set(captureId, state);

  await session.send('Network.enable');
  session.on('Network.requestWillBeSent', state.requestWillBeSentHandler);
  session.on('Network.responseReceived', state.responseReceivedHandler);
  session.on('Network.loadingFinished', state.loadingFinishedHandler);
  session.on('Network.loadingFailed', state.loadingFailedHandler);
  session.on('disconnected', state.disconnectHandler);

  logger.info(`Network capture started: ${captureId} on target ${targetId}`);

  return { captureId, targetId, status: 'capturing' };
}

export function stopNetworkCapture(captureId: string): StopNetworkCaptureResult {
  const state = captures.get(captureId);
  if (!state) {
    throw new Error(`Network capture not found: ${captureId}`);
  }

  unsubscribe(state);

  const requests = [...state.requests.values()];
  const stats = {
    total: state.totalReceived,
    completed: requests.filter(r => r.isComplete).length,
    failed: requests.filter(r => r.error).length,
    dropped: state.dropped,
  };

  captures.delete(captureId);
  logger.info(`Network capture stopped: ${captureId} (${stats.total} total, ${stats.dropped} dropped)`);

  return { requests, stats };
}

export function getNetworkRequests(opts: GetNetworkRequestsOptions): GetNetworkRequestsResult {
  const state = captures.get(opts.captureId);
  if (!state) {
    throw new Error(`Network capture not found: ${opts.captureId}`);
  }

  let requests = [...state.requests.values()];

  // Filter by URL pattern
  if (opts.urlPattern) {
    const pattern = opts.urlPattern;
    requests = requests.filter(r => r.url.includes(pattern));
  }

  // Filter by method
  if (opts.method) {
    const method = opts.method.toUpperCase();
    requests = requests.filter(r => r.method === method);
  }

  // Filter by content type
  if (opts.contentType) {
    const ct = opts.contentType.toLowerCase();
    requests = requests.filter(r => r.responseMimeType?.toLowerCase().includes(ct));
  }

  // Filter by status range
  if (opts.statusRange) {
    const rangeStart = parseInt(opts.statusRange[0]) * 100;
    const rangeEnd = rangeStart + 99;
    requests = requests.filter(r =>
      r.responseStatus !== undefined &&
      r.responseStatus >= rangeStart &&
      r.responseStatus <= rangeEnd
    );
  }

  const total = requests.length;

  // Sort
  if (opts.sort === 'latest') {
    requests.sort((a, b) => b.timestamp - a.timestamp);
  } else {
    requests.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Limit
  if (opts.limit && opts.limit > 0) {
    requests = requests.slice(0, opts.limit);
  }

  return { requests, total };
}

export function waitForNetworkRequest(
  captureId: string,
  urlPattern: string,
  options: { timeout?: number; onlyComplete?: boolean } = {},
): Promise<WaitForNetworkRequestResult> {
  const timeout = options.timeout ?? 30000;
  const onlyComplete = options.onlyComplete ?? true;

  return new Promise((resolve) => {
    const startTime = Date.now();

    const check = () => {
      const state = captures.get(captureId);
      if (!state) {
        resolve({ found: false });
        return;
      }

      for (const req of state.requests.values()) {
        if (req.url.includes(urlPattern)) {
          if (!onlyComplete || req.isComplete) {
            resolve({ found: true, request: { ...req } });
            return;
          }
        }
      }

      if (Date.now() - startTime >= timeout) {
        resolve({ found: false });
        return;
      }

      setTimeout(check, 100);
    };

    check();
  });
}

export function clearAllNetworkCaptures(): void {
  for (const [captureId, state] of captures) {
    unsubscribe(state);
    logger.debug(`Network capture cleared: ${captureId}`);
  }
  captures.clear();
  captureCounter = 0;
}

// ── Internal handlers ──

function handleRequestWillBeSent(captureId: string, params: NetworkRequestWillBeSentParams): void {
  const state = captures.get(captureId);
  if (!state || state.status !== 'capturing') return;

  // Domain filter
  if (state.options.filterDomains?.length) {
    try {
      const hostname = new URL(params.request.url).hostname;
      if (!state.options.filterDomains.some(d => hostname.includes(d))) return;
    } catch {
      return;
    }
  }

  // Method filter
  if (state.options.filterMethods?.length) {
    if (!state.options.filterMethods.includes(params.request.method.toUpperCase())) return;
  }

  // Resource type filter
  if (state.options.filterResourceTypes?.length && params.type) {
    if (!state.options.filterResourceTypes.includes(params.type)) return;
  }

  state.totalReceived++;

  // Ring buffer: evict oldest if at capacity
  if (state.requestOrder.length >= state.options.maxRequests) {
    const evictId = state.requestOrder.shift()!;
    state.requests.delete(evictId);
    state.dropped++;
  }

  const captured: CapturedRequest = {
    id: params.requestId,
    url: params.request.url,
    method: params.request.method,
    headers: params.request.headers,
    requestBody: params.request.postData,
    resourceType: params.type,
    timestamp: params.timestamp,
    isSSE: false,
    isComplete: false,
  };

  state.requests.set(params.requestId, captured);
  state.requestOrder.push(params.requestId);
}

function handleResponseReceived(captureId: string, params: NetworkResponseReceivedParams): void {
  const state = captures.get(captureId);
  if (!state || state.status !== 'capturing') return;

  const req = state.requests.get(params.requestId);
  if (!req) return;

  req.responseStatus = params.response.status;
  req.responseHeaders = params.response.headers;
  req.responseMimeType = params.response.mimeType;

  // SSE detection
  const mimeType = params.response.mimeType?.toLowerCase() ?? '';
  req.isSSE = mimeType === 'text/event-stream' || mimeType === 'application/x-ndjson';

  // Timing
  if (params.timestamp && req.timestamp) {
    req.timing = { duration: Math.round((params.timestamp - req.timestamp) * 1000) };
  }
}

function handleLoadingFinished(captureId: string, params: NetworkLoadingFinishedParams): void {
  const state = captures.get(captureId);
  if (!state || state.status !== 'capturing') return;

  const req = state.requests.get(params.requestId);
  if (!req) return;

  req.isComplete = true;

  // Capture response body
  if (state.options.captureBody) {
    state.session.send<NetworkGetResponseBodyResult>('Network.getResponseBody', {
      requestId: params.requestId,
    }).then((result) => {
      if (result.base64Encoded) {
        const size = Math.ceil(result.body.length * 3 / 4);
        if (size > state.options.maxBodySize) {
          req.responseBody = `[binary, ${size} bytes]`;
        } else {
          req.responseBody = `[base64] ${result.body.substring(0, 200)}...`;
        }
      } else if (result.body.length > state.options.maxBodySize) {
        req.responseBody = result.body.substring(0, 1000) + '... [truncated]';
      } else {
        req.responseBody = result.body;
      }
    }).catch(() => {
      req.responseBody = null;
    });
  }
}

function handleLoadingFailed(captureId: string, params: NetworkLoadingFailedParams): void {
  const state = captures.get(captureId);
  if (!state || state.status !== 'capturing') return;

  const req = state.requests.get(params.requestId);
  if (!req) return;

  req.isComplete = true;
  req.error = params.errorText;
}

function handleDisconnect(captureId: string): void {
  const state = captures.get(captureId);
  if (!state) return;

  state.status = 'stopped_disconnected';
  logger.info(`Network capture disconnected: ${captureId}`);
}

function unsubscribe(state: CaptureState): void {
  state.session.off('Network.requestWillBeSent', state.requestWillBeSentHandler);
  state.session.off('Network.responseReceived', state.responseReceivedHandler);
  state.session.off('Network.loadingFinished', state.loadingFinishedHandler);
  state.session.off('Network.loadingFailed', state.loadingFailedHandler);
  state.session.off('disconnected', state.disconnectHandler);
}
