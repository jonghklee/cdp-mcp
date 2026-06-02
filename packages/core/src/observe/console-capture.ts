import type { CdpSession } from '../cdp/cdp-session.js';
import type {
  RemoteObject,
  RuntimeConsoleAPICalledParams,
  RuntimeExceptionThrownParams,
} from '../cdp/protocol-types.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('console-capture');

// ── Public types ──

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  timestamp: number;
  source: 'console' | 'exception';
  stackTrace?: string;
}

export interface CaptureOptions {
  levels?: ConsoleLevel[];
  maxEntries?: number;  // ring buffer size, default 1000
}

export type CaptureStatus = 'capturing' | 'stopped' | 'stopped_disconnected';

export interface StartCaptureResult {
  captureId: string;
  targetId: string;
  status: CaptureStatus;
}

export interface StopCaptureResult {
  entries: ConsoleEntry[];
  totalReceived: number;
  dropped: number;
  status: CaptureStatus;
}

export interface GetMessagesResult {
  entries: ConsoleEntry[];
  totalReceived: number;
  dropped: number;
  capturing: boolean;
}

// ── Internal state ──

interface CaptureState {
  session: CdpSession;
  targetId: string;
  status: CaptureStatus;
  entries: ConsoleEntry[];
  maxEntries: number;
  levels: ConsoleLevel[] | null;  // null = all levels
  totalReceived: number;
  dropped: number;
  consoleHandler: (params: RuntimeConsoleAPICalledParams) => void;
  exceptionHandler: (params: RuntimeExceptionThrownParams) => void;
  disconnectHandler: () => void;
}

const captures = new Map<string, CaptureState>();
let captureCounter = 0;

// ── Level mapping ──

const CDP_TYPE_TO_LEVEL: Record<string, ConsoleLevel> = {
  log: 'log',
  debug: 'debug',
  info: 'info',
  error: 'error',
  warning: 'warn',
  dir: 'log',
  dirxml: 'log',
  table: 'log',
  trace: 'debug',
  clear: 'log',
  startGroup: 'log',
  startGroupCollapsed: 'log',
  endGroup: 'log',
  assert: 'error',
  profile: 'debug',
  profileEnd: 'debug',
  count: 'log',
  timeEnd: 'log',
};

// ── Arg serialization ──

export function serializeArg(arg: RemoteObject): string {
  if (arg.value !== undefined) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  }
  if (arg.description) return arg.description;
  if (arg.type === 'undefined') return 'undefined';
  return `[${arg.type}${arg.subtype ? `:${arg.subtype}` : ''}]`;
}

export function serializeArgs(args: RemoteObject[]): string {
  return args.map(serializeArg).join(' ');
}

// ── Public API ──

export async function startCapture(
  session: CdpSession,
  targetId: string,
  options: CaptureOptions = {},
): Promise<StartCaptureResult> {
  const captureId = `cap_${++captureCounter}`;
  const maxEntries = options.maxEntries ?? 1000;
  const levels = options.levels ?? null;

  const state: CaptureState = {
    session,
    targetId,
    status: 'capturing',
    entries: [],
    maxEntries,
    levels,
    totalReceived: 0,
    dropped: 0,
    consoleHandler: (params: RuntimeConsoleAPICalledParams) => {
      handleConsoleEvent(captureId, params);
    },
    exceptionHandler: (params: RuntimeExceptionThrownParams) => {
      handleExceptionEvent(captureId, params);
    },
    disconnectHandler: () => {
      handleDisconnect(captureId);
    },
  };

  captures.set(captureId, state);

  // Enable Runtime domain and subscribe to events
  await session.send('Runtime.enable');
  session.on('Runtime.consoleAPICalled', state.consoleHandler);
  session.on('Runtime.exceptionThrown', state.exceptionHandler);
  session.on('disconnected', state.disconnectHandler);

  logger.info(`Capture started: ${captureId} on target ${targetId}`);

  return { captureId, targetId, status: 'capturing' };
}

export function stopCapture(captureId: string): StopCaptureResult {
  const state = captures.get(captureId);
  if (!state) {
    throw new Error(`Capture not found: ${captureId}`);
  }

  // Unsubscribe events
  state.session.off('Runtime.consoleAPICalled', state.consoleHandler);
  state.session.off('Runtime.exceptionThrown', state.exceptionHandler);
  state.session.off('disconnected', state.disconnectHandler);

  const result: StopCaptureResult = {
    entries: [...state.entries],
    totalReceived: state.totalReceived,
    dropped: state.dropped,
    status: state.status === 'stopped_disconnected' ? 'stopped_disconnected' : 'stopped',
  };

  captures.delete(captureId);
  logger.info(`Capture stopped: ${captureId} (${result.totalReceived} received, ${result.dropped} dropped)`);

  return result;
}

export function getMessages(opts: { captureId: string; clear?: boolean }): GetMessagesResult {
  const state = captures.get(opts.captureId);
  if (!state) {
    throw new Error(`Capture not found: ${opts.captureId}`);
  }

  const result: GetMessagesResult = {
    entries: [...state.entries],
    totalReceived: state.totalReceived,
    dropped: state.dropped,
    capturing: state.status === 'capturing',
  };

  if (opts.clear) {
    state.entries = [];
  }

  return result;
}

export function clearAllCaptures(): void {
  for (const [captureId, state] of captures) {
    state.session.off('Runtime.consoleAPICalled', state.consoleHandler);
    state.session.off('Runtime.exceptionThrown', state.exceptionHandler);
    state.session.off('disconnected', state.disconnectHandler);
    logger.debug(`Capture cleared: ${captureId}`);
  }
  captures.clear();
  captureCounter = 0;
}

// ── Internal handlers ──

function handleConsoleEvent(captureId: string, params: RuntimeConsoleAPICalledParams): void {
  const state = captures.get(captureId);
  if (!state || state.status !== 'capturing') return;

  const level = CDP_TYPE_TO_LEVEL[params.type] ?? 'log';

  // Level filtering
  if (state.levels && !state.levels.includes(level)) return;

  state.totalReceived++;

  const entry: ConsoleEntry = {
    level,
    text: serializeArgs(params.args),
    timestamp: params.timestamp,
    source: 'console',
  };

  if (params.stackTrace) {
    entry.stackTrace = params.stackTrace.callFrames
      .map(f => `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
      .join('\n');
  }

  pushEntry(state, entry);
}

function handleExceptionEvent(captureId: string, params: RuntimeExceptionThrownParams): void {
  const state = captures.get(captureId);
  if (!state || state.status !== 'capturing') return;

  // Exceptions always count as 'error' level
  if (state.levels && !state.levels.includes('error')) return;

  state.totalReceived++;

  const { exceptionDetails } = params;
  let text = exceptionDetails.text;
  if (exceptionDetails.exception?.description) {
    text = exceptionDetails.exception.description;
  }

  const entry: ConsoleEntry = {
    level: 'error',
    text,
    timestamp: params.timestamp,
    source: 'exception',
  };

  if (exceptionDetails.stackTrace) {
    entry.stackTrace = exceptionDetails.stackTrace.callFrames
      .map(f => `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
      .join('\n');
  }

  pushEntry(state, entry);
}

function handleDisconnect(captureId: string): void {
  const state = captures.get(captureId);
  if (!state) return;

  state.status = 'stopped_disconnected';
  logger.info(`Capture disconnected: ${captureId}`);
}

function pushEntry(state: CaptureState, entry: ConsoleEntry): void {
  if (state.entries.length >= state.maxEntries) {
    state.entries.shift();
    state.dropped++;
  }
  state.entries.push(entry);
}
