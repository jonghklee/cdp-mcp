import { createLogger } from '@cdp-mcp/shared';
import type { ConnectionPool } from '../cdp/connection-pool.js';
import type { TargetInfoCdp } from '../cdp/protocol-types.js';

const logger = createLogger('session-info-tab');

const SESSION_INFO_MARKER = 'cdp-mcp-session-info';

export interface SessionInfoData {
  port: number;
  sessionId: string;
  sessionName: string;
  mcpPid: number;
  ownerPid?: number;
  chromePid?: number;
  startedAt: number;
  status: 'CONNECTED' | 'RECONNECTED';
}

/**
 * URL에 cdp-mcp-session-info 마커가 포함되어 있는지 판별
 */
export function isSessionInfoTab(url: string): boolean {
  return url.includes(SESSION_INFO_MARKER);
}

/**
 * 세션 정보를 담은 HTML 문자열 생성 (다크 테마)
 */
export function generateSessionInfoHtml(data: SessionInfoData): string {
  const startedAtStr = new Date(data.startedAt).toLocaleString();
  const updatedAtStr = new Date().toLocaleString();

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>CDP-MCP Session</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 20px;
  }
  .container {
    background: #16213e;
    border: 1px solid #0f3460;
    border-radius: 12px;
    padding: 32px;
    max-width: 480px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .header {
    text-align: center;
    margin-bottom: 24px;
  }
  .header h1 {
    font-size: 20px;
    color: #e94560;
    margin-bottom: 4px;
  }
  .status {
    display: inline-block;
    padding: 2px 12px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1px;
  }
  .status.connected { background: #0a3d2a; color: #4ade80; }
  .status.reconnected { background: #3d2a0a; color: #fbbf24; }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  tr { border-bottom: 1px solid #0f3460; }
  tr:last-child { border-bottom: none; }
  td {
    padding: 10px 8px;
    font-size: 14px;
  }
  td:first-child {
    color: #8899aa;
    white-space: nowrap;
    width: 120px;
  }
  td:last-child {
    color: #ffffff;
    font-family: 'SF Mono', 'Fira Code', monospace;
    word-break: break-all;
  }
  .footer {
    text-align: center;
    margin-top: 16px;
    font-size: 11px;
    color: #556677;
  }
</style>
</head>
<body>
<div class="container" id="session-info">
  <div class="header">
    <h1>CDP-MCP Session</h1>
    <span class="status ${data.status.toLowerCase()}" id="status">${data.status}</span>
  </div>
  <table>
    <tr><td>Port</td><td id="v-port">${data.port}</td></tr>
    <tr><td>Session ID</td><td id="v-sessionId">${data.sessionId}</td></tr>
    <tr><td>Session Name</td><td id="v-sessionName">${data.sessionName}</td></tr>
    <tr><td>MCP PID</td><td id="v-mcpPid">${data.mcpPid}</td></tr>
    <tr><td>Owner PID</td><td id="v-ownerPid">${data.ownerPid ?? '-'}</td></tr>
    <tr><td>Chrome PID</td><td id="v-chromePid">${data.chromePid ?? '-'}</td></tr>
    <tr><td>Started At</td><td id="v-startedAt">${startedAtStr}</td></tr>
    <tr><td>Last Updated</td><td id="v-updatedAt">${updatedAtStr}</td></tr>
  </table>
  <div class="footer">This tab is managed by CDP-MCP. Do not close it.</div>
</div>
</body>
</html>`;
}

/**
 * HTML을 data:text/html URL로 인코딩 + #cdp-mcp-session-info 프래그먼트 추가
 */
export function buildDataUrl(html: string): string {
  const encoded = encodeURIComponent(html);
  return `data:text/html;charset=utf-8,${encoded}#${SESSION_INFO_MARKER}`;
}

/**
 * 재접속 시 기존 탭 DOM을 업데이트하는 JS 스크립트 생성
 */
export function generateUpdateScript(data: SessionInfoData): string {
  const startedAtStr = new Date(data.startedAt).toLocaleString();
  const updatedAtStr = new Date().toLocaleString();

  return `
    (function() {
      var fields = {
        'status': '${data.status}',
        'v-port': '${data.port}',
        'v-sessionId': '${data.sessionId}',
        'v-sessionName': '${data.sessionName}',
        'v-mcpPid': '${data.mcpPid}',
        'v-ownerPid': '${data.ownerPid ?? '-'}',
        'v-chromePid': '${data.chromePid ?? '-'}',
        'v-startedAt': '${startedAtStr}',
        'v-updatedAt': '${updatedAtStr}'
      };
      for (var id in fields) {
        var el = document.getElementById(id);
        if (el) el.textContent = fields[id];
      }
      var statusEl = document.getElementById('status');
      if (statusEl) {
        statusEl.className = 'status ' + '${data.status.toLowerCase()}';
      }
      return 'updated';
    })();
  `.trim();
}

/**
 * 세션 정보 탭을 관리하는 오케스트레이터.
 * - 기존 세션 정보 탭이 있으면 내용 업데이트
 * - 없으면 새로 생성 (빈 탭이 하나뿐이면 해당 탭을 활용)
 */
export class SessionInfoTabManager {
  constructor(private readonly pool: ConnectionPool) {}

  async ensureSessionInfoTab(data: SessionInfoData): Promise<void> {
    const browserClient = this.pool.getBrowserClient();

    // 1. 기존 세션 정보 탭 검색
    const { targetInfos } = await browserClient.send<{ targetInfos: TargetInfoCdp[] }>(
      'Target.getTargets', {},
    );
    const pages = targetInfos.filter(t => t.type === 'page');
    const existingTab = pages.find(t => isSessionInfoTab(t.url));

    if (existingTab) {
      // 2. 기존 탭이 있으면 → 내용 업데이트
      try {
        const session = await this.pool.getConnection(existingTab.targetId);
        const script = generateUpdateScript(data);
        await session.send('Runtime.evaluate', { expression: script, returnByValue: true });
        logger.info(`Session info tab updated: ${existingTab.targetId}`);
        return;
      } catch (err) {
        // 업데이트 실패 → 탭 닫고 새로 생성
        logger.warn(`Failed to update session info tab, recreating: ${err}`);
        try {
          await browserClient.send('Target.closeTarget', { targetId: existingTab.targetId });
          this.pool.releaseConnection(existingTab.targetId);
        } catch { /* ignore close failure */ }
      }
    }

    // 3. 새로 생성
    const html = generateSessionInfoHtml(data);
    const dataUrl = buildDataUrl(html);

    // about:blank 탭이 하나뿐이면 해당 탭을 navigate
    const blankTabs = pages.filter(
      t => t.url === 'about:blank' || t.url === 'chrome://newtab/' || t.url === 'chrome://newtab',
    );
    const isOnlyBlankTab = pages.length === 1 && blankTabs.length === 1;

    if (isOnlyBlankTab) {
      try {
        const session = await this.pool.getConnection(blankTabs[0].targetId);
        await session.send('Page.navigate', { url: dataUrl });
        logger.info(`Navigated blank tab to session info: ${blankTabs[0].targetId}`);
        return;
      } catch (err) {
        logger.warn(`Failed to navigate blank tab, creating new: ${err}`);
      }
    }

    // 새 탭 생성
    const { targetId } = await browserClient.send<{ targetId: string }>(
      'Target.createTarget', { url: dataUrl, background: true },
    );
    logger.info(`Created session info tab: ${targetId}`);
  }
}
