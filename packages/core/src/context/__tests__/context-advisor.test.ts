import { describe, it, expect } from 'vitest';
import { adviseContext } from '../context-advisor.js';
import { CONTEXT_CAPABILITIES, CONTEXT_REQUIRED_MESSAGE } from '../context-types.js';

describe('adviseContext', () => {
  describe('worker context', () => {
    it('recommends worker for chrome.storage without DOM', () => {
      const advice = adviseContext('chrome.storage.local.get("key")');
      expect(advice.recommended).toBe('worker');
    });

    it('recommends worker for chrome.runtime without DOM', () => {
      const advice = adviseContext('chrome.runtime.sendMessage({ type: "test" })');
      expect(advice.recommended).toBe('worker');
    });

    it('recommends worker for chrome.tabs without DOM', () => {
      const advice = adviseContext('chrome.tabs.query({ active: true })');
      expect(advice.recommended).toBe('worker');
    });
  });

  describe('page context', () => {
    it('recommends page for DOM + window vars', () => {
      const advice = adviseContext('document.querySelector("div"); window.__REACT_DEVTOOLS');
      expect(advice.recommended).toBe('page');
    });

    it('recommends page for DOM only', () => {
      const advice = adviseContext('document.querySelector(".button").click()');
      expect(advice.recommended).toBe('page');
    });

    it('recommends page for window vars only', () => {
      const advice = adviseContext('window.__NEXT_DATA__');
      expect(advice.recommended).toBe('page');
    });

    it('recommends page as default', () => {
      const advice = adviseContext('console.log("hello")');
      expect(advice.recommended).toBe('page');
    });
  });

  describe('content context', () => {
    it('recommends content for DOM + chrome API', () => {
      const advice = adviseContext('document.querySelector("input"); chrome.storage.local.set({ key: "value" })');
      expect(advice.recommended).toBe('content');
    });
  });

  describe('popup context', () => {
    it('recommends popup for DOM + popup pattern', () => {
      const advice = adviseContext('document.querySelector(".popup-container")');
      expect(advice.recommended).toBe('popup');
    });
  });

  describe('alternatives', () => {
    it('provides alternatives for worker', () => {
      const advice = adviseContext('chrome.storage.local.get("key")');
      expect(advice.alternatives).toBeDefined();
      expect(advice.alternatives!.some(a => a.context === 'popup')).toBe(true);
    });
  });
});

describe('CONTEXT_CAPABILITIES', () => {
  it('page has DOM and webJsVars', () => {
    expect(CONTEXT_CAPABILITIES.page.dom).toBe(true);
    expect(CONTEXT_CAPABILITIES.page.webJsVars).toBe(true);
    expect(CONTEXT_CAPABILITIES.page.chromeApi).toBe(false);
  });

  it('worker has chromeApi but no DOM', () => {
    expect(CONTEXT_CAPABILITIES.worker.dom).toBe(false);
    expect(CONTEXT_CAPABILITIES.worker.chromeApi).toBe(true);
    expect(CONTEXT_CAPABILITIES.worker.fetchCorsBypass).toBe(true);
  });

  it('content has DOM and partial chromeApi', () => {
    expect(CONTEXT_CAPABILITIES.content.dom).toBe(true);
    expect(CONTEXT_CAPABILITIES.content.chromeApi).toBe('partial');
  });

  it('popup has DOM, chromeApi, and popupDom', () => {
    expect(CONTEXT_CAPABILITIES.popup.dom).toBe(true);
    expect(CONTEXT_CAPABILITIES.popup.chromeApi).toBe(true);
    expect(CONTEXT_CAPABILITIES.popup.popupDom).toBe(true);
  });
});

describe('CONTEXT_REQUIRED_MESSAGE', () => {
  it('contains all four context types', () => {
    expect(CONTEXT_REQUIRED_MESSAGE).toContain('page');
    expect(CONTEXT_REQUIRED_MESSAGE).toContain('content');
    expect(CONTEXT_REQUIRED_MESSAGE).toContain('worker');
    expect(CONTEXT_REQUIRED_MESSAGE).toContain('popup');
  });
});
