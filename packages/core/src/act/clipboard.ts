import type { ConnectionPool } from '../cdp/connection-pool.js';
import { createLogger } from '@cdp-mcp/shared';
import { dispatchCombo } from './press-key.js';

const logger = createLogger('clipboard');

export interface ClipboardOptions {
  action: 'copy' | 'paste' | 'cut' | 'read';
  /** Text to paste (only for paste action) */
  text?: string;
  /** Focus this element first via CSS selector */
  selector?: string;
}

export interface ClipboardResult {
  success: boolean;
  action: string;
  text?: string;
}

const IS_MAC = process.platform === 'darwin';
const CMD_OR_CTRL = IS_MAC ? 'Meta' : 'Control';

export async function clipboard(
  pool: ConnectionPool,
  options: ClipboardOptions,
): Promise<ClipboardResult> {
  const { action, text, selector } = options;
  const client = await pool.getActiveTab();

  // Focus element if selector provided
  if (selector) {
    await client.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
        el.focus();
      })()`,
      awaitPromise: true,
    });
  }

  switch (action) {
    case 'copy': {
      // Read current selection, then dispatch Ctrl+C
      const selectedText = await readSelection(client, selector);
      await dispatchCombo(client, `${CMD_OR_CTRL}+c`);
      logger.info(`Copied: "${selectedText.substring(0, 50)}${selectedText.length > 50 ? '...' : ''}"`);
      return { success: true, action, text: selectedText };
    }

    case 'cut': {
      const selectedText = await readSelection(client, selector);
      await dispatchCombo(client, `${CMD_OR_CTRL}+x`);
      logger.info(`Cut: "${selectedText.substring(0, 50)}${selectedText.length > 50 ? '...' : ''}"`);
      return { success: true, action, text: selectedText };
    }

    case 'paste': {
      if (text !== undefined) {
        // Direct paste via ClipboardEvent (same pattern as type.ts typeViaClipboard)
        await pasteViaClipboardEvent(client, text, selector);
        logger.info(`Pasted text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
      } else {
        // No text provided: dispatch Ctrl+V (paste from system clipboard)
        await dispatchCombo(client, `${CMD_OR_CTRL}+v`);
        logger.info('Pasted from system clipboard');
      }
      return { success: true, action, text };
    }

    case 'read': {
      const clipText = await readClipboard(pool);
      logger.info(`Read clipboard: "${clipText.substring(0, 50)}${clipText.length > 50 ? '...' : ''}"`);
      return { success: true, action, text: clipText };
    }

    default:
      throw new Error(`Unknown clipboard action: ${action}`);
  }
}

async function readSelection(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  selector?: string,
): Promise<string> {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      ${selector ? `
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          return el.value.substring(el.selectionStart, el.selectionEnd);
        }
      ` : ''}
      const sel = window.getSelection();
      return sel ? sel.toString() : '';
    })()`,
    returnByValue: true,
  }) as { result: { value: string } };

  return result.result.value ?? '';
}

async function pasteViaClipboardEvent(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  text: string,
  selector?: string,
): Promise<void> {
  const targetExpr = selector
    ? `document.querySelector(${JSON.stringify(selector)})`
    : 'document.activeElement';

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const el = ${targetExpr};
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

async function readClipboard(pool: ConnectionPool): Promise<string> {
  // Grant clipboard permission via browser-level client
  const browserClient = pool.getBrowserClient();
  await browserClient.send('Browser.grantPermissions', {
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });

  const client = await pool.getActiveTab();
  const result = await client.send('Runtime.evaluate', {
    expression: `navigator.clipboard.readText()`,
    awaitPromise: true,
    returnByValue: true,
  }) as { result: { value: string } };

  return result.result.value ?? '';
}
