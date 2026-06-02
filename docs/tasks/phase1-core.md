# Phase 1: Core 기반 — 태스크 목록

> 21개 atomic 태스크. 각 태스크는 선행 의존이 완료된 상태에서 독립 실행 가능.
> `site_analyze`는 Intelligence Layer이므로 Phase 2에서 구현한다.
> Always Loaded 8개 중 7개를 Phase 1에서 구현한다 (`site_analyze` 제외).

---

## 의존 관계 그래프

```
Task 1 (monorepo)
├── Task 2 (shared 패키지) → Task 3 (shared 유틸)
└── Task 4 (core 패키지)
    └── Task 5 (CDP client) ← Task 3
        ├── Task 6 (Connection Pool)
        │   ├── Task 8 (Context Router) ← Task 7
        │   ├── Task 10 (Tab/Session Mgr)
        │   ├── Task 11 (Extension Mgr)
        │   ├── Task 12 (navigate)
        │   ├── Task 13 (click)
        │   ├── Task 15 (type)
        │   └── Task 16 (screenshot + page-info)
        └── Task 9 (Port/Chrome Mgr)
    └── Task 7 (Context types + Advisor)
        └── Task 14 (evaluate) ← Task 8

Task 17 (act-tools) ← 12,13,14,15
Task 18 (observe-tools + infra-tools) ← 16,11,9,10
Task 19 (MCP server index) ← 17,18
Task 20 (unit test 전체) ← 19
Task 21 (E2E) ← 20
```

---

## A. 프로젝트 셋업 (Task 1~4)

### Task 1: 모노레포 루트 초기화

**의존**: 없음

**산출물**:
- `package.json` — workspace root (`"private": true`, scripts: `test`, `inspect`, `test:e2e`)
- `pnpm-workspace.yaml` — `packages/*`, `products/*` 포함
- `tsconfig.base.json` — strict mode, paths alias (`@cdp-mcp/*`)
- `.gitignore` — node_modules, dist, data/, *.tsbuildinfo
- `.npmrc` — `shamefully-hoist=false`

**작업 내용**:
```
1. pnpm-workspace.yaml 작성: packages: ["packages/*", "products/*"]
2. root package.json 작성 (name: "cdp-mcp", private: true)
   scripts:
     "test": "vitest run",
     "test:watch": "vitest",
     "inspect": "mcp-inspector",
     "test:e2e": "vitest run --config vitest.e2e.config.ts"
3. tsconfig.base.json 작성:
   compilerOptions: strict, target ES2022, module NodeNext,
   moduleResolution NodeNext, declaration, declarationMap,
   sourceMap, outDir dist, rootDir src,
   paths: { "@cdp-mcp/*": ["packages/*/src"] }
4. .gitignore 업데이트: node_modules, dist, *.tsbuildinfo, data/
5. vitest.config.ts (root) — workspace 설정
```

**완료 조건**: `pnpm install` 성공. `pnpm -r ls` 로 빈 workspace 확인.

---

### Task 2: shared 패키지 초기화

**의존**: Task 1

**산출물**:
- `packages/shared/package.json` — name: `@cdp-mcp/shared`, 의존성 없음
- `packages/shared/tsconfig.json` — extends base
- `packages/shared/src/index.ts` — barrel export

**작업 내용**:
```
1. packages/shared/ 디렉토리 생성
2. package.json: name "@cdp-mcp/shared", main/types 설정
3. tsconfig.json: extends "../../tsconfig.base.json"
4. src/index.ts: 빈 barrel (후속 Task 3에서 채움)
```

**완료 조건**: `pnpm --filter @cdp-mcp/shared build` (tsc) 성공.

---

### Task 3: shared 타입 + 유틸리티

**의존**: Task 2

**산출물**:
- `packages/shared/src/types.ts` — 공통 타입 정의
- `packages/shared/src/logger.ts` — 구조화 로거
- `packages/shared/src/utils.ts` — 범용 유틸
- `packages/shared/src/errors.ts` — 공통 에러 클래스

**작업 내용**:
```
types.ts:
  - CdpMcpError (base error class)
  - Result<T> = { ok: true, value: T } | { ok: false, error: CdpMcpError }
  - ExecutionContext = 'page' | 'content' | 'worker' | 'popup'
  - ToolNamespace = 'cdp' | 'site' | 'debug' | 'pattern' | 'ext' | 'product' | 'qa'
  - TabInfo, TargetInfo 등 CDP 공통 타입

logger.ts:
  - createLogger(namespace: string) → { debug, info, warn, error }
  - 환경변수 LOG_LEVEL 지원

utils.ts:
  - sleep(ms)
  - retry<T>(fn, opts: { maxRetries, delay, backoff })
  - escapeSelector(s: string)
  - timeout<T>(promise, ms)

errors.ts:
  - CdpConnectionError, CdpTimeoutError, CdpEvaluationError
  - ContextError (잘못된 실행 컨텍스트)
  - TabNotFoundError, ExtensionNotFoundError
```

**완료 조건**: 단위 테스트 통과 (utils.test.ts, errors.test.ts). `pnpm --filter @cdp-mcp/shared test`.

---

### Task 4: core 패키지 초기화

**의존**: Task 1

**산출물**:
- `packages/core/package.json` — name: `@cdp-mcp/core`, deps: `@cdp-mcp/shared`, `@modelcontextprotocol/sdk`, `ws`
- `packages/core/tsconfig.json` — extends base
- `packages/core/src/index.ts` — barrel export
- 하위 디렉토리 구조: `cdp/`, `observe/`, `act/`, `infra/`, `context/`, `tools/`

**작업 내용**:
```
1. packages/core/ 디렉토리 + 하위 구조 생성
2. package.json: 의존성 설정
   dependencies: @modelcontextprotocol/sdk, ws
   devDependencies: @types/ws, vitest
   peerDependencies: @cdp-mcp/shared
3. tsconfig.json: extends base, references shared
4. src/index.ts: 빈 barrel
```

**완료 조건**: `pnpm install` 성공. 패키지 구조 확인.

---

## B. CDP 통신 기반 (Task 5~6)

### Task 5: CDP WebSocket 클라이언트

**의존**: Task 3, Task 4

**산출물**:
- `packages/core/src/cdp/cdp-client.ts` — 단일 WebSocket CDP 연결
- `packages/core/src/cdp/protocol-types.ts` — CDP 프로토콜 타입 (사용하는 것만)
- `packages/core/src/cdp/__tests__/cdp-client.test.ts`

**작업 내용**:
```
cdp-client.ts:
  class CdpClient {
    constructor(wsUrl: string)
    connect(): Promise<void>
    send<T>(method: string, params?: object): Promise<T>
    on(event: string, handler: Function): void
    off(event: string, handler: Function): void
    close(): Promise<void>
    get connected(): boolean
  }

  내부:
  - WebSocket 연결 관리 (ws 라이브러리)
  - JSON-RPC 2.0 메시지 ID 관리
  - 요청-응답 매칭 (Map<id, {resolve, reject}>)
  - 이벤트 리스닝 (CDP 이벤트 → EventEmitter)
  - 자동 재연결 옵션
  - 타임아웃 처리 (기본 30초)

protocol-types.ts:
  - Phase 1에서 사용하는 CDP 메서드/이벤트만 정의
  - Runtime.evaluate, Page.navigate, Page.lifecycleEvent
  - Input.dispatchMouseEvent, Input.dispatchKeyEvent
  - Page.captureScreenshot, Page.getFrameTree
  - Target.*, Emulation.setDeviceMetricsOverride
```

**완료 조건**: Mock WebSocket으로 send/receive 단위 테스트 통과. 이벤트 핸들링 테스트 통과.

---

### Task 6: Connection Pool

**의존**: Task 5

**산출물**:
- `packages/core/src/cdp/connection-pool.ts`
- `packages/core/src/cdp/__tests__/connection-pool.test.ts`

**작업 내용**:
```
connection-pool.ts:
  class ConnectionPool {
    constructor(browserWsUrl: string)

    // 브라우저 레벨 연결 (Target 도메인)
    connectBrowser(): Promise<void>

    // 탭/타겟별 연결
    getConnection(targetId: string): Promise<CdpClient>
    releaseConnection(targetId: string): void

    // 편의 메서드
    getActiveTab(): Promise<CdpClient>
    getExtensionWorker(extensionId?: string): Promise<CdpClient>
    getPopupTab(extensionId?: string): Promise<CdpClient>

    // 생명주기
    closeAll(): Promise<void>

    // 이벤트
    on(event: 'targetCreated' | 'targetDestroyed' | 'targetInfoChanged', handler): void
  }

  내부:
  - Map<targetId, CdpClient> 연결 캐시
  - Target.setDiscoverTargets로 자동 탐색
  - Target.attachToTarget으로 개별 세션
  - 비활성 연결 정리 (idle timeout)
```

**완료 조건**: Mock 기반 테스트 — 탭 연결/해제, 워커 탐색, 풀 정리 테스트 통과.

---

## C. 실행 컨텍스트 시스템 (Task 7~8)

### Task 7: Context 타입 + Advisor

**의존**: Task 4 (core 패키지 존재)

**산출물**:
- `packages/core/src/context/context-types.ts`
- `packages/core/src/context/context-advisor.ts`
- `packages/core/src/context/__tests__/context-advisor.test.ts`

**작업 내용**:
```
context-types.ts:
  type ExecutionContext = 'page' | 'content' | 'worker' | 'popup'

  interface ContextCapability {
    dom: boolean
    webJsVars: boolean
    chromeApi: boolean | 'partial'
    chromeStorage: boolean
    fetchCorsBypass: boolean
    extensionIndexedDb: boolean
    popupDom: boolean
  }

  const CONTEXT_CAPABILITIES: Record<ExecutionContext, ContextCapability>

  // context 누락 시 에러 메시지 (spec 참조)
  const CONTEXT_REQUIRED_MESSAGE: string

context-advisor.ts:
  function adviseContext(code: string): {
    recommended: ExecutionContext
    reason: string
    alternatives?: Array<{ context: ExecutionContext; reason: string }>
  }

  패턴 매칭:
  - document.*/querySelector/getElement/innerHTML → DOM 접근
  - chrome.(storage|runtime|tabs|action|scripting) → chrome API
  - window.__REACT|__VUE|__NEXT → 웹 전역변수
  - fetch()/XMLHttpRequest → 네트워크
  - popup/onboarding/.popup- → 팝업

  결정 규칙 (spec과 동일):
  - chromeAPI && !dom → 'worker'
  - dom && windowVars → 'page'
  - dom && chromeAPI → 'content'
  - dom && popup → 'popup'
  - default → 'page'
```

**완료 조건**: adviseContext 단위 테스트 — 각 컨텍스트별 코드 샘플에 올바른 추천 확인.

---

### Task 8: Context Router

**의존**: Task 6, Task 7

**산출물**:
- `packages/core/src/context/context-router.ts`
- `packages/core/src/context/__tests__/context-router.test.ts`

**작업 내용**:
```
context-router.ts:
  class ContextRouter {
    constructor(private pool: ConnectionPool)

    async evaluate(
      context: ExecutionContext,
      code: string,
      options?: { returnByValue?: boolean; awaitPromise?: boolean }
    ): Promise<EvaluationResult>
  }

  라우팅 로직 (spec 참조):
  - 'page': pool.getActiveTab() → Runtime.evaluate({ expression })
  - 'content': pool.getActiveTab() → Page.createIsolatedWorld → Runtime.evaluate({ contextId })
  - 'worker': pool.getExtensionWorker() → Runtime.evaluate({ expression })
  - 'popup': pool.getPopupTab() → Runtime.evaluate({ expression })

  에러 처리:
  - context 누락 → CONTEXT_REQUIRED_MESSAGE 에러 (가이드 포함)
  - context 미스매치 → adviseContext 결과 포함한 경고

  interface EvaluationResult {
    value: unknown
    type: string
    subtype?: string
    exceptionDetails?: { text: string; exception?: { description: string } }
  }
```

**완료 조건**: Mock pool로 각 context별 라우팅 테스트 통과. context 누락 에러 메시지 테스트 통과.

---

## D. 인프라 모듈 (Task 9~11)

### Task 9: Port Manager + Chrome Manager

**의존**: Task 5

**산출물**:
- `packages/core/src/infra/port-manager.ts`
- `packages/core/src/infra/chrome-pool.ts`
- `packages/core/src/infra/__tests__/port-manager.test.ts`

**작업 내용**:
```
port-manager.ts:
  class PortManager {
    async findAvailablePort(startFrom?: number): Promise<number>
    async isPortInUse(port: number): Promise<boolean>
    async findChromeDebugPort(): Promise<number | null>  // 이미 열린 Chrome
  }

  - 기본 포트: 9222
  - net.createServer로 포트 사용 가능 여부 확인

chrome-pool.ts:
  class ChromeManager {
    async launch(options?: {
      port?: number
      userDataDir?: string
      headless?: boolean
      args?: string[]
    }): Promise<{ port: number; wsUrl: string }>

    async connect(port?: number): Promise<string>  // → ws endpoint URL
    async status(): Promise<{ connected: boolean; port?: number; version?: string }>
    async close(): Promise<void>
  }

  - http://localhost:{port}/json/version 으로 wsUrl 획득
  - Chrome 프로세스 spawn (platform별 경로)
  - macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

**완료 조건**: PortManager 단위 테스트 (포트 확인). ChromeManager는 `connect()` 의 HTTP 요청 로직 mock 테스트.

---

### Task 10: Tab Manager + Session Manager

**의존**: Task 6

**산출물**:
- `packages/core/src/infra/tab-manager.ts`
- `packages/core/src/infra/session-manager.ts`
- `packages/core/src/infra/__tests__/tab-manager.test.ts`

**작업 내용**:
```
tab-manager.ts:
  class TabManager {
    constructor(private pool: ConnectionPool)

    async listTabs(filter?: { url?: string; title?: string }): Promise<TabInfo[]>
    async getActiveTab(): Promise<TabInfo>
    async switchTab(target: { tabId?: string; url?: string; title?: string }): Promise<TabInfo>
    async createTab(url: string): Promise<TabInfo>
    async closeTab(tabId: string): Promise<void>
  }

  - Target 도메인 사용: getTargets, activateTarget, createTarget, closeTarget
  - TabInfo: { id, url, title, type, attached }

session-manager.ts:
  class SessionManager {
    constructor(private pool: ConnectionPool)

    async getOrCreateSession(targetId: string): Promise<string>  // sessionId
    async releaseSession(targetId: string): void
    async listSessions(): Promise<SessionInfo[]>
  }

  - Target.attachToTarget({ flatten: true }) 기반
  - 세션 캐싱 + 자동 정리
```

**완료 조건**: Mock pool 기반 단위 테스트 — 탭 목록, 전환, 세션 생성/해제.

---

### Task 11: Extension Manager

**의존**: Task 6

**산출물**:
- `packages/core/src/infra/extension-manager.ts`
- `packages/core/src/infra/__tests__/extension-manager.test.ts`

**작업 내용**:
```
extension-manager.ts:
  class ExtensionManager {
    constructor(private pool: ConnectionPool)

    async findExtension(extensionId?: string): Promise<ExtensionInfo | null>
    async listExtensions(): Promise<ExtensionInfo[]>
    async attachToWorker(extensionId: string): Promise<CdpClient>
    async reloadExtension(extensionId: string, waitMs?: number): Promise<void>
    async openPopupAsTab(extensionId: string, page?: string): Promise<string>  // tabId
  }

  interface ExtensionInfo {
    id: string
    title: string
    serviceWorkerTargetId?: string
    popupUrl?: string
    attached: boolean
  }

  내부:
  - Target.getTargets() 에서 type='service_worker' 필터
  - URL 패턴: chrome-extension://{id}/ 로 식별
  - openPopupAsTab: Target.createTarget({ url: chrome-extension://{id}/popup.html })
```

**완료 조건**: Mock 기반 테스트 — 익스텐션 탐색, 워커 attach, 팝업 열기.

---

## E. Act 모듈 (Task 12~15)

### Task 12: navigate

**의존**: Task 6

**산출물**:
- `packages/core/src/act/navigate.ts`
- `packages/core/src/act/__tests__/navigate.test.ts`

**작업 내용**:
```
navigate.ts:
  interface NavigateOptions {
    url: string
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'  // 기본: 'load'
    timeout?: number  // 기본: 30000ms
  }

  interface NavigateResult {
    url: string
    statusCode?: number
    loadTime: number  // ms
  }

  async function navigate(
    pool: ConnectionPool,
    options: NavigateOptions
  ): Promise<NavigateResult>

  내부:
  - Page.navigate({ url })
  - Page.lifecycleEvent 대기 (waitUntil에 따라)
  - Network.responseReceived에서 status code 수집
  - 타임아웃 처리
```

**완료 조건**: Mock CDP로 navigate → 로딩 완료 이벤트 → 결과 반환 테스트.

---

### Task 13: click

**의존**: Task 6

**산출물**:
- `packages/core/src/act/click.ts`
- `packages/core/src/act/__tests__/click.test.ts`

**작업 내용**:
```
click.ts:
  interface ClickOptions {
    selector: string
    button?: 'left' | 'right' | 'middle'  // 기본: 'left'
    clickCount?: number  // 기본: 1 (더블클릭=2)
    delay?: number  // mousedown-mouseup 사이 지연
    timeout?: number
  }

  interface ClickResult {
    clicked: boolean
    selector: string
    position: { x: number; y: number }
  }

  async function click(
    pool: ConnectionPool,
    options: ClickOptions
  ): Promise<ClickResult>

  내부:
  1. Runtime.evaluate로 요소 좌표 획득:
     document.querySelector(selector).getBoundingClientRect()
  2. 요소 보이는지 확인 (visibility, display, opacity)
  3. 필요 시 요소로 스크롤 (scrollIntoView)
  4. Input.dispatchMouseEvent — mouseMoved → mousePressed → mouseReleased
  5. 클릭 좌표: 요소 중앙
```

**완료 조건**: Mock CDP로 셀렉터 → 좌표 계산 → 마우스 이벤트 시퀀스 테스트.

---

### Task 14: evaluate (Context-Aware)

**의존**: Task 8 (Context Router)

**산출물**:
- `packages/core/src/act/evaluate.ts`
- `packages/core/src/act/__tests__/evaluate.test.ts`

**작업 내용**:
```
evaluate.ts:
  interface EvaluateOptions {
    code: string
    context: ExecutionContext   // 필수!
    returnByValue?: boolean    // 기본: true
    awaitPromise?: boolean     // 기본: true
    timeout?: number
  }

  interface EvaluateResult {
    value: unknown
    type: string
    context: ExecutionContext
    advisedContext?: { recommended: ExecutionContext; reason: string }
  }

  async function evaluate(
    router: ContextRouter,
    options: EvaluateOptions
  ): Promise<EvaluateResult>

  로직:
  1. context 누락 → CONTEXT_REQUIRED_MESSAGE 에러 throw
  2. adviseContext(code) 실행 → 추천과 다르면 result에 advisedContext 포함 (경고만, 차단 안 함)
  3. router.evaluate(context, code, { returnByValue, awaitPromise }) 호출
  4. exceptionDetails 있으면 CdpEvaluationError throw
```

**완료 조건**: context별 라우팅 + 누락 에러 + advisor 경고 테스트.

---

### Task 15: type (다중 입력 방식)

**의존**: Task 6

**산출물**:
- `packages/core/src/act/type.ts`
- `packages/core/src/act/__tests__/type.test.ts`

**작업 내용**:
```
type.ts:
  interface TypeOptions {
    selector: string
    text: string
    method?: 'auto' | 'keyboard' | 'execCommand' | 'clipboard' | 'nativeSetter'
    delay?: number          // 키 간 지연 (keyboard 방식, 기본 0)
    clear?: boolean         // 입력 전 기존 텍스트 삭제 (기본: false)
    timeout?: number
  }

  interface TypeResult {
    typed: boolean
    method: string          // 실제 사용된 방식
    selector: string
  }

  async function type(
    pool: ConnectionPool,
    options: TypeOptions
  ): Promise<TypeResult>

  'auto' 판별 트리 (spec 참조):
  1. [data-lexical-editor] → ClipboardEvent paste
  2. .ProseMirror → execCommand('insertText')
  3. contenteditable → execCommand, fallback: keyboard
  4. input/textarea + React controlled → nativeInputValueSetter + dispatchEvent
  5. input/textarea 일반 → CDP Input.dispatchKeyEvent
  6. 그 외 → CDP keyboard fallback

  Phase 1에서는:
  - 'auto' 모드에서 기본 판별 (에디터 감지는 DOM 쿼리로)
  - 'keyboard' 직접 모드
  - 'nativeSetter' 직접 모드
  - 'execCommand' 직접 모드
  - 'clipboard' 직접 모드
  → Intelligence Layer(Phase 2)에서 고도화된 에디터 감지와 연동
```

**완료 조건**: 각 입력 방식별 mock 테스트 + auto 판별 로직 테스트.

---

## F. Observe 모듈 (Task 16)

### Task 16: screenshot + page-info

**의존**: Task 6

**산출물**:
- `packages/core/src/observe/screenshot.ts`
- `packages/core/src/observe/page-info.ts`
- `packages/core/src/observe/__tests__/screenshot.test.ts`
- `packages/core/src/observe/__tests__/page-info.test.ts`

**작업 내용**:
```
screenshot.ts:
  interface ScreenshotOptions {
    format?: 'png' | 'jpeg' | 'webp'   // 기본: 'png'
    quality?: number                     // jpeg/webp만 (0-100)
    fullPage?: boolean                   // 기본: false
    selector?: string                    // 특정 요소만
    clip?: { x: number; y: number; width: number; height: number }
  }

  interface ScreenshotResult {
    data: string              // base64
    format: string
    width: number
    height: number
  }

  async function screenshot(
    pool: ConnectionPool,
    options?: ScreenshotOptions
  ): Promise<ScreenshotResult>

  내부:
  - Page.captureScreenshot
  - selector 지정 시: 요소 boundingRect → clip
  - fullPage: Layout metrics 기반 전체 페이지 캡처

page-info.ts:
  interface PageInfo {
    url: string
    title: string
    frameTree: FrameInfo[]
    viewport: { width: number; height: number }
    documentReady: boolean
    loadTime?: number
  }

  interface FrameInfo {
    id: string
    url: string
    securityOrigin: string
    mimeType: string
    children?: FrameInfo[]
  }

  async function getPageInfo(
    pool: ConnectionPool
  ): Promise<PageInfo>

  내부:
  - Runtime.evaluate로 document.title, document.readyState
  - Page.getFrameTree로 프레임 구조
  - Emulation 상태로 viewport
```

**완료 조건**: Mock CDP로 스크린샷 base64 반환 + page info 수집 테스트.

---

## G. MCP 서버 조립 (Task 17~19)

### Task 17: act-tools MCP 등록

**의존**: Task 12, 13, 14, 15

**산출물**:
- `packages/core/src/tools/act-tools.ts`

**작업 내용**:
```
act-tools.ts:
  MCP tool 정의 4개:

  cdp_navigate:
    inputSchema: { url: string, waitUntil?: string, timeout?: number }
    handler: navigate(pool, params)

  cdp_click:
    inputSchema: { selector: string, button?: string, clickCount?: number }
    handler: click(pool, params)

  cdp_evaluate:
    inputSchema: { code: string, context: ExecutionContext, returnByValue?: boolean }
    handler: evaluate(router, params)
    ※ context 누락 시 에러 메시지에 가이드 포함

  cdp_type:
    inputSchema: { selector: string, text: string, method?: string, clear?: boolean }
    handler: type(pool, params)

  export function registerActTools(server: McpServer, pool: ConnectionPool, router: ContextRouter)
```

**완료 조건**: tool 정의 구조 검증 (inputSchema 유효성). 핸들러-모듈 연결 확인.

---

### Task 18: observe-tools + infra-tools MCP 등록

**의존**: Task 9, 10, 11, 16

**산출물**:
- `packages/core/src/tools/observe-tools.ts`
- `packages/core/src/tools/infra-tools.ts`

**작업 내용**:
```
observe-tools.ts:
  MCP tool 정의 2개:

  cdp_screenshot:
    inputSchema: { format?: string, quality?: number, fullPage?: boolean, selector?: string }
    handler: screenshot(pool, params)

  cdp_page_info:
    inputSchema: {} (파라미터 없음)
    handler: getPageInfo(pool)

  export function registerObserveTools(server: McpServer, pool: ConnectionPool)

infra-tools.ts:
  MCP tool 정의 1개 (Always Loaded):

  cdp_ext_attach:
    inputSchema: { extensionId?: string }
    handler: extensionManager.attachToWorker(extensionId)
    반환: { attached: boolean, extensionInfo: ExtensionInfo }

  export function registerInfraTools(server: McpServer, managers: InfraManagers)
```

**완료 조건**: tool 정의 구조 검증. 핸들러-모듈 연결 확인.

---

### Task 19: MCP 서버 진입점

**의존**: Task 17, 18

**산출물**:
- `packages/core/src/index.ts` — 전체 export + MCP 서버 생성 함수
- `packages/core/src/server.ts` — MCP 서버 조립 + stdio 실행

**작업 내용**:
```
index.ts:
  // 모듈 re-export (MCP 없이 import 가능하도록)
  export { CdpClient } from './cdp/cdp-client'
  export { ConnectionPool } from './cdp/connection-pool'
  export { ContextRouter } from './context/context-router'
  export { adviseContext } from './context/context-advisor'
  export { navigate } from './act/navigate'
  export { click } from './act/click'
  export { evaluate } from './act/evaluate'
  export { type } from './act/type'
  export { screenshot } from './observe/screenshot'
  export { getPageInfo } from './observe/page-info'
  export { ChromeManager } from './infra/chrome-pool'
  export { TabManager } from './infra/tab-manager'
  export { ExtensionManager } from './infra/extension-manager'
  // types
  export * from './context/context-types'
  export * from './cdp/protocol-types'

server.ts:
  import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
  import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

  async function createServer(): Promise<McpServer> {
    const server = new McpServer({ name: 'cdp-mcp', version: '0.1.0' })

    // 인프라 초기화
    const chromeManager = new ChromeManager()
    const wsUrl = await chromeManager.connect()
    const pool = new ConnectionPool(wsUrl)
    await pool.connectBrowser()
    const router = new ContextRouter(pool)
    const tabManager = new TabManager(pool)
    const extensionManager = new ExtensionManager(pool)

    // Always Loaded 7개 tool 등록
    registerActTools(server, pool, router)        // 4개: navigate, click, evaluate, type
    registerObserveTools(server, pool)             // 2개: screenshot, page_info
    registerInfraTools(server, { extensionManager, tabManager, chromeManager })  // 1개: ext_attach

    return server
  }

  // CLI 진입점
  async function main() {
    const server = await createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }

  main().catch(console.error)
```

**완료 조건**: `pnpm --filter @cdp-mcp/core build` 성공. import 경로 검증.

---

## H. 통합 검증 (Task 20~21)

### Task 20: 단위 테스트 전체 통과

**의존**: Task 19

**산출물**:
- 모든 `__tests__/*.test.ts` 통과
- `packages/core/vitest.config.ts`
- `packages/shared/vitest.config.ts`

**작업 내용**:
```
1. 각 패키지 vitest.config.ts 확인/생성
2. pnpm test 실행 (workspace 전체)
3. 실패 테스트 수정
4. 커버리지 확인 (최소 목표: 핵심 모듈 80%+)
```

**완료 조건**: `pnpm test` 전체 통과. 0 failures.

---

### Task 21: E2E 통합 테스트

**의존**: Task 20

**산출물**:
- `packages/core/src/__tests__/e2e/basic-flow.test.ts`
- `vitest.e2e.config.ts` (root)

**작업 내용**:
```
basic-flow.test.ts:
  describe('E2E: Basic Browser Control', () => {
    // 사전 조건: Chrome --remote-debugging-port=9222 실행 중

    it('Chrome에 연결한다', async () => {
      const manager = new ChromeManager()
      const wsUrl = await manager.connect(9222)
      expect(wsUrl).toContain('ws://')
    })

    it('ChatGPT.com으로 이동한다', async () => {
      const result = await navigate(pool, { url: 'https://chatgpt.com' })
      expect(result.url).toContain('chatgpt.com')
    })

    it('페이지 정보를 가져온다', async () => {
      const info = await getPageInfo(pool)
      expect(info.title).toBeTruthy()
      expect(info.url).toContain('chatgpt.com')
    })

    it('스크린샷을 찍는다', async () => {
      const result = await screenshot(pool, { format: 'png' })
      expect(result.data).toBeTruthy()  // base64
    })

    it('텍스트를 입력한다', async () => {
      const result = await type(pool, {
        selector: '#prompt-textarea',
        text: 'Hello from CDP-MCP!'
      })
      expect(result.typed).toBe(true)
    })

    it('버튼을 클릭한다', async () => {
      const result = await click(pool, {
        selector: '[data-testid="send-button"]'
      })
      expect(result.clicked).toBe(true)
    })
  })

  vitest.e2e.config.ts:
  - testMatch: ['**/__tests__/e2e/**/*.test.ts']
  - timeout: 60000
  - 환경변수: CDP_PORT=9222
```

**완료 조건**: Chrome 실행 상태에서 `pnpm test:e2e` 통과. ChatGPT.com 접속 → DOM 스냅샷 → 텍스트 입력 → 전송.

---

## 체크리스트 요약

| # | 태스크 | 의존 | 상태 |
|---|--------|------|------|
| 1 | 모노레포 루트 초기화 | — | ⬜ |
| 2 | shared 패키지 초기화 | 1 | ⬜ |
| 3 | shared 타입 + 유틸리티 | 2 | ⬜ |
| 4 | core 패키지 초기화 | 1 | ⬜ |
| 5 | CDP WebSocket 클라이언트 | 3, 4 | ⬜ |
| 6 | Connection Pool | 5 | ⬜ |
| 7 | Context 타입 + Advisor | 4 | ⬜ |
| 8 | Context Router | 6, 7 | ⬜ |
| 9 | Port/Chrome Manager | 5 | ⬜ |
| 10 | Tab/Session Manager | 6 | ⬜ |
| 11 | Extension Manager | 6 | ⬜ |
| 12 | navigate | 6 | ⬜ |
| 13 | click | 6 | ⬜ |
| 14 | evaluate (Context-Aware) | 8 | ⬜ |
| 15 | type (다중 입력 방식) | 6 | ⬜ |
| 16 | screenshot + page-info | 6 | ⬜ |
| 17 | act-tools MCP 등록 | 12,13,14,15 | ⬜ |
| 18 | observe-tools + infra-tools MCP 등록 | 9,10,11,16 | ⬜ |
| 19 | MCP 서버 진입점 | 17, 18 | ⬜ |
| 20 | 단위 테스트 전체 통과 | 19 | ⬜ |
| 21 | E2E 통합 테스트 | 20 | ⬜ |
