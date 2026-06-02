/**
 * CDP Card — 파일 기반 쓰기 뮤텍스
 *
 * Chrome CDP에 쓰기 작업을 할 때 카드를 획득해야 한다.
 * 한 시점에 하나의 에이전트만 카드를 보유할 수 있다.
 * 읽기 작업(screenshot, evaluate 읽기)은 카드 없이 가능.
 *
 * 저장소: ~/.cdp-mcp/sessions/cdp-card-{port}.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger, sleep } from '@cdp-mcp/shared';
import type { CardInfo } from '@cdp-mcp/shared';

const logger = createLogger('cdp-card');

const SESSIONS_DIR = path.join(os.homedir(), '.cdp-mcp', 'sessions');

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class CdpCard {
  private readonly cardPath: string;

  constructor(private readonly port: number) {
    this.cardPath = path.join(SESSIONS_DIR, `cdp-card-${port}.json`);
  }

  /**
   * 쓰기 카드 획득.
   * 다른 에이전트가 들고 있으면 대기 (polling).
   * 들고 있던 프로세스가 죽었으면 강제 획득.
   */
  async acquire(agentId: string, opts?: { timeout?: number; purpose?: string }): Promise<void> {
    const timeout = opts?.timeout ?? 30_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const current = this.peek();

      // 카드 없음 → 획득
      if (!current) {
        this.write({ holder: agentId, pid: process.pid, acquiredAt: Date.now(), purpose: opts?.purpose });
        logger.info(`Card acquired by ${agentId}${opts?.purpose ? ` (${opts.purpose})` : ''}`);
        return;
      }

      // 내가 이미 들고 있음 → 성공 (재진입)
      if (current.holder === agentId) {
        logger.debug(`Card already held by ${agentId}`);
        return;
      }

      // 들고 있는 프로세스가 죽었음 → 강제 획득
      if (!isProcessAlive(current.pid)) {
        logger.info(`Stale card from ${current.holder} (pid ${current.pid} dead), taking over`);
        this.write({ holder: agentId, pid: process.pid, acquiredAt: Date.now(), purpose: opts?.purpose });
        return;
      }

      // 살아있음 → 대기
      logger.debug(`Card held by ${current.holder}, waiting...`);
      await sleep(500);
    }

    const current = this.peek();
    throw new CdpCardTimeoutError(
      `Failed to acquire card within ${timeout}ms. ` +
      `Currently held by: ${current?.holder ?? 'unknown'} (pid: ${current?.pid ?? '?'})`
    );
  }

  /**
   * 쓰기 카드 반납.
   * 자기가 들고 있는 카드만 반납 가능.
   */
  release(agentId: string): void {
    const current = this.peek();
    if (!current) {
      logger.debug('No card to release');
      return;
    }

    if (current.holder !== agentId) {
      logger.warn(`Cannot release card: held by ${current.holder}, not ${agentId}`);
      return;
    }

    try {
      fs.unlinkSync(this.cardPath);
      logger.info(`Card released by ${agentId}`);
    } catch {
      // 이미 삭제된 경우 무시
    }
  }

  /**
   * 현재 카드 상태 확인 (누가 들고 있는지).
   */
  peek(): CardInfo | null {
    try {
      if (!fs.existsSync(this.cardPath)) return null;
      return JSON.parse(fs.readFileSync(this.cardPath, 'utf-8')) as CardInfo;
    } catch {
      return null;
    }
  }

  /**
   * 카드가 현재 사용 중인지 확인.
   */
  isHeld(): boolean {
    const card = this.peek();
    if (!card) return false;
    // 프로세스 죽었으면 held가 아님
    return isProcessAlive(card.pid);
  }

  /**
   * 강제로 카드 정리 (포트 정리 시 사용).
   */
  forceRelease(): void {
    try {
      if (fs.existsSync(this.cardPath)) {
        fs.unlinkSync(this.cardPath);
        logger.info(`Card force-released for port ${this.port}`);
      }
    } catch {
      // ignore
    }
  }

  private write(info: CardInfo): void {
    ensureSessionsDir();
    fs.writeFileSync(this.cardPath, JSON.stringify(info, null, 2), 'utf-8');
  }
}

export class CdpCardTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpCardTimeoutError';
  }
}
