import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';
import { syncCookies } from '../infra/shared-chrome.js';

const EXT_PARAM = z.string().optional().describe(
  '익스텐션 이름 또는 ID. 이름은 부분 일치 (예: "ChatLens"). 생략 시 마지막 사용한 익스텐션'
);

export function registerInfraTools(
  server: McpServer,
  lazy: LazyConnectionManager
): void {
  // cdp_ext_attach
  server.tool(
    'cdp_ext_attach',
    `크롬 익스텐션의 Service Worker에 연결합니다. 연결 후 cdp_evaluate(context=worker)로 코드를 실행할 수 있습니다.

사용 시점:
- 익스텐션의 Service Worker에서 chrome.* API를 호출하기 전에
- cdp_evaluate(context=worker/popup) 사용 전 반드시 호출

대신 사용할 도구:
- cdp_ext_idb: IndexedDB/Dexie 접근 (attach 없이 바로 사용)
- ext_qaqc_list: QAQC bridge 등록/확인

반환 값:
- attached: 연결 성공 여부
- extensionInfo: {id, name, title, serviceWorkerTargetId}`,
    {
      extension: EXT_PARAM,
    },
    async ({ extension }) => {
      const { extensionManager } = await lazy.ensure();
      const ext = await extensionManager.resolveExtension(extension);

      if (ext.serviceWorkerTargetId) {
        await extensionManager.attachToWorker(ext.id);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ attached: true, extensionInfo: ext }),
        }],
      };
    }
  );

  // cdp_sync_profile
  server.tool(
    'cdp_sync_profile',
    `평소 크롬에서 바뀐 로그인 상태(쿠키)를 지금 공유 크롬으로 가져옵니다. 크롬을 다시 켜지 않습니다.

사용 시점:
- 사용자가 평소 크롬에서 방금 로그인·회원가입했다고 할 때
- 로그인돼 있어야 할 사이트가 로그아웃 상태로 보일 때

restart=true:
- 저장 비밀번호까지 최신으로 다시 복사하려고 공유 크롬을 다시 켭니다.
- 다른 에이전트가 쓰는 중이면 하지 않고 이유를 돌려줍니다(다른 에이전트의 탭이 날아가므로).

반환 값:
- sync: {sourceCookies, imported, failed} 또는 {skipped}
- restart: {restarted, reason?, otherAgents?}`,
    {
      restart: z.boolean().optional().default(false).describe('저장 비밀번호까지 다시 복사하려고 크롬을 다시 켤지 (다른 에이전트가 없을 때만)'),
    },
    async ({ restart }) => {
      if (restart) {
        const result = await lazy.restartChrome();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ restart: result }) }] };
      }
      await lazy.ensure();
      const sync = await syncCookies({ force: true });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ sync }) }] };
    }
  );
}
