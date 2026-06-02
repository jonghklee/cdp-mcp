import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';
import { navigate } from '../act/navigate.js';
import { click } from '../act/click.js';
import { typeText } from '../act/type.js';
import { screenshot } from '../observe/screenshot.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('workflow-tools');

export function registerWorkflowTools(
  server: McpServer,
  lazy: LazyConnectionManager
): void {
  // cdp_fill_form
  server.tool(
    'cdp_fill_form',
    `여러 입력 필드를 한번에 채우고, 선택적으로 제출 버튼을 클릭합니다.
내부적으로 cdp_type을 순차 실행하므로 에디터 자동 감지가 각 필드에 적용됩니다.

사용 시점:
- 로그인 폼 (아이디 + 비밀번호 + 로그인 버튼)
- 회원가입, 검색 등 여러 필드를 채우는 모든 폼

대신 사용할 도구:
- cdp_type: 단일 필드만 입력할 때

반환 값:
- filled: 입력된 필드 수
- submitted: 제출 버튼 클릭 여부
- screenshot: captureAfter=true 시 제출 후 스크린샷`,
    {
      fields: z.array(z.object({
        selector: z.string().describe('입력할 요소의 CSS 셀렉터'),
        value: z.string().describe('입력할 텍스트'),
        method: z.enum(['auto', 'keyboard', 'execCommand', 'clipboard', 'nativeSetter']).optional().describe('입력 방식 (기본: auto)'),
        clear: z.boolean().optional().describe('기존 텍스트 삭제 후 입력 (기본: false)'),
      })).describe('채울 필드 목록'),
      submit: z.object({
        selector: z.string().describe('제출 버튼의 CSS 셀렉터'),
        waitAfter: z.number().optional().describe('제출 후 대기 시간 (ms, 기본: 0)'),
      }).optional().describe('제출 버튼 (생략 시 입력만 수행)'),
      captureAfter: z.boolean().optional().describe('완료 후 스크린샷 캡처 (기본: false)'),
    },
    async ({ fields, submit, captureAfter }) => {
      const { pool } = await lazy.ensure();

      // 필드 순차 입력
      for (const field of fields) {
        await typeText(pool, {
          selector: field.selector,
          text: field.value,
          method: field.method,
          clear: field.clear,
        });
      }

      // 선택적 제출
      let submitted = false;
      if (submit) {
        await click(pool, { selector: submit.selector });
        submitted = true;
        if (submit.waitAfter && submit.waitAfter > 0) {
          await new Promise(r => setTimeout(r, submit.waitAfter));
        }
      }

      logger.info(`Form filled: ${fields.length} fields, submitted: ${submitted}`);

      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ filled: fields.length, submitted }) },
      ];

      if (captureAfter) {
        const shot = await screenshot(pool, { format: 'png' });
        content.push({
          type: 'image' as const,
          data: shot.data,
          mimeType: `image/${shot.format}`,
        });
      }

      return { content };
    }
  );

  // cdp_navigate_and_wait
  server.tool(
    'cdp_navigate_and_wait',
    `URL로 이동한 후, 특정 조건이 충족될 때까지 대기합니다. 선택적으로 스크린샷을 캡처합니다.
cdp_navigate + 대기 + cdp_screenshot을 하나로 합친 복합 도구입니다.

사용 시점:
- 페이지 이동 후 특정 요소가 나타날 때까지 기다려야 할 때
- SPA에서 라우팅 후 렌더링 완료를 확인하고 싶을 때
- 이동 + 확인을 한번에 처리하고 싶을 때

대신 사용할 도구:
- cdp_navigate: 단순 이동만 필요할 때 (대기 조건 불필요)

반환 값:
- url, statusCode, loadTime: 네비게이션 결과
- waitResult: {found, elapsed} 대기 조건 충족 여부와 소요 시간
- screenshot: captureAfter=true 시 최종 스크린샷`,
    {
      url: z.string().describe('이동할 URL'),
      waitUntil: z
        .enum(['load', 'domcontentloaded', 'networkidle'])
        .optional()
        .describe('네비게이션 대기 이벤트 (기본: load)'),
      waitFor: z.object({
        selector: z.string().optional().describe('이 CSS 셀렉터가 나타날 때까지 대기'),
        text: z.string().optional().describe('이 텍스트가 페이지에 나타날 때까지 대기'),
        timeout: z.number().optional().describe('대기 타임아웃 (ms, 기본: 10000)'),
      }).optional().describe('추가 대기 조건 (생략 시 네비게이션 완료만 대기)'),
      captureAfter: z.boolean().optional().describe('완료 후 스크린샷 캡처 (기본: false)'),
    },
    async ({ url, waitUntil, waitFor, captureAfter }) => {
      const { pool } = await lazy.ensure();

      // 1. Navigate
      const navResult = await navigate(pool, { url, waitUntil });

      // 2. Optional wait for selector/text
      let waitResult: { found: boolean; elapsed: number } | undefined;

      if (waitFor && (waitFor.selector || waitFor.text)) {
        const waitTimeout = waitFor.timeout ?? 10000;
        const waitStart = Date.now();
        const client = await pool.getActiveTab();

        const expression = waitFor.selector
          ? `(() => {
              return new Promise((resolve) => {
                const check = () => {
                  if (document.querySelector(${JSON.stringify(waitFor.selector)})) return resolve(true);
                  requestAnimationFrame(check);
                };
                check();
                setTimeout(() => resolve(false), ${waitTimeout});
              });
            })()`
          : `(() => {
              return new Promise((resolve) => {
                const check = () => {
                  if (document.body && document.body.innerText.includes(${JSON.stringify(waitFor.text)})) return resolve(true);
                  requestAnimationFrame(check);
                };
                check();
                setTimeout(() => resolve(false), ${waitTimeout});
              });
            })()`;

        const result = await client.send<{ result: { value: boolean } }>('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });

        waitResult = {
          found: result.result.value === true,
          elapsed: Date.now() - waitStart,
        };
      }

      logger.info(`Navigate and wait: ${url}, waitResult: ${JSON.stringify(waitResult)}`);

      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: JSON.stringify({ ...navResult, waitResult }) },
      ];

      if (captureAfter) {
        const shot = await screenshot(pool, { format: 'png' });
        content.push({
          type: 'image' as const,
          data: shot.data,
          mimeType: `image/${shot.format}`,
        });
      }

      return { content };
    }
  );
}
