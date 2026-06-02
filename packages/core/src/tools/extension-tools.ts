import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';

const EXT_PARAM = z.string().optional().describe(
  '익스텐션 이름 또는 ID. 이름은 부분 일치 (예: "ChatLens"). 생략 시 마지막 사용한 익스텐션'
);

export function registerExtensionTools(
  server: McpServer,
  lazy: LazyConnectionManager
): void {
  // cdp_list_extensions
  server.tool(
    'cdp_list_extensions',
    `설치된 크롬 익스텐션 목록을 반환합니다. 이름으로 검색할 수 있습니다.

사용 시점:
- 설치된 익스텐션을 확인할 때
- 익스텐션 이름/ID를 조회할 때

반환 값:
- extensions: [{id, name, title, serviceWorkerTargetId, popupUrl, attached}]
- name 지정 시 해당 이름을 포함하는 익스텐션만 반환 (대소문자 무시)`,
    {
      name: z.string().optional().describe('익스텐션 이름 검색 (부분 일치, 대소문자 무시). 예: "ChatLens", "react"'),
    },
    async ({ name }) => {
      const { extensionManager } = await lazy.ensure();
      let extensions = await extensionManager.listExtensions();

      if (name) {
        const query = name.toLowerCase();
        extensions = extensions.filter(ext =>
          ext.name.toLowerCase().includes(query) ||
          ext.title.toLowerCase().includes(query) ||
          ext.id.toLowerCase().includes(query)
        );
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ extensions, total: extensions.length }) }],
      };
    }
  );

  // cdp_reload_extension
  server.tool(
    'cdp_reload_extension',
    `익스텐션을 리로드합니다. 코드 변경 후 익스텐션을 다시 로드할 때 사용합니다.

사용 시점:
- 익스텐션 코드를 수정한 후 변경 사항을 적용할 때
- 익스텐션이 오동작할 때 재시작할 때

반환 값:
- reloaded: 성공 여부
- extension: {id, name}`,
    {
      extension: EXT_PARAM,
      waitMs: z.number().optional().describe('리로드 후 대기 시간 (ms, 기본: 1000)'),
    },
    async ({ extension, waitMs }) => {
      const { extensionManager } = await lazy.ensure();
      const ext = await extensionManager.resolveExtension(extension);
      await extensionManager.reloadExtension(ext.id, waitMs);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          reloaded: true,
          extension: { id: ext.id, name: ext.name },
        }) }],
      };
    }
  );

  // cdp_open_popup
  server.tool(
    'cdp_open_popup',
    `익스텐션 팝업을 새 탭으로 엽니다. 팝업 UI를 테스트하거나 조작할 때 사용합니다.

사용 시점:
- 익스텐션 팝업 UI를 확인하거나 테스트할 때
- 팝업 내 요소를 click, type 등으로 조작하기 위해 탭으로 열 때

반환 값:
- opened: 성공 여부
- tabId: 팝업이 열린 탭 ID
- url: 열린 팝업 URL`,
    {
      extension: EXT_PARAM,
      page: z.string().optional().describe('열 페이지 (기본: popup.html)'),
    },
    async ({ extension, page }) => {
      const { extensionManager } = await lazy.ensure();
      const ext = await extensionManager.resolveExtension(extension);
      const targetId = await extensionManager.openPopupAsTab(ext.id, page);
      const url = `chrome-extension://${ext.id}/${page ?? 'popup.html'}`;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          opened: true,
          tabId: targetId,
          url,
          extension: { id: ext.id, name: ext.name },
        }) }],
      };
    }
  );
}
