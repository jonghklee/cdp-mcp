import { CdpTimeoutError } from './errors.js';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries: number;
  delay: number;
  backoff?: 'linear' | 'exponential';
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < opts.maxRetries) {
        const delayMs = opts.backoff === 'exponential'
          ? opts.delay * Math.pow(2, attempt)
          : opts.delay;
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

export function escapeSelector(s: string): string {
  return s.replace(/([\\!"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, '\\$1');
}

export function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpTimeoutError(`Operation timed out after ${ms}ms`, ms));
    }, ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}
