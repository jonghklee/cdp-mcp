import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CdpCard, CdpCardTimeoutError } from '../cdp-card.js';

const TEST_PORT = 19222;
const SESSIONS_DIR = path.join(os.homedir(), '.cdp-mcp', 'sessions');
const cardPath = path.join(SESSIONS_DIR, `cdp-card-${TEST_PORT}.json`);

function cleanup(): void {
  try {
    if (fs.existsSync(cardPath)) fs.unlinkSync(cardPath);
  } catch { /* ignore */ }
}

describe('CdpCard', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('acquire: 카드 없으면 즉시 획득', async () => {
    const card = new CdpCard(TEST_PORT);
    await card.acquire('agent-1');

    const info = card.peek();
    expect(info).not.toBeNull();
    expect(info!.holder).toBe('agent-1');
    expect(info!.pid).toBe(process.pid);
  });

  it('release: 자기 카드 반납', async () => {
    const card = new CdpCard(TEST_PORT);
    await card.acquire('agent-1');
    card.release('agent-1');

    expect(card.peek()).toBeNull();
  });

  it('release: 다른 agent의 카드는 반납 불가', async () => {
    const card = new CdpCard(TEST_PORT);
    await card.acquire('agent-1');
    card.release('agent-2'); // 다른 agent

    // 카드는 여전히 agent-1이 보유
    const info = card.peek();
    expect(info).not.toBeNull();
    expect(info!.holder).toBe('agent-1');
  });

  it('acquire: 재진입 (같은 agentId면 바로 성공)', async () => {
    const card = new CdpCard(TEST_PORT);
    await card.acquire('agent-1');
    await card.acquire('agent-1'); // 재진입

    const info = card.peek();
    expect(info!.holder).toBe('agent-1');
  });

  it('acquire: 죽은 프로세스의 카드는 강제 획득', async () => {
    const card = new CdpCard(TEST_PORT);

    // 존재하지 않는 PID로 카드를 직접 작성
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(cardPath, JSON.stringify({
      holder: 'dead-agent',
      pid: 999999, // 존재하지 않는 PID
      acquiredAt: Date.now(),
    }), 'utf-8');

    await card.acquire('agent-2');

    const info = card.peek();
    expect(info!.holder).toBe('agent-2');
  });

  it('acquire: timeout 시 CdpCardTimeoutError', async () => {
    const card = new CdpCard(TEST_PORT);

    // 현재 프로세스 PID로 카드 작성 (살아있는 프로세스)
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(cardPath, JSON.stringify({
      holder: 'blocking-agent',
      pid: process.pid, // 살아있는 PID
      acquiredAt: Date.now(),
    }), 'utf-8');

    await expect(
      card.acquire('agent-2', { timeout: 1000 })
    ).rejects.toThrow(CdpCardTimeoutError);
  });

  it('isHeld: 살아있는 프로세스가 들고 있으면 true', async () => {
    const card = new CdpCard(TEST_PORT);
    await card.acquire('agent-1');

    expect(card.isHeld()).toBe(true);
  });

  it('isHeld: 카드 없으면 false', () => {
    const card = new CdpCard(TEST_PORT);
    expect(card.isHeld()).toBe(false);
  });

  it('isHeld: 죽은 프로세스가 들고 있으면 false', () => {
    const card = new CdpCard(TEST_PORT);

    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(cardPath, JSON.stringify({
      holder: 'dead-agent',
      pid: 999999,
      acquiredAt: Date.now(),
    }), 'utf-8');

    expect(card.isHeld()).toBe(false);
  });

  it('forceRelease: 누가 들고 있든 강제 삭제', async () => {
    const card = new CdpCard(TEST_PORT);
    await card.acquire('agent-1');

    card.forceRelease();
    expect(card.peek()).toBeNull();
  });

  it('purpose 필드 저장', async () => {
    const card = new CdpCard(TEST_PORT);
    await card.acquire('agent-1', { purpose: 'DOM 조작' });

    const info = card.peek();
    expect(info!.purpose).toBe('DOM 조작');
  });

  it('포트별 독립 카드', async () => {
    const card1 = new CdpCard(TEST_PORT);
    const card2 = new CdpCard(TEST_PORT + 1);
    const card2Path = path.join(SESSIONS_DIR, `cdp-card-${TEST_PORT + 1}.json`);

    try {
      await card1.acquire('agent-1');
      await card2.acquire('agent-2'); // 다른 포트이므로 바로 성공

      expect(card1.peek()!.holder).toBe('agent-1');
      expect(card2.peek()!.holder).toBe('agent-2');
    } finally {
      try { fs.unlinkSync(card2Path); } catch { /* ignore */ }
    }
  });
});
