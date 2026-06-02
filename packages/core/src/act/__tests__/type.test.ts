import { describe, it, expect, beforeEach, vi } from 'vitest';
import { typeText } from '../type.js';

function createMockClient() {
  return {
    send: vi.fn().mockResolvedValue({ result: { value: undefined } }),
    connected: true,
  };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(mockClient),
  };
}

describe('typeText', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
  });

  describe('keyboard method', () => {
    it('types each character via Input.dispatchKeyEvent', async () => {
      const result = await typeText(mockPool as any, {
        selector: '#input',
        text: 'hi',
        method: 'keyboard',
      });

      expect(result.typed).toBe(true);
      expect(result.method).toBe('keyboard');
      // focusElement call + 2 chars * 2 events (keyDown + keyUp) = 1 + 4 = at least 5 calls
      const keyEvents = mockClient.send.mock.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
      expect(keyEvents.length).toBe(4); // 2 chars * 2 (keyDown + keyUp)
    });
  });

  describe('execCommand method', () => {
    it('inserts text via document.execCommand', async () => {
      const result = await typeText(mockPool as any, {
        selector: '#editor',
        text: 'hello',
        method: 'execCommand',
      });

      expect(result.typed).toBe(true);
      expect(result.method).toBe('execCommand');
      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasExecCommand = evalCalls.some(c => c[1]?.expression?.includes('insertText'));
      expect(hasExecCommand).toBe(true);
    });
  });

  describe('clipboard method', () => {
    it('dispatches paste ClipboardEvent', async () => {
      const result = await typeText(mockPool as any, {
        selector: '[data-lexical-editor]',
        text: 'pasted text',
        method: 'clipboard',
      });

      expect(result.typed).toBe(true);
      expect(result.method).toBe('clipboard');
      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasClipboard = evalCalls.some(c => c[1]?.expression?.includes('ClipboardEvent'));
      expect(hasClipboard).toBe(true);
    });
  });

  describe('nativeSetter method', () => {
    it('uses nativeInputValueSetter', async () => {
      const result = await typeText(mockPool as any, {
        selector: '#react-input',
        text: 'react value',
        method: 'nativeSetter',
      });

      expect(result.typed).toBe(true);
      expect(result.method).toBe('nativeSetter');
      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasSetter = evalCalls.some(c => c[1]?.expression?.includes('nativeSetter'));
      expect(hasSetter).toBe(true);
    });
  });

  describe('auto method', () => {
    it('selects keyboard for plain input', async () => {
      // First call is focus, second is detect (return plain input)
      mockClient.send
        .mockResolvedValueOnce({ result: { value: undefined } }) // focus
        .mockResolvedValueOnce({ result: { value: {
          isLexical: false, isProseMirror: false, isContentEditable: false,
          isInput: true, isTextarea: false, isReactControlled: false,
        }}})
        .mockResolvedValue({ result: { value: undefined } }); // remaining calls

      const result = await typeText(mockPool as any, {
        selector: '#input',
        text: 'x',
        method: 'auto',
      });

      expect(result.method).toBe('keyboard');
    });

    it('selects clipboard for Lexical editor', async () => {
      mockClient.send
        .mockResolvedValueOnce({ result: { value: undefined } }) // focus
        .mockResolvedValueOnce({ result: { value: {
          isLexical: true, isProseMirror: false, isContentEditable: true,
          isInput: false, isTextarea: false, isReactControlled: false,
        }}})
        .mockResolvedValue({ result: { value: undefined } }); // remaining

      const result = await typeText(mockPool as any, {
        selector: '[data-lexical-editor]',
        text: 'x',
        method: 'auto',
      });

      expect(result.method).toBe('clipboard');
    });

    it('selects execCommand for ProseMirror', async () => {
      mockClient.send
        .mockResolvedValueOnce({ result: { value: undefined } }) // focus
        .mockResolvedValueOnce({ result: { value: {
          isLexical: false, isProseMirror: true, isContentEditable: true,
          isInput: false, isTextarea: false, isReactControlled: false,
        }}})
        .mockResolvedValue({ result: { value: undefined } }); // remaining

      const result = await typeText(mockPool as any, {
        selector: '.ProseMirror',
        text: 'x',
        method: 'auto',
      });

      expect(result.method).toBe('execCommand');
    });

    it('selects nativeSetter for React controlled input', async () => {
      mockClient.send
        .mockResolvedValueOnce({ result: { value: undefined } }) // focus
        .mockResolvedValueOnce({ result: { value: {
          isLexical: false, isProseMirror: false, isContentEditable: false,
          isInput: true, isTextarea: false, isReactControlled: true,
        }}})
        .mockResolvedValue({ result: { value: undefined } }); // remaining

      const result = await typeText(mockPool as any, {
        selector: '#react-input',
        text: 'x',
        method: 'auto',
      });

      expect(result.method).toBe('nativeSetter');
    });
  });

  describe('clear option', () => {
    it('clears element before typing', async () => {
      const result = await typeText(mockPool as any, {
        selector: '#input',
        text: 'new',
        method: 'keyboard',
        clear: true,
      });

      expect(result.typed).toBe(true);
      // Verify a Runtime.evaluate call that clears the value
      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasClear = evalCalls.some(c => c[1]?.expression?.includes("value = ''") || c[1]?.expression?.includes("textContent = ''"));
      expect(hasClear).toBe(true);
    });
  });
});
