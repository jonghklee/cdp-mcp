/**
 * CDP-MCP Port Store
 *
 * 파일 기반 포트 할당 저장소 + 락 파일 관리
 * ~/.cdp-mcp/locks/{port}.lock — 포트별 락 파일
 * ~/.cdp-mcp/port-assignments.json — 포트 할당 정보
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('port-store');

// ── Types ──────────────────────────────────────────────────

export interface LockInfo {
  sessionId: string;
  sessionName: string;
  pid: number;
  ownerPid?: number;   // Claude Code PID (ppid) — 소유권 + 생존 판단 기준
  mcpPid?: number;     // MCP Server PID (참고용, 변경될 수 있음)
  chromePid?: number;  // Chrome 프로세스 PID — stale lock 정리 시 orphan Chrome 종료용
  startedAt: number;
}

export interface PortAssignment {
  port: number;
  createdAt: number;
  lastUsedAt: number;
}

interface PortAssignmentFile {
  assignments: Record<string, PortAssignment>;
  metadata: {
    portRange: { start: number; end: number };
  };
}

// ── Constants ──────────────────────────────────────────────

const CDP_MCP_PORT = parseInt(process.env.CDP_MCP_PORT ?? '9222', 10);
const PORT_RANGE = { start: CDP_MCP_PORT, end: CDP_MCP_PORT + 28 };
export const EXCLUDED_PORTS = new Set([9229]); // Node.js debugger

const CONFIG_DIR = path.join(os.homedir(), '.cdp-mcp');
const LOCKS_DIR = path.join(CONFIG_DIR, 'locks');
const ASSIGNMENTS_FILE = path.join(CONFIG_DIR, 'port-assignments.json');

// ── Internal helpers ───────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureLocksDir(): void {
  ensureDir(CONFIG_DIR);
  ensureDir(LOCKS_DIR);
}

function lockFilePath(port: number): string {
  return path.join(LOCKS_DIR, `${port}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Internal: stale lock cleanup ──────────────────────────

function cleanupOrphanChrome(port: number, info: LockInfo): void {
  if (info.chromePid && isProcessAlive(info.chromePid)) {
    // Chrome 프로세스를 강제 종료하지 않음 — lock만 정리
    // 사용자가 수동으로 Chrome을 사용 중일 수 있으므로 kill 금지
    logger.info(`Orphan Chrome process ${info.chromePid} on port ${port} still alive (not killing, lock only cleanup)`);
  }
}

// ── Lock operations ────────────────────────────────────────

export function readLock(port: number): LockInfo | null {
  const file = lockFilePath(port);
  if (!fs.existsSync(file)) return null;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as LockInfo;
  } catch {
    logger.warn(`Corrupted lock file for port ${port}`);
    return null;
  }
}

export function acquireLock(port: number, sessionId: string, sessionName: string, chromePid?: number): boolean {
  ensureLocksDir();

  const existing = readLock(port);
  if (existing) {
    const ownerPid = existing.ownerPid ?? existing.pid;

    // 같은 Claude Code 세션이면 mcpPid만 갱신 (MCP 재시작 대응)
    if (ownerPid === process.ppid) {
      logger.info(`Port ${port} is my lock, updating mcpPid → ${process.pid}`);
    } else if (isProcessAlive(ownerPid)) {
      // 다른 살아있는 Claude Code가 소유
      logger.info(`Port ${port} locked by ${existing.sessionName} (ownerPid: ${ownerPid})`);
      return false;
    } else {
      // ownerPid(Claude Code)가 죽었으면 stale → orphan Chrome도 정리
      logger.info(`Removing stale lock for port ${port} (ownerPid ${ownerPid} dead)`);
      cleanupOrphanChrome(port, existing);
      fs.unlinkSync(lockFilePath(port));
    }
  }

  const lockInfo: LockInfo = {
    sessionId,
    sessionName,
    pid: process.pid,
    ownerPid: process.ppid,
    mcpPid: process.pid,
    chromePid: chromePid ?? existing?.chromePid,
    startedAt: Date.now(),
  };

  try {
    fs.writeFileSync(lockFilePath(port), JSON.stringify(lockInfo, null, 2), 'utf-8');
    logger.info(`Acquired lock for port ${port} (session: ${sessionName}, PID: ${process.pid})`);
    return true;
  } catch (err) {
    logger.error(`Failed to write lock for port ${port}`, err);
    return false;
  }
}

export function releaseLock(port: number, sessionId?: string): boolean {
  const file = lockFilePath(port);
  if (!fs.existsSync(file)) return true;

  if (sessionId) {
    const existing = readLock(port);
    if (existing && existing.sessionId !== sessionId) {
      logger.warn(`Cannot release lock for port ${port}: owned by different session`);
      return false;
    }
  }

  try {
    fs.unlinkSync(file);
    logger.info(`Released lock for port ${port}`);
    return true;
  } catch (err) {
    logger.error(`Failed to release lock for port ${port}`, err);
    return false;
  }
}

export function isPortLocked(port: number): { locked: boolean; lockInfo?: LockInfo } {
  const info = readLock(port);
  if (!info) return { locked: false };

  const ownerPid = info.ownerPid ?? info.pid;
  if (isProcessAlive(ownerPid)) {
    return { locked: true, lockInfo: info };
  }

  // ownerPid(Claude Code)가 죽었으면 stale → orphan Chrome도 정리
  logger.info(`Removing stale lock for port ${port} (ownerPid ${ownerPid} dead)`);
  cleanupOrphanChrome(port, info);
  releaseLock(port);
  return { locked: false };
}

export function isMyLock(port: number): boolean {
  const info = readLock(port);
  if (!info) return false;
  const ownerPid = info.ownerPid ?? info.pid;
  return ownerPid === process.ppid;
}

export function getAllLocks(): Record<number, LockInfo> {
  ensureLocksDir();
  const locks: Record<number, LockInfo> = {};

  try {
    for (const file of fs.readdirSync(LOCKS_DIR)) {
      if (!file.endsWith('.lock')) continue;
      const port = parseInt(file.replace('.lock', ''), 10);
      const info = readLock(port);
      if (!info) continue;

      const ownerPid = info.ownerPid ?? info.pid;
      if (isProcessAlive(ownerPid)) {
        locks[port] = info;
      } else {
        logger.info(`Cleaning stale lock for port ${port} (ownerPid ${ownerPid} dead)`);
        cleanupOrphanChrome(port, info);
        releaseLock(port);
      }
    }
  } catch (err) {
    logger.error('Error reading locks directory', err);
  }

  return locks;
}

// ── Port assignment operations ─────────────────────────────

function readAssignments(): PortAssignmentFile {
  ensureDir(CONFIG_DIR);
  if (!fs.existsSync(ASSIGNMENTS_FILE)) {
    return { assignments: {}, metadata: { portRange: PORT_RANGE } };
  }
  try {
    return JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, 'utf-8')) as PortAssignmentFile;
  } catch {
    return { assignments: {}, metadata: { portRange: PORT_RANGE } };
  }
}

function writeAssignments(data: PortAssignmentFile): void {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function assignPort(sessionId: string, sessionName: string): number | null {
  const data = readAssignments();
  const { start, end } = data.metadata.portRange;

  for (let port = start; port <= end; port++) {
    if (EXCLUDED_PORTS.has(port)) continue;

    const { locked } = isPortLocked(port);
    if (locked) continue;

    if (!acquireLock(port, sessionId, sessionName)) continue;

    data.assignments[sessionId] = {
      port,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    writeAssignments(data);
    logger.info(`Assigned port ${port} to session ${sessionName}`);
    return port;
  }

  logger.warn(`No available port for session ${sessionName}`);
  return null;
}

export function releasePort(sessionId: string): void {
  const data = readAssignments();
  const assignment = data.assignments[sessionId];
  if (!assignment) return;

  releaseLock(assignment.port, sessionId);
  delete data.assignments[sessionId];
  writeAssignments(data);
  logger.info(`Released port ${assignment.port} from session ${sessionId}`);
}

export function cleanupStaleAssignments(maxAgeMs: number = 60 * 60 * 1000): number {
  const data = readAssignments();
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, assignment] of Object.entries(data.assignments)) {
    if (now - assignment.lastUsedAt > maxAgeMs) {
      releaseLock(assignment.port, sessionId);
      delete data.assignments[sessionId];
      cleaned++;
      logger.info(`Cleaned stale assignment: ${sessionId}`);
    }
  }

  if (cleaned > 0) writeAssignments(data);
  return cleaned;
}
