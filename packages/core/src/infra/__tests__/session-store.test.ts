import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { saveSession, loadSession, clearSession } from '../session-store.js';
import type { SessionDescriptor } from '@cdp-mcp/shared';

const SESSIONS_DIR = path.join(os.homedir(), '.cdp-mcp', 'sessions');
const ACTIVE_PATH = path.join(SESSIONS_DIR, 'active.json');

function cleanup(): void {
  try {
    if (fs.existsSync(ACTIVE_PATH)) fs.unlinkSync(ACTIVE_PATH);
  } catch { /* ignore */ }
}

describe('SessionStore', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  const descriptor: SessionDescriptor = {
    port: 9222,
    sessionId: 'cdp-mcp_9222_12345',
    ownerPid: process.pid, // 현재 프로세스 (살아있음)
    chromePid: 99999,
    tags: { purpose: 'test' },
    exportedAt: Date.now(),
  };

  it('saveSession + loadSession 왕복', () => {
    saveSession(descriptor);
    const loaded = loadSession();

    expect(loaded).not.toBeNull();
    expect(loaded!.port).toBe(9222);
    expect(loaded!.sessionId).toBe('cdp-mcp_9222_12345');
    expect(loaded!.ownerPid).toBe(process.pid);
    expect(loaded!.tags).toEqual({ purpose: 'test' });
  });

  it('loadSession: 파일 없으면 null', () => {
    expect(loadSession()).toBeNull();
  });

  it('loadSession: ownerPid 죽었으면 stale → null + 파일 삭제', () => {
    const staleDescriptor: SessionDescriptor = {
      ...descriptor,
      ownerPid: 999999, // 존재하지 않는 PID
    };
    saveSession(staleDescriptor);

    const loaded = loadSession();
    expect(loaded).toBeNull();
    // 파일도 삭제되어야 함
    expect(fs.existsSync(ACTIVE_PATH)).toBe(false);
  });

  it('clearSession: 파일 삭제', () => {
    saveSession(descriptor);
    expect(fs.existsSync(ACTIVE_PATH)).toBe(true);

    clearSession();
    expect(fs.existsSync(ACTIVE_PATH)).toBe(false);
  });

  it('clearSession: 파일 없어도 에러 안 남', () => {
    expect(() => clearSession()).not.toThrow();
  });

  it('tags 포함 저장/로드', () => {
    const withTags: SessionDescriptor = {
      ...descriptor,
      tags: { purpose: 'e2e', phase: 'P3', site: 'chatgpt.com' },
    };
    saveSession(withTags);
    const loaded = loadSession();

    expect(loaded!.tags).toEqual({ purpose: 'e2e', phase: 'P3', site: 'chatgpt.com' });
  });

  it('activeTabId, extensionId 힌트 저장', () => {
    const withHints: SessionDescriptor = {
      ...descriptor,
      activeTabId: 'tab-123',
      extensionId: 'ext-abc',
    };
    saveSession(withHints);
    const loaded = loadSession();

    expect(loaded!.activeTabId).toBe('tab-123');
    expect(loaded!.extensionId).toBe('ext-abc');
  });
});
