import * as net from 'net';
import { createLogger } from '@cdp-mcp/shared';
import { isPortLocked, isMyLock, EXCLUDED_PORTS } from './port-store.js';

const logger = createLogger('port-manager');

const DEFAULT_PORT = parseInt(process.env.CDP_MCP_PORT ?? '9222', 10);
const PORT_RANGE_END = DEFAULT_PORT + 28;

export class PortManager {
  async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => {
        server.close();
        resolve(false);
      });
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * lock 파일 + 포트 사용 여부 이중 체크로 사용 가능한 포트 탐색
   */
  async findAvailablePort(startFrom: number = DEFAULT_PORT): Promise<number> {
    const end = Math.max(startFrom + 100, PORT_RANGE_END);
    for (let port = startFrom; port <= end; port++) {
      if (EXCLUDED_PORTS.has(port)) continue;

      // 1. lock 파일 확인
      const { locked } = isPortLocked(port);
      if (locked) continue;

      // 2. 실제 포트 사용 여부
      const inUse = await this.isPortInUse(port);
      if (!inUse) {
        logger.debug(`Found available port: ${port}`);
        return port;
      }
    }
    throw new Error(`No available port found in range ${startFrom}-${end}`);
  }

  /**
   * lock 파일 기반 자기 Chrome 우선 탐색
   * 1. isMyLock인 포트 → 우선 반환
   * 2. 없으면 기존 Chrome 디버그 포트 탐색
   */
  async findChromeDebugPort(): Promise<number | null> {
    // 1단계: 내 lock이 있는 포트를 먼저 찾기
    for (let port = DEFAULT_PORT; port <= PORT_RANGE_END; port++) {
      if (EXCLUDED_PORTS.has(port)) continue;
      if (!isMyLock(port)) continue;

      // lock이 있으면 실제 Chrome이 살아있는지 확인
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          logger.info(`Found my Chrome on port ${port} (via lock)`);
          return port;
        }
      } catch {
        // Chrome이 죽었을 수 있음, 다음 포트 시도
      }
    }

    // 2단계: lock 없는 Chrome에는 연결하지 않음
    // 다른 CDP 클라이언트(chrome-devtools 등)가 사용 중인 Chrome에
    // 중복 연결하면 경쟁 상태가 발생하므로, 자체 launch한 Chrome만 사용
    logger.info('No owned Chrome found, will launch new instance');
    return null;
  }
}
