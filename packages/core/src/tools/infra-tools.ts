import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';

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

  // cdp_reconnect
  server.tool(
    'cdp_reconnect',
    `크롬 연결을 끊고 재연결합니다. port를 지정하면 해당 포트의 크롬에 연결합니다.

사용 시점:
- 다른 포트의 크롬으로 전환할 때
- 크롬 연결 상태를 초기화하고 싶을 때
- 기존 크롬을 종료하고 새 크롬을 시작하고 싶을 때

동작:
- killChrome=false (기본): 연결만 끊고 재연결 (크롬은 유지)
- killChrome=true: 기존 크롬 프로세스를 종료하고 재연결 (주의: 사용자 확인 필요)
- refreshProfile=true: 기존 프로필을 삭제하고 현재 크롬에서 쿠키/로그인을 다시 복사 (세션 만료 시 유용)
- port 지정: 해당 포트의 크롬에 연결 (없으면 새로 launch)
- port 미지정: 자동 탐색으로 연결

⚠️ 포트 지정 시 안전 절차:
1. confirm 없이 호출 → 해당 포트의 탭 목록 + lock 소유자 정보 반환 (연결 안 함)
2. 반환된 정보를 사용자에게 보여주고 확답을 받은 후 confirm=true로 재호출
3. confirm=true → 실제 연결 수행`,
    {
      port: z.number().optional().describe('연결할 크롬 디버깅 포트 (미지정 시 자동 탐색)'),
      killChrome: z.boolean().optional().default(false).describe('기존 크롬 프로세스 종료 여부 (기본: false — 크롬 유지)'),
      refreshProfile: z.boolean().optional().default(false).describe('기존 프로필을 삭제하고 현재 크롬에서 쿠키/로그인을 다시 복사 (세션 만료 시 사용)'),
      confirm: z.boolean().optional().default(false).describe('포트 지정 시 확인 절차를 거쳤는지 여부. false면 탭 정보만 반환'),
    },
    async ({ port, killChrome, refreshProfile: doRefresh, confirm }) => {
      // 포트 지정 + 미확인 → 프로브만 수행 (연결하지 않음)
      if (port && !confirm) {
        const probe: Record<string, unknown> = {
          action: 'probe',
          targetPort: port,
          currentPort: lazy.getPort(),
        };

        // lock 소유자 확인
        try {
          const { readLock: readLockFn } = await import('../infra/port-store.js');
          const lockInfo = readLockFn(port);
          if (lockInfo) {
            probe.lockOwner = {
              sessionName: lockInfo.sessionName,
              ownerPid: lockInfo.ownerPid,
              mcpPid: lockInfo.mcpPid,
              startedAt: new Date(lockInfo.startedAt).toISOString(),
            };
          } else {
            probe.lockOwner = null;
          }
        } catch {
          probe.lockOwner = 'unknown';
        }

        // 탭 목록 가져오기 (연결 없이 HTTP로 직접 조회)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`);
          if (response.ok) {
            const targets = await response.json() as Array<{ id: string; type: string; title: string; url: string }>;
            probe.tabs = targets
              .filter((t) => t.type === 'page')
              .map((t) => ({ id: t.id, title: t.title, url: t.url }));
            probe.tabCount = (probe.tabs as unknown[]).length;
          } else {
            probe.tabs = [];
            probe.error = `Chrome responded with status ${response.status}`;
          }
        } catch {
          probe.tabs = [];
          probe.error = 'Chrome이 해당 포트에서 응답하지 않습니다';
        }

        probe.message = '⚠️ 위 정보를 사용자에게 보여주고, 이 포트에 연결해도 되는지 확답을 받은 후 confirm=true로 다시 호출하세요.';

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(probe, null, 2),
          }],
        };
      }

      // 실제 연결 수행
      const previousPort = lazy.getPort();

      // refreshProfile은 크롬이 해당 프로필을 안 쓸 때만 가능 → 먼저 종료
      if (doRefresh) {
        await lazy.disconnect();
      } else if (killChrome) {
        await lazy.disconnect();
      } else {
        await lazy.softDisconnect();
      }

      // 프로필 갱신: 기존 프로필 삭제 → 현재 크롬에서 다시 복사
      let profileRefreshed: { deleted: boolean; copied: boolean } | null = null;
      if (doRefresh) {
        const targetPort = port ?? previousPort;
        if (targetPort) {
          const { ChromeManager } = await import('../infra/chrome-pool.js');
          const mgr = new ChromeManager();
          profileRefreshed = mgr.refreshProfile(targetPort);
        }
      }

      if (port) {
        lazy.setTargetPort(port);
      }

      await lazy.ensure();
      const newPort = lazy.getPort();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            previousPort,
            newPort,
            killChrome: !!(killChrome || doRefresh),
            refreshProfile: profileRefreshed,
            targetPortRequested: port ?? null,
          }),
        }],
      };
    }
  );
}
