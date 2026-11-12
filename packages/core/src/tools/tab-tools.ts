import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';

export function registerTabTools(
  server: McpServer,
  lazy: LazyConnectionManager
): void {
  // cdp_list_tabs
  server.tool(
    'cdp_list_tabs',
    `이 에이전트 창에 열린 탭 목록을 반환합니다(다른 에이전트의 탭은 보이지 않습니다). 각 탭에는 고유 id가 포함됩니다.

사용 시점:
- 현재 열린 탭들을 확인할 때
- cdp_switch_tab에 전달할 탭 ID를 조회할 때
- URL이나 제목으로 특정 탭을 찾을 때

대신 사용할 도구:
- cdp_page_info: 현재 활성 탭의 상세 정보만 필요할 때

반환 값:
- tabs: 탭 목록 [{id, url, title, type, attached}]
- activeTabId: 현재 활성 탭 ID`,
    {
      url: z.string().optional().describe('URL에 포함된 문자열로 필터 (부분 일치)'),
      title: z.string().optional().describe('제목에 포함된 문자열로 필터 (대소문자 무시)'),
    },
    async ({ url, title }) => {
      const { tabManager } = await lazy.ensure();
      const filter = (url || title) ? { url, title } : undefined;
      const tabs = await tabManager.listTabs(filter);

      let activeTabId: string | undefined;
      try {
        const active = await tabManager.getActiveTab();
        activeTabId = active.id;
      } catch {
        // no active tab
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ tabs, activeTabId }) }],
      };
    }
  );

  // cdp_switch_tab
  server.tool(
    'cdp_switch_tab',
    `지정한 탭을 활성화합니다. 이후 모든 도구(click, type, screenshot 등)가 이 탭에서 실행됩니다.

사용 시점:
- 특정 탭에서 작업하고 싶을 때
- 여러 탭을 오가며 작업할 때

선행 조건:
- tabId를 모르면 cdp_list_tabs로 먼저 조회

반환 값:
- switched: 성공 여부
- tab: 활성화된 탭 정보 {id, url, title}`,
    {
      tabId: z.string().optional().describe('활성화할 탭 ID (cdp_list_tabs에서 반환된 id)'),
      url: z.string().optional().describe('URL 부분 일치로 탭 검색'),
      title: z.string().optional().describe('제목 부분 일치로 탭 검색'),
    },
    async ({ tabId, url, title }) => {
      const { tabManager } = await lazy.ensure();
      const tab = await tabManager.switchTab({ tabId, url, title });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ switched: true, tab }) }],
      };
    }
  );

  // cdp_create_tab
  server.tool(
    'cdp_create_tab',
    `새 탭을 생성하고 지정 URL로 이동합니다.

사용 시점:
- 새 탭에서 다른 페이지를 열어야 할 때
- 기존 탭은 유지하면서 추가 페이지를 열 때

대신 사용할 도구:
- cdp_navigate: 현재 탭에서 URL을 변경할 때

반환 값:
- created: 성공 여부
- tab: 생성된 탭 정보 {id, url, title}`,
    {
      url: z.string().describe('새 탭에서 열 URL'),
    },
    async ({ url }) => {
      const { tabManager } = await lazy.ensure();
      const tab = await tabManager.createTab(url);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ created: true, tab }) }],
      };
    }
  );

  // cdp_show
  server.tool(
    'cdp_show',
    `이 에이전트 창의 현재 탭을 사람이 볼 수 있는 주소를 돌려줍니다. 크롬은 창 없이 돌기 때문에 화면에는 아무것도 뜨지 않습니다.

사용 시점:
- 사용자가 «띄워줘», «보여줘», «화면 보자»라고 직접 요청했을 때만

반환 값:
- tab: 현재 탭 {id, url, title}
- viewUrl: 평소 크롬에서 열면 이 탭을 실시간으로 보고 조작할 수 있는 주소`,
    {},
    async () => {
      const { tabManager } = await lazy.ensure();
      const tab = await tabManager.getActiveTab();
      const port = lazy.getPort();
      const viewUrl = `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${tab.id}`;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ tab, viewUrl }) }],
      };
    }
  );

  // cdp_save_pdf
  server.tool(
    'cdp_save_pdf',
    `현재 탭을 PDF 파일로 저장합니다(인쇄 대화상자 없이). 사이트가 «출력/인쇄» 화면을 띄우는 문서(사업자등록증명, 영수증 등)를 파일로 남길 때 씁니다.
사이트의 «내려받기» 버튼으로 받는 파일은 자동으로 ~/Downloads 에 저장되니 이 도구가 필요 없습니다.

반환 값:
- path: 저장한 파일 경로
- bytes: 파일 크기`,
    {
      path: z.string().optional().describe('저장할 절대 경로(.pdf). 생략하면 ~/Downloads/<탭 제목>.pdf'),
      landscape: z.boolean().optional().describe('가로 방향 (기본 false)'),
    },
    async ({ path: outPath, landscape }) => {
      const { pool, tabManager } = await lazy.ensure();
      const tab = await tabManager.getActiveTab();
      const session = await pool.getActiveTab();
      const { data } = await session.send<{ data: string }>('Page.printToPDF', {
        printBackground: true, landscape: landscape ?? false, preferCSSPageSize: true,
      });
      const safeTitle = (tab.title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
      const target = outPath ?? path.join(os.homedir(), 'Downloads', `${safeTitle}.pdf`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(data, 'base64'));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ path: target, bytes: fs.statSync(target).size, tab }) }],
      };
    }
  );

  // cdp_close_tab
  server.tool(
    'cdp_close_tab',
    `지정한 탭을 닫습니다.

사용 시점:
- 더 이상 필요 없는 탭을 정리할 때

선행 조건:
- tabId를 모르면 cdp_list_tabs로 먼저 조회

반환 값:
- closed: 성공 여부
- tabId: 닫힌 탭 ID`,
    {
      tabId: z.string().describe('닫을 탭 ID (cdp_list_tabs에서 반환된 id)'),
    },
    async ({ tabId }) => {
      const { tabManager } = await lazy.ensure();
      await tabManager.closeTab(tabId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ closed: true, tabId }) }],
      };
    }
  );
}
