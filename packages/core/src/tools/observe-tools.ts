import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';
import { screenshot, MAX_SCREENSHOT_DIMENSION } from '../observe/screenshot.js';
import { getPageInfo } from '../observe/page-info.js';
import { startCapture, stopCapture, getMessages } from '../observe/console-capture.js';
import type { ConsoleLevel } from '../observe/console-capture.js';

export function registerObserveTools(
  server: McpServer,
  lazy: LazyConnectionManager
): void {
  // cdp_screenshot
  server.tool(
    'cdp_screenshot',
    `현재 페이지의 스크린샷을 캡처합니다. 전체 페이지, 특정 요소, 또는 뷰포트 영역을 캡처할 수 있습니다.

사용 시점:
- 현재 화면 상태를 시각적으로 확인할 때
- 특정 요소만 캡처하고 싶을 때 (selector 사용)
- 전체 페이지 캡처가 필요할 때 (fullPage=true)

대신 사용할 도구:
- cdp_page_info: 시각적 확인 없이 URL, 제목 등 메타 정보만 필요할 때

반환 값:
- image: 캡처된 이미지 (base64)
- format, width, height: 이미지 메타 정보
- resized: 자동 리사이즈 여부 (2000px 초과 방지)`,
    {
      format: z.enum(['png', 'jpeg', 'webp']).optional().describe('이미지 형식 (기본: png)'),
      quality: z.number().min(0).max(100).optional().describe('이미지 품질 (jpeg/webp만, 0-100)'),
      fullPage: z.boolean().optional().describe('전체 페이지 캡처 (기본: false)'),
      selector: z.string().optional().describe('특정 요소만 캡처할 CSS 셀렉터'),
      maxWidth: z.number().min(100).max(MAX_SCREENSHOT_DIMENSION).optional()
        .describe('최대 출력 너비 (기본: 1280, 최대: 2000)'),
      maxHeight: z.number().min(100).max(MAX_SCREENSHOT_DIMENSION).optional()
        .describe('최대 출력 높이 (기본: 800, 최대: 2000)'),
    },
    async ({ format, quality, fullPage, selector, maxWidth, maxHeight }) => {
      const { pool } = await lazy.ensure();
      const result = await screenshot(pool, { format, quality, fullPage, selector, maxWidth, maxHeight });

      const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];

      // Add resize warning if applicable
      if (result.resized) {
        content.push({
          type: 'text' as const,
          text: `⚠️ 이미지가 자동 리사이즈되었습니다: ${result.originalWidth}x${result.originalHeight} → ${result.width}x${result.height} (maxWidth=${maxWidth ?? 1280}, maxHeight=${maxHeight ?? 800})`,
        });
      }

      content.push(
        {
          type: 'image' as const,
          data: result.data,
          mimeType: `image/${result.format}`,
        },
        {
          type: 'text' as const,
          text: JSON.stringify({
            format: result.format,
            width: result.width,
            height: result.height,
            ...(result.resized ? { resized: true, originalWidth: result.originalWidth, originalHeight: result.originalHeight } : {}),
          }),
        },
      );

      return { content };
    }
  );

  // cdp_page_info
  server.tool(
    'cdp_page_info',
    `현재 페이지의 URL, 제목, 프레임 구조, 뷰포트 크기, 로딩 상태 등 메타 정보를 수집합니다.

사용 시점:
- 현재 페이지의 URL이나 제목을 확인할 때
- 페이지 로드 완료 여부를 확인할 때
- iframe 구조를 파악할 때

대신 사용할 도구:
- cdp_screenshot: 시각적으로 화면을 확인할 때
- cdp_list_tabs: 모든 탭의 정보를 한번에 볼 때

반환 값:
- url, title: 현재 페이지 주소와 제목
- viewport: {width, height}
- documentReady: 로드 완료 여부
- frameTree: iframe 계층 구조`,
    {},
    async () => {
      const { pool } = await lazy.ensure();
      const info = await getPageInfo(pool);
      const content: Array<{ type: 'text'; text: string }> = [];

      // Warn if viewport is 0x0 (minimized/offscreen — will cause screenshot timeouts)
      if (info.viewport.width === 0 || info.viewport.height === 0) {
        content.push({
          type: 'text' as const,
          text: '⚠️ viewport가 0x0입니다. Chrome 창이 최소화되었거나 화면 밖에 있습니다. cdp_focus_chrome을 호출하여 창을 foreground로 올리세요. 스크린샷은 자동으로 viewport를 보정합니다.',
        });
      }

      content.push({ type: 'text' as const, text: JSON.stringify(info, null, 2) });

      return { content };
    }
  );

  // cdp_console_capture
  server.tool(
    'cdp_console_capture',
    `콘솔 로그 캡처를 시작하거나 중지합니다. 캡처 중인 동안 console.log, console.error, 미처리 예외 등이 수집됩니다.

사용 시점:
- 페이지에서 발생하는 콘솔 로그를 실시간으로 모니터링할 때
- JavaScript 에러나 경고를 추적할 때
- extension service worker의 로그를 캡처할 때
- content script의 로그를 캡처할 때 (target='content_script')

워크플로우:
1. action='start'로 캡처 시작 → captureId 받기
2. cdp_get_console_message로 수집된 로그 조회
3. action='stop'으로 캡처 중지 + 최종 로그 반환

반환 값:
- start: captureId, targetId, status
- stop: entries[], totalReceived, dropped, status`,
    {
      action: z.enum(['start', 'stop']).describe("'start': 캡처 시작, 'stop': 캡처 중지"),
      target: z.string().optional().describe("대상: 'page'(기본), 'worker', 'content_script'(확장 CS가 주입된 페이지), 또는 targetId"),
      levels: z.array(z.enum(['log', 'info', 'warn', 'error', 'debug'])).optional()
        .describe('캡처할 레벨 필터 (미지정시 전체)'),
      maxEntries: z.number().min(1).max(10000).optional()
        .describe('버퍼 크기 (기본 1000, 최대 10000)'),
      captureId: z.string().optional().describe("stop 시 필수: 중지할 captureId"),
    },
    async ({ action, target, levels, maxEntries, captureId }) => {
      const { pool } = await lazy.ensure();

      if (action === 'start') {
        // Resolve target to session + targetId
        const resolvedTarget = target ?? 'page';
        let session;
        let targetId: string;

        if (resolvedTarget === 'page') {
          const targets = await pool.listTargets();
          const pages = targets.filter(t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
          const pageTarget = pages[0] ?? targets.find(t => t.type === 'page');
          if (!pageTarget) throw new Error('No page target found');
          session = await pool.getConnection(pageTarget.id);
          targetId = pageTarget.id;
        } else if (resolvedTarget === 'content_script') {
          // Content scripts share the page's Runtime domain.
          // Find pages that likely have extension content scripts injected
          // (non-chrome:// pages — content scripts can't run on chrome:// pages)
          const targets = await pool.listTargets();
          const pages = targets.filter(t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
          const pageTarget = pages[0] ?? targets.find(t => t.type === 'page');
          if (!pageTarget) throw new Error('No page target found for content_script capture');
          session = await pool.getConnection(pageTarget.id);
          targetId = pageTarget.id;

          // Enable Runtime with includeCommandLineAPI for broader context capture
          // Runtime.enable on the page captures ALL execution contexts including
          // content script isolated worlds
          await session.send('Runtime.enable');
        } else if (resolvedTarget === 'worker') {
          const targets = await pool.listTargets();
          const worker = targets.find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
          if (!worker) throw new Error('No extension worker found');
          session = await pool.getConnection(worker.id);
          targetId = worker.id;
        } else {
          session = await pool.getConnection(resolvedTarget);
          targetId = resolvedTarget;
        }

        const result = await startCapture(session, targetId, {
          levels: levels as ConsoleLevel[] | undefined,
          maxEntries,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } else {
        // stop
        if (!captureId) throw new Error('captureId is required for stop action');
        const result = stopCapture(captureId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    }
  );

  // cdp_get_console_message
  server.tool(
    'cdp_get_console_message',
    `진행 중인 콘솔 캡처에서 수집된 메시지를 조회합니다.

사용 시점:
- cdp_console_capture로 시작한 캡처의 로그를 확인할 때
- 주기적으로 로그를 폴링할 때
- clear=true로 읽은 로그를 버퍼에서 제거할 때

반환 값:
- entries[]: 수집된 콘솔 메시지 배열 (level, text, timestamp, source)
- totalReceived: 총 수신 건수
- dropped: 버퍼 초과로 누락된 건수
- capturing: 현재 캡처 진행 중 여부`,
    {
      captureId: z.string().describe('조회할 captureId'),
      clear: z.boolean().optional().describe('조회 후 버퍼 비우기 (기본: false)'),
    },
    async ({ captureId, clear }) => {
      const result = getMessages({ captureId, clear });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
