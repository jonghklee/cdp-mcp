import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clipboard } from '../clipboard.js';

function createMockClient() {
  return {
    send: vi.fn().mockResolvedValue({ result: { value: '' } }),
    connected: true,
  };
}

function createMockBrowserClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
    connected: true,
  };
}

function createMockPool(
  mockClient: ReturnType<typeof createMockClient>,
  mockBrowserClient: ReturnType<typeof createMockBrowserClient>,
) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(mockClient),
    getBrowserClient: vi.fn().mockReturnValue(mockBrowserClient),
  };
}

describe('clipboard', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockBrowserClient: ReturnType<typeof createMockBrowserClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockBrowserClient = createMockBrowserClient();
    mockPool = createMockPool(mockClient, mockBrowserClient);
  });

  describe('copy', () => {
    it('reads selection and dispatches Ctrl+C', async () => {
      mockClient.send.mockResolvedValue({ result: { value: 'copied text' } });

      const result = await clipboard(mockPool as any, { action: 'copy' });

      expect(result.success).toBe(true);
      expect(result.action).toBe('copy');
      expect(result.text).toBe('copied text');

      // Should have key events for copy shortcut
      const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
      expect(keyCalls.length).toBeGreaterThan(0);
    });
  });

  describe('cut', () => {
    it('reads selection and dispatches Ctrl+X', async () => {
      mockClient.send.mockResolvedValue({ result: { value: 'cut text' } });

      const result = await clipboard(mockPool as any, { action: 'cut' });

      expect(result.success).toBe(true);
      expect(result.action).toBe('cut');
      expect(result.text).toBe('cut text');

      const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
      expect(keyCalls.length).toBeGreaterThan(0);
    });
  });

  describe('paste', () => {
    it('pastes text via ClipboardEvent when text provided', async () => {
      const result = await clipboard(mockPool as any, {
        action: 'paste',
        text: 'hello world',
      });

      expect(result.success).toBe(true);
      expect(result.text).toBe('hello world');

      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasPaste = evalCalls.some(c => c[1]?.expression?.includes('ClipboardEvent'));
      expect(hasPaste).toBe(true);
    });

    it('dispatches Ctrl+V when no text provided', async () => {
      const result = await clipboard(mockPool as any, { action: 'paste' });

      expect(result.success).toBe(true);

      const keyCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
      expect(keyCalls.length).toBeGreaterThan(0);
      const hasV = keyCalls.some(c => c[1].key === 'v');
      expect(hasV).toBe(true);
    });
  });

  describe('read', () => {
    it('grants clipboard permission and reads', async () => {
      mockClient.send.mockResolvedValue({ result: { value: 'clipboard content' } });

      const result = await clipboard(mockPool as any, { action: 'read' });

      expect(result.success).toBe(true);
      expect(result.text).toBe('clipboard content');

      // Check Browser.grantPermissions was called on browser client
      expect(mockBrowserClient.send).toHaveBeenCalledWith('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
    });
  });

  describe('selector', () => {
    it('focuses element before action', async () => {
      mockClient.send.mockResolvedValue({ result: { value: '' } });

      await clipboard(mockPool as any, { action: 'copy', selector: '#target' });

      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasFocus = evalCalls.some(c => c[1]?.expression?.includes('focus'));
      expect(hasFocus).toBe(true);
    });

    it('uses selector for paste target', async () => {
      await clipboard(mockPool as any, {
        action: 'paste',
        text: 'test',
        selector: '#input',
      });

      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasPaste = evalCalls.some(c =>
        c[1]?.expression?.includes('ClipboardEvent') && c[1]?.expression?.includes('#input')
      );
      expect(hasPaste).toBe(true);
    });
  });

  it('throws for unknown action', async () => {
    await expect(
      clipboard(mockPool as any, { action: 'invalid' as any })
    ).rejects.toThrow('Unknown clipboard action');
  });
});
