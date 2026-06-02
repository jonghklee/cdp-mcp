import { describe, it, expect } from 'vitest';
import {
  resolveKeyName,
  parseKeyCombo,
  computeModifierBitmask,
  getKeyDefinition,
  isPrintableKey,
  KEY_DEFINITIONS,
  MODIFIER_BIT,
} from '../key-definitions.js';

describe('key-definitions', () => {
  describe('resolveKeyName', () => {
    it('resolves Ctrl to Control', () => {
      expect(resolveKeyName('Ctrl')).toBe('Control');
    });

    it('resolves Cmd to Meta', () => {
      expect(resolveKeyName('Cmd')).toBe('Meta');
    });

    it('resolves Esc to Escape', () => {
      expect(resolveKeyName('Esc')).toBe('Escape');
    });

    it('resolves Up/Down/Left/Right to Arrow variants', () => {
      expect(resolveKeyName('Up')).toBe('ArrowUp');
      expect(resolveKeyName('Down')).toBe('ArrowDown');
      expect(resolveKeyName('Left')).toBe('ArrowLeft');
      expect(resolveKeyName('Right')).toBe('ArrowRight');
    });

    it('returns single char keys lowercase', () => {
      expect(resolveKeyName('A')).toBe('a');
      expect(resolveKeyName('z')).toBe('z');
    });

    it('passes through unknown multi-char names', () => {
      expect(resolveKeyName('Enter')).toBe('Enter');
      expect(resolveKeyName('F1')).toBe('F1');
    });
  });

  describe('parseKeyCombo', () => {
    it('parses single key', () => {
      const result = parseKeyCombo('Enter');
      expect(result.modifiers).toEqual([]);
      expect(result.key).toBe('Enter');
    });

    it('parses modifier + key', () => {
      const result = parseKeyCombo('Control+a');
      expect(result.modifiers).toEqual(['Control']);
      expect(result.key).toBe('a');
    });

    it('parses multiple modifiers', () => {
      const result = parseKeyCombo('Control+Shift+a');
      expect(result.modifiers).toEqual(['Control', 'Shift']);
      expect(result.key).toBe('a');
    });

    it('resolves aliases in combos', () => {
      const result = parseKeyCombo('Ctrl+Shift+Esc');
      expect(result.modifiers).toEqual(['Control', 'Shift']);
      expect(result.key).toBe('Escape');
    });

    it('handles plus key: Control++', () => {
      const result = parseKeyCombo('Control++');
      expect(result.modifiers).toEqual(['Control']);
      expect(result.key).toBe('+');
    });

    it('throws for empty combo', () => {
      expect(() => parseKeyCombo('')).toThrow('no main key');
    });
  });

  describe('computeModifierBitmask', () => {
    it('returns 0 for no modifiers', () => {
      expect(computeModifierBitmask([])).toBe(0);
    });

    it('returns correct bitmask for Control', () => {
      expect(computeModifierBitmask(['Control'])).toBe(MODIFIER_BIT.Control);
    });

    it('combines multiple modifiers', () => {
      const mask = computeModifierBitmask(['Control', 'Shift']);
      expect(mask).toBe(MODIFIER_BIT.Control | MODIFIER_BIT.Shift);
    });
  });

  describe('getKeyDefinition', () => {
    it('returns definition for known keys', () => {
      const def = getKeyDefinition('Enter');
      expect(def.key).toBe('Enter');
      expect(def.keyCode).toBe(13);
    });

    it('resolves aliases before lookup', () => {
      const def = getKeyDefinition('Esc');
      expect(def.key).toBe('Escape');
    });

    it('returns definition for single characters', () => {
      const def = getKeyDefinition('a');
      expect(def.key).toBe('a');
      expect(def.code).toBe('KeyA');
    });

    it('falls back for unknown single character', () => {
      const def = getKeyDefinition('!');
      expect(def.key).toBe('!');
      expect(def.text).toBe('!');
    });

    it('throws for unknown multi-char key', () => {
      expect(() => getKeyDefinition('UnknownKey')).toThrow('Unknown key');
    });
  });

  describe('isPrintableKey', () => {
    it('returns true for character keys', () => {
      expect(isPrintableKey(KEY_DEFINITIONS['a'])).toBe(true);
      expect(isPrintableKey(KEY_DEFINITIONS['Space'])).toBe(true);
    });

    it('returns false for special keys', () => {
      expect(isPrintableKey(KEY_DEFINITIONS['Escape'])).toBe(false);
      expect(isPrintableKey(KEY_DEFINITIONS['ArrowUp'])).toBe(false);
    });

    it('returns false for Enter (text is \\r)', () => {
      expect(isPrintableKey(KEY_DEFINITIONS['Enter'])).toBe(false);
    });
  });
});
