# CDP-MCP 구현 프롬프트

> 이 문서는 Claude Code가 CDP-MCP를 구축하기 위한 구현 명세이다.
> 처음부터 새로 만든다. 기존 코드를 재활용하지 않는다.

---

## 아키텍처

pnpm monorepo, TypeScript strict mode.

```
QA Layer:    QA/QC        → 익스텐션 기능 검증 (assert, scenario, report)
Layer 3: Product MCPs     → 특정 익스텐션 전용 (예: ChatLens)
Layer 2: Intelligence     → 사이트 지식 축적/분석
Layer 1: CDP Core         → 순수 브라우저 제어 (범용)
```

의존 방향: `QA → 3 → 2 → 1`. Layer 1은 외부 의존 없음.
QA Layer는 Layer 1~3 모두 사용 (브라우저 조작 + 사이트 지식 + 제품 연결).
각 모듈은 MCP 없이도 import 가능해야 한다 (단위 테스트 가능).

---

## 프로젝트 구조

```
cdp-mcp/
├── packages/
│   ├── core/                          # Layer 1
│   │   ├── src/
│   │   │   ├── cdp/
│   │   │   │   ├── cdp-client.ts          # WebSocket CDP 클라이언트
│   │   │   │   ├── connection-pool.ts     # 다중 탭/타겟 연결 풀
│   │   │   │   └── protocol-types.ts
│   │   │   ├── observe/
│   │   │   │   ├── dom-snapshot.ts        # DOM + computed styles 캡처
│   │   │   │   ├── dom-watch.ts           # MutationObserver 실시간 감시
│   │   │   │   ├── network-capture.ts
│   │   │   │   ├── network-intercept.ts
│   │   │   │   ├── console-capture.ts
│   │   │   │   ├── screenshot.ts
│   │   │   │   └── page-info.ts
│   │   │   ├── act/
│   │   │   │   ├── navigate.ts
│   │   │   │   ├── click.ts
│   │   │   │   ├── type.ts                # ★ 다중 입력 방식 자동 판별
│   │   │   │   ├── evaluate.ts            # ★ Context-Aware (page/content/worker/popup)
│   │   │   │   ├── upload.ts              # 다중 업로드 방식
│   │   │   │   └── scroll.ts
│   │   │   ├── infra/
│   │   │   │   ├── chrome-pool.ts
│   │   │   │   ├── port-manager.ts
│   │   │   │   ├── extension-manager.ts
│   │   │   │   ├── tab-manager.ts
│   │   │   │   └── session-manager.ts
│   │   │   ├── context/                   # ★ 실행 컨텍스트 시스템
│   │   │   │   ├── context-types.ts
│   │   │   │   ├── context-router.ts
│   │   │   │   └── context-advisor.ts
│   │   │   ├── stores/
│   │   │   │   ├── network-store.ts
│   │   │   │   ├── console-store.ts
│   │   │   │   └── dom-store.ts
│   │   │   ├── tools/
│   │   │   │   ├── observe-tools.ts
│   │   │   │   ├── act-tools.ts
│   │   │   │   └── infra-tools.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── intelligence/                  # Layer 2
│   │   ├── src/
│   │   │   ├── capture/
│   │   │   │   ├── dom-capture.ts
│   │   │   │   ├── event-capture.ts       # ★ 이벤트 리스너 매핑
│   │   │   │   ├── network-capture.ts     # API/WebSocket/SSE 패턴 분석
│   │   │   │   ├── storage-capture.ts     # cookies/localStorage/IndexedDB
│   │   │   │   ├── style-capture.ts       # CSS 변수/아키텍처 분류
│   │   │   │   ├── framework-capture.ts   # ★ React/Vue/Angular 감지+상태
│   │   │   │   └── input-capture.ts       # 에디터 8종+ 세부 분류
│   │   │   ├── analysis/
│   │   │   │   ├── selector-engine.ts     # 안정적 셀렉터 추천 (신뢰도)
│   │   │   │   ├── endpoint-classifier.ts
│   │   │   │   ├── pattern-detector.ts
│   │   │   │   ├── framework-analyzer.ts  # ★ 프레임워크별 최적 접근법
│   │   │   │   └── interaction-advisor.ts
│   │   │   ├── storage/
│   │   │   │   ├── site-profile-db.ts     # SQLite
│   │   │   │   ├── snapshot-store.ts
│   │   │   │   └── diff-engine.ts
│   │   │   ├── registry/                  # ★ Pattern Registry
│   │   │   │   ├── pattern-registry.ts
│   │   │   │   ├── builtin-patterns.ts
│   │   │   │   └── learning-loop.ts
│   │   │   ├── tools/
│   │   │   │   ├── analyze.ts
│   │   │   │   ├── capture.ts
│   │   │   │   ├── query.ts
│   │   │   │   ├── diff.ts
│   │   │   │   ├── monitor.ts
│   │   │   │   ├── selectors.ts
│   │   │   │   └── patterns.ts
│   │   │   └── types/
│   │   │       └── site-profile.ts
│   │   ├── data/                          # 내장 패턴 JSON
│   │   │   ├── editors.json
│   │   │   ├── frameworks.json
│   │   │   ├── api-formats.json
│   │   │   ├── auth-patterns.json
│   │   │   └── routing-patterns.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── shared/
│       ├── src/
│       │   ├── types.ts
│       │   ├── logger.ts
│       │   └── utils.ts
│       └── package.json
│
├── packages/qa/                           # QA Layer
│   ├── src/
│   │   ├── assert/
│   │   │   ├── dom-assert.ts                 # DOM 상태 검증
│   │   │   ├── storage-assert.ts             # chrome.storage 검증
│   │   │   ├── network-assert.ts             # 네트워크 요청/응답 검증
│   │   │   ├── visual-assert.ts              # 스크린샷 비교 (pixelmatch)
│   │   │   ├── state-assert.ts               # 익스텐션 내부 상태 검증
│   │   │   └── assert-types.ts
│   │   ├── scenario/
│   │   │   ├── scenario-types.ts             # 시나리오/스텝 타입
│   │   │   ├── scenario-parser.ts            # YAML → 실행 가능 시나리오
│   │   │   ├── scenario-builder.ts           # 프로그래밍 방식 구성
│   │   │   └── step-registry.ts
│   │   ├── runner/
│   │   │   ├── scenario-runner.ts            # 시나리오 순차 실행
│   │   │   ├── suite-runner.ts               # 여러 시나리오 묶어 실행
│   │   │   ├── cross-platform-runner.ts      # 같은 테스트 여러 사이트 반복
│   │   │   ├── retry-handler.ts
│   │   │   └── environment.ts
│   │   ├── report/
│   │   │   ├── report-generator.ts
│   │   │   ├── report-formatter.ts           # JSON / Markdown / HTML
│   │   │   └── regression-tracker.ts         # 이전 결과 비교 (회귀 감지)
│   │   ├── visual/
│   │   │   ├── screenshot-manager.ts         # 기준 스크린샷 관리
│   │   │   ├── pixel-diff.ts                 # 픽셀 단위 비교
│   │   │   └── visual-report.ts
│   │   ├── tools/
│   │   │   ├── assert-tools.ts
│   │   │   ├── scenario-tools.ts
│   │   │   ├── runner-tools.ts
│   │   │   └── report-tools.ts
│   │   └── index.ts
│   ├── scenarios/examples/
│   ├── baselines/
│   ├── package.json
│   └── tsconfig.json
│
├── products/                          # Layer 3
│   ├── chatlens-mcp/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── connection.ts          # 범용 보일러플레이트
│   │   │   ├── tools/
│   │   │   └── types.ts
│   │   ├── qa/                        # ★ 제품별 QA
│   │   │   ├── scenarios/             # smoke.yaml, search.yaml 등
│   │   │   ├── baselines/             # 기준 스크린샷
│   │   │   └── fixtures/              # 테스트용 사전 데이터
│   │   ├── config.json
│   │   └── package.json
│   └── template/                      # Scaffolding 템플릿
│
├── templates/
│   └── product-mcp/
│       ├── src/
│       │   ├── index.ts.template
│       │   └── connection.ts.template
│       └── config.json.template
│
├── data/                              # 런타임 데이터
│   ├── site-profiles/
│   ├── snapshots/
│   └── patterns/
│
├── package.json                       # pnpm workspace root
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

패키지 의존성:
```
@cdp-mcp/core:         @modelcontextprotocol/sdk, ws
@cdp-mcp/intelligence: @cdp-mcp/core, better-sqlite3
@cdp-mcp/qa:           @cdp-mcp/core, @cdp-mcp/intelligence, pixelmatch, pngjs, yaml
@cdp-mcp/shared:       (없음)
products/*:            @cdp-mcp/core, @cdp-mcp/intelligence, @cdp-mcp/qa
```

---

## 실행 컨텍스트 시스템 (★ 핵심)

크롬 익스텐션은 4개의 독립된 JS 실행 환경이 있다. `cdp_evaluate`의 `context` 파라미터로 명시적 분리한다.

```
              Page    Content   Service   Popup
              World   Script    Worker
─────────────────────────────────────────────────
웹사이트 DOM    ✅      ✅        ❌        ❌
웹사이트 JS변수  ✅      ❌        ❌        ❌
chrome.* API   ❌      일부       ✅        ✅
chrome.storage ❌      ✅        ✅        ✅
chrome.runtime ❌      ✅        ✅        ✅
fetch CORS우회  ❌      ❌        ✅        ❌
IndexedDB(ext) ❌      ❌        ✅        ✅
팝업 DOM       ❌      ❌        ❌        ✅
```

`context`를 안 넣으면 에러로 가이드:
```
"context는 필수입니다:
 - page: 웹사이트 DOM/JS 조작
 - content: 익스텐션↔웹페이지 통신
 - worker: 익스텐션 백그라운드 로직 (chrome.* 전체)
 - popup: 팝업 UI 테스트"
```

### Context Advisor (자동 추천)

```typescript
function adviseContext(code: string): { recommended: Context; reason: string } {
  const has = {
    dom: /document\.|querySelector|getElement|innerHTML/.test(code),
    chromeAPI: /chrome\.(storage|runtime|tabs|action|scripting)/.test(code),
    windowVars: /window\.|__REACT|__VUE|__NEXT/.test(code),
    fetch: /fetch\(|XMLHttpRequest/.test(code),
    popup: /popup|onboarding|\.popup-/.test(code),
  };
  if (has.chromeAPI && !has.dom) return { recommended: 'worker', reason: 'chrome.* API' };
  if (has.dom && has.windowVars) return { recommended: 'page', reason: '웹사이트 전역변수' };
  if (has.dom && has.chromeAPI) return { recommended: 'content', reason: 'DOM + chrome.runtime' };
  if (has.dom && has.popup) return { recommended: 'popup', reason: '팝업 DOM' };
  return { recommended: 'page', reason: 'default' };
}
```

### CDP 연결 라우팅

```typescript
// context-router.ts
async function routeEvaluation(context: Context, code: string, pool: ConnectionPool) {
  switch (context) {
    case 'page':
      // 현재 활성 탭의 Runtime.evaluate
      return pool.getActiveTab().send('Runtime.evaluate', { expression: code });
    case 'content':
      // 현재 탭의 isolated world에서 실행
      const { executionContextId } = await pool.getActiveTab()
        .send('Page.createIsolatedWorld', { frameId: mainFrameId });
      return pool.getActiveTab().send('Runtime.evaluate', {
        expression: code, contextId: executionContextId
      });
    case 'worker':
      // Extension Service Worker 타겟에서 실행
      return pool.getExtensionWorker().send('Runtime.evaluate', { expression: code });
    case 'popup':
      // Popup 탭에서 실행 (chrome-extension://[id]/popup.html)
      return pool.getPopupTab().send('Runtime.evaluate', { expression: code });
  }
}
```

---

## 텍스트 입력 자동 판별 (cdp_type)

```
결정 트리:
1. Lexical 에디터? ([data-lexical-editor]) → ClipboardEvent paste
2. ProseMirror? (.ProseMirror) → execCommand('insertText'), fallback: transaction API
3. contenteditable? → execCommand, fallback: keyboard events
4. textarea/input + React controlled? → nativeInputValueSetter + dispatchEvent
5. textarea/input 일반? → CDP Input.dispatchKeyEvent
6. 그 외 → CDP keyboard fallback
```

React Controlled Input 처리:
```typescript
// ❌ React가 감지 못함
input.value = 'hello';
input.dispatchEvent(new Event('input', { bubbles: true }));

// ✅ nativeInputValueSetter 트릭
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(input, 'hello');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

---

## SiteProfile 타입 정의

```typescript
interface SiteProfile {
  id: string;                       // "chatgpt.com"
  url: string;
  lastAnalyzed: number;
  version: number;

  structure: {
    dom: {
      rootTag: string;
      semanticLandmarks: string[];
      forms: FormMapping[];
      shadowDomElements: string[];
      iframes: IframeInfo[];
      customElements: string[];
      totalNodeCount: number;
    };
    text: { visibleTextSample: string; hiddenTexts: string[]; language: string };
    media: { images: { count: number; lazyLoaded: number }; videos: number; canvases: number; inlineSvgs: number };
  };

  behavior: {
    events: {
      globalListeners: EventListenerInfo[];
      elementListeners: Map<string, EventListenerInfo[]>;
      delegatedEvents: DelegatedEventInfo[];
    };
    framework: FrameworkDetection | null;
    jsEnvironment: {
      globalVariables: string[];
      moduleSystem: 'esm' | 'commonjs' | 'amd' | 'umd' | 'none';
      serviceWorker: boolean;
      webWorkers: number;
    };
    inputMethods: InputMethodInfo[];
    routing: {
      type: 'spa-history' | 'spa-hash' | 'mpa' | 'hybrid';
      routeChangeSignal: string;
      dynamicContentSelector?: string;
    };
  };

  communication: {
    endpoints: EndpointInfo[];
    websockets: WebSocketInfo[];
    sseConnections: SSEInfo[];
    externalScripts: ScriptInfo[];
  };

  visual: {
    cssArchitecture: 'css-modules' | 'tailwind' | 'css-in-js' | 'bem' | 'utility' | 'vanilla';
    cssFramework?: string;
    themes: string[];
    cssVariables: Record<string, string>;
    reusableClasses: string[];
    layoutSystem: 'flex' | 'grid' | 'table' | 'mixed';
    responsiveBreakpoints: number[];
  };

  state: {
    localStorage: StorageAnalysis;
    sessionStorage: StorageAnalysis;
    indexedDB: IndexedDBAnalysis;
    cookies: CookieAnalysis;
    auth: {
      method: 'jwt' | 'cookie' | 'oauth' | 'api-key' | 'none' | 'unknown';
      tokenLocation?: string;
      refreshPattern?: string;
    };
  };

  selectors: Map<string, SelectorInfo>;
  history: SnapshotHistory[];
}

interface EndpointInfo {
  pattern: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  purpose: 'chat' | 'auth' | 'sync' | 'media' | 'search' | 'crud' | 'unknown';
  requestContentType?: string;
  responseFormat: 'json' | 'sse' | 'ndjson' | 'binary' | 'html';
  completionSignals?: string[];
  requestSchema?: object;
  sampleResponse?: object;
}

interface InputMethodInfo {
  selector: string;
  type: 'textarea' | 'contenteditable' | 'input' | 'custom';
  editorFramework: 'lexical' | 'prosemirror' | 'quill' | 'tiptap' |
                   'draft-js' | 'codemirror' | 'monaco' | 'slate' | 'vanilla';
  recommendedInputMethod: 'cdp_keyboard' | 'execCommand' | 'clipboard_paste' |
                          'native_setter' | 'framework_api';
  inputCode: string;
  confidence: number;
}

interface SelectorInfo {
  role: string;
  primary: string;
  confidence: number;
  alternatives: string[];
  basis: 'data-attr' | 'aria' | 'structure' | 'id' | 'class' | 'xpath';
  lastVerified: number;
  broken: boolean;
}

interface FrameworkDetection {
  name: 'react' | 'vue' | 'angular' | 'svelte' | 'solid' | 'next' | 'nuxt' | 'vanilla';
  version?: string;
  confidence: number;
  detectionMethod: string;
  devToolsHook?: string;
  stateAccessMethod?: string;
  reactivityModel: 'virtual-dom' | 'proxy' | 'signals' | 'compiler' | 'none';
  eventSystem: 'synthetic' | 'native' | 'zone' | 'compiler-generated';
}

interface SnapshotHistory {
  timestamp: number;
  type: 'dom' | 'api' | 'selector' | 'full';
  changes: DomDiff | ApiDiff | SelectorDiff;
  triggeredBy: 'manual' | 'scheduled' | 'change_detected';
}

interface StorageAnalysis {
  totalKeys: number;
  keyPatterns: string[];
  totalSize: string;
  interestingKeys: Record<string, string>;
}

interface IndexedDBAnalysis {
  databases: Array<{
    name: string;
    version: number;
    objectStores: Array<{
      name: string; keyPath: string; indexCount: number; recordCount: number;
    }>;
  }>;
}

interface EventListenerInfo {
  type: string;
  selector?: string;
  useCapture: boolean;
  passive: boolean;
  handlerPreview: string;
}
```

---

## Pattern Registry

새 프레임워크/API/인증을 만나도 코드 수정 없이 대응하기 위한 확장 시스템.

```typescript
interface PatternEntry {
  id: string;
  category: 'framework' | 'editor' | 'api_format' | 'auth' |
            'routing' | 'css_architecture' | 'state_management';
  detection: {
    rules: DetectionRule[];
    operator: 'AND' | 'OR';
    confidence: number;
  };
  interaction: {
    description: string;
    guide: string;
    codeTemplates: Record<string, string>;
  };
  source: 'builtin' | 'learned' | 'user_added';
  addedAt: number;
  lastVerified?: number;
  verifiedOnSites?: string[];
}

interface DetectionRule {
  type: 'dom_query' | 'global_var' | 'dom_attribute' |
        'network_pattern' | 'header_pattern' | 'js_eval';
  expression: string;
  expectedResult?: any;
}
```

내장 패턴 예시 (`data/editors.json`):
```json
[
  {
    "id": "editor-lexical",
    "category": "editor",
    "detection": {
      "rules": [
        { "type": "dom_query", "expression": "[data-lexical-editor]" },
        { "type": "global_var", "expression": "window.__lexicalEditor" }
      ],
      "operator": "OR",
      "confidence": 0.95
    },
    "interaction": {
      "description": "Lexical 리치 텍스트 에디터",
      "guide": "ClipboardEvent paste 방식 사용. execCommand 동작하지 않음.",
      "codeTemplates": {
        "type": "const dt=new DataTransfer();dt.setData('text/plain','{{text}}');document.querySelector('[data-lexical-editor]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true}));"
      }
    },
    "source": "builtin",
    "verifiedOnSites": ["chatgpt.com"]
  }
]
```

---

## 프레임워크 감지

```typescript
// framework-capture.ts — 페이지에서 실행할 감지 스크립트
const DETECT_SCRIPT = `(() => {
  const f = [];
  // React
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    const el = document.querySelector('[data-reactroot]') || document.getElementById('root');
    const fiber = el?._reactRootContainer || el?.__reactFiber$;
    f.push({ name:'react', confidence:0.95, reactivityModel:'virtual-dom', eventSystem:'synthetic',
      version: fiber?._internalRoot?.current?.memoizedState?.element?.type?.version,
      devToolsHook:'__REACT_DEVTOOLS_GLOBAL_HOOK__' });
  }
  // Vue
  if (window.__VUE__ || document.querySelector('.__vue_app__,[data-v-]')) {
    f.push({ name:'vue', confidence:0.9, reactivityModel:'proxy', eventSystem:'native',
      version: window.__VUE__?.version, devToolsHook:'__VUE_DEVTOOLS_GLOBAL_HOOK__' });
  }
  // Angular
  const ngEl = document.querySelector('[ng-version]');
  if (window.ng || ngEl) {
    f.push({ name:'angular', confidence:0.95, reactivityModel:'zone', eventSystem:'zone',
      version: ngEl?.getAttribute('ng-version') });
  }
  // Next.js
  if (window.__NEXT_DATA__) f.push({ name:'next', confidence:0.9, reactivityModel:'virtual-dom', eventSystem:'synthetic' });
  // Svelte
  if (document.querySelector('[class*="svelte-"]')) f.push({ name:'svelte', confidence:0.8, reactivityModel:'compiler', eventSystem:'native' });
  // Solid
  if (window._$HY) f.push({ name:'solid', confidence:0.8, reactivityModel:'signals', eventSystem:'native' });
  return f;
})()`;
```

### 프레임워크별 상태 변경 방법

```
React:    nativeInputValueSetter + dispatchEvent (controlled input)
          또는 __reactFiber$ → setState 직접 호출
Vue:      component.proxy.property = newVal (reactivity 자동 감지)
Angular:  ng.getComponent(el).property = newVal + detectChanges()
Svelte:   일반 DOM 이벤트로 충분
Solid:    일반 DOM 이벤트로 충분
```

---

## Service Worker 모니터링

```typescript
interface WorkerMonitor {
  errors: WorkerError[];
  status: 'active' | 'stopped' | 'crashed' | 'installing' | 'waiting';
  lastCrash?: { timestamp: number; error: string };
  restartCount: number;
  watching: boolean;
}

interface WorkerError {
  timestamp: number;
  type: 'exception' | 'unhandled_rejection' | 'console_error' | 'crash';
  message: string;
  stack?: string;
  source?: string;
  context?: string;
}
```

CDP 이벤트 바인딩:
```typescript
// Service Worker 타겟에 attach 후:
cdp.on('Runtime.exceptionThrown', (p) => { /* → errors에 추가 */ });
cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type==='error') /* → errors */ });
cdp.on('Target.targetCrashed', () => { status='crashed'; restartCount++ });
cdp.on('Target.targetInfoChanged', (p) => { /* status 업데이트 */ });
```

`ext_worker` 서브커맨드: `status | errors | watch | unwatch | restart`

---

## 팝업 자동화

팝업을 탭으로 열어 테스트한다 (`chrome-extension://[id]/popup.html` → 새 탭).

```typescript
interface PopupTestOptions {
  viewportWidth?: number;   // 기본 400
  viewportHeight?: number;  // 기본 600
  preloadStorage?: Record<string, unknown>;
  autoOnboarding?: boolean;
}

async function openPopupForTest(opts: PopupTestOptions) {
  const tabId = await Target.createTarget({ url: `chrome-extension://${extId}/popup.html` });
  await Emulation.setDeviceMetricsOverride({
    width: opts.viewportWidth ?? 400,
    height: opts.viewportHeight ?? 600,
    deviceScaleFactor: 1, mobile: false
  });
  if (opts.preloadStorage) {
    await workerEvaluate(`chrome.storage.local.set(${JSON.stringify(opts.preloadStorage)})`);
  }
  return tabId;
}
```

가능/불가능:
```
✅ 팝업 열기 + DOM 조작 + 클릭/입력/스크롤 + 스크린샷
✅ chrome.storage 읽기/쓰기 + runtime.sendMessage
✅ 뷰포트 크기 시뮬레이션 (Emulation)
⚠️ Badge 텍스트 확인 (chrome.action API 간접)
❌ 툴바 클릭으로 팝업 열기 시뮬레이션
❌ 포커스 잃으면 닫히는 동작 테스트
```

---

## Product MCP Scaffolding

`product_scaffold` tool이 생성하는 템플릿:

```
products/my-extension-mcp/
├── src/
│   ├── index.ts           # MCP 서버 진입점
│   ├── connection.ts      # 범용 익스텐션 연결 보일러플레이트
│   ├── tools/
│   │   ├── data.ts        # 데이터 CRUD (커스터마이즈)
│   │   ├── ui.ts          # UI 테스트 (openPopup, popupClick 등)
│   │   ├── storage.ts     # chrome.storage 읽기/쓰기
│   │   └── dev.ts         # reload, console, errors
│   └── types.ts
├── config.json
│   { "extensionId": "...", "popupUrl": "popup.html",
│     "optionsUrl": "options.html", "siteProfiles": ["chatgpt.com"] }
└── package.json
```

핵심 보일러플레이트 — `connection.ts`:
```typescript
import { CoreMCP } from '@cdp-mcp/core';

export class ExtensionConnection {
  constructor(private core: CoreMCP, private extensionId: string) {}

  async ensureConnected(): Promise<void> {
    // 1. CDP 연결 확인 → 2. Extension target 찾기 → 3. SW attach → 4. 캐싱
  }

  async sendCommand<T>(command: string, params?: unknown): Promise<T> {
    await this.ensureConnected();
    return this.core.extensionEvaluate(
      `handleMcpCommand('${command}', ${JSON.stringify(params)})`
    );
  }

  async openPopup(page: 'popup'|'options' = 'popup'): Promise<string> {
    // Target.createTarget → tabId 반환
  }
}
```

---

## Tool 설계 규칙

### Namespace

```
cdp_*       → Layer 1 Core
site_*      → Layer 2 Intelligence
debug_*     → Layer 2 디버깅
pattern_*   → Layer 2 Pattern Registry
ext_*       → Layer 1 익스텐션
product_*   → Scaffolding
qa_*        → QA Layer
```

### 동적 로딩

Always Loaded 8개 + Deferred 42개. Deferred tool은 태그 검색으로 on-demand 로딩.

### Tool 설명 작성 형식

모든 Deferred tool:
```typescript
{
  name: "site_trace_event",
  summary: "한 줄 요약",
  description: `
    상세 1~2문장.
    USE WHEN: 구체적 상황 2~3개
    DON'T USE WHEN: 대안 tool 이름 포함
  `,
  tags: ["5~10개 검색 키워드"]
}
```

---

## 알려진 CDP 제한사항

구현 시 반드시 우회해야 하는 것들:

```
❌ extension_evaluate → Dexie/라이브러리 접근 불가 (importScripts 불가)
❌ extension_evaluate → IndexedDB 직접 열기 불가 (버전 충돌)
❌ extension_evaluate → chrome.runtime.sendMessage 불가 (컨텍스트 분리)
❌ browser_evaluate → Content Script API 불가 (isolated world)

✅ 우회: Popup을 탭으로 열고 DOM 확인
✅ 우회: Console 로그 캡처로 간접 확인
✅ 우회: 스크린샷으로 시각적 확인
✅ 우회: handleMcpCommand 패턴으로 SW에 메시지 전달
```

---

## 전체 Tool 카탈로그

### Always Loaded (11개)

| Tool | Layer | 설명 |
|------|-------|------|
| `cdp_evaluate` | Core | Context-Aware JS 실행 (page/content/worker/popup) |
| `cdp_navigate` | Core | URL 이동 + 로딩 대기 |
| `cdp_click` | Core | 요소 클릭 |
| `cdp_type` | Core | 텍스트 입력 (다중 방식 자동 판별) |
| `cdp_press_key` | Core | 키보드 키 입력 — 단일 키(Enter, Tab, Escape), 조합(Ctrl+A), 시퀀스, 홀드/릴리스 |
| `cdp_select_text` | Core | 키보드 기반 텍스트 선택 — 전체/단어/줄/문자 단위, 방향/횟수 지정 |
| `cdp_clipboard` | Core | 클립보드 제어 — 복사/붙여넣기/잘라내기/읽기 |
| `site_analyze` | Intelligence | URL → SiteProfile 자동 생성 |
| `cdp_ext_attach` | Core | 익스텐션 Service Worker 연결 |
| `cdp_screenshot` | Core | 스크린샷 |
| `cdp_page_info` | Core | 현재 페이지 메타 정보 |

### Deferred — CDP Core (15개)

| Tool | 설명 | 파라미터 | Tags |
|------|------|---------|------|
| `cdp_dom_snapshot` | DOM + computed styles 캡처 | `selector?, depth?, includeStyles?` | dom, snapshot, capture |
| `cdp_dom_watch_start` | DOM 변화 실시간 감시 | `selector?, options` | dom, watch, mutation |
| `cdp_dom_watch_stop` | 감시 중단 + 리포트 | `observerId?` | dom, watch, stop |
| `cdp_network_capture` | 네트워크 캡처 start/stop/get | `action, filterDomains?` | network, capture, api |
| `cdp_network_wait` | 특정 패턴 대기 | `urlPattern, timeout?` | network, wait, pattern |
| `cdp_network_intercept` | 요청 인터셉트 | `urlPattern, action` | network, intercept |
| `cdp_console_capture` | 콘솔 캡처 start/stop/get | `action, levels?` | console, log, error |
| `cdp_upload` | 파일 업로드 (3방식) | `selector, filePath, method?` | upload, file |
| `cdp_scroll` | 스크롤 | `selector?, direction, amount?` | scroll |
| `cdp_connect` | Chrome 연결 | `port?` | connect, chrome |
| `cdp_list_tabs` | 탭 목록 | `filter?` | tabs, list |
| `cdp_switch_tab` | 탭 전환 | `tabId or url or title` | tabs, switch |
| `cdp_chrome_launch` | Chrome 실행 | `port?, userDataDir?` | chrome, launch |
| `cdp_chrome_status` | 연결 상태 | — | chrome, status |
| `cdp_ext_reload` | 익스텐션 리로드 | `extensionId, waitMs?` | extension, reload |

### Deferred — Intelligence (12개)

| Tool | 설명 | Tags |
|------|------|------|
| `site_capture_dom` | DOM 스냅샷 (영역 지정) | dom, capture, selector |
| `site_capture_events` | 이벤트 리스너 매핑 | event, listener, click, keydown |
| `site_capture_network` | N초 네트워크 → 엔드포인트 분류 | network, endpoint, classify |
| `site_capture_state` | Storage + Framework 상태 | storage, localStorage, indexedDB |
| `site_selectors` | 안정적 셀렉터 추천 | selector, stable, aria, confidence |
| `site_input_method` | 입력 방식 추천 | input, editor, lexical, prosemirror |
| `site_framework` | 프레임워크 감지 | framework, react, vue, angular |
| `site_profile_get` | SiteProfile 조회 | profile, query, get |
| `site_profile_update` | SiteProfile 수동 보정 | profile, update, edit |
| `site_diff` | 시점 간 변화 비교 | diff, change, compare, history |
| `site_monitor` | 주기적 변화 모니터링 | monitor, watch, schedule |
| `ext_worker` | Worker 상태/에러/감시 (서브커맨드) | service-worker, error, crash |

### Deferred — Debug (8개)

| Tool | 설명 | Tags |
|------|------|------|
| `debug_stream` | 실시간 로그/에러 스트리밍 | debug, log, error, realtime |
| `debug_trace_pipeline` | 파이프라인 단계별 추적 | debug, trace, step |
| `debug_bisect_workflow` | 이진 탐색 실패 단계 | debug, bisect, failing |
| `debug_record_sequence` | 이벤트 시퀀스 기록 | debug, record, replay |
| `debug_compare_runs` | 두 실행 비교 | debug, compare, regression |
| `debug_verify_selectors` | 셀렉터 건강 확인 | debug, selector, broken |
| `debug_save_state` | 상태 스냅샷 저장 | debug, state, snapshot |
| `debug_replay` | 저장 상태 복원 | debug, replay, restore |

### Deferred — Pattern & Scaffolding (7개)

| Tool | 설명 | Tags |
|------|------|------|
| `pattern_list` | 패턴 목록 | pattern, list, registry |
| `pattern_match` | 현재 페이지 패턴 매칭 | pattern, match, detect |
| `pattern_add` | 새 패턴 등록 | pattern, add, learn |
| `pattern_test` | 패턴 테스트 | pattern, test, verify |
| `product_scaffold` | 새 Product MCP 생성 | product, scaffold, create |
| `product_generate_tools` | SiteProfile 기반 tool 생성 | product, generate, auto |
| `product_test_setup` | 테스트 환경 구성 | product, test, popup |

**총계: Always 11 + Deferred 42 = 53개 (+ QA 10개 = 63개)**

### Deferred — QA Layer (10개)

| Tool | 설명 | Tags |
|------|------|------|
| `qa_assert` | 단일 assertion 실행 | qa, assert, verify, check |
| `qa_run` | 시나리오 파일 실행 | qa, scenario, run, test |
| `qa_status` | 현재 실행 상태/진행률 | qa, status, progress |
| `qa_run_step` | step-by-step 대화형 실행 | qa, step, interactive, debug |
| `qa_run_suite` | 여러 시나리오 묶어 실행 | qa, suite, batch |
| `qa_run_cross_platform` | 같은 시나리오 여러 사이트 | qa, cross-platform, repeat |
| `qa_report` | 마지막 실행 리포트 | qa, report, result |
| `qa_compare` | 두 실행 비교 (회귀 분석) | qa, compare, regression |
| `qa_baseline_update` | 시각적 기준 스크린샷 갱신 | qa, visual, baseline |
| `qa_list_scenarios` | 사용 가능한 시나리오 목록 | qa, scenario, list |

---

## site_analyze 실행 흐름

```
site_analyze(url, depth: 'quick'|'standard'|'deep')

1. navigate(url) + 로드 대기
2. 병렬 캡처:
   ├── DOM 스냅샷 → structure
   ├── 네트워크 10초 캡처 → endpoints 분류
   ├── 프레임워크 감지 스크립트 → framework
   ├── 이벤트 리스너 스캔 → events
   ├── CSS 변수/클래스 수집 → visual
   ├── Storage 분석 → state
   └── 입력 필드 스캔 → inputMethods
3. 분석:
   ├── 안정적 셀렉터 추천 → selectors
   ├── API 엔드포인트 분류
   ├── Pattern Registry 매칭
   └── 미지의 패턴 → "unknown" + 수동 확인 제안
4. SQLite에 SiteProfile 저장
5. 요약 리포트 반환
```

---

## 구현 순서

### Phase 1: Core 기반 (1~2주)

모노레포 셋업 → CDP 클라이언트 → 연결 풀 → 실행 컨텍스트 시스템 → Always Loaded 8개 tool 구현.
검증: ChatGPT.com 접속 → DOM 스냅샷 → 텍스트 입력 → 전송.

### Phase 2: Intelligence MVP (1~2주)

SiteProfile 타입 + SQLite → 캡처 모듈들 → 프레임워크 감지 → Pattern Registry 기본 + 내장 패턴 → `site_analyze` tool.
검증: `site_analyze("chatgpt.com")` 결과 확인.

### Phase 3: Diff & Monitor (1주)

스냅샷 비교 엔진 → `site_diff` → `site_monitor` → 깨진 셀렉터 감지.
검증: ChatGPT DOM 변경 시 자동 감지.

### Phase 4: Product Scaffolding (3~5일)

템플릿 시스템 → `product_scaffold` → `connection.ts` 보일러플레이트 → ChatLens MCP 마이그레이션.

### Phase 5: Tool Search & 최적화 (1주)

Deferred loading → 태그 기반 검색 → 시스템 프롬프트 의사결정 가이드.

### Phase 6: QA Layer (2~3주)

상세 명세: docs/qa-layer-spec.md 참조.

**Phase 6A: Assert + Scenario 기반 (1주)**
assert-types + dom-assert + storage-assert → scenario-types + parser → runner (full 모드) → qa_assert + qa_run tool.
검증: ChatLens smoke 시나리오 1개 통과.

**Phase 6B: Runner 확장 + Report (3~5일)**
suite-runner → cross-platform-runner + Intelligence 연동 → report-generator (JSON/Markdown).
검증: ChatLens 전체 시나리오 + 리포트 생성.

**Phase 6C: Visual Regression + Step-by-Step (3~5일)**
pixel-diff (pixelmatch) → baseline 관리 → visual-assert → step-by-step 세션 → regression-tracker.
검증: 팝업 스크린샷 기준 저장 → UI 변경 → diff 감지.

---

## 초기 서비스 데이터 (Intelligence 시드)

```json
{
  "chatgpt.com": { "input": "#prompt-textarea", "send": "[data-testid=\"send-button\"]", "editor": "lexical", "api": "sse" },
  "claude.ai": { "input": "[contenteditable=\"true\"]", "send": "button[type=\"submit\"]", "editor": "prosemirror", "api": "sse" },
  "gemini.google.com": { "input": "rich-textarea", "send": ".send-button", "editor": "custom", "api": "sse" },
  "grok.com": { "input": "textarea", "send": "button[type=\"submit\"]", "editor": "vanilla", "api": "sse" },
  "perplexity.ai": { "input": "textarea", "send": "button[aria-label=\"Submit\"]", "editor": "vanilla", "api": "sse" }
}
```
