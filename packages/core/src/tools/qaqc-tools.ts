import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('qaqc-tools');

const EXT_PARAM = z.string().optional().describe(
  '익스텐션 이름 또는 ID. 이름은 부분 일치 (예: "ChatLens"). 생략 시 마지막 사용한 익스텐션'
);

interface BridgeState {
  extensionId: string;
  bridgePath: string;
  injected: boolean;
}

const bridgeCache = new Map<string, BridgeState>();

/** Inject bridge script into extension's Service Worker */
async function injectBridge(
  lazy: LazyConnectionManager,
  extensionId: string,
  bridgePath: string
): Promise<void> {
  const code = readFileSync(bridgePath, 'utf-8');
  const { extensionManager } = await lazy.ensure();
  const session = await extensionManager.attachToWorker(extensionId);
  await session.send('Runtime.evaluate', {
    expression: code,
    awaitPromise: true,
    returnByValue: false,
  });
  logger.info(`Bridge injected into SW: ${extensionId}`);
}

/** Check if bridge exists in SW, re-inject if missing */
async function ensureBridge(
  lazy: LazyConnectionManager,
  state: BridgeState
): Promise<void> {
  const { extensionManager } = await lazy.ensure();
  const session = await extensionManager.attachToWorker(state.extensionId);
  const result = await session.send<{
    result: { type: string; value?: boolean };
  }>('Runtime.evaluate', {
    expression: 'typeof globalThis.__qaqcBridge !== "undefined"',
    returnByValue: true,
  });

  if (result.result.value !== true) {
    logger.info(`Bridge missing in SW, re-injecting: ${state.extensionId}`);
    await injectBridge(lazy, state.extensionId, state.bridgePath);
  }
}

/** Get manifest from bridge in SW */
async function getManifest(
  lazy: LazyConnectionManager,
  extensionId: string
): Promise<unknown> {
  const { extensionManager } = await lazy.ensure();
  const session = await extensionManager.attachToWorker(extensionId);
  const result = await session.send<{
    result: { type: string; value?: unknown };
  }>('Runtime.evaluate', {
    expression: 'JSON.parse(JSON.stringify(globalThis.__qaqcBridge.manifest))',
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}

export function registerQaqcTools(
  server: McpServer,
  lazy: LazyConnectionManager
): void {
  // ext_qaqc_list
  server.tool(
    'ext_qaqc_list',
    `익스텐션의 QAQC bridge 명령 목록을 조회합니다.
bridgePath를 지정하면 bridge를 Service Worker에 주입하고 manifest를 반환합니다.
이미 주입된 경우 manifest만 반환합니다 (bridge가 사라졌으면 자동 재주입).

사용 시점:
- 새 익스텐션의 QAQC bridge를 등록할 때 (bridgePath 지정)
- 등록된 bridge의 사용 가능한 명령을 확인할 때

반환 값:
- manifest: { name, version, commands: [{ name, description, params }] }
- injected: bridge 주입 완료 여부`,
    {
      extension: EXT_PARAM,
      bridgePath: z.string().optional().describe('qaqc-bridge.js 파일 절대 경로 (최초 등록 시 필수)'),
    },
    async ({ extension, bridgePath }) => {
      const { extensionManager } = await lazy.ensure();
      const ext = await extensionManager.resolveExtension(extension);
      const extensionId = ext.id;

      let state = bridgeCache.get(extensionId);

      // bridgePath 제공 → 등록 + 주입
      if (bridgePath) {
        state = { extensionId, bridgePath, injected: false };
        bridgeCache.set(extensionId, state);
        await injectBridge(lazy, extensionId, bridgePath);
        state.injected = true;
      }

      if (!state) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Bridge not registered for ${ext.name}(${extensionId}). Provide bridgePath to register.`,
            }),
          }],
          isError: true,
        };
      }

      // 이미 등록된 경우 → bridge 존재 확인, 없으면 재주입
      if (!bridgePath) {
        await ensureBridge(lazy, state);
        state.injected = true;
      }

      const manifest = await getManifest(lazy, extensionId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ extension: { id: ext.id, name: ext.name }, manifest, injected: state.injected }),
        }],
      };
    }
  );

  // ext_qaqc_invoke
  server.tool(
    'ext_qaqc_invoke',
    `QAQC bridge를 통해 익스텐션 명령을 실행합니다.

사용 시점:
- ext_qaqc_list로 확인한 명령을 실행할 때
- 익스텐션의 내부 기능 (데이터 조회, 설정 변경 등)을 호출할 때

선행 조건:
- ext_qaqc_list로 bridge가 먼저 등록되어 있어야 합니다
- command는 manifest.commands에 있는 name 값

반환 값:
- result: 명령 실행 결과 (명령별 상이)`,
    {
      extension: EXT_PARAM,
      command: z.string().describe('실행할 명령 이름 (manifest.commands[].name)'),
      params: z.record(z.string(), z.unknown()).optional().describe('명령 파라미터 (명령별 상이)'),
    },
    async ({ extension, command, params }) => {
      const { extensionManager } = await lazy.ensure();
      const ext = await extensionManager.resolveExtension(extension);
      const extensionId = ext.id;

      const state = bridgeCache.get(extensionId);
      if (!state) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Bridge not registered for ${ext.name}(${extensionId}). Use ext_qaqc_list with bridgePath first.`,
            }),
          }],
          isError: true,
        };
      }

      // bridge 존재 확인 → 없으면 재주입
      await ensureBridge(lazy, state);
      state.injected = true;

      const session = await extensionManager.attachToWorker(extensionId);

      const paramsJson = JSON.stringify(params ?? {});
      const expression = `globalThis.__qaqcBridge.execute(${JSON.stringify(command)}, ${paramsJson})`;

      const evalResult = await session.send<{
        result: { type: string; value?: unknown };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });

      if (evalResult.exceptionDetails) {
        const errMsg = evalResult.exceptionDetails.exception?.description
          ?? evalResult.exceptionDetails.text
          ?? 'Unknown error';
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: errMsg }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ extension: { id: ext.id, name: ext.name }, result: evalResult.result.value }),
        }],
      };
    }
  );
}

/** Reset bridge cache (for testing) */
export function _resetBridgeCache(): void {
  bridgeCache.clear();
}
