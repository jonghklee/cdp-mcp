import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startCapture,
  stopCapture,
  getMessages,
  clearAllCaptures,
  serializeArg,
  serializeArgs,
} from '../console-capture.js';
import type { RemoteObject } from '../../cdp/protocol-types.js';

// ── Mock CdpSession ──

function createMockSession() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    connected: true,
    send: vi.fn().mockResolvedValue(undefined),
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return this;
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      const fns = handlers.get(event);
      if (fns) {
        for (const fn of fns) fn(...args);
      }
    },
    _handlers: handlers,
  };
}

type MockSession = ReturnType<typeof createMockSession>;

// ── Tests ──

describe('serializeArg', () => {
  it('serializes string value', () => {
    expect(serializeArg({ type: 'string', value: 'hello' })).toBe('hello');
  });

  it('serializes number value', () => {
    expect(serializeArg({ type: 'number', value: 42 })).toBe('42');
  });

  it('serializes boolean value', () => {
    expect(serializeArg({ type: 'boolean', value: true })).toBe('true');
  });

  it('serializes null value', () => {
    expect(serializeArg({ type: 'object', subtype: 'null', value: null })).toBe('null');
  });

  it('serializes undefined', () => {
    expect(serializeArg({ type: 'undefined' })).toBe('undefined');
  });

  it('uses description when no value', () => {
    expect(serializeArg({ type: 'object', description: 'HTMLDivElement' })).toBe('HTMLDivElement');
  });

  it('falls back to type:subtype', () => {
    expect(serializeArg({ type: 'object', subtype: 'regexp' })).toBe('[object:regexp]');
  });

  it('falls back to type only', () => {
    expect(serializeArg({ type: 'function' })).toBe('[function]');
  });
});

describe('serializeArgs', () => {
  it('joins multiple args with space', () => {
    const args: RemoteObject[] = [
      { type: 'string', value: 'count:' },
      { type: 'number', value: 3 },
    ];
    expect(serializeArgs(args)).toBe('count: 3');
  });
});

describe('console-capture', () => {
  let session: MockSession;

  beforeEach(() => {
    clearAllCaptures();
    session = createMockSession();
  });

  it('startCapture enables Runtime and subscribes to events', async () => {
    const result = await startCapture(session as any, 'target-1');

    expect(result.captureId).toMatch(/^cap_/);
    expect(result.targetId).toBe('target-1');
    expect(result.status).toBe('capturing');
    expect(session.send).toHaveBeenCalledWith('Runtime.enable');
    expect(session._handlers.get('Runtime.consoleAPICalled')?.size).toBe(1);
    expect(session._handlers.get('Runtime.exceptionThrown')?.size).toBe(1);
    expect(session._handlers.get('disconnected')?.size).toBe(1);
  });

  it('captures console.log events', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'hello world' }],
      executionContextId: 1,
      timestamp: 1000,
    });

    const result = getMessages({ captureId });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      level: 'log',
      text: 'hello world',
      source: 'console',
      timestamp: 1000,
    });
    expect(result.totalReceived).toBe(1);
    expect(result.capturing).toBe(true);
  });

  it('maps CDP warning type to warn level', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ type: 'string', value: 'deprecated' }],
      executionContextId: 1,
      timestamp: 1000,
    });

    const { entries } = getMessages({ captureId });
    expect(entries[0].level).toBe('warn');
  });

  it('maps CDP assert type to error level', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.consoleAPICalled', {
      type: 'assert',
      args: [{ type: 'string', value: 'assertion failed' }],
      executionContextId: 1,
      timestamp: 1000,
    });

    const { entries } = getMessages({ captureId });
    expect(entries[0].level).toBe('error');
  });

  it('filters by level', async () => {
    const { captureId } = await startCapture(session as any, 'target-1', {
      levels: ['error'],
    });

    // log → filtered out
    session.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'info msg' }],
      executionContextId: 1,
      timestamp: 1000,
    });

    // error → captured
    session.emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'error msg' }],
      executionContextId: 1,
      timestamp: 1001,
    });

    const { entries, totalReceived } = getMessages({ captureId });
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('error msg');
    expect(totalReceived).toBe(1);
  });

  it('captures exception events', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.exceptionThrown', {
      timestamp: 2000,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught ReferenceError',
        lineNumber: 10,
        columnNumber: 5,
        exception: { type: 'object', description: 'ReferenceError: foo is not defined' },
      },
    });

    const { entries } = getMessages({ captureId });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      text: 'ReferenceError: foo is not defined',
      source: 'exception',
      timestamp: 2000,
    });
  });

  it('exception without exception.description uses text', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.exceptionThrown', {
      timestamp: 2000,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Script error.',
        lineNumber: 0,
        columnNumber: 0,
      },
    });

    const { entries } = getMessages({ captureId });
    expect(entries[0].text).toBe('Script error.');
  });

  it('exceptions filtered when error level excluded', async () => {
    const { captureId } = await startCapture(session as any, 'target-1', {
      levels: ['log'],
    });

    session.emit('Runtime.exceptionThrown', {
      timestamp: 2000,
      exceptionDetails: {
        exceptionId: 1,
        text: 'error',
        lineNumber: 0,
        columnNumber: 0,
      },
    });

    const { entries } = getMessages({ captureId });
    expect(entries).toHaveLength(0);
  });

  it('ring buffer drops oldest entries', async () => {
    const { captureId } = await startCapture(session as any, 'target-1', {
      maxEntries: 3,
    });

    for (let i = 0; i < 5; i++) {
      session.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ type: 'string', value: `msg-${i}` }],
        executionContextId: 1,
        timestamp: 1000 + i,
      });
    }

    const result = getMessages({ captureId });
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].text).toBe('msg-2');
    expect(result.entries[2].text).toBe('msg-4');
    expect(result.totalReceived).toBe(5);
    expect(result.dropped).toBe(2);
  });

  it('getMessages with clear empties the buffer', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'msg' }],
      executionContextId: 1,
      timestamp: 1000,
    });

    const first = getMessages({ captureId, clear: true });
    expect(first.entries).toHaveLength(1);

    const second = getMessages({ captureId });
    expect(second.entries).toHaveLength(0);
    expect(second.totalReceived).toBe(1); // counter preserved
  });

  it('disconnect changes status to stopped_disconnected', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('disconnected');

    const result = getMessages({ captureId });
    expect(result.capturing).toBe(false);

    // New events should be ignored
    session.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'after disconnect' }],
      executionContextId: 1,
      timestamp: 3000,
    });

    const result2 = getMessages({ captureId });
    expect(result2.entries).toHaveLength(0);
  });

  it('stopCapture returns entries and cleans up', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'captured' }],
      executionContextId: 1,
      timestamp: 1000,
    });

    const result = stopCapture(captureId);
    expect(result.entries).toHaveLength(1);
    expect(result.status).toBe('stopped');
    expect(result.totalReceived).toBe(1);

    // Handlers removed
    expect(session._handlers.get('Runtime.consoleAPICalled')?.size ?? 0).toBe(0);
    expect(session._handlers.get('Runtime.exceptionThrown')?.size ?? 0).toBe(0);

    // Cannot query again
    expect(() => getMessages({ captureId })).toThrow('Capture not found');
  });

  it('stopCapture preserves stopped_disconnected status', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');
    session.emit('disconnected');

    const result = stopCapture(captureId);
    expect(result.status).toBe('stopped_disconnected');
  });

  it('stopCapture throws for unknown captureId', () => {
    expect(() => stopCapture('nonexistent')).toThrow('Capture not found');
  });

  it('getMessages throws for unknown captureId', () => {
    expect(() => getMessages({ captureId: 'nonexistent' })).toThrow('Capture not found');
  });

  it('captures stackTrace from console event', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'oops' }],
      executionContextId: 1,
      timestamp: 1000,
      stackTrace: {
        callFrames: [
          { functionName: 'doStuff', scriptId: '1', url: 'app.js', lineNumber: 10, columnNumber: 5 },
          { functionName: '', scriptId: '1', url: 'app.js', lineNumber: 1, columnNumber: 0 },
        ],
      },
    });

    const { entries } = getMessages({ captureId });
    expect(entries[0].stackTrace).toContain('at doStuff (app.js:10:5)');
    expect(entries[0].stackTrace).toContain('at (anonymous) (app.js:1:0)');
  });

  it('captures stackTrace from exception event', async () => {
    const { captureId } = await startCapture(session as any, 'target-1');

    session.emit('Runtime.exceptionThrown', {
      timestamp: 2000,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Error',
        lineNumber: 5,
        columnNumber: 0,
        stackTrace: {
          callFrames: [
            { functionName: 'init', scriptId: '2', url: 'main.js', lineNumber: 5, columnNumber: 3 },
          ],
        },
      },
    });

    const { entries } = getMessages({ captureId });
    expect(entries[0].stackTrace).toContain('at init (main.js:5:3)');
  });

  it('multiple concurrent captures are independent', async () => {
    const r1 = await startCapture(session as any, 'target-1');
    const r2 = await startCapture(session as any, 'target-2', { levels: ['error'] });

    // Emit log → only capture 1 gets it
    session.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'log msg' }],
      executionContextId: 1,
      timestamp: 1000,
    });

    // Emit error → both get it
    session.emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'error msg' }],
      executionContextId: 1,
      timestamp: 1001,
    });

    const m1 = getMessages({ captureId: r1.captureId });
    const m2 = getMessages({ captureId: r2.captureId });

    expect(m1.entries).toHaveLength(2);
    expect(m2.entries).toHaveLength(1);
    expect(m2.entries[0].text).toBe('error msg');
  });

  it('clearAllCaptures cleans up all captures', async () => {
    const r1 = await startCapture(session as any, 'target-1');
    await startCapture(session as any, 'target-2');

    clearAllCaptures();

    expect(() => getMessages({ captureId: r1.captureId })).toThrow('Capture not found');
  });
});
