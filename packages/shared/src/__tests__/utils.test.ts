import { describe, it, expect, vi } from 'vitest';
import { sleep, retry, escapeSelector, timeout } from '../utils.js';
import { CdpTimeoutError } from '../errors.js';

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe('retry', () => {
  it('returns value on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, { maxRetries: 3, delay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds on retry after initial failures', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    const result = await retry(fn, { maxRetries: 3, delay: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws last error when all retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(
      retry(fn, { maxRetries: 2, delay: 1 })
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('supports exponential backoff', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    const start = Date.now();
    await retry(fn, { maxRetries: 3, delay: 20, backoff: 'exponential' });
    const elapsed = Date.now() - start;
    // delay=20 * 2^0 = 20, delay=20 * 2^1 = 40 => total >= 60
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('wraps non-Error thrown values into Error', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    await expect(
      retry(fn, { maxRetries: 0, delay: 1 })
    ).rejects.toThrow('string error');
  });
});

describe('escapeSelector', () => {
  it('escapes special CSS characters', () => {
    expect(escapeSelector('my.class')).toBe('my\\.class');
    expect(escapeSelector('#id')).toBe('\\#id');
    expect(escapeSelector('a[b]')).toBe('a\\[b\\]');
    expect(escapeSelector('foo:bar')).toBe('foo\\:bar');
  });

  it('returns plain strings unchanged', () => {
    expect(escapeSelector('simple')).toBe('simple');
    expect(escapeSelector('hello-world')).toBe('hello-world');
    expect(escapeSelector('under_score')).toBe('under_score');
  });
});

describe('timeout', () => {
  it('resolves if promise completes before timeout', async () => {
    const fast = Promise.resolve('done');
    const result = await timeout(fast, 1000);
    expect(result).toBe('done');
  });

  it('rejects with CdpTimeoutError if promise is too slow', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 500));
    await expect(timeout(slow, 10)).rejects.toThrow(CdpTimeoutError);
  });

  it('includes timeout duration in error', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 500));
    try {
      await timeout(slow, 25);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CdpTimeoutError);
      expect((err as CdpTimeoutError).timeoutMs).toBe(25);
      expect((err as CdpTimeoutError).message).toContain('25ms');
    }
  });

  it('propagates original error if promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original error'));
    await expect(timeout(failing, 1000)).rejects.toThrow('original error');
  });
});
