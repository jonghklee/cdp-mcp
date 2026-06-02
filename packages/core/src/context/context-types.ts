import type { ExecutionContext } from '@cdp-mcp/shared';

export interface ContextCapability {
  dom: boolean;
  webJsVars: boolean;
  chromeApi: boolean | 'partial';
  chromeStorage: boolean;
  fetchCorsBypass: boolean;
  extensionIndexedDb: boolean;
  popupDom: boolean;
}

export const CONTEXT_CAPABILITIES: Record<ExecutionContext, ContextCapability> = {
  page: {
    dom: true,
    webJsVars: true,
    chromeApi: false,
    chromeStorage: false,
    fetchCorsBypass: false,
    extensionIndexedDb: false,
    popupDom: false,
  },
  content: {
    dom: true,
    webJsVars: false,
    chromeApi: 'partial',
    chromeStorage: true,
    fetchCorsBypass: false,
    extensionIndexedDb: false,
    popupDom: false,
  },
  worker: {
    dom: false,
    webJsVars: false,
    chromeApi: true,
    chromeStorage: true,
    fetchCorsBypass: true,
    extensionIndexedDb: true,
    popupDom: false,
  },
  popup: {
    dom: true,
    webJsVars: false,
    chromeApi: true,
    chromeStorage: true,
    fetchCorsBypass: true,
    extensionIndexedDb: false,
    popupDom: true,
  },
};

export const CONTEXT_REQUIRED_MESSAGE = `[context 필수] evaluate 호출 시 context 파라미터가 필요합니다.

실행 컨텍스트를 지정해 주세요:
- "page": 웹 페이지 DOM + 전역변수 접근 (window.__REACT, __VUE 등)
- "content": 웹 페이지 DOM + chrome.storage (격리된 환경)
- "worker": 익스텐션 Service Worker (chrome.* API 전체, DOM 없음)
- "popup": 익스텐션 팝업 DOM + chrome.* API

어느 것을 써야 할지 모르겠으면:
- DOM 조작 + 웹 전역변수 필요 → "page"
- DOM 조작 + chrome API 필요 → "content"
- chrome API만 필요 (DOM 불필요) → "worker"
- 익스텐션 팝업 UI 조작 → "popup"`;
