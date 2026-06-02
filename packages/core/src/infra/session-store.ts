/**
 * Session Store — SessionDescriptor 영속화
 *
 * owner 모드의 부모 에이전트가 세션 정보를 파일로 저장하면,
 * shared 모드의 subagent가 읽어서 동일한 Chrome에 연결한다.
 *
 * 저장소: ~/.cdp-mcp/sessions/active.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '@cdp-mcp/shared';
import type { SessionDescriptor } from '@cdp-mcp/shared';

const logger = createLogger('session-store');

const SESSIONS_DIR = path.join(os.homedir(), '.cdp-mcp', 'sessions');
const ACTIVE_SESSION_PATH = path.join(SESSIONS_DIR, 'active.json');

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/**
 * 현재 세션 정보를 active.json에 저장.
 * owner 모드에서 Chrome 연결 후 호출.
 */
export function saveSession(descriptor: SessionDescriptor): void {
  ensureSessionsDir();
  try {
    fs.writeFileSync(ACTIVE_SESSION_PATH, JSON.stringify(descriptor, null, 2), 'utf-8');
    logger.info(`Session saved: port=${descriptor.port}, sessionId=${descriptor.sessionId}`);
  } catch (err) {
    logger.error(`Failed to save session: ${err}`);
  }
}

/**
 * active.json에서 세션 정보 로드.
 * shared 모드에서 연결 대상을 찾을 때 호출.
 * ownerPid가 죽었으면 stale로 판단하여 null 반환.
 */
export function loadSession(): SessionDescriptor | null {
  try {
    if (!fs.existsSync(ACTIVE_SESSION_PATH)) return null;
    const descriptor = JSON.parse(fs.readFileSync(ACTIVE_SESSION_PATH, 'utf-8')) as SessionDescriptor;

    // ownerPid 생존 확인
    if (descriptor.ownerPid) {
      try {
        process.kill(descriptor.ownerPid, 0);
      } catch {
        logger.info(`Active session stale (ownerPid ${descriptor.ownerPid} dead), ignoring`);
        clearSession();
        return null;
      }
    }

    return descriptor;
  } catch {
    logger.warn('Failed to read active session file');
    return null;
  }
}

/**
 * active.json 삭제.
 * owner 모드에서 Chrome 종료 시 호출.
 */
export function clearSession(): void {
  try {
    if (fs.existsSync(ACTIVE_SESSION_PATH)) {
      fs.unlinkSync(ACTIVE_SESSION_PATH);
      logger.info('Active session cleared');
    }
  } catch {
    // ignore
  }
}
