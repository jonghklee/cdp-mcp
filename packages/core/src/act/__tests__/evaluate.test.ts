import { describe, it, expect, beforeEach, vi } from 'vitest';
import { evaluate } from '../evaluate.js';
import { CdpEvaluationError, ContextError } from '@cdp-mcp/shared';

function createMockRouter() {
  return {
    evaluate: vi.fn(),
  };
}

describe('evaluate', () => {
  let mockRouter: ReturnType<typeof createMockRouter>;

  beforeEach(() => {
    mockRouter = createMockRouter();
  });

  it('evaluates code in the specified context', async () => {
    mockRouter.evaluate.mockResolvedValue({
      value: 'Hello',
      type: 'string',
    });

    const result = await evaluate(mockRouter as any, {
      code: 'document.title',
      context: 'page',
    });

    expect(result.value).toBe('Hello');
    expect(result.type).toBe('string');
    expect(result.context).toBe('page');
    expect(mockRouter.evaluate).toHaveBeenCalledWith('page', 'document.title', {
      returnByValue: true,
      awaitPromise: true,
    });
  });

  it('throws ContextError when context is missing', async () => {
    await expect(
      evaluate(mockRouter as any, { code: 'test', context: undefined as any })
    ).rejects.toThrow(ContextError);
  });

  it('includes advised context when mismatch', async () => {
    mockRouter.evaluate.mockResolvedValue({
      value: undefined,
      type: 'undefined',
    });

    // chrome.storage code in 'page' context — should advise 'worker'
    const result = await evaluate(mockRouter as any, {
      code: 'chrome.storage.local.get("key")',
      context: 'page',
    });

    expect(result.advisedContext).toBeDefined();
    expect(result.advisedContext!.recommended).toBe('worker');
  });

  it('does not include advisedContext when context matches', async () => {
    mockRouter.evaluate.mockResolvedValue({
      value: { key: 'val' },
      type: 'object',
    });

    const result = await evaluate(mockRouter as any, {
      code: 'chrome.storage.local.get("key")',
      context: 'worker',
    });

    expect(result.advisedContext).toBeUndefined();
  });

  it('throws CdpEvaluationError on exception', async () => {
    mockRouter.evaluate.mockResolvedValue({
      value: undefined,
      type: 'object',
      exceptionDetails: {
        text: 'Uncaught Error',
        exception: { description: 'Error: test error' },
      },
    });

    await expect(
      evaluate(mockRouter as any, { code: 'throw new Error("test")', context: 'page' })
    ).rejects.toThrow(CdpEvaluationError);
  });

  it('respects custom returnByValue and awaitPromise options', async () => {
    mockRouter.evaluate.mockResolvedValue({
      value: {},
      type: 'object',
    });

    await evaluate(mockRouter as any, {
      code: 'fetch("/")',
      context: 'page',
      returnByValue: false,
      awaitPromise: false,
    });

    expect(mockRouter.evaluate).toHaveBeenCalledWith('page', 'fetch("/")', {
      returnByValue: false,
      awaitPromise: false,
    });
  });
});
