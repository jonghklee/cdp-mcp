import type { ExecutionContext } from '@cdp-mcp/shared';
import { ContextError, createLogger } from '@cdp-mcp/shared';
import type { ConnectionPool } from '../cdp/connection-pool.js';
import { CONTEXT_REQUIRED_MESSAGE } from './context-types.js';

const logger = createLogger('context-router');

export interface EvaluationResult {
  value: unknown;
  type: string;
  subtype?: string;
  exceptionDetails?: {
    text: string;
    exception?: { description: string };
  };
}

export interface EvaluateOptions {
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

export class ContextRouter {
  constructor(private readonly pool: ConnectionPool) {}

  async evaluate(
    context: ExecutionContext,
    code: string,
    options?: EvaluateOptions
  ): Promise<EvaluationResult> {
    if (!context) {
      throw new ContextError(CONTEXT_REQUIRED_MESSAGE);
    }

    const returnByValue = options?.returnByValue ?? true;
    const awaitPromise = options?.awaitPromise ?? true;

    switch (context) {
      case 'page':
        return this.evaluateInPage(code, returnByValue, awaitPromise);
      case 'content':
        return this.evaluateInContent(code, returnByValue, awaitPromise);
      case 'worker':
        return this.evaluateInWorker(code, returnByValue, awaitPromise);
      case 'popup':
        return this.evaluateInPopup(code, returnByValue, awaitPromise);
      default:
        throw new ContextError(`Unknown context: ${context}`);
    }
  }

  private async evaluateInPage(
    code: string,
    returnByValue: boolean,
    awaitPromise: boolean
  ): Promise<EvaluationResult> {
    const client = await this.pool.getActiveTab();
    // 실행 직전에 다시 깨운다 — 창을 올리지 않고 백그라운드 탭의 비동기 작업이 멈추지 않게.
    try { await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* noop */ }
    try { await client.send('Page.setWebLifecycleState', { state: 'active' }); } catch { /* noop */ }
    const result = await client.send<{
      result: { type: string; subtype?: string; value?: unknown };
      exceptionDetails?: Record<string, unknown>;
    }>('Runtime.evaluate', {
      expression: code,
      returnByValue,
      awaitPromise,
    });
    return this.formatResult(result);
  }

  private async evaluateInContent(
    code: string,
    returnByValue: boolean,
    awaitPromise: boolean
  ): Promise<EvaluationResult> {
    const client = await this.pool.getActiveTab();

    // Get the main frame ID
    const frameTree = await client.send<{
      frameTree: { frame: { id: string } };
    }>('Page.getFrameTree', {});
    const frameId = frameTree.frameTree.frame.id;

    // Create an isolated world for content script-like execution
    const world = await client.send<{ executionContextId: number }>(
      'Page.createIsolatedWorld',
      {
        frameId,
        worldName: 'cdp-mcp-content',
      }
    );

    const result = await client.send<{
      result: { type: string; subtype?: string; value?: unknown };
      exceptionDetails?: Record<string, unknown>;
    }>('Runtime.evaluate', {
      expression: code,
      contextId: world.executionContextId,
      returnByValue,
      awaitPromise,
    });

    return this.formatResult(result);
  }

  private async evaluateInWorker(
    code: string,
    returnByValue: boolean,
    awaitPromise: boolean
  ): Promise<EvaluationResult> {
    const client = await this.pool.getExtensionWorker();
    const result = await client.send<{
      result: { type: string; subtype?: string; value?: unknown };
      exceptionDetails?: Record<string, unknown>;
    }>('Runtime.evaluate', {
      expression: code,
      returnByValue,
      awaitPromise,
    });
    return this.formatResult(result);
  }

  private async evaluateInPopup(
    code: string,
    returnByValue: boolean,
    awaitPromise: boolean
  ): Promise<EvaluationResult> {
    const client = await this.pool.getPopupTab();
    const result = await client.send<{
      result: { type: string; subtype?: string; value?: unknown };
      exceptionDetails?: Record<string, unknown>;
    }>('Runtime.evaluate', {
      expression: code,
      returnByValue,
      awaitPromise,
    });
    return this.formatResult(result);
  }

  private formatResult(raw: {
    result: { type: string; subtype?: string; value?: unknown };
    exceptionDetails?: Record<string, unknown>;
  }): EvaluationResult {
    const result: EvaluationResult = {
      value: raw.result.value,
      type: raw.result.type,
    };
    if (raw.result.subtype) {
      result.subtype = raw.result.subtype;
    }
    if (raw.exceptionDetails) {
      result.exceptionDetails = {
        text: raw.exceptionDetails.text as string,
        exception: raw.exceptionDetails.exception
          ? {
              description: (
                raw.exceptionDetails.exception as { description: string }
              ).description,
            }
          : undefined,
      };
    }
    return result;
  }
}
