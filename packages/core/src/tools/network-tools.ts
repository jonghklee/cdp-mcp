import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';
import {
  startNetworkCapture,
  stopNetworkCapture,
  getNetworkRequests,
  waitForNetworkRequest,
} from '../observe/network-capture.js';
import {
  startIntercept,
  stopIntercept,
  addRule,
  removeRule,
  listRules,
} from '../observe/network-intercept.js';

export function registerNetworkTools(
  server: McpServer,
  lazy: LazyConnectionManager,
): void {
  // cdp_network_capture
  server.tool(
    'cdp_network_capture',
    `네트워크 요청 캡처를 시작하거나 중지합니다. 캡처 중 모든 HTTP 요청/응답이 수집됩니다.

사용 시점:
- API 호출을 모니터링할 때
- 네트워크 요청의 상태/헤더/본문을 확인할 때
- SSE/스트림 요청을 감지할 때

워크플로우:
1. action='start'로 캡처 시작 → captureId 받기
2. cdp_list_network_requests로 수집된 요청 조회
3. action='stop'으로 캡처 중지 + 최종 요청 반환

반환 값:
- start: captureId, targetId, status
- stop: requests[], stats { total, completed, failed, dropped }`,
    {
      action: z.enum(['start', 'stop']).describe("'start': 캡처 시작, 'stop': 캡처 중지"),
      target: z.string().optional().describe("대상: 'page'(기본), 'worker', 또는 targetId"),
      captureBody: z.boolean().optional().describe('응답 본문 캡처 여부 (기본: true)'),
      maxRequests: z.number().min(1).max(10000).optional().describe('버퍼 크기 (기본 500, 최대 10000)'),
      filterDomains: z.array(z.string()).optional().describe('캡처할 도메인 필터'),
      filterMethods: z.array(z.string()).optional().describe('캡처할 HTTP 메서드 필터'),
      captureId: z.string().optional().describe("stop 시 필수: 중지할 captureId"),
    },
    async ({ action, target, captureBody, maxRequests, filterDomains, filterMethods, captureId }) => {
      const { pool } = await lazy.ensure();

      if (action === 'start') {
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

        const result = await startNetworkCapture(session, targetId, {
          captureBody,
          maxRequests,
          filterDomains,
          filterMethods,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } else {
        if (!captureId) throw new Error('captureId is required for stop action');
        const result = stopNetworkCapture(captureId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    },
  );

  // cdp_list_network_requests
  server.tool(
    'cdp_list_network_requests',
    `진행 중인 네트워크 캡처에서 수집된 요청을 조회합니다. 다양한 필터와 정렬을 지원합니다.

사용 시점:
- cdp_network_capture로 시작한 캡처의 요청을 확인할 때
- 특정 URL 패턴, HTTP 메서드, 상태 코드로 필터링할 때
- API 응답 본문을 확인할 때

반환 값:
- requests[]: 캡처된 요청 배열 (url, method, status, body 등)
- total: 필터 조건에 맞는 전체 건수`,
    {
      captureId: z.string().describe('조회할 captureId'),
      urlPattern: z.string().optional().describe('URL에 포함된 문자열로 필터'),
      method: z.string().optional().describe('HTTP 메서드 필터 (GET, POST 등)'),
      contentType: z.string().optional().describe('응답 Content-Type 필터'),
      statusRange: z.enum(['2xx', '3xx', '4xx', '5xx']).optional().describe('HTTP 상태 코드 범위 필터'),
      limit: z.number().min(1).optional().describe('반환할 최대 건수'),
      sort: z.enum(['oldest', 'latest']).optional().describe('정렬 (기본: oldest)'),
    },
    async ({ captureId, urlPattern, method, contentType, statusRange, limit, sort }) => {
      const result = getNetworkRequests({
        captureId,
        urlPattern,
        method,
        contentType,
        statusRange,
        limit,
        sort,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // cdp_wait_for_request
  server.tool(
    'cdp_wait_for_request',
    `특정 URL 패턴의 네트워크 요청이 완료될 때까지 대기합니다.

사용 시점:
- 특정 API 호출이 발생하기를 기다릴 때
- 페이지 로드 후 특정 XHR 요청 완료를 확인할 때
- 비동기 데이터 로딩 완료를 대기할 때

반환 값:
- found: 요청 발견 여부
- request?: 발견된 요청 정보`,
    {
      captureId: z.string().describe('대기할 captureId'),
      urlPattern: z.string().describe('URL에 포함되어야 하는 문자열'),
      timeout: z.number().optional().describe('타임아웃 ms (기본: 30000)'),
      onlyComplete: z.boolean().optional().describe('완료된 요청만 매칭 (기본: true)'),
    },
    async ({ captureId, urlPattern, timeout, onlyComplete }) => {
      const result = await waitForNetworkRequest(captureId, urlPattern, { timeout, onlyComplete });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // cdp_network_intercept
  server.tool(
    'cdp_network_intercept',
    `네트워크 요청 인터셉트를 관리합니다. 요청 차단, 응답 수정, 지연을 설정할 수 있습니다.

사용 시점:
- 특정 API 요청을 차단하거나 모킹할 때
- 네트워크 오류 시뮬레이션을 할 때
- 응답을 수정하여 테스트할 때
- 네트워크 지연을 시뮬레이션할 때

워크플로우:
1. action='start'로 인터셉트 시작 → interceptId 받기
2. action='add_rule'로 규칙 추가
3. action='list_rules'로 현재 규칙 확인
4. action='remove_rule'로 규칙 삭제
5. action='stop'으로 인터셉트 중지

반환 값:
- start: interceptId, targetId
- add_rule: ruleId
- list_rules: rules[]
- stop: rules[], totalIntercepted`,
    {
      action: z.enum(['start', 'stop', 'add_rule', 'remove_rule', 'list_rules'])
        .describe('인터셉트 동작'),
      target: z.string().optional().describe("대상: 'page'(기본), 'worker', 또는 targetId (start 시)"),
      interceptId: z.string().optional().describe('인터셉트 ID (stop/add_rule/remove_rule/list_rules 시)'),
      urlPattern: z.string().optional().describe('URL 패턴 (add_rule 시 필수)'),
      ruleAction: z.enum(['block', 'modify_response', 'delay']).optional()
        .describe('규칙 동작 (add_rule 시 필수)'),
      statusCode: z.number().optional().describe('응답 상태 코드 (modify_response 시)'),
      responseHeaders: z.record(z.string(), z.string()).optional().describe('응답 헤더 (modify_response 시)'),
      responseBody: z.string().optional().describe('응답 본문 (modify_response 시)'),
      delayMs: z.number().optional().describe('지연 ms (delay 시)'),
      ruleId: z.string().optional().describe('삭제할 규칙 ID (remove_rule 시)'),
    },
    async ({ action, target, interceptId, urlPattern, ruleAction, statusCode, responseHeaders, responseBody, delayMs, ruleId }) => {
      const { pool } = await lazy.ensure();

      switch (action) {
        case 'start': {
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

          const result = await startIntercept(session, targetId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'stop': {
          if (!interceptId) throw new Error('interceptId is required for stop action');
          const result = await stopIntercept(interceptId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'add_rule': {
          if (!interceptId) throw new Error('interceptId is required for add_rule action');
          if (!urlPattern) throw new Error('urlPattern is required for add_rule action');
          if (!ruleAction) throw new Error('ruleAction is required for add_rule action');

          const result = addRule(interceptId, {
            urlPattern,
            action: ruleAction,
            statusCode,
            responseHeaders,
            responseBody,
            delayMs,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'remove_rule': {
          if (!interceptId) throw new Error('interceptId is required for remove_rule action');
          if (!ruleId) throw new Error('ruleId is required for remove_rule action');

          removeRule(interceptId, ruleId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ removed: ruleId }, null, 2) }],
          };
        }

        case 'list_rules': {
          if (!interceptId) throw new Error('interceptId is required for list_rules action');
          const result = listRules(interceptId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }
      }
    },
  );
}
