# QA Layer 설계 명세서

> 익스텐션의 기능을 하나씩 조작하면서 QA/QC가 가능하도록 하는 전용 레이어.

---

## 위치: 기존 아키텍처에서의 역할

```
┌──────────────────────────────────────────────────────────┐
│                    QA Layer (신규)                         │
│                                                          │
│  "이 익스텐션이 제대로 동작하는가?"를 체계적으로 검증      │
│                                                          │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Assert  │  │Scenario │  │ Runner   │  │ Report   │  │
│  │ Engine  │  │ Engine  │  │          │  │ Engine   │  │
│  └────┬────┘  └────┬────┘  └────┬─────┘  └────┬─────┘  │
│       │            │            │              │         │
├───────▼────────────▼────────────▼──────────────▼─────────┤
│                                                          │
│  Layer 3: Product MCPs  (ChatLens 등)                     │
│  Layer 2: Intelligence  (사이트 분석)                      │
│  Layer 1: CDP Core      (브라우저 제어)                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

의존 방향:
```
QA Layer → Layer 1 (브라우저 조작/관찰)
QA Layer → Layer 2 (사이트 지식 참조, 셀렉터)  
QA Layer → Layer 3 (Product 연결, storage 접근)
```

핵심 원칙: **QA Layer는 "행동"하지 않고 "검증"한다.** 행동은 Layer 1~3에 위임하고, QA는 "기대 결과와 실제 결과가 같은가?"만 판단한다.

---

## 식별 체계 (Naming Conventions)

기존 레이어와 동일한 패턴을 적용한다.

### 타입명: `Qa` 접두사

vitest, playwright 등 테스트 프레임워크 타입과 충돌 방지.

```
기존 레이어 패턴:     SiteProfile, FrameworkDetection, PatternEntry
QA Layer 패턴:        QaScenario, QaAssertResult, QaRunResult, QaReport

❌ QaScenario       → ✅ QaScenario
❌ TestStep           → ✅ QaStep  
❌ QaSuite          → ✅ QaSuite
❌ QaReport         → ✅ QaReport
❌ RunResult          → ✅ QaRunResult
❌ RunOptions         → ✅ QaRunOptions
❌ StepResult         → ✅ QaStepResult
❌ QaAssertResult    → ✅ QaAssertResult
❌ QaAssertStatus    → ✅ QaAssertStatus
```

### Assert 식별자: `{domain}.{action}` 패턴

시나리오 YAML에서 사용하는 assert 종류. 도메인을 접두사로 명시.

```
DOM 검증:
  dom.exists, dom.not_exists
  dom.count, dom.count_at_least, dom.count_at_most
  dom.text_equals, dom.text_contains, dom.text_matches
  dom.has_attribute, dom.has_class
  dom.is_visible, dom.is_hidden, dom.is_enabled, dom.is_disabled
  dom.value_equals, dom.is_checked
  dom.child_count, dom.nth_child_text

Storage 검증:
  storage.key_exists, storage.value_equals, storage.value_contains
  storage.key_count, storage.structure_matches
  storage.local_equals

Network 검증:
  network.request_made, network.request_not_made
  network.response_status, network.response_contains
  network.request_count

State 검증:
  state.ext_equals, state.ext_contains
  state.worker_active, state.no_console_errors
  state.url_equals, state.url_contains, state.tab_count

Visual 검증:
  visual.matches_baseline, visual.element_matches_baseline
```

### 시나리오 ID: `{product}-{feature}-{variant}`

```
chatlens-search-basic
chatlens-search-cross-platform
chatlens-bookmark-crud
chatlens-onboarding-first-install
chatlens-settings-theme-change
```

### 시나리오 파일명: `{feature}-{variant}.yaml`

```
products/chatlens-mcp/qa/scenarios/
├── search-basic.yaml
├── search-cross-platform.yaml
├── bookmark-crud.yaml
├── onboarding-first-install.yaml
└── settings-theme-change.yaml
```

### 시나리오 태그: 카테고리 체계

```
범위 태그:      smoke | regression | full | edge-case
기능 태그:      search | bookmark | settings | onboarding | sync
사이트 태그:    chatgpt | claude | gemini | grok | perplexity
우선순위 태그:  p0 (필수) | p1 (중요) | p2 (선택)
```

예시: `tags: [smoke, search, chatgpt, p0]`

### 함수명: `{도메인}{Action}` camelCase

```
기존 레이어 패턴:     adviseContext(), routeEvaluation(), detectInputMethod()
QA Layer 패턴:        domExists(), storageKeyExists(), networkRequestMade()

Assert 함수:
  dom-assert.ts      → domExists(), domTextContains(), domCount(), domIsVisible()
  storage-assert.ts  → storageKeyExists(), storageValueEquals(), storageKeyCount()
  network-assert.ts  → networkRequestMade(), networkResponseStatus()
  state-assert.ts    → stateWorkerActive(), stateNoConsoleErrors(), stateUrlEquals()
  visual-assert.ts   → visualMatchesBaseline(), visualElementMatchesBaseline()

Runner 함수:
  scenario-runner.ts → runScenario(), runStep(), pauseScenario(), resumeScenario()
  suite-runner.ts    → runSuite(), runSuiteFiltered()
  cross-platform-runner.ts → runCrossPlatform(), resolveProfileVariables()

Report 함수:
  report-generator.ts    → generateReport(), generateSummary()
  report-formatter.ts    → formatAsJson(), formatAsMarkdown(), formatAsHtml()
  regression-tracker.ts  → detectNewFailures(), getConsistentFailures(), getTrend()
```

### 파일명: 기존 레이어와 동일 `{도메인}-{기능}.ts`

```
기존: dom-snapshot.ts, network-capture.ts, framework-capture.ts
QA:   dom-assert.ts, storage-assert.ts, scenario-runner.ts, pixel-diff.ts
      → 이미 일치 ✅
```

---

## 패키지 구조

```
packages/qa/
├── src/
│   ├── assert/                        # ★ 검증 엔진
│   │   ├── dom-assert.ts                 # DOM 상태 검증
│   │   ├── storage-assert.ts             # chrome.storage / localStorage 검증
│   │   ├── network-assert.ts             # 네트워크 요청/응답 검증
│   │   ├── visual-assert.ts              # 스크린샷 비교 (픽셀 diff)
│   │   ├── state-assert.ts              # 익스텐션 내부 상태 검증
│   │   └── assert-types.ts              # 공통 타입 + QaAssertResult
│   │
│   ├── scenario/                      # ★ 시나리오 엔진
│   │   ├── scenario-types.ts             # 시나리오/스텝 타입 정의
│   │   ├── scenario-parser.ts            # JSON/YAML → 실행 가능 시나리오
│   │   ├── scenario-builder.ts           # 프로그래밍 방식 시나리오 구성
│   │   └── step-registry.ts             # 내장 스텝 타입 등록소
│   │
│   ├── runner/                        # ★ 실행 엔진
│   │   ├── scenario-runner.ts            # 시나리오 순차 실행
│   │   ├── suite-runner.ts              # 여러 시나리오 묶어 실행
│   │   ├── cross-platform-runner.ts     # 같은 시나리오를 여러 사이트에서 반복
│   │   ├── retry-handler.ts             # 실패 시 재시도 + 대기 전략
│   │   └── environment.ts               # 테스트 환경 설정/정리
│   │
│   ├── report/                        # ★ 리포트 엔진
│   │   ├── report-types.ts              # 리포트 타입 정의
│   │   ├── report-generator.ts          # 실행 결과 → 구조화 리포트
│   │   ├── report-formatter.ts          # JSON / Markdown / HTML 포맷
│   │   └── regression-tracker.ts        # 이전 결과와 비교 (회귀 감지)
│   │
│   ├── visual/                        # ★ 시각적 회귀 테스트
│   │   ├── screenshot-manager.ts        # 기준 스크린샷 관리
│   │   ├── pixel-diff.ts               # 픽셀 단위 비교 (pixelmatch)
│   │   └── visual-report.ts            # diff 이미지 생성 + 리포트
│   │
│   ├── tools/                         # MCP Tool 핸들러
│   │   ├── assert-tools.ts
│   │   ├── scenario-tools.ts
│   │   ├── runner-tools.ts
│   │   └── report-tools.ts
│   │
│   ├── types.ts                       # 전체 QA 타입 export
│   └── index.ts
│
├── scenarios/                         # 내장 시나리오 예시
│   └── examples/
│       ├── extension-basic.yaml       # 기본 익스텐션 QA 시나리오
│       └── cross-platform.yaml        # 크로스 플랫폼 시나리오
│
├── baselines/                         # 시각적 기준 스크린샷
│   └── .gitkeep
│
├── package.json
└── tsconfig.json
```

의존성:
```
@cdp-mcp/qa: @cdp-mcp/core, @cdp-mcp/intelligence, pixelmatch, pngjs
```

---

## 1. Assert Engine — "이게 맞는가?"

### 핵심 타입

```typescript
// assert-types.ts

type QaAssertStatus = 'pass' | 'fail' | 'skip' | 'error';

interface QaAssertResult {
  status: QaAssertStatus;
  assertion: string;         // 사람이 읽을 수 있는 설명
  expected?: unknown;
  actual?: unknown;
  selector?: string;
  screenshot?: string;       // 실패 시 자동 스크린샷 경로
  duration: number;          // ms
  error?: string;
}
```

### DOM Assert

```typescript
// dom-assert.ts

interface QaDomAssertions {
  // 존재/부재
  exists(selector: string): Promise<QaAssertResult>;
  notExists(selector: string): Promise<QaAssertResult>;
  
  // 개수
  count(selector: string, expected: number): Promise<QaAssertResult>;
  countAtLeast(selector: string, min: number): Promise<QaAssertResult>;
  countAtMost(selector: string, max: number): Promise<QaAssertResult>;
  
  // 텍스트
  textEquals(selector: string, expected: string): Promise<QaAssertResult>;
  textContains(selector: string, substring: string): Promise<QaAssertResult>;
  textMatches(selector: string, regex: string): Promise<QaAssertResult>;
  
  // 속성
  hasAttribute(selector: string, attr: string, value?: string): Promise<QaAssertResult>;
  hasClass(selector: string, className: string): Promise<QaAssertResult>;
  
  // 가시성
  isVisible(selector: string): Promise<QaAssertResult>;
  isHidden(selector: string): Promise<QaAssertResult>;
  isEnabled(selector: string): Promise<QaAssertResult>;
  isDisabled(selector: string): Promise<QaAssertResult>;
  
  // 값
  valueEquals(selector: string, expected: string): Promise<QaAssertResult>;
  isChecked(selector: string): Promise<QaAssertResult>;
  
  // 순서/구조
  childCount(selector: string, expected: number): Promise<QaAssertResult>;
  nthChildText(selector: string, n: number, expected: string): Promise<QaAssertResult>;
}
```

구현 원리 — 모든 assertion은 Layer 1의 `cdp_evaluate`를 통해 실행:

```typescript
// dom-assert.ts 구현 예시
async function domExists(selector: string): Promise<QaAssertResult> {
  const start = Date.now();
  const result = await evaluate({
    context: 'page',  // 또는 'popup'
    code: `!!document.querySelector('${escapeSelector(selector)}')`
  });
  return {
    status: result === true ? 'pass' : 'fail',
    assertion: `Element "${selector}" should exist`,
    expected: true,
    actual: result,
    selector,
    duration: Date.now() - start
  };
}
```

### Storage Assert

```typescript
// storage-assert.ts

interface QaStorageAssertions {
  // chrome.storage (context=worker 또는 popup)
  storageKeyExists(area: 'local'|'sync'|'session', key: string): Promise<QaAssertResult>;
  storageValueEquals(area: 'local'|'sync'|'session', key: string, expected: unknown): Promise<QaAssertResult>;
  storageValueContains(area: 'local'|'sync'|'session', key: string, substring: string): Promise<QaAssertResult>;
  storageKeyCount(area: 'local'|'sync'|'session', prefix: string, expected: number): Promise<QaAssertResult>;
  
  // localStorage (context=page)
  localStorageEquals(key: string, expected: string): Promise<QaAssertResult>;
  
  // 구조 검증 (deep equality)
  storageStructureMatches(area: 'local'|'sync', key: string, schema: object): Promise<QaAssertResult>;
}
```

### Network Assert

```typescript
// network-assert.ts

interface QaNetworkAssertions {
  // 특정 요청이 발생했는지
  requestWasMade(urlPattern: string, method?: string): Promise<QaAssertResult>;
  requestNotMade(urlPattern: string): Promise<QaAssertResult>;
  
  // 응답 검증
  responseStatusIs(urlPattern: string, expectedStatus: number): Promise<QaAssertResult>;
  responseBodyContains(urlPattern: string, substring: string): Promise<QaAssertResult>;
  
  // 요청 개수
  requestCount(urlPattern: string, expected: number): Promise<QaAssertResult>;
}
```

네트워크 assert는 Layer 1의 `cdp_network_capture`와 연동:
```
시나리오 시작 시 네트워크 캡처 자동 시작 → 스텝 실행 → assert 시점에 캡처 데이터 검색
```

### State Assert

```typescript
// state-assert.ts

interface QaStateAssertions {
  // 익스텐션 내부 상태 (handleMcpCommand 통해)
  extensionStateEquals(command: string, expected: unknown): Promise<QaAssertResult>;
  extensionStateContains(command: string, path: string, expected: unknown): Promise<QaAssertResult>;
  
  // Service Worker 상태
  workerIsActive(): Promise<QaAssertResult>;
  workerHasNoErrors(): Promise<QaAssertResult>;
  consoleHasNoErrors(): Promise<QaAssertResult>;
  
  // URL/탭 상태
  currentUrlEquals(expected: string): Promise<QaAssertResult>;
  currentUrlContains(substring: string): Promise<QaAssertResult>;
  tabCountEquals(expected: number): Promise<QaAssertResult>;
}
```

### Visual Assert

```typescript
// visual-assert.ts

interface QaVisualAssertions {
  // 스크린샷 비교
  matchesBaseline(
    name: string,                    // 기준 이미지 이름
    options?: {
      selector?: string;             // 특정 영역만
      threshold?: number;            // 허용 차이 (0~1, 기본 0.1)
      updateBaseline?: boolean;      // true면 현재를 새 기준으로 저장
    }
  ): Promise<QaAssertResult & { diffImage?: string; diffPercent?: number }>;
  
  // 요소 스크린샷 비교
  elementMatchesBaseline(selector: string, name: string): Promise<QaAssertResult>;
}
```

---

## 2. Scenario Engine — "무엇을 어떤 순서로 검증하는가?"

### 시나리오 타입

```typescript
// scenario-types.ts

interface QaScenario {
  id: string;
  name: string;
  description?: string;
  tags: string[];                      // ['smoke', 'search', 'chatgpt']
  
  // 환경 설정
  setup?: QaSetupConfig;
  
  // 테스트 단계
  steps: QaStep[];
  
  // 정리
  teardown?: QaTeardownConfig;
}

interface QaSetupConfig {
  sites?: string[];                    // 방문할 사이트 (크로스플랫폼용)
  extension?: {
    id: string;
    preloadStorage?: Record<string, unknown>;
    waitForReady?: string;             // 준비 완료 조건 (셀렉터 또는 storage key)
  };
  viewport?: { width: number; height: number };
  clearData?: boolean;                 // storage 초기화
}

interface QaTeardownConfig {
  clearStorage?: boolean;
  closePopup?: boolean;
  screenshot?: boolean;                // 최종 스크린샷
}

// ★ 핵심: 스텝 타입
type QaStep =
  | QaActionStep      // 행동 (클릭, 입력, 이동)
  | QaAssertStep      // 검증 (DOM, storage, visual)
  | QaWaitStep        // 대기 (시간, 요소, 네트워크)
  | QaContextStep     // 컨텍스트 전환 (page→popup, popup→page)
  | QaGroupStep;      // 스텝 그룹 (반복, 조건부)

interface QaActionStep {
  type: 'action';
  action: 'navigate' | 'click' | 'type' | 'scroll' | 'upload'
        | 'popup_open' | 'popup_close'
        | 'storage_set' | 'storage_clear'
        | 'evaluate' | 'ext_command';
  params: Record<string, unknown>;
  description?: string;
}

interface QaAssertStep {
  type: 'assert';
  assert: 
    // DOM
    | 'dom.exists' | 'dom.not_exists'
    | 'dom.count' | 'dom.count_at_least' | 'dom.count_at_most'
    | 'dom.text_equals' | 'dom.text_contains' | 'dom.text_matches'
    | 'dom.has_attribute' | 'dom.has_class'
    | 'dom.is_visible' | 'dom.is_hidden' | 'dom.is_enabled' | 'dom.is_disabled'
    | 'dom.value_equals' | 'dom.is_checked'
    | 'dom.child_count' | 'dom.nth_child_text'
    // Storage
    | 'storage.key_exists' | 'storage.value_equals' | 'storage.key_count'
    | 'storage.structure_matches'
    // Network
    | 'network.request_made' | 'network.request_not_made' | 'network.response_status'
    // State
    | 'state.ext_equals' | 'state.worker_active' | 'state.no_console_errors'
    | 'state.url_equals' | 'state.url_contains' | 'state.tab_count'
    // Visual
    | 'visual.matches_baseline' | 'visual.element_matches_baseline';
  params: Record<string, unknown>;
  description?: string;
  critical?: boolean;                  // true면 실패 시 시나리오 중단
}

interface QaWaitStep {
  type: 'wait';
  wait: 'time' | 'element' | 'element_gone' | 'network' | 'idle';
  params: {
    ms?: number;
    selector?: string;
    urlPattern?: string;
    timeout?: number;                  // 최대 대기 시간
  };
  description?: string;
}

interface QaContextStep {
  type: 'context';
  target: 'page' | 'popup' | 'options' | 'new_tab';
  params?: {
    url?: string;
    popupPage?: string;               // 'popup.html' | 'options.html'
  };
  description?: string;
}

interface QaGroupStep {
  type: 'group';
  name: string;
  steps: QaStep[];
  repeat?: number;                     // 반복 횟수
  forEachSite?: string[];              // 크로스플랫폼: 각 사이트에서 반복
  continueOnFailure?: boolean;
}
```

### YAML 시나리오 예시: ChatLens 검색 기능 QA

```yaml
# scenarios/chatlens/search-basic.yaml

id: chatlens-search-basic
name: "ChatLens 기본 검색 기능"
description: "ChatGPT에서 대화 생성 후 ChatLens 검색이 정상 작동하는지 검증"
tags: [smoke, search, chatgpt]

setup:
  extension:
    id: "${CHATLENS_EXT_ID}"
    clearData: true
    waitForReady: "storage:chatlens_initialized"

steps:
  # 1단계: 사이트에서 데이터 생성
  - type: action
    action: navigate
    params: { url: "https://chatgpt.com" }
    description: "ChatGPT 접속"

  - type: wait
    wait: element
    params: { selector: "#prompt-textarea", timeout: 10000 }

  - type: action
    action: type
    params: { selector: "#prompt-textarea", text: "QA 테스트용 대화입니다" }

  - type: action
    action: click
    params: { selector: "[data-testid='send-button']" }

  - type: wait
    wait: network
    params: { urlPattern: "*/conversation", timeout: 15000 }

  # 2단계: 익스텐션이 데이터를 수집했는지 확인
  - type: wait
    wait: time
    params: { ms: 3000 }
    description: "익스텐션 데이터 수집 대기"

  - type: assert
    assert: storage.key_exists
    params: { area: "local", key: "chatlens_conversations" }
    description: "ChatLens가 대화를 저장했는지 확인"
    critical: true

  # 3단계: 팝업 열고 검색
  - type: context
    target: popup
    description: "ChatLens 팝업 열기"

  - type: wait
    wait: element
    params: { selector: "[data-testid='search-input']", timeout: 5000 }

  - type: assert
    assert: dom.exists
    params: { selector: "[data-testid='search-input']" }
    description: "검색창이 존재하는지"

  - type: action
    action: type
    params: { selector: "[data-testid='search-input']", text: "QA 테스트" }

  - type: wait
    wait: time
    params: { ms: 1000 }
    description: "검색 결과 로딩 대기"

  # 4단계: 검색 결과 검증
  - type: assert
    assert: dom.count_at_least
    params: { selector: "[data-testid='search-result']", min: 1 }
    description: "검색 결과가 1개 이상 존재"
    critical: true

  - type: assert
    assert: dom.text_contains
    params: { selector: "[data-testid='search-result']:first-child", substring: "QA 테스트" }
    description: "첫 번째 결과에 검색어 포함"

  - type: assert
    assert: state.no_console_errors
    params: {}
    description: "콘솔 에러 없음"

  # 5단계: 시각적 확인
  - type: assert
    assert: visual.matches_baseline
    params: { name: "chatlens-search-results", threshold: 0.15 }
    description: "검색 결과 UI가 기준과 일치"

teardown:
  screenshot: true
  clearStorage: true
```

### 크로스 플랫폼 시나리오 예시

```yaml
# scenarios/chatlens/cross-platform-input.yaml

id: chatlens-cross-platform-input
name: "크로스 플랫폼 입력 테스트"
tags: [cross-platform, input]

setup:
  extension:
    id: "${CHATLENS_EXT_ID}"

steps:
  - type: group
    name: "각 플랫폼 입력 테스트"
    forEachSite:
      - chatgpt.com
      - claude.ai
      - gemini.google.com
      - grok.com
      - perplexity.ai
    steps:
      - type: action
        action: navigate
        params: { url: "https://${site}" }

      - type: wait
        wait: element
        params: { selector: "${site.inputSelector}", timeout: 10000 }
        # site.inputSelector는 Intelligence의 SiteProfile에서 자동 해소

      - type: action
        action: type
        params: { selector: "${site.inputSelector}", text: "cross-platform QA test" }

      - type: assert
        assert: dom.value_equals
        params: { selector: "${site.inputSelector}", expected: "cross-platform QA test" }
        description: "${site}에서 텍스트 입력 정상"

      - type: assert
        assert: state.no_console_errors
        params: {}

      - type: assert
        assert: state.worker_active
        params: {}
        description: "Service Worker가 크래시 없이 살아있음"
```

### Scenario Builder (프로그래밍 방식)

```typescript
// scenario-builder.ts — YAML 대신 코드로 시나리오 작성

const scenario = new QaScenarioBuilder('chatlens-bookmark-test')
  .describe('북마크 추가/삭제 테스트')
  .tags(['bookmark', 'storage', 'p0'])
  .setup({ extension: { id: EXT_ID, clearData: true } })
  
  // 팝업에서 북마크 추가
  .openPopup()
  .waitFor('[data-testid="conversation-list"]')
  .click('[data-testid="conversation-item"]:first-child [data-testid="bookmark-btn"]')
  .waitFor(500)
  
  // 북마크가 storage에 저장됐는지
  .assert('storage.key_exists', { area: 'local', key: 'chatlens_bookmarks' })
  .assert('storage.key_count', { area: 'local', prefix: 'bookmark_', expected: 1 })
  
  // 북마크 탭에 표시되는지
  .click('[data-testid="tab-bookmarks"]')
  .waitForElement('[data-testid="bookmark-item"]')
  .assert('dom.count', { selector: '[data-testid="bookmark-item"]', expected: 1 })
  
  // 북마크 삭제
  .click('[data-testid="bookmark-item"]:first-child [data-testid="remove-btn"]')
  .waitFor(500)
  .assert('dom.count', { selector: '[data-testid="bookmark-item"]', expected: 0 })
  .assert('storage.key_count', { area: 'local', prefix: 'bookmark_', expected: 0 })
  
  .teardown({ screenshot: true })
  .build();
```

---

## 3. Runner Engine — "어떻게 실행하는가?"

### Scenario Runner

```typescript
// scenario-runner.ts

interface QaRunOptions {
  scenario: QaScenario;
  
  // 실행 모드
  mode: 'full' | 'step-by-step' | 'from-step';
  fromStep?: number;
  
  // 실패 처리
  stopOnFailure?: boolean;             // critical assert 외에도 즉시 중단
  retryFailed?: number;               // 실패 스텝 재시도 횟수
  retryDelay?: number;                // 재시도 간 대기 (ms)
  
  // 기록
  screenshotOnFailure?: boolean;       // 실패 시 자동 스크린샷 (기본: true)
  recordNetwork?: boolean;             // 네트워크 자동 캡처 (기본: true)
  recordConsole?: boolean;             // 콘솔 자동 캡처 (기본: true)
  
  // 환경
  variables?: Record<string, string>;  // ${VAR} 치환용
}

interface QaRunResult {
  scenarioId: string;
  scenarioName: string;
  status: 'pass' | 'fail' | 'error' | 'partial';
  startedAt: number;
  completedAt: number;
  duration: number;
  
  steps: QaStepResult[];
  
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errors: number;
  };
  
  // 자동 수집 데이터
  screenshots: string[];               // 실패 시 + teardown 스크린샷
  networkLog?: CapturedRequest[];
  consoleLog?: ConsoleEntry[];
  workerErrors?: WorkerError[];
}

interface QaStepResult {
  index: number;
  step: QaStep;
  status: QaAssertStatus;
  duration: number;
  result?: QaAssertResult;            // assert 스텝만
  error?: string;                      // error 스텝만
  screenshot?: string;                 // 실패 시 자동 캡처
  retryCount?: number;
}
```

### Suite Runner — 여러 시나리오 묶어 실행

```typescript
// suite-runner.ts

interface QaSuite {
  name: string;
  scenarios: QaScenario[];
  
  // 필터
  tags?: string[];                     // 특정 태그만 실행
  exclude?: string[];                  // 제외할 시나리오 ID
  
  // 글로벌 설정
  globalSetup?: QaSetupConfig;
  globalTeardown?: QaTeardownConfig;
  parallelism?: number;                // 동시 실행 (기본: 1 = 순차)
}

interface QaSuiteResult {
  suiteName: string;
  status: 'pass' | 'fail' | 'partial';
  duration: number;
  scenarios: QaRunResult[];
  
  summary: {
    totalScenarios: number;
    passed: number;
    failed: number;
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
  };
}
```

### Cross-Platform Runner

```typescript
// cross-platform-runner.ts — 같은 시나리오를 여러 사이트에서 반복

interface QaCrossPlatformConfig {
  scenario: QaScenario;
  sites: string[];                     // ['chatgpt.com', 'claude.ai', ...]
  
  // 사이트별 변수를 Intelligence SiteProfile에서 자동 해소
  // ${site.inputSelector} → SiteProfile.selectors['input'].primary
  // ${site.sendSelector}  → SiteProfile.selectors['send'].primary
  // ${site.editor}        → SiteProfile.behavior.inputMethods[0].editorFramework
  resolveFromProfile: boolean;
}

interface QaCrossPlatformResult {
  scenario: string;
  sites: Record<string, QaRunResult>;    // 사이트별 결과
  
  comparison: {
    allPassed: string[];               // 모든 사이트 통과
    someFailed: string[];              // 일부 사이트 실패
    siteSpecificIssues: Array<{
      site: string;
      failedSteps: number[];
      reason: string;
    }>;
  };
}
```

### Step-by-Step 모드 (대화형 QA)

Claude Code나 MCP client에서 한 스텝씩 실행하면서 결과를 확인:

```typescript
// 사용 예:
// qa_run_step → 스텝 1 실행 → 결과 반환 → 사람이 확인 → qa_run_step → 스텝 2 ...

interface QaStepSession {
  sessionId: string;
  scenario: QaScenario;
  currentStep: number;
  results: QaStepResult[];
  status: 'running' | 'paused' | 'completed' | 'failed';
}
```

---

## 4. Report Engine — "결과를 어떻게 보여주는가?"

### Report 타입

```typescript
// report-types.ts

interface QaReport {
  id: string;
  generatedAt: number;
  
  // 실행 정보
  environment: {
    chrome: string;
    extension: { id: string; version: string };
    os: string;
  };
  
  // 결과 요약
  summary: {
    status: 'pass' | 'fail' | 'partial';
    totalScenarios: number;
    passedScenarios: number;
    failedScenarios: number;
    totalAssertions: number;
    passedAssertions: number;
    failedAssertions: number;
    duration: number;
  };
  
  // 시나리오별 상세
  scenarios: QaRunResult[];
  
  // 회귀 분석 (이전 실행과 비교)
  regression?: {
    previousRunId: string;
    newFailures: string[];             // 이번에 새로 실패한 것
    fixed: string[];                   // 이번에 고쳐진 것
    consistent: string[];              // 계속 실패 중인 것
  };
  
  // 시각적 회귀
  visualRegression?: {
    changed: Array<{
      name: string;
      diffPercent: number;
      diffImage: string;
      baselineImage: string;
      currentImage: string;
    }>;
    unchanged: string[];
    newBaselines: string[];
  };
}
```

### Regression Tracker — 회귀 감지

```typescript
// regression-tracker.ts

// 이전 리포트를 SQLite에 저장하고, 새 결과와 비교
interface QaRegressionAnalysis {
  // "어제까지 통과했는데 오늘 실패한 것" 자동 감지
  detectNewFailures(current: QaReport, previous: QaReport): string[];
  
  // "3일 연속 실패 중" 추적
  getConsistentFailures(recentReports: QaReport[]): string[];
  
  // 트렌드: 시간에 따른 통과율 변화
  getTrend(scenarioId: string, lastN: number): Array<{
    date: string;
    status: 'pass' | 'fail';
    duration: number;
  }>;
}
```

---

## 5. Visual Regression — "UI가 깨지지 않았는가?"

```typescript
// pixel-diff.ts

interface QaPixelDiffResult {
  match: boolean;
  diffPercent: number;                 // 0.0 ~ 100.0
  diffPixelCount: number;
  totalPixels: number;
  diffImagePath?: string;             // diff 시각화 이미지
}

async function compareScreenshots(
  baselinePath: string,
  currentPath: string,
  options: {
    threshold: number;                 // 픽셀 민감도 (0~1, 기본 0.1)
    includeAA: boolean;                // anti-aliasing 차이 포함 (기본 false)
    maskSelectors?: string[];          // 무시할 영역 (동적 콘텐츠)
  }
): Promise<PixelDiffResult>;
```

### 기준 스크린샷 관리

```
baselines/
├── chatlens/
│   ├── popup-search-results.png
│   ├── popup-bookmarks.png
│   ├── popup-empty-state.png
│   └── popup-settings.png
└── manifest.json                      # 기준 메타데이터
    {
      "popup-search-results": {
        "createdAt": "2026-02-09",
        "viewport": { "width": 400, "height": 600 },
        "description": "검색 결과 3개 표시 상태"
      }
    }
```

---

## 6. QA MCP Tools (10개)

### Always Loaded (QA 모드에서)

| Tool | 설명 | 파라미터 |
|------|------|---------|
| `qa_assert` | 단일 assertion 실행 | `assert, params, context?` |
| `qa_run` | 시나리오 파일 실행 | `scenario (path or id), mode?, variables?` |
| `qa_status` | 현재 실행 상태/진행률 | — |

### Deferred

| Tool | 설명 | Tags |
|------|------|------|
| `qa_run_step` | step-by-step 모드 (다음 스텝 실행) | qa, step, interactive |
| `qa_run_suite` | 여러 시나리오 묶어 실행 | qa, suite, batch |
| `qa_run_cross_platform` | 같은 시나리오를 여러 사이트에서 | qa, cross-platform, repeat |
| `qa_report` | 마지막 실행 리포트 조회 | qa, report, result |
| `qa_compare` | 두 실행 결과 비교 (회귀 분석) | qa, compare, regression |
| `qa_baseline_update` | 시각적 기준 스크린샷 업데이트 | qa, visual, baseline |
| `qa_list_scenarios` | 사용 가능한 시나리오 목록 | qa, scenario, list |

### AI 의사결정 가이드 (시스템 프롬프트용)

Phase 5에서 시스템 프롬프트에 포함될 QA tool 라우팅 규칙.

```
QA TOOL 의사결정:

"테스트 해줘" / "QA 해줘" / "검증 해줘" / "확인 해줘"
  → 시나리오가 있는지 확인: qa_list_scenarios
  → 있으면: qa_run { scenario: "..." }
  → 없으면: qa_assert로 개별 검증

"이거 작동해?" / "제대로 동작하는지 봐줘"
  → 구체적 기능 언급 있으면: qa_run { scenario: 해당 기능 }
  → 없으면: qa_run { scenario: smoke.yaml }

"어제까지 되던 게 오늘도 돼?" / "회귀 테스트"
  → qa_run_suite { tags: ["regression"] }
  → 이전 결과 있으면: qa_compare

"모든 사이트에서 테스트 해줘" / "크로스 플랫폼"
  → qa_run_cross_platform

"한 단계씩 확인하면서" / "디버깅 모드"
  → qa_run { mode: "step-by-step" }
  → 이후: qa_run_step 반복

"검색 결과가 3개 나오는지 확인" (단일 검증)
  → qa_assert { assert: "dom.count", params: { selector: "...", expected: 3 } }

"리포트 보여줘" / "결과 요약"
  → qa_report

"스크린샷이 바뀌었는지" / "UI 깨졌는지"
  → qa_assert { assert: "visual.matches_baseline", params: { name: "..." } }

DON'T USE QA WHEN:
  - 단순 DOM 관찰 → cdp_evaluate, cdp_dom_snapshot
  - 사이트 분석 → site_analyze
  - 디버그 로그 → debug_stream
  - 셀렉터 확인 → site_selectors, debug_verify_selectors
```

### Tool 설명 형식 (Deferred 등록용)

```typescript
// qa_assert
{
  name: "qa_assert",
  summary: "단일 assertion 실행 — DOM/Storage/Network/State/Visual 검증",
  description: `
    특정 조건이 참인지 검증하고 pass/fail 결과를 반환한다.
    USE WHEN: 한 가지만 빠르게 확인할 때, 시나리오 없이 즉석 검증할 때
    DON'T USE WHEN: 여러 단계를 순서대로 검증 → qa_run
  `,
  tags: ["qa", "assert", "verify", "check", "dom", "storage", "network", "visual"]
}

// qa_run
{
  name: "qa_run",
  summary: "YAML/JSON 시나리오 파일을 실행하여 기능을 체계적으로 검증",
  description: `
    시나리오의 모든 스텝을 순차 실행하고 종합 결과를 반환한다.
    USE WHEN: 기능 전체를 테스트할 때, QA 시나리오가 이미 있을 때
    DON'T USE WHEN: 단일 확인 → qa_assert, 여러 시나리오 → qa_run_suite
  `,
  tags: ["qa", "scenario", "run", "test", "execute", "functional"]
}

// qa_run_step
{
  name: "qa_run_step",
  summary: "시나리오를 한 스텝씩 실행하며 중간 결과를 확인",
  description: `
    step-by-step 모드로 시나리오를 진행한다. 실패 원인 추적에 유용.
    USE WHEN: 어디서 실패하는지 찾을 때, 대화형으로 디버깅할 때
    DON'T USE WHEN: 전체 결과만 필요 → qa_run
  `,
  tags: ["qa", "step", "interactive", "debug", "stepbystep"]
}

// qa_run_suite
{
  name: "qa_run_suite",
  summary: "여러 시나리오를 묶어서 한 번에 실행",
  description: `
    태그 필터로 시나리오를 선택하고 일괄 실행한다.
    USE WHEN: 회귀 테스트, 릴리즈 전 전체 검증, smoke 테스트
    DON'T USE WHEN: 단일 시나리오 → qa_run
  `,
  tags: ["qa", "suite", "batch", "regression", "smoke", "release"]
}

// qa_run_cross_platform
{
  name: "qa_run_cross_platform",
  summary: "같은 시나리오를 여러 사이트에서 반복 실행",
  description: `
    ChatGPT, Claude, Gemini 등에서 동일 기능이 작동하는지 검증.
    SiteProfile에서 셀렉터를 자동 해소한다.
    USE WHEN: 크로스 플랫폼 호환성 확인, 새 사이트 지원 추가 후
    DON'T USE WHEN: 한 사이트만 → qa_run
  `,
  tags: ["qa", "cross-platform", "multi-site", "compatibility", "chatgpt", "claude", "gemini"]
}

// qa_report
{
  name: "qa_report",
  summary: "마지막 실행 결과를 구조화된 리포트로 조회",
  description: `
    JSON/Markdown/HTML 형식으로 테스트 결과 요약을 반환한다.
    USE WHEN: 실행 결과 확인, 팀 공유용 리포트, 실패 목록 조회
    DON'T USE WHEN: 실행 중 상태 → qa_status
  `,
  tags: ["qa", "report", "result", "summary", "markdown", "html"]
}

// qa_compare
{
  name: "qa_compare",
  summary: "두 실행 결과를 비교하여 회귀/개선을 감지",
  description: `
    이전 리포트와 현재 리포트를 비교. 새로 깨진 것, 고쳐진 것 분류.
    USE WHEN: 배포 후 회귀 확인, "어제 vs 오늘" 비교
    DON'T USE WHEN: 단순 결과 조회 → qa_report
  `,
  tags: ["qa", "compare", "regression", "diff", "before-after"]
}

// qa_baseline_update
{
  name: "qa_baseline_update",
  summary: "시각적 기준 스크린샷을 현재 상태로 갱신",
  description: `
    의도적 UI 변경 후 새 기준을 저장한다.
    USE WHEN: UI 리디자인 후, 의도된 변경을 반영할 때
    DON'T USE WHEN: UI 비교만 → qa_assert { assert: "visual.matches_baseline" }
  `,
  tags: ["qa", "visual", "baseline", "screenshot", "update", "ui"]
}

// qa_list_scenarios
{
  name: "qa_list_scenarios",
  summary: "사용 가능한 QA 시나리오 목록과 태그를 조회",
  description: `
    등록된 시나리오를 태그/제품별로 필터링하여 보여준다.
    USE WHEN: 어떤 테스트가 있는지 확인, 실행할 시나리오 선택
    DON'T USE WHEN: 바로 실행 → qa_run
  `,
  tags: ["qa", "scenario", "list", "catalog", "available"]
}

// qa_status
{
  name: "qa_status",
  summary: "현재 실행 중인 QA의 진행 상태를 확인",
  description: `
    실행 중인 시나리오/스위트의 현재 스텝, 경과 시간, 중간 결과.
    USE WHEN: 긴 테스트 실행 중 진행률 확인
    DON'T USE WHEN: 완료된 결과 → qa_report
  `,
  tags: ["qa", "status", "progress", "running", "current"]
}
```

---

## 7. Product별 QA 시나리오 위치

```
products/chatlens-mcp/
├── qa/                                # ★ 제품별 QA 시나리오
│   ├── scenarios/
│   │   ├── smoke.yaml                 # 핵심 기능 빠른 확인 (5분)
│   │   ├── search.yaml                # 검색 기능 전체
│   │   ├── bookmark.yaml              # 북마크 기능 전체
│   │   ├── cross-platform.yaml        # 5개 사이트 반복
│   │   ├── onboarding.yaml            # 첫 설치 → 온보딩 흐름
│   │   ├── settings.yaml              # 설정 변경 + 반영
│   │   └── regression-full.yaml       # 전체 회귀 (30분)
│   ├── baselines/                     # 제품별 기준 스크린샷
│   │   ├── popup-default.png
│   │   ├── popup-search.png
│   │   └── popup-bookmarks.png
│   └── fixtures/                      # 테스트용 사전 데이터
│       ├── sample-conversations.json
│       └── sample-bookmarks.json
```

---

## 8. 실행 방법 3가지

### A. MCP Tool로 대화형 (개발 중)

```
Claude: "ChatLens 검색 기능 QA 해줘"

→ qa_run { scenario: "chatlens/search.yaml", mode: "full" }
→ 결과: 12/14 assertions passed, 2 failed
→ qa_report → 상세 리포트
```

### B. CLI로 자동화 (CI/CD)

```bash
# 단일 시나리오
pnpm qa run scenarios/chatlens/smoke.yaml

# 전체 회귀
pnpm qa suite scenarios/chatlens/regression-full.yaml

# 크로스 플랫폼
pnpm qa cross-platform scenarios/chatlens/cross-platform.yaml \
  --sites chatgpt.com,claude.ai,gemini.google.com

# 리포트 생성
pnpm qa report --format html --output reports/latest.html
```

### C. Step-by-Step 디버깅 (문제 추적)

```
qa_run { scenario: "chatlens/search.yaml", mode: "step-by-step" }
→ "Step 1/14: Navigate to ChatGPT — Ready to execute?"

qa_run_step { action: "next" }
→ "Step 1 PASS (1.2s). Step 2/14: Wait for input element — Ready?"

qa_run_step { action: "next" }
→ "Step 2 PASS (0.3s). Step 3/14: Type search text — Ready?"

... 실패 발견 시 ...

qa_run_step { action: "next" }
→ "Step 8 FAIL: Expected count >= 1 for '[data-testid=search-result]', got 0"
→ [자동 스크린샷 첨부]
→ "디버깅을 위해 현재 DOM을 확인하시겠습니까?"
```

---

## 9. Intelligence 연동

QA Layer가 Intelligence를 활용하는 지점:

```
1. 셀렉터 자동 해소
   시나리오의 ${site.inputSelector} → SiteProfile에서 검색
   셀렉터가 깨져있으면 대안 셀렉터 자동 시도

2. 입력 방식 자동 판별
   type 액션 시 → SiteProfile.inputMethods에서 최적 방식 참조

3. 대기 전략 최적화
   SiteProfile.communication.endpoints에서 완료 시그널 참조
   → "이 사이트는 SSE 응답이 끝나면 완료"

4. 깨진 테스트 자동 진단
   셀렉터 실패 시 → site_diff로 "무엇이 바뀌었는지" 자동 분석
   → "ChatGPT가 [data-testid='send-button']을 
       button[data-testid='composer-send-button']으로 변경함"
```

---

## 10. 구현 순서 (Phase 6으로 추가)

### Phase 6A: Assert + Scenario 기반 (1주)

```
1. assert-types.ts + dom-assert.ts + storage-assert.ts
2. scenario-types.ts + scenario-parser.ts
3. scenario-runner.ts (full 모드)
4. qa_assert + qa_run tool
검증: ChatLens smoke.yaml 시나리오 1개 통과
```

### Phase 6B: Runner 확장 + Report (3~5일)

```
1. suite-runner.ts
2. cross-platform-runner.ts + Intelligence 연동
3. report-generator.ts + report-formatter.ts (JSON + Markdown)
4. qa_run_suite + qa_report tool
검증: ChatLens 전체 시나리오 + 리포트 생성
```

### Phase 6C: Visual Regression + Step-by-Step (3~5일)

```
1. pixel-diff.ts (pixelmatch)
2. screenshot-manager.ts + baseline 관리
3. visual-assert.ts + visual-report.ts
4. step-by-step 세션 관리
5. regression-tracker.ts
검증: 팝업 스크린샷 기준 저장 → UI 변경 → diff 감지
```
