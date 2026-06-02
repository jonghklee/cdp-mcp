import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';
import { navigate } from '../act/navigate.js';
import { click } from '../act/click.js';
import { evaluate } from '../act/evaluate.js';
import { typeText } from '../act/type.js';
import { pressKey } from '../act/press-key.js';
import { selectText } from '../act/select-text.js';
import { clipboard } from '../act/clipboard.js';
import { uploadFile } from '../act/upload-file.js';
import { capturePostActionSnapshot } from '../act/post-action-snapshot.js';

const snapshotSchema = z.object({
  screenshot: z.boolean().optional().describe('액션 후 스크린샷 캡처'),
  pageInfo: z.boolean().optional().describe('액션 후 페이지 메타 정보 포함'),
}).optional().describe('액션 후 페이지 상태를 함께 반환 (생략 시 반환하지 않음)');

export function registerActTools(
  server: McpServer,
  lazy: LazyConnectionManager
): void {
  // cdp_navigate
  server.tool(
    'cdp_navigate',
    `지정 URL로 브라우저 탭을 이동합니다. 페이지 로드 완료까지 대기합니다.

사용 시점:
- 새 URL로 페이지를 이동할 때
- 페이지 로드 완료를 기다려야 할 때 (load, domcontentloaded, networkidle)

대신 사용할 도구:
- cdp_evaluate: location.href 변경 등 JS 기반 네비게이션이 필요할 때
- cdp_click: 링크를 클릭하여 이동할 때

반환 값:
- url: 이동한 URL
- statusCode: HTTP 상태 코드
- loadTime: 로드 소요 시간(ms)`,
    {
      url: z.string().describe('이동할 URL'),
      waitUntil: z
        .enum(['load', 'domcontentloaded', 'networkidle'])
        .optional()
        .describe('대기할 이벤트 (기본: load)'),
      timeout: z.number().optional().describe('타임아웃 (ms, 기본: 30000)'),
      includeSnapshot: snapshotSchema,
    },
    async ({ url, waitUntil, timeout, includeSnapshot }) => {
      const { pool } = await lazy.ensure();
      const result = await navigate(pool, { url, waitUntil, timeout });
      const snapshot = await capturePostActionSnapshot(pool, includeSnapshot);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ ...result, ...(snapshot?.pageInfo ? { pageInfo: snapshot.pageInfo } : {}) }) },
      ];
      if (snapshot?.screenshot) {
        content.push({
          type: 'image' as const,
          data: snapshot.screenshot.data,
          mimeType: `image/${snapshot.screenshot.format}`,
        });
      }
      return { content };
    }
  );

  // cdp_click
  server.tool(
    'cdp_click',
    `CSS 셀렉터로 요소를 찾아 클릭합니다. 요소를 자동으로 스크롤하여 화면에 보이게 한 후 클릭합니다.

사용 시점:
- 버튼, 링크, 체크박스 등 클릭 가능 요소를 클릭할 때
- 더블클릭(clickCount=2)이나 우클릭(button=right)이 필요할 때

대신 사용할 도구:
- cdp_type: 입력 필드에 텍스트를 넣어야 할 때
- cdp_evaluate: element.click()으로 안 되는 복잡한 DOM 조작이 필요할 때
- cdp_fill_form: 여러 필드 입력 + 제출을 한번에 할 때

선행 조건:
- 요소가 페이지에 존재하고 화면에 렌더링되어 있어야 함 (visibility, display, opacity)

반환 값:
- clicked: 성공 여부
- position: 클릭된 화면 좌표 {x, y}`,
    {
      selector: z.string().describe('클릭할 요소의 CSS 셀렉터'),
      button: z
        .enum(['left', 'right', 'middle'])
        .optional()
        .describe('마우스 버튼 (기본: left)'),
      clickCount: z
        .number()
        .optional()
        .describe('클릭 횟수 (기본: 1, 더블클릭=2)'),
      delay: z
        .number()
        .optional()
        .describe('mousedown-mouseup 사이 지연 (ms)'),
      includeSnapshot: snapshotSchema,
    },
    async ({ selector, button, clickCount, delay, includeSnapshot }) => {
      const { pool } = await lazy.ensure();
      const result = await click(pool, { selector, button, clickCount, delay });
      const snapshot = await capturePostActionSnapshot(pool, includeSnapshot);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ ...result, ...(snapshot?.pageInfo ? { pageInfo: snapshot.pageInfo } : {}) }) },
      ];
      if (snapshot?.screenshot) {
        content.push({
          type: 'image' as const,
          data: snapshot.screenshot.data,
          mimeType: `image/${snapshot.screenshot.format}`,
        });
      }
      return { content };
    }
  );

  // cdp_evaluate
  server.tool(
    'cdp_evaluate',
    `지정된 실행 컨텍스트에서 JavaScript 코드를 평가합니다. context 파라미터는 필수입니다.

사용 시점:
- DOM 조회/조작 등 JavaScript 실행이 필요할 때 (context: page)
- 익스텐션 content script에서 chrome.storage 등에 접근할 때 (context: content)
- 익스텐션 Service Worker에서 chrome.* API를 호출할 때 (context: worker)
- 익스텐션 팝업 UI를 조작할 때 (context: popup)

대신 사용할 도구:
- cdp_ext_idb: 익스텐션의 IndexedDB/Dexie 데이터 조회·수정은 이 도구가 훨씬 편함 (DB 탐색, CRUD 지원)
- ext_qaqc_invoke: 익스텐션 전용 QAQC bridge 명령이 있으면 이 도구 사용
- cdp_click: 단순 요소 클릭이면 이 도구가 더 안정적
- cdp_type: 텍스트 입력이면 에디터 자동 감지가 있는 이 도구가 더 나음
- cdp_page_info: 페이지 메타 정보만 필요할 때

주의 — context:worker 제약:
- ES module 스코프의 변수(Dexie db 등)에 접근 불가 → cdp_ext_idb 사용
- Dexie db.table.toArray() 같은 코드는 실패함 → cdp_ext_idb로 raw IndexedDB 접근

선행 조건:
- context=worker/popup: cdp_ext_attach로 익스텐션에 먼저 연결 필요
- extensionId를 모르면 cdp_list_extensions(name:"익스텐션이름")으로 이름 검색

반환 값:
- value: 실행 결과 값
- type: 결과 타입
- context: 사용된 컨텍스트`,
    {
      code: z.string().describe('실행할 JavaScript 코드'),
      context: z
        .enum(['page', 'content', 'worker', 'popup'])
        .describe(
          '실행 컨텍스트: page(웹 DOM+전역변수), content(DOM+chrome.storage), worker(Service Worker), popup(팝업 UI)'
        ),
      returnByValue: z
        .boolean()
        .optional()
        .describe('값을 직접 반환할지 여부 (기본: true)'),
    },
    async ({ code, context, returnByValue }) => {
      const { router } = await lazy.ensure();
      const result = await evaluate(router, { code, context, returnByValue });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    }
  );

  // cdp_type
  server.tool(
    'cdp_type',
    `지정 요소에 텍스트를 입력합니다. 에디터 종류를 자동 감지하여 최적의 입력 방식을 사용합니다.
Lexical→clipboard, ProseMirror→execCommand, React controlled→nativeSetter, 일반→keyboard.

사용 시점:
- input, textarea에 텍스트를 입력할 때
- contenteditable, Lexical, ProseMirror 등 리치 에디터에 입력할 때
- method=auto(기본)로 대부분 해결되며, 특정 방식 강제도 가능

대신 사용할 도구:
- cdp_fill_form: 여러 필드를 한번에 채울 때
- cdp_click: 텍스트 입력이 아니라 클릭만 필요할 때
- cdp_evaluate: 값을 직접 설정해야 할 때 (el.value = ...)

반환 값:
- typed: 성공 여부
- method: 실제 사용된 입력 방식 (auto일 때 어떤 방식이 선택됐는지 확인 가능)`,
    {
      selector: z.string().describe('텍스트를 입력할 요소의 CSS 셀렉터'),
      text: z.string().describe('입력할 텍스트'),
      method: z
        .enum(['auto', 'keyboard', 'execCommand', 'clipboard', 'nativeSetter'])
        .optional()
        .describe('입력 방식 (기본: auto - 에디터 종류 자동 감지)'),
      clear: z
        .boolean()
        .optional()
        .describe('입력 전 기존 텍스트 삭제 (기본: false)'),
      delay: z
        .number()
        .optional()
        .describe('키 간 지연 ms (keyboard 방식만, 기본: 0)'),
      includeSnapshot: snapshotSchema,
    },
    async ({ selector, text, method, clear, delay, includeSnapshot }) => {
      const { pool } = await lazy.ensure();
      const result = await typeText(pool, {
        selector,
        text,
        method,
        clear,
        delay,
      });
      const snapshot = await capturePostActionSnapshot(pool, includeSnapshot);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ ...result, ...(snapshot?.pageInfo ? { pageInfo: snapshot.pageInfo } : {}) }) },
      ];
      if (snapshot?.screenshot) {
        content.push({
          type: 'image' as const,
          data: snapshot.screenshot.data,
          mimeType: `image/${snapshot.screenshot.format}`,
        });
      }
      return { content };
    }
  );

  // cdp_press_key
  server.tool(
    'cdp_press_key',
    `키보드 키를 누릅니다. 단일 키, 조합 키, 시퀀스, 홀드/릴리스를 지원합니다.

사용 시점:
- Enter, Tab, Escape 등 특수 키를 눌러야 할 때
- Ctrl+A, Ctrl+C 같은 키 조합이 필요할 때
- 키를 누른 채 유지(hold)하거나 릴리스해야 할 때
- 같은 키를 여러 번 반복해야 할 때 (repeat)

대신 사용할 도구:
- cdp_type: 텍스트를 입력할 때 (자동 에디터 감지)
- cdp_select_text: 텍스트 선택이 필요할 때
- cdp_clipboard: 복사/붙여넣기가 필요할 때

키 이름 형식:
- 단일 키: "Enter", "Tab", "Escape", "ArrowDown", "F1", "a"
- 조합 키: "Control+A", "Control+Shift+K", "Meta+C" (Mac의 Cmd)
- 별칭 지원: Ctrl→Control, Cmd→Meta, Esc→Escape, Up→ArrowUp

반환 값:
- pressed: 성공 여부
- action: 수행된 액션 (press/down/up)`,
    {
      key: z.string().optional().describe('키 또는 조합: "Enter", "Control+A"'),
      keys: z.array(z.string()).optional().describe('키 시퀀스: ["Tab", "Tab", "Enter"]'),
      action: z
        .enum(['press', 'down', 'up'])
        .optional()
        .describe('press=누르고 떼기(기본), down=홀드, up=릴리스'),
      repeat: z.number().optional().describe('반복 횟수 (기본: 1)'),
      delay: z.number().optional().describe('반복 간 지연 ms (기본: 0)'),
      includeSnapshot: snapshotSchema,
    },
    async ({ key, keys, action, repeat, delay, includeSnapshot }) => {
      const { pool } = await lazy.ensure();
      const result = await pressKey(pool, { key, keys, action, repeat, delay });
      const snapshot = await capturePostActionSnapshot(pool, includeSnapshot);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ ...result, ...(snapshot?.pageInfo ? { pageInfo: snapshot.pageInfo } : {}) }) },
      ];
      if (snapshot?.screenshot) {
        content.push({
          type: 'image' as const,
          data: snapshot.screenshot.data,
          mimeType: `image/${snapshot.screenshot.format}`,
        });
      }
      return { content };
    }
  );

  // cdp_select_text
  server.tool(
    'cdp_select_text',
    `키보드 기반으로 텍스트를 선택합니다. 전체, 단어, 줄, 문자 단위 선택을 지원합니다.

사용 시점:
- 텍스트를 선택한 후 복사/잘라내기할 때
- 입력 필드의 텍스트를 부분 선택할 때
- 전체 선택(Ctrl+A)이 필요할 때

대신 사용할 도구:
- cdp_clipboard: 선택 후 복사/붙여넣기까지 할 때
- cdp_evaluate: JS로 직접 selection range를 조작할 때

모드:
- all: 전체 선택 (Ctrl+A)
- character: 문자 단위 (Shift+Arrow, count로 문자 수 지정)
- word: 단어 단위 (Ctrl+Shift+Arrow)
- line: 줄 단위 (Shift+Home/End 또는 Shift+Arrow)
- toStart: 현재 위치에서 맨 앞까지
- toEnd: 현재 위치에서 맨 뒤까지

반환 값:
- selected: 성공 여부
- text: 선택된 텍스트`,
    {
      mode: z
        .enum(['all', 'word', 'line', 'toStart', 'toEnd', 'character'])
        .describe('선택 모드'),
      direction: z
        .enum(['left', 'right', 'up', 'down'])
        .optional()
        .describe('선택 방향 (기본: right)'),
      count: z.number().optional().describe('선택 반복 횟수 (기본: 1)'),
      selector: z.string().optional().describe('먼저 포커스할 요소의 CSS 셀렉터'),
      includeSnapshot: snapshotSchema,
    },
    async ({ mode, direction, count, selector, includeSnapshot }) => {
      const { pool } = await lazy.ensure();
      const result = await selectText(pool, { mode, direction, count, selector });
      const snapshot = await capturePostActionSnapshot(pool, includeSnapshot);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ ...result, ...(snapshot?.pageInfo ? { pageInfo: snapshot.pageInfo } : {}) }) },
      ];
      if (snapshot?.screenshot) {
        content.push({
          type: 'image' as const,
          data: snapshot.screenshot.data,
          mimeType: `image/${snapshot.screenshot.format}`,
        });
      }
      return { content };
    }
  );

  // cdp_clipboard
  server.tool(
    'cdp_clipboard',
    `클립보드 제어: 복사, 붙여넣기, 잘라내기, 클립보드 읽기.

사용 시점:
- 선택된 텍스트를 복사/잘라내기할 때
- 특정 텍스트를 직접 붙여넣을 때 (text 파라미터 사용)
- 시스템 클립보드 내용을 읽어야 할 때

대신 사용할 도구:
- cdp_type: 텍스트를 직접 입력할 때
- cdp_select_text: 텍스트를 선택만 할 때
- cdp_press_key: Ctrl+C/V를 직접 디스패치할 때

동작:
- copy: 현재 선택 텍스트를 복사 (선택 텍스트 반환)
- cut: 현재 선택 텍스트를 잘라내기 (잘라낸 텍스트 반환)
- paste: text가 있으면 해당 텍스트 붙여넣기, 없으면 시스템 클립보드에서 붙여넣기
- read: 시스템 클립보드 내용 읽기

반환 값:
- success: 성공 여부
- text: 복사/잘라낸/읽은 텍스트`,
    {
      action: z
        .enum(['copy', 'paste', 'cut', 'read'])
        .describe('클립보드 동작'),
      text: z.string().optional().describe('붙여넣을 텍스트 (paste 액션 전용)'),
      selector: z.string().optional().describe('먼저 포커스할 요소의 CSS 셀렉터'),
      includeSnapshot: snapshotSchema,
    },
    async ({ action, text, selector, includeSnapshot }) => {
      const { pool } = await lazy.ensure();
      const result = await clipboard(pool, { action, text, selector });
      const snapshot = await capturePostActionSnapshot(pool, includeSnapshot);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ ...result, ...(snapshot?.pageInfo ? { pageInfo: snapshot.pageInfo } : {}) }) },
      ];
      if (snapshot?.screenshot) {
        content.push({
          type: 'image' as const,
          data: snapshot.screenshot.data,
          mimeType: `image/${snapshot.screenshot.format}`,
        });
      }
      return { content };
    }
  );

  // cdp_upload_file
  server.tool(
    'cdp_upload_file',
    `파일을 웹 페이지에 업로드합니다. file input, 드래그 앤 드롭, 클립보드 붙여넣기 3가지 방식을 지원합니다.

사용 시점:
- <input type="file">에 파일을 설정할 때
- 드래그 앤 드롭 영역에 파일을 올릴 때
- 에디터/채팅에 파일을 붙여넣을 때

method 자동 감지:
- input[type=file] → input 방식 (DOM.setFileInputFiles)
- textarea, contenteditable → paste 방식 (ClipboardEvent)
- 기타 → drop 방식 (DragEvent 시퀀스)

반환 값:
- uploaded: 성공 여부
- method: 실제 사용된 업로드 방식
- fileName, fileSize: 파일 메타 정보`,
    {
      selector: z.string().describe('대상 요소의 CSS 셀렉터'),
      filePath: z.string().describe('업로드할 파일의 절대 경로'),
      method: z
        .enum(['auto', 'input', 'drop', 'paste'])
        .optional()
        .describe('업로드 방식 (기본: auto - 요소 타입 자동 감지)'),
      mimeType: z.string().optional().describe('파일 MIME 타입 (미지정 시 확장자로 추론)'),
      fileName: z.string().optional().describe('사용할 파일 이름 (미지정 시 원본 파일 이름)'),
      includeSnapshot: snapshotSchema,
    },
    async ({ selector, filePath, method, mimeType, fileName, includeSnapshot }) => {
      const { pool } = await lazy.ensure();
      const result = await uploadFile(pool, { selector, filePath, method, mimeType, fileName });
      const snapshot = await capturePostActionSnapshot(pool, includeSnapshot);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ ...result, ...(snapshot?.pageInfo ? { pageInfo: snapshot.pageInfo } : {}) }) },
      ];
      if (snapshot?.screenshot) {
        content.push({
          type: 'image' as const,
          data: snapshot.screenshot.data,
          mimeType: `image/${snapshot.screenshot.format}`,
        });
      }
      return { content };
    }
  );
}
