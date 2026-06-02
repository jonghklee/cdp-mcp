import type { ConnectionPool } from '../cdp/connection-pool.js';
import { createLogger } from '@cdp-mcp/shared';
import { dispatchCombo } from './press-key.js';

const logger = createLogger('select-text');

export interface SelectTextOptions {
  mode: 'all' | 'word' | 'line' | 'toStart' | 'toEnd' | 'character';
  direction?: 'left' | 'right' | 'up' | 'down';
  count?: number;
  /** Focus this element first via CSS selector */
  selector?: string;
}

export interface SelectTextResult {
  selected: boolean;
  mode: string;
  text: string;
}

const IS_MAC = process.platform === 'darwin';
const CMD_OR_CTRL = IS_MAC ? 'Meta' : 'Control';

const MODE_KEY_MAP: Record<string, (dir: string, isMac: boolean) => string> = {
  all: () => `${CMD_OR_CTRL}+a`,
  character: (dir) => `Shift+Arrow${capitalize(dir)}`,
  word: (dir) => `${CMD_OR_CTRL}+Shift+Arrow${capitalize(dir)}`,
  line: (dir) => {
    if (dir === 'up' || dir === 'down') return `Shift+Arrow${capitalize(dir)}`;
    return dir === 'left' ? 'Shift+Home' : 'Shift+End';
  },
  toStart: () => `${CMD_OR_CTRL}+Shift+Home`,
  toEnd: () => `${CMD_OR_CTRL}+Shift+End`,
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function selectText(
  pool: ConnectionPool,
  options: SelectTextOptions,
): Promise<SelectTextResult> {
  const {
    mode,
    direction = 'right',
    count = 1,
    selector,
  } = options;

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

  // Get key combo for this mode
  const getCombo = MODE_KEY_MAP[mode];
  if (!getCombo) {
    throw new Error(`Unknown select mode: ${mode}`);
  }
  const combo = getCombo(direction, IS_MAC);

  // Dispatch the selection combo (repeated count times for character/word/line)
  const repeatCount = mode === 'all' || mode === 'toStart' || mode === 'toEnd' ? 1 : count;
  for (let i = 0; i < repeatCount; i++) {
    await dispatchCombo(client, combo);
  }

  // Read selected text
  const text = await readSelectedText(client, selector);

  logger.info(`Selected text (${mode}): "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

  return {
    selected: true,
    mode,
    text,
  };
}

async function readSelectedText(
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
