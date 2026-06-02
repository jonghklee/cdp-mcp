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
    `열려 있는 모든 브라우저 탭 목록을 반환합니다. 각 탭에는 고유 id가 포함됩니다.

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
      background: z.boolean().optional().describe('기본 true (백그라운드). false로 설정하면 Chrome을 foreground로 올림'),
    },
    async ({ tabId, url, title, background }) => {
      const { tabManager } = await lazy.ensure();
      const tab = await tabManager.switchTab({ tabId, url, title, background });
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
      background: z.boolean().optional().describe('기본 true (백그라운드). false로 설정하면 Chrome을 foreground로 올림'),
    },
    async ({ url, background }) => {
      const { tabManager } = await lazy.ensure();
      const tab = await tabManager.createTab(url, background);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ created: true, tab }) }],
      };
    }
  );

  // cdp_focus_chrome
  server.tool(
    'cdp_focus_chrome',
    `Chrome 브라우저를 foreground로 올려 화면에 표시합니다.

사용 시점:
- 사용자가 Chrome 화면을 직접 확인해야 할 때
- 스크린샷 전에 Chrome을 앞으로 가져올 때

반환 값:
- focused: 성공 여부
- tab: 활성화된 탭 정보 {id, url, title}`,
    {
      tabId: z.string().optional().describe('foreground로 올릴 탭 ID (미지정 시 현재 활성 탭)'),
    },
    async ({ tabId }) => {
      const { tabManager } = await lazy.ensure();
      let targetTabId = tabId;
      if (!targetTabId) {
        const active = await tabManager.getActiveTab();
        targetTabId = active.id;
      }
      await tabManager.activateTab(targetTabId);
      const tabs = await tabManager.listTabs();
      const tab = tabs.find(t => t.id === targetTabId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ focused: true, tab }) }],
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
