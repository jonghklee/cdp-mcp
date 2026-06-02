import type { ConnectionPool } from '../cdp/connection-pool.js';
import { createLogger, sleep } from '@cdp-mcp/shared';
import {
  parseKeyCombo,
  computeModifierBitmask,
  getKeyDefinition,
  isPrintableKey,
  MODIFIER_KEYS,
  type KeyDefinition,
} from './key-definitions.js';

const logger = createLogger('press-key');

export interface PressKeyOptions {
  /** Single key or combo: "Enter", "Control+A" */
  key?: string;
  /** Sequence of keys: ["Tab", "Tab", "Enter"] */
  keys?: string[];
  /** press=full keyDown+keyUp, down=hold, up=release. Default: press */
  action?: 'press' | 'down' | 'up';
  /** Repeat count for key/keys. Default: 1 */
  repeat?: number;
  /** Delay in ms between repeats. Default: 0 */
  delay?: number;
}

export interface PressKeyResult {
  pressed: boolean;
  key?: string;
  keys?: string[];
  action: string;
  repeat: number;
}

// ─── Internal dispatch functions (reused by select-text, clipboard) ───

export async function dispatchKeyDown(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  keyDef: KeyDefinition,
  modifiers: number,
): Promise<void> {
  const isChar = isPrintableKey(keyDef) && modifiers === 0;

  if (isChar) {
    // Character key: keyDown with text, then char event
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers,
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode,
      nativeVirtualKeyCode: keyDef.keyCode,
      text: keyDef.text,
      unmodifiedText: keyDef.text,
    });
  } else {
    // Special key or modifier combo: rawKeyDown, no text
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers,
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode,
      nativeVirtualKeyCode: keyDef.keyCode,
    });
  }
}

export async function dispatchKeyUp(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  keyDef: KeyDefinition,
  modifiers: number,
): Promise<void> {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers,
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
  });
}

export async function dispatchKeyPress(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  keyDef: KeyDefinition,
  modifiers: number,
): Promise<void> {
  await dispatchKeyDown(client, keyDef, modifiers);
  await dispatchKeyUp(client, keyDef, modifiers);
}

/**
 * Dispatch a full combo: modifier keys down → main key press → modifier keys up (reverse order).
 */
export async function dispatchCombo(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  combo: string,
): Promise<void> {
  const { modifiers, key } = parseKeyCombo(combo);
  const bitmask = computeModifierBitmask(modifiers);

  // Press modifiers down
  for (const mod of modifiers) {
    const modDef = getKeyDefinition(mod);
    await dispatchKeyDown(client, modDef, 0);
  }

  // Press main key
  const mainDef = getKeyDefinition(key);
  await dispatchKeyPress(client, mainDef, bitmask);

  // Release modifiers (reverse order)
  for (let i = modifiers.length - 1; i >= 0; i--) {
    const modDef = getKeyDefinition(modifiers[i]);
    await dispatchKeyUp(client, modDef, 0);
  }
}

// ─── Main tool function ───

export async function pressKey(
  pool: ConnectionPool,
  options: PressKeyOptions,
): Promise<PressKeyResult> {
  const {
    key,
    keys,
    action = 'press',
    repeat = 1,
    delay = 0,
  } = options;

  if (!key && (!keys || keys.length === 0)) {
    throw new Error('Either key or keys must be provided');
  }

  const client = await pool.getActiveTab();
  const keyList = keys ?? [key!];

  for (let r = 0; r < repeat; r++) {
    for (const k of keyList) {
      await dispatchSingle(client, k, action);
    }
    if (delay > 0 && r < repeat - 1) {
      await sleep(delay);
    }
  }

  const desc = keys ? keys.join(', ') : key!;
  logger.info(`Key ${action}: ${desc}${repeat > 1 ? ` x${repeat}` : ''}`);

  return {
    pressed: true,
    key,
    keys,
    action,
    repeat,
  };
}

async function dispatchSingle(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  combo: string,
  action: 'press' | 'down' | 'up',
): Promise<void> {
  const parsed = parseKeyCombo(combo);
  const hasModifiers = parsed.modifiers.length > 0;

  if (hasModifiers && action === 'press') {
    // Full combo dispatch
    await dispatchCombo(client, combo);
    return;
  }

  const bitmask = computeModifierBitmask(parsed.modifiers);
  const mainDef = getKeyDefinition(parsed.key);

  // For down/up with modifiers, press modifier keys accordingly
  if (hasModifiers) {
    if (action === 'down') {
      for (const mod of parsed.modifiers) {
        await dispatchKeyDown(client, getKeyDefinition(mod), 0);
      }
      await dispatchKeyDown(client, mainDef, bitmask);
    } else {
      await dispatchKeyUp(client, mainDef, bitmask);
      for (let i = parsed.modifiers.length - 1; i >= 0; i--) {
        await dispatchKeyUp(client, getKeyDefinition(parsed.modifiers[i]), 0);
      }
    }
    return;
  }

  // Simple key, no modifiers
  if (action === 'press') {
    // If the key itself is a modifier, just press/release it
    if (MODIFIER_KEYS.has(parsed.key)) {
      await dispatchKeyDown(client, mainDef, 0);
      await dispatchKeyUp(client, mainDef, 0);
    } else {
      await dispatchKeyPress(client, mainDef, 0);
    }
  } else if (action === 'down') {
    await dispatchKeyDown(client, mainDef, 0);
  } else {
    await dispatchKeyUp(client, mainDef, 0);
  }
}
