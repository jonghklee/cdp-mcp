import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pressKey } from '../press-key.js';

function createMockClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
    connected: true,
  };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(mockClient),
  };
}

describe('pressKey', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
  });

  it('presses a single key (Enter)', async () => {
    const result = await pressKey(mockPool as any, { key: 'Enter' });

    expect(result.pressed).toBe(true);
    expect(result.action).toBe('press');

    // rawKeyDown + keyUp
    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    expect(calls.length).toBe(2);
    expect(calls[0][1].type).toBe('rawKeyDown');
    expect(calls[0][1].key).toBe('Enter');
    expect(calls[1][1].type).toBe('keyUp');
  });

  it('presses a character key with text', async () => {
    await pressKey(mockPool as any, { key: 'a' });

    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    expect(calls.length).toBe(2);
    // Character key uses keyDown (not rawKeyDown) with text
    expect(calls[0][1].type).toBe('keyDown');
    expect(calls[0][1].text).toBe('a');
    expect(calls[1][1].type).toBe('keyUp');
  });

  it('dispatches combo: Control+A', async () => {
    await pressKey(mockPool as any, { key: 'Control+a' });

    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    // Control down, 'a' rawKeyDown (with modifier), 'a' keyUp, Control up
    expect(calls.length).toBe(4);
    expect(calls[0][1].key).toBe('Control');
    expect(calls[0][1].type).toBe('rawKeyDown');
    expect(calls[1][1].key).toBe('a');
    expect(calls[1][1].modifiers).toBe(2); // Control bitmask
    expect(calls[3][1].key).toBe('Control');
    expect(calls[3][1].type).toBe('keyUp');
  });

  it('dispatches key sequence', async () => {
    await pressKey(mockPool as any, { keys: ['Tab', 'Enter'] });

    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    // Tab: rawKeyDown + keyUp, Enter: rawKeyDown + keyUp = 4
    expect(calls.length).toBe(4);
    expect(calls[0][1].key).toBe('Tab');
    expect(calls[2][1].key).toBe('Enter');
  });

  it('repeats key multiple times', async () => {
    await pressKey(mockPool as any, { key: 'Tab', repeat: 3 });

    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    // 3 repeats * 2 events (down + up) = 6
    expect(calls.length).toBe(6);
  });

  it('supports action=down (hold)', async () => {
    await pressKey(mockPool as any, { key: 'Shift', action: 'down' });

    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    expect(calls.length).toBe(1);
    expect(calls[0][1].type).toBe('rawKeyDown');
    expect(calls[0][1].key).toBe('Shift');
  });

  it('supports action=up (release)', async () => {
    await pressKey(mockPool as any, { key: 'Shift', action: 'up' });

    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    expect(calls.length).toBe(1);
    expect(calls[0][1].type).toBe('keyUp');
    expect(calls[0][1].key).toBe('Shift');
  });

  it('resolves key aliases', async () => {
    await pressKey(mockPool as any, { key: 'Esc' });

    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    expect(calls[0][1].key).toBe('Escape');
  });

  it('throws when neither key nor keys provided', async () => {
    await expect(pressKey(mockPool as any, {})).rejects.toThrow('Either key or keys must be provided');
  });

  it('handles multi-modifier combo: Control+Shift+K', async () => {
    await pressKey(mockPool as any, { key: 'Control+Shift+K' });

    const calls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
    // Control down, Shift down, K rawKeyDown, K keyUp, Shift up, Control up = 6
    expect(calls.length).toBe(6);
    expect(calls[0][1].key).toBe('Control');
    expect(calls[1][1].key).toBe('Shift');
    expect(calls[2][1].key).toBe('k');  // resolveKeyName lowercases single chars
    expect(calls[2][1].modifiers).toBe(10); // Control(2) | Shift(8)
  });
});
