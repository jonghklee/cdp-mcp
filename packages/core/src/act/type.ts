import type { ConnectionPool } from '../cdp/connection-pool.js';
import { createLogger, sleep } from '@cdp-mcp/shared';

const logger = createLogger('type');

export interface TypeOptions {
  selector: string;
  text: string;
  method?: 'auto' | 'keyboard' | 'execCommand' | 'clipboard' | 'nativeSetter';
  delay?: number;     // between keys (keyboard mode), default 0
  clear?: boolean;    // clear existing text first, default false
  timeout?: number;
}

export interface TypeResult {
  typed: boolean;
  method: string;
  selector: string;
}

type InputMethod = 'keyboard' | 'execCommand' | 'clipboard' | 'nativeSetter';

interface EditorDetection {
  isLexical: boolean;
  isProseMirror: boolean;
  isContentEditable: boolean;
  isInput: boolean;
  isTextarea: boolean;
  isReactControlled: boolean;
}

export async function typeText(
  pool: ConnectionPool,
  options: TypeOptions
): Promise<TypeResult> {
  const {
    selector,
    text,
    method = 'auto',
    delay = 0,
    clear = false,
    timeout: timeoutMs = 30000,
  } = options;

  const client = await pool.getActiveTab();

  // Focus the element
  await focusElement(client, selector);

  // Clear existing text if requested
  if (clear) {
    await clearElement(client, selector);
  }

  // Determine input method
  let actualMethod: InputMethod;

  if (method === 'auto') {
    const detection = await detectEditor(client, selector);
    actualMethod = resolveMethod(detection);
    logger.info(`Auto-detected input method: ${actualMethod} for selector '${selector}'`);
  } else {
    actualMethod = method;
  }

  // Execute the input
  switch (actualMethod) {
    case 'keyboard':
      await typeViaKeyboard(client, text, delay);
      break;
    case 'execCommand':
      await typeViaExecCommand(client, text);
      break;
    case 'clipboard':
      await typeViaClipboard(client, text, selector);
      break;
    case 'nativeSetter':
      await typeViaNativeSetter(client, text, selector);
      break;
  }

  logger.info(`Typed '${text.substring(0, 50)}${text.length > 50 ? '...' : ''}' into '${selector}' via ${actualMethod}`);

  return {
    typed: true,
    method: actualMethod,
    selector,
  };
}

async function focusElement(client: any, selector: string): Promise<void> {
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
      el.focus();
      if (el.click) el.click();
    })()`,
    awaitPromise: true,
  });
}

async function clearElement(client: any, selector: string): Promise<void> {
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.textContent = '';
      }
    })()`,
    awaitPromise: true,
  });
}

async function detectEditor(client: any, selector: string): Promise<EditorDetection> {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { isLexical: false, isProseMirror: false, isContentEditable: false, isInput: false, isTextarea: false, isReactControlled: false };

      const isLexical = !!el.closest('[data-lexical-editor]');
      const isProseMirror = !!el.closest('.ProseMirror');
      const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
      const isInput = el.tagName === 'INPUT';
      const isTextarea = el.tagName === 'TEXTAREA';

      // Detect React controlled input
      const reactKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      const isReactControlled = !!(isInput || isTextarea) && !!reactKey;

      return { isLexical, isProseMirror, isContentEditable, isInput, isTextarea, isReactControlled };
    })()`,
    returnByValue: true,
  });

  return result.result.value;
}

function resolveMethod(detection: EditorDetection): InputMethod {
  // Decision tree from spec:
  // 1. Lexical -> clipboard
  if (detection.isLexical) return 'clipboard';
  // 2. ProseMirror -> execCommand
  if (detection.isProseMirror) return 'execCommand';
  // 3. contenteditable -> execCommand
  if (detection.isContentEditable) return 'execCommand';
  // 4. input/textarea + React controlled -> nativeSetter
  if ((detection.isInput || detection.isTextarea) && detection.isReactControlled) return 'nativeSetter';
  // 5. input/textarea -> keyboard
  if (detection.isInput || detection.isTextarea) return 'keyboard';
  // 6. fallback -> keyboard
  return 'keyboard';
}

async function typeViaKeyboard(client: any, text: string, delay: number): Promise<void> {
  for (const char of text) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: char,
      text: char,
      unmodifiedText: char,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
    });
    if (delay > 0) {
      await sleep(delay);
    }
  }
}

async function typeViaExecCommand(client: any, text: string): Promise<void> {
  await client.send('Runtime.evaluate', {
    expression: `document.execCommand('insertText', false, ${JSON.stringify(text)})`,
    awaitPromise: false,
  });
}

async function typeViaClipboard(client: any, text: string, selector: string): Promise<void> {
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(text)});
      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
    })()`,
    awaitPromise: true,
  });
}

async function typeViaNativeSetter(client: any, text: string, selector: string): Promise<void> {
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`,
    awaitPromise: true,
  });
}
