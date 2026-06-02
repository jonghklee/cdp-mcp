import type { ExecutionContext } from '@cdp-mcp/shared';

export interface ContextAdvice {
  recommended: ExecutionContext;
  reason: string;
  alternatives?: Array<{ context: ExecutionContext; reason: string }>;
}

// Pattern detection
interface DetectedPatterns {
  dom: boolean;
  chromeApi: boolean;
  windowVars: boolean;
  network: boolean;
  popup: boolean;
}

function detectPatterns(code: string): DetectedPatterns {
  return {
    dom: /document\.|querySelector|getElement|innerHTML|outerHTML|textContent|\.classList|\.style\.|\.children|\.parentNode|\.appendChild|\.removeChild|\.setAttribute/.test(code),
    chromeApi: /chrome\.(storage|runtime|tabs|action|scripting|management|contextMenus|alarms|notifications|permissions|webRequest)/.test(code),
    windowVars: /window\.__REACT|window\.__VUE|window\.__NEXT|window\.__NUXT|window\.__remixContext|__REACT_DEVTOOLS|__NEXT_DATA__/.test(code),
    network: /\bfetch\s*\(|XMLHttpRequest|\.ajax\(/.test(code),
    popup: /popup|onboarding|\.popup[-_]|popup\.html|popupDom/.test(code),
  };
}

export function adviseContext(code: string): ContextAdvice {
  const patterns = detectPatterns(code);

  // Decision rules (matching spec):

  // chrome API && !dom → worker
  if (patterns.chromeApi && !patterns.dom) {
    return {
      recommended: 'worker',
      reason: 'chrome.* API 사용이 감지되었고 DOM 접근이 없으므로 Service Worker가 적합합니다.',
      alternatives: [
        { context: 'popup', reason: '팝업 UI에서 chrome API를 사용하는 경우' },
      ],
    };
  }

  // dom && popup → popup
  if (patterns.dom && patterns.popup) {
    return {
      recommended: 'popup',
      reason: '팝업 관련 DOM 접근이 감지되었습니다.',
      alternatives: [
        { context: 'page', reason: '팝업이 아닌 일반 페이지의 popup 관련 요소인 경우' },
      ],
    };
  }

  // dom && chromeApi → content
  if (patterns.dom && patterns.chromeApi) {
    return {
      recommended: 'content',
      reason: 'DOM 접근과 chrome API가 모두 필요합니다. Content script 환경이 적합합니다.',
      alternatives: [
        { context: 'popup', reason: '익스텐션 팝업 UI를 조작하는 경우' },
      ],
    };
  }

  // dom && windowVars → page
  if (patterns.dom && patterns.windowVars) {
    return {
      recommended: 'page',
      reason: 'DOM과 웹 페이지 전역변수(React/Vue/Next 등) 접근이 필요합니다.',
    };
  }

  // dom only → page (default for DOM access)
  if (patterns.dom) {
    return {
      recommended: 'page',
      reason: 'DOM 접근이 감지되었습니다. 기본적으로 page 컨텍스트를 사용합니다.',
      alternatives: [
        { context: 'content', reason: 'chrome.storage 접근도 필요한 경우' },
      ],
    };
  }

  // windowVars only → page
  if (patterns.windowVars) {
    return {
      recommended: 'page',
      reason: '웹 페이지 전역변수 접근이 감지되었습니다.',
    };
  }

  // default → page
  return {
    recommended: 'page',
    reason: '특별한 패턴이 감지되지 않았습니다. 기본값으로 page 컨텍스트를 사용합니다.',
  };
}
