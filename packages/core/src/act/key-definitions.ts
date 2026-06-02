/**
 * CDP keyboard key definitions, aliases, and parsing utilities.
 * Pure logic — no CDP dependency.
 */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
}

export const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  // Letters
  ...Object.fromEntries(
    'abcdefghijklmnopqrstuvwxyz'.split('').map(c => [
      c, { key: c, code: `Key${c.toUpperCase()}`, keyCode: c.toUpperCase().charCodeAt(0), text: c },
    ])
  ),

  // Digits
  ...Object.fromEntries(
    '0123456789'.split('').map(d => [
      d, { key: d, code: `Digit${d}`, keyCode: d.charCodeAt(0), text: d },
    ])
  ),

  // Function keys
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `F${i + 1}`, { key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i },
    ])
  ),

  // Navigation
  ArrowUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  ArrowDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  ArrowLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home:       { key: 'Home',       code: 'Home',       keyCode: 36 },
  End:        { key: 'End',        code: 'End',        keyCode: 35 },
  PageUp:     { key: 'PageUp',     code: 'PageUp',     keyCode: 33 },
  PageDown:   { key: 'PageDown',   code: 'PageDown',   keyCode: 34 },

  // Editing
  Enter:      { key: 'Enter',      code: 'Enter',      keyCode: 13, text: '\r' },
  Tab:        { key: 'Tab',        code: 'Tab',        keyCode: 9 },
  Escape:     { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  Backspace:  { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
  Delete:     { key: 'Delete',     code: 'Delete',     keyCode: 46 },
  Insert:     { key: 'Insert',     code: 'Insert',     keyCode: 45 },
  Space:      { key: ' ',          code: 'Space',      keyCode: 32, text: ' ' },

  // Modifiers
  Shift:      { key: 'Shift',   code: 'ShiftLeft',   keyCode: 16, location: 1 },
  Control:    { key: 'Control', code: 'ControlLeft',  keyCode: 17, location: 1 },
  Alt:        { key: 'Alt',     code: 'AltLeft',      keyCode: 18, location: 1 },
  Meta:       { key: 'Meta',    code: 'MetaLeft',     keyCode: 91, location: 1 },

  // Symbols (US keyboard)
  '`':  { key: '`',  code: 'Backquote',    keyCode: 192, text: '`' },
  '-':  { key: '-',  code: 'Minus',        keyCode: 189, text: '-' },
  '=':  { key: '=',  code: 'Equal',        keyCode: 187, text: '=' },
  '[':  { key: '[',  code: 'BracketLeft',  keyCode: 219, text: '[' },
  ']':  { key: ']',  code: 'BracketRight', keyCode: 221, text: ']' },
  '\\': { key: '\\', code: 'Backslash',    keyCode: 220, text: '\\' },
  ';':  { key: ';',  code: 'Semicolon',    keyCode: 186, text: ';' },
  "'":  { key: "'",  code: 'Quote',        keyCode: 222, text: "'" },
  ',':  { key: ',',  code: 'Comma',        keyCode: 188, text: ',' },
  '.':  { key: '.',  code: 'Period',       keyCode: 190, text: '.' },
  '/':  { key: '/',  code: 'Slash',        keyCode: 191, text: '/' },
};

export const KEY_ALIASES: Record<string, string> = {
  Ctrl: 'Control',
  Cmd: 'Meta',
  Command: 'Meta',
  Win: 'Meta',
  Windows: 'Meta',
  Esc: 'Escape',
  Return: 'Enter',
  Del: 'Delete',
  BS: 'Backspace',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};

export const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift']);

export const MODIFIER_BIT: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

/** Resolve aliases (e.g. Ctrl → Control, Esc → Escape), case-insensitive for aliases. */
export function resolveKeyName(name: string): string {
  // Check aliases first (case-insensitive match)
  for (const [alias, resolved] of Object.entries(KEY_ALIASES)) {
    if (alias.toLowerCase() === name.toLowerCase()) return resolved;
  }
  // Check direct definition match (case-insensitive for single chars)
  if (name.length === 1) {
    const lower = name.toLowerCase();
    if (KEY_DEFINITIONS[lower]) return lower;
    return name;
  }
  return name;
}

export interface ParsedKeyCombo {
  modifiers: string[];  // e.g. ['Control', 'Shift']
  key: string;          // e.g. 'a', 'ArrowUp'
}

/** Parse "Control+Shift+A" → { modifiers: ['Control', 'Shift'], key: 'a' } */
export function parseKeyCombo(combo: string): ParsedKeyCombo {
  const parts = combo.split('+');

  // Handle "Control++" (plus key): last empty part after split means the key is '+'
  if (combo.endsWith('++') || (parts.length > 1 && parts[parts.length - 1] === '')) {
    parts.pop(); // remove empty
    parts.push('+'); // add literal +
  }

  const modifiers: string[] = [];
  let key = '';

  for (let i = 0; i < parts.length; i++) {
    const resolved = resolveKeyName(parts[i].trim());
    if (MODIFIER_KEYS.has(resolved) && i < parts.length - 1) {
      modifiers.push(resolved);
    } else {
      key = resolved;
    }
  }

  if (!key) {
    throw new Error(`Invalid key combo: "${combo}" — no main key found`);
  }

  return { modifiers, key };
}

/** Compute the CDP modifier bitmask from modifier names. */
export function computeModifierBitmask(modifiers: string[]): number {
  let mask = 0;
  for (const mod of modifiers) {
    mask |= (MODIFIER_BIT[mod] ?? 0);
  }
  return mask;
}

/** Look up a key definition by (resolved) name. */
export function getKeyDefinition(name: string): KeyDefinition {
  const resolved = resolveKeyName(name);
  const def = KEY_DEFINITIONS[resolved];
  if (def) return def;

  // Single character fallback
  if (resolved.length === 1) {
    return {
      key: resolved,
      code: `Key${resolved.toUpperCase()}`,
      keyCode: resolved.toUpperCase().charCodeAt(0),
      text: resolved,
    };
  }

  throw new Error(`Unknown key: "${name}"`);
}

/** Check if a key is a printable character (produces text output). */
export function isPrintableKey(keyDef: KeyDefinition): boolean {
  return !!keyDef.text && keyDef.text !== '\r';
}
