import type { CdpSession } from '../cdp/cdp-session.js';
import type { FetchRequestPausedParams, FetchHeaderEntry } from '../cdp/protocol-types.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('network-intercept');

// ── Public types ──

export interface InterceptRule {
  id?: string;
  urlPattern: string;
  action: 'block' | 'modify_response' | 'delay';
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  delayMs?: number;
}

interface StoredRule extends InterceptRule {
  id: string;
  hitCount: number;
}

export interface StartInterceptResult {
  interceptId: string;
  targetId: string;
}

export interface StopInterceptResult {
  rules: Array<{ id: string; urlPattern: string; action: string; hitCount: number }>;
  totalIntercepted: number;
}

export interface AddRuleResult {
  ruleId: string;
}

export interface ListRulesResult {
  rules: Array<{ id: string; urlPattern: string; action: string; hitCount: number }>;
}

// ── Internal state ──

interface InterceptState {
  session: CdpSession;
  targetId: string;
  rules: StoredRule[];
  totalIntercepted: number;
  requestPausedHandler: (params: FetchRequestPausedParams) => void;
  disconnectHandler: () => void;
}

const intercepts = new Map<string, InterceptState>();
const targetToIntercept = new Map<string, string>(); // targetId → interceptId
let interceptCounter = 0;
let ruleCounter = 0;

// ── Public API ──

export async function startIntercept(
  session: CdpSession,
  targetId: string,
): Promise<StartInterceptResult> {
  // Prevent duplicate intercepts on the same target
  if (targetToIntercept.has(targetId)) {
    throw new Error(`Intercept already active on target ${targetId}: ${targetToIntercept.get(targetId)}`);
  }

  const interceptId = `int_${++interceptCounter}`;

  const state: InterceptState = {
    session,
    targetId,
    rules: [],
    totalIntercepted: 0,
    requestPausedHandler: (params) => handleRequestPaused(interceptId, params),
    disconnectHandler: () => handleDisconnect(interceptId),
  };

  intercepts.set(interceptId, state);
  targetToIntercept.set(targetId, interceptId);

  await session.send('Fetch.enable', {
    patterns: [{ requestStage: 'Request' }],
  });
  session.on('Fetch.requestPaused', state.requestPausedHandler);
  session.on('disconnected', state.disconnectHandler);

  logger.info(`Intercept started: ${interceptId} on target ${targetId}`);

  return { interceptId, targetId };
}

export function addRule(interceptId: string, rule: InterceptRule): AddRuleResult {
  const state = intercepts.get(interceptId);
  if (!state) {
    throw new Error(`Intercept not found: ${interceptId}`);
  }

  const ruleId = rule.id ?? `rule_${++ruleCounter}`;
  const storedRule: StoredRule = {
    ...rule,
    id: ruleId,
    hitCount: 0,
  };

  state.rules.push(storedRule);
  logger.info(`Rule added: ${ruleId} (${rule.action} ${rule.urlPattern}) to ${interceptId}`);

  return { ruleId };
}

export function removeRule(interceptId: string, ruleId: string): void {
  const state = intercepts.get(interceptId);
  if (!state) {
    throw new Error(`Intercept not found: ${interceptId}`);
  }

  const idx = state.rules.findIndex(r => r.id === ruleId);
  if (idx === -1) {
    throw new Error(`Rule not found: ${ruleId}`);
  }

  state.rules.splice(idx, 1);
  logger.info(`Rule removed: ${ruleId} from ${interceptId}`);
}

export function listRules(interceptId: string): ListRulesResult {
  const state = intercepts.get(interceptId);
  if (!state) {
    throw new Error(`Intercept not found: ${interceptId}`);
  }

  return {
    rules: state.rules.map(r => ({
      id: r.id,
      urlPattern: r.urlPattern,
      action: r.action,
      hitCount: r.hitCount,
    })),
  };
}

export async function stopIntercept(interceptId: string): Promise<StopInterceptResult> {
  const state = intercepts.get(interceptId);
  if (!state) {
    throw new Error(`Intercept not found: ${interceptId}`);
  }

  // Unsubscribe
  state.session.off('Fetch.requestPaused', state.requestPausedHandler);
  state.session.off('disconnected', state.disconnectHandler);

  // Disable Fetch domain
  try {
    await state.session.send('Fetch.disable');
  } catch {
    // Session may be disconnected
  }

  const result: StopInterceptResult = {
    rules: state.rules.map(r => ({
      id: r.id,
      urlPattern: r.urlPattern,
      action: r.action,
      hitCount: r.hitCount,
    })),
    totalIntercepted: state.totalIntercepted,
  };

  targetToIntercept.delete(state.targetId);
  intercepts.delete(interceptId);
  logger.info(`Intercept stopped: ${interceptId} (${result.totalIntercepted} intercepted)`);

  return result;
}

export function clearAllIntercepts(): void {
  for (const [interceptId, state] of intercepts) {
    state.session.off('Fetch.requestPaused', state.requestPausedHandler);
    state.session.off('disconnected', state.disconnectHandler);
    logger.debug(`Intercept cleared: ${interceptId}`);
  }
  intercepts.clear();
  targetToIntercept.clear();
  interceptCounter = 0;
  ruleCounter = 0;
}

// ── Internal handlers ──

async function handleRequestPaused(interceptId: string, params: FetchRequestPausedParams): Promise<void> {
  const state = intercepts.get(interceptId);
  if (!state) return;

  const matchedRule = state.rules.find(rule =>
    params.request.url.includes(rule.urlPattern)
  );

  if (!matchedRule) {
    // No matching rule: continue the request
    try {
      await state.session.send('Fetch.continueRequest', { requestId: params.requestId });
    } catch {
      // Request may have been cancelled
    }
    return;
  }

  matchedRule.hitCount++;
  state.totalIntercepted++;

  try {
    switch (matchedRule.action) {
      case 'block':
        await state.session.send('Fetch.failRequest', {
          requestId: params.requestId,
          reason: 'BlockedByClient',
        });
        break;

      case 'modify_response': {
        const headers: FetchHeaderEntry[] = matchedRule.responseHeaders
          ? Object.entries(matchedRule.responseHeaders).map(([name, value]) => ({ name, value }))
          : [];

        const body = matchedRule.responseBody
          ? Buffer.from(matchedRule.responseBody).toString('base64')
          : undefined;

        await state.session.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: matchedRule.statusCode ?? 200,
          responseHeaders: headers,
          body,
        });
        break;
      }

      case 'delay': {
        const delay = matchedRule.delayMs ?? 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        await state.session.send('Fetch.continueRequest', { requestId: params.requestId });
        break;
      }
    }
  } catch (err) {
    // Fallback: always continue on error to prevent browser hang
    logger.error(`Intercept handler error for ${matchedRule.action}, continuing request`, err);
    try {
      await state.session.send('Fetch.continueRequest', { requestId: params.requestId });
    } catch {
      // Nothing we can do
    }
  }
}

function handleDisconnect(interceptId: string): void {
  const state = intercepts.get(interceptId);
  if (!state) return;

  targetToIntercept.delete(state.targetId);
  intercepts.delete(interceptId);
  logger.info(`Intercept disconnected: ${interceptId}`);
}
