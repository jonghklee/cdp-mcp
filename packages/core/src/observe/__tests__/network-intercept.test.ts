import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startIntercept,
  stopIntercept,
  addRule,
  removeRule,
  listRules,
  clearAllIntercepts,
} from '../network-intercept.js';

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

function emitPausedRequest(session: MockSession, requestId: string, url: string) {
  session.emit('Fetch.requestPaused', {
    requestId,
    request: { url, method: 'GET', headers: {} },
    resourceType: 'Fetch',
  });
}

// ── Tests ──

describe('network-intercept', () => {
  let session: MockSession;

  beforeEach(() => {
    clearAllIntercepts();
    session = createMockSession();
  });

  describe('startIntercept', () => {
    it('enables Fetch and subscribes to events', async () => {
      const result = await startIntercept(session as any, 'target-1');

      expect(result.interceptId).toMatch(/^int_/);
      expect(result.targetId).toBe('target-1');
      expect(session.send).toHaveBeenCalledWith('Fetch.enable', {
        patterns: [{ requestStage: 'Request' }],
      });
      expect(session._handlers.get('Fetch.requestPaused')?.size).toBe(1);
      expect(session._handlers.get('disconnected')?.size).toBe(1);
    });

    it('prevents duplicate intercepts on same target', async () => {
      await startIntercept(session as any, 'target-1');

      await expect(startIntercept(session as any, 'target-1'))
        .rejects.toThrow('Intercept already active');
    });
  });

  describe('rule management', () => {
    it('adds a rule', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');

      const { ruleId } = addRule(interceptId, {
        urlPattern: '/api/test',
        action: 'block',
      });

      expect(ruleId).toMatch(/^rule_/);

      const { rules } = listRules(interceptId);
      expect(rules).toHaveLength(1);
      expect(rules[0].urlPattern).toBe('/api/test');
      expect(rules[0].action).toBe('block');
    });

    it('accepts custom rule id', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');

      const { ruleId } = addRule(interceptId, {
        id: 'my-rule',
        urlPattern: '/api/test',
        action: 'block',
      });

      expect(ruleId).toBe('my-rule');
    });

    it('removes a rule', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');
      const { ruleId } = addRule(interceptId, { urlPattern: '/test', action: 'block' });

      removeRule(interceptId, ruleId);

      const { rules } = listRules(interceptId);
      expect(rules).toHaveLength(0);
    });

    it('throws when removing nonexistent rule', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');

      expect(() => removeRule(interceptId, 'nonexistent')).toThrow('Rule not found');
    });

    it('throws for unknown interceptId', () => {
      expect(() => addRule('nonexistent', { urlPattern: '/test', action: 'block' }))
        .toThrow('Intercept not found');
      expect(() => listRules('nonexistent')).toThrow('Intercept not found');
      expect(() => removeRule('nonexistent', 'rule-1')).toThrow('Intercept not found');
    });
  });

  describe('request handling', () => {
    it('continues requests with no matching rule', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');
      addRule(interceptId, { urlPattern: '/blocked', action: 'block' });

      emitPausedRequest(session, 'req-1', 'https://example.com/allowed');

      // Wait for async handler
      await vi.waitFor(() => {
        expect(session.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'req-1' });
      });
    });

    it('blocks matching requests', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');
      addRule(interceptId, { urlPattern: '/ads/', action: 'block' });

      emitPausedRequest(session, 'req-1', 'https://example.com/ads/banner');

      await vi.waitFor(() => {
        expect(session.send).toHaveBeenCalledWith('Fetch.failRequest', {
          requestId: 'req-1',
          reason: 'BlockedByClient',
        });
      });
    });

    it('modifies response for matching requests', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');
      addRule(interceptId, {
        urlPattern: '/api/mock',
        action: 'modify_response',
        statusCode: 200,
        responseHeaders: { 'Content-Type': 'application/json' },
        responseBody: '{"mocked":true}',
      });

      emitPausedRequest(session, 'req-1', 'https://example.com/api/mock');

      await vi.waitFor(() => {
        expect(session.send).toHaveBeenCalledWith('Fetch.fulfillRequest', {
          requestId: 'req-1',
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from('{"mocked":true}').toString('base64'),
        });
      });
    });

    it('delays matching requests', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');
      addRule(interceptId, { urlPattern: '/slow', action: 'delay', delayMs: 50 });

      const start = Date.now();
      emitPausedRequest(session, 'req-1', 'https://example.com/slow/api');

      await vi.waitFor(() => {
        expect(session.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'req-1' });
      });

      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });

    it('tracks hit count', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');
      addRule(interceptId, { urlPattern: '/api', action: 'block' });

      emitPausedRequest(session, 'req-1', 'https://example.com/api/a');
      emitPausedRequest(session, 'req-2', 'https://example.com/api/b');

      // Wait for both to be processed
      await vi.waitFor(() => {
        const { rules } = listRules(interceptId);
        expect(rules[0].hitCount).toBe(2);
      });
    });

    it('matches first rule in order', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');
      addRule(interceptId, { urlPattern: '/api', action: 'block' });
      addRule(interceptId, { urlPattern: '/api', action: 'delay', delayMs: 100 });

      emitPausedRequest(session, 'req-1', 'https://example.com/api/test');

      await vi.waitFor(() => {
        // First rule (block) should be applied
        expect(session.send).toHaveBeenCalledWith('Fetch.failRequest', expect.anything());
      });

      const { rules } = listRules(interceptId);
      expect(rules[0].hitCount).toBe(1);
      expect(rules[1].hitCount).toBe(0);
    });
  });

  describe('stopIntercept', () => {
    it('disables Fetch and returns stats', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');
      addRule(interceptId, { urlPattern: '/api', action: 'block' });

      emitPausedRequest(session, 'req-1', 'https://example.com/api/test');

      await vi.waitFor(async () => {
        const result = await stopIntercept(interceptId);
        expect(result.rules).toHaveLength(1);
        expect(result.totalIntercepted).toBe(1);
      });

      expect(session.send).toHaveBeenCalledWith('Fetch.disable');

      // Handlers removed
      expect(session._handlers.get('Fetch.requestPaused')?.size ?? 0).toBe(0);

      // Can start new intercept on same target
      await startIntercept(session as any, 'target-1');
    });

    it('throws for unknown interceptId', async () => {
      await expect(stopIntercept('nonexistent')).rejects.toThrow('Intercept not found');
    });
  });

  describe('disconnect', () => {
    it('cleans up on disconnect', async () => {
      const { interceptId } = await startIntercept(session as any, 'target-1');

      session.emit('disconnected');

      // Should be cleaned up
      expect(() => listRules(interceptId)).toThrow('Intercept not found');

      // Can start new intercept on same target
      await startIntercept(session as any, 'target-1');
    });
  });

  describe('clearAllIntercepts', () => {
    it('clears all intercepts', async () => {
      const r1 = await startIntercept(session as any, 'target-1');

      const session2 = createMockSession();
      await startIntercept(session2 as any, 'target-2');

      clearAllIntercepts();

      expect(() => listRules(r1.interceptId)).toThrow('Intercept not found');

      // Can re-use targets
      await startIntercept(session as any, 'target-1');
    });
  });
});
