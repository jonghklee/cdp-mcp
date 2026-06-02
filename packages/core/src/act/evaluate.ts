import type { ExecutionContext } from '@cdp-mcp/shared';
import { CdpEvaluationError, ContextError, createLogger } from '@cdp-mcp/shared';
import type { ContextRouter } from '../context/context-router.js';
import { adviseContext } from '../context/context-advisor.js';
import { CONTEXT_REQUIRED_MESSAGE } from '../context/context-types.js';

const logger = createLogger('evaluate');

export interface EvaluateOptions {
  code: string;
  context: ExecutionContext;
  returnByValue?: boolean;
  awaitPromise?: boolean;
  timeout?: number;
}

export interface EvaluateResult {
  value: unknown;
  type: string;
  context: ExecutionContext;
  advisedContext?: { recommended: ExecutionContext; reason: string };
}

export async function evaluate(
  router: ContextRouter,
  options: EvaluateOptions
): Promise<EvaluateResult> {
  const { code, context, returnByValue = true, awaitPromise = true } = options;

  // 1. context missing → error with guide
  if (!context) {
    throw new ContextError(CONTEXT_REQUIRED_MESSAGE);
  }

  // 2. advise context — warn if mismatch but don't block
  const advice = adviseContext(code);
  let advisedContext: EvaluateResult['advisedContext'] | undefined;

  if (advice.recommended !== context) {
    logger.warn(
      `Context mismatch: using '${context}' but recommended '${advice.recommended}' — ${advice.reason}`
    );
    advisedContext = {
      recommended: advice.recommended,
      reason: advice.reason,
    };
  }

  // 3. Route to the correct context
  const result = await router.evaluate(context, code, { returnByValue, awaitPromise });

  // 4. Check for exceptions
  if (result.exceptionDetails) {
    throw new CdpEvaluationError(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      result.exceptionDetails
    );
  }

  return {
    value: result.value,
    type: result.type,
    context,
    advisedContext,
  };
}
