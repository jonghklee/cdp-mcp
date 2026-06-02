import { describe, it, expect, beforeEach, vi } from 'vitest';
import { selectText } from '../select-text.js';

function createMockClient() {
  return {
    send: vi.fn().mockResolvedValue({ result: { value: 'selected text' } }),
    connected: true,
  };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(mockClient),
  };
}

describe('selectText', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
  });

  it('selects all text', async () => {
    const result = await selectText(mockPool as any, { mode: 'all' });

    expect(result.selected).toBe(true);
    expect(result.mode).toBe('all');
    expect(result.text).toBe('selected text');

    // Should dispatch key combo (modifier down, key press, modifier up)
    const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    expect(keyCalls.length).toBeGreaterThan(0);
    // Check that 'a' key was dispatched (Control+A or Meta+A)
    const hasA = keyCalls.some(c => c[1].key === 'a');
    expect(hasA).toBe(true);
  });

  it('selects characters with count', async () => {
    const result = await selectText(mockPool as any, {
      mode: 'character',
      direction: 'right',
      count: 3,
    });

    expect(result.selected).toBe(true);
    // 3 repeats of Shift+ArrowRight combo
    const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    const arrowCalls = keyCalls.filter(c => c[1].key === 'ArrowRight');
    expect(arrowCalls.length).toBe(6);  // 3 combos × 2 events (rawKeyDown + keyUp) per combo
  });

  it('selects word left', async () => {
    await selectText(mockPool as any, { mode: 'word', direction: 'left' });

    const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    const arrowCalls = keyCalls.filter(c => c[1].key === 'ArrowLeft');
    expect(arrowCalls.length).toBeGreaterThan(0);
  });

  it('selects line right (Shift+End)', async () => {
    await selectText(mockPool as any, { mode: 'line', direction: 'right' });

    const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    const endCalls = keyCalls.filter(c => c[1].key === 'End');
    expect(endCalls.length).toBeGreaterThan(0);
  });

  it('selects line left (Shift+Home)', async () => {
    await selectText(mockPool as any, { mode: 'line', direction: 'left' });

    const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    const homeCalls = keyCalls.filter(c => c[1].key === 'Home');
    expect(homeCalls.length).toBeGreaterThan(0);
  });

  it('selects to start', async () => {
    await selectText(mockPool as any, { mode: 'toStart' });

    const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    const homeCalls = keyCalls.filter(c => c[1].key === 'Home');
    expect(homeCalls.length).toBeGreaterThan(0);
  });

  it('selects to end', async () => {
    await selectText(mockPool as any, { mode: 'toEnd' });

    const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    const endCalls = keyCalls.filter(c => c[1].key === 'End');
    expect(endCalls.length).toBeGreaterThan(0);
  });

  it('focuses element via selector before selecting', async () => {
    await selectText(mockPool as any, { mode: 'all', selector: '#input' });

    const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
    const hasFocus = evalCalls.some(c => c[1]?.expression?.includes('focus'));
    expect(hasFocus).toBe(true);
  });

  it('returns selected text from input element', async () => {
    mockClient.send.mockResolvedValue({ result: { value: 'input selection' } });

    const result = await selectText(mockPool as any, {
      mode: 'all',
      selector: '#myinput',
    });

    expect(result.text).toBe('input selection');
  });
});
