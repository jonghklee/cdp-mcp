import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fs and process before importing the module
const TEST_DIR = path.join(os.tmpdir(), `cdp-mcp-test-${process.pid}-${Date.now()}`);
const LOCKS_DIR = path.join(TEST_DIR, 'locks');
const ASSIGNMENTS_FILE = path.join(TEST_DIR, 'port-assignments.json');

// We need to mock the CONFIG_DIR/LOCKS_DIR/ASSIGNMENTS_FILE constants
// Since they're module-level constants, we mock the entire module paths
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: actual };
});

// Instead of mocking constants, we'll use the actual module but with a test helper
// that creates/removes lock files in the real ~/.cdp-mcp directory.
// For isolation, we'll use a temp directory approach.

describe('PortStore', () => {
  let portStore: typeof import('../port-store.js');
  const testLocksDir = LOCKS_DIR;

  beforeEach(async () => {
    // Create test directories
    fs.mkdirSync(testLocksDir, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Re-import to get fresh module state
    // Since we can't easily change module constants, we'll test via the real path
    // but clean up carefully
    portStore = await import('../port-store.js');
  });

  afterEach(() => {
    // Clean up test files — only clean the real lock directory entries we created
    // This is safe because we use unique session IDs
    try {
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  describe('readLock', () => {
    it('returns null for non-existent lock', () => {
      const result = portStore.readLock(19999);
      expect(result).toBeNull();
    });
  });

  describe('acquireLock + readLock', () => {
    const testPort = 19990;

    afterEach(() => {
      // Clean up lock after each test
      portStore.releaseLock(testPort);
    });

    it('creates a lock file and reads it back', () => {
      const result = portStore.acquireLock(testPort, 'test-session-1', 'test-name');
      expect(result).toBe(true);

      const lock = portStore.readLock(testPort);
      expect(lock).not.toBeNull();
      expect(lock!.sessionId).toBe('test-session-1');
      expect(lock!.sessionName).toBe('test-name');
      expect(lock!.pid).toBe(process.pid);
      expect(lock!.mcpPid).toBe(process.pid);
      expect(lock!.ownerPid).toBe(process.ppid);
      expect(lock!.startedAt).toBeGreaterThan(0);
    });

    it('rejects lock when port is locked by different ownerPid', () => {
      // First acquire
      const first = portStore.acquireLock(testPort, 'session-a', 'name-a');
      expect(first).toBe(true);

      // Manually modify the lock to simulate a different ownerPid (use process.pid which is alive)
      const lockFile = path.join(os.homedir(), '.cdp-mcp', 'locks', `${testPort}.lock`);
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      lockData.ownerPid = process.pid; // Different owner (alive process)
      fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf-8');

      // Second acquire should fail (different owner, ownerPid alive)
      const second = portStore.acquireLock(testPort, 'session-b', 'name-b');
      expect(second).toBe(false);
    });

    it('allows re-acquire when same ownerPid (same Claude Code session)', () => {
      const first = portStore.acquireLock(testPort, 'session-a', 'name-a');
      expect(first).toBe(true);

      // ownerPid = process.ppid by default, so same session → should succeed
      const second = portStore.acquireLock(testPort, 'session-b', 'name-b');
      expect(second).toBe(true);

      const lock = portStore.readLock(testPort);
      expect(lock!.sessionId).toBe('session-b');
    });

    it('allows acquire when existing lock has dead ownerPid (stale lock)', () => {
      const first = portStore.acquireLock(testPort, 'session-stale', 'name-stale');
      expect(first).toBe(true);

      // Modify lock to have a dead ownerPid (Claude Code가 죽은 상태)
      const lockFile = path.join(os.homedir(), '.cdp-mcp', 'locks', `${testPort}.lock`);
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      lockData.ownerPid = 99998; // Dead PID
      fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf-8');

      // Should succeed because ownerPid is dead
      const second = portStore.acquireLock(testPort, 'session-new', 'name-new');
      expect(second).toBe(true);

      const lock = portStore.readLock(testPort);
      expect(lock!.sessionId).toBe('session-new');
    });

    it('stores chromePid in lock file', () => {
      const result = portStore.acquireLock(testPort, 'session-chrome', 'name-chrome', 12345);
      expect(result).toBe(true);

      const lock = portStore.readLock(testPort);
      expect(lock!.chromePid).toBe(12345);
    });
  });

  describe('releaseLock', () => {
    const testPort = 19991;

    it('returns true for non-existent lock', () => {
      const result = portStore.releaseLock(testPort);
      expect(result).toBe(true);
    });

    it('releases an existing lock', () => {
      portStore.acquireLock(testPort, 'session-rel', 'name-rel');
      const result = portStore.releaseLock(testPort);
      expect(result).toBe(true);
      expect(portStore.readLock(testPort)).toBeNull();
    });

    it('rejects release with wrong sessionId', () => {
      portStore.acquireLock(testPort, 'session-owner', 'name-owner');
      const result = portStore.releaseLock(testPort, 'session-other');
      expect(result).toBe(false);

      // Lock should still exist
      expect(portStore.readLock(testPort)).not.toBeNull();

      // Clean up
      portStore.releaseLock(testPort);
    });
  });

  describe('isPortLocked', () => {
    const testPort = 19992;

    afterEach(() => {
      portStore.releaseLock(testPort);
    });

    it('returns locked: false for unlocked port', () => {
      const result = portStore.isPortLocked(testPort);
      expect(result.locked).toBe(false);
      expect(result.lockInfo).toBeUndefined();
    });

    it('returns locked: true for locked port with live process', () => {
      portStore.acquireLock(testPort, 'session-live', 'name-live');
      const result = portStore.isPortLocked(testPort);
      expect(result.locked).toBe(true);
      expect(result.lockInfo).toBeDefined();
      expect(result.lockInfo!.sessionId).toBe('session-live');
    });

    it('cleans stale lock and returns locked: false when ownerPid is dead', () => {
      portStore.acquireLock(testPort, 'session-dead', 'name-dead');

      // Make the lock stale by setting dead ownerPid
      const lockFile = path.join(os.homedir(), '.cdp-mcp', 'locks', `${testPort}.lock`);
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      lockData.ownerPid = 99996; // Dead ownerPid (Claude Code가 죽은 상태)
      fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf-8');

      const result = portStore.isPortLocked(testPort);
      expect(result.locked).toBe(false);
      // Lock file should be cleaned up
      expect(portStore.readLock(testPort)).toBeNull();
    });

    it('returns locked: true even when mcpPid is dead (ownerPid alive)', () => {
      portStore.acquireLock(testPort, 'session-mcp-dead', 'name-mcp-dead');

      // mcpPid만 죽이고 ownerPid(Claude Code)는 살아있는 상태
      const lockFile = path.join(os.homedir(), '.cdp-mcp', 'locks', `${testPort}.lock`);
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      lockData.mcpPid = 99996; // Dead mcpPid
      // ownerPid는 process.ppid (alive) 그대로
      fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf-8');

      const result = portStore.isPortLocked(testPort);
      // ownerPid가 살아있으므로 lock은 유효
      expect(result.locked).toBe(true);
    });
  });

  describe('isMyLock', () => {
    const testPort = 19993;

    afterEach(() => {
      portStore.releaseLock(testPort);
    });

    it('returns false for unlocked port', () => {
      expect(portStore.isMyLock(testPort)).toBe(false);
    });

    it('returns true when ownerPid matches process.ppid', () => {
      portStore.acquireLock(testPort, 'session-mine', 'name-mine');
      // acquireLock sets ownerPid = process.ppid
      expect(portStore.isMyLock(testPort)).toBe(true);
    });

    it('returns false when ownerPid differs', () => {
      portStore.acquireLock(testPort, 'session-other', 'name-other');

      // Change ownerPid
      const lockFile = path.join(os.homedir(), '.cdp-mcp', 'locks', `${testPort}.lock`);
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      lockData.ownerPid = 99995;
      fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf-8');

      expect(portStore.isMyLock(testPort)).toBe(false);
    });
  });

  describe('getAllLocks', () => {
    const testPorts = [19994, 19995];

    afterEach(() => {
      for (const port of testPorts) {
        portStore.releaseLock(port);
      }
    });

    it('returns all active locks', () => {
      portStore.acquireLock(testPorts[0], 'session-all-1', 'name-1');
      portStore.acquireLock(testPorts[1], 'session-all-2', 'name-2');

      const locks = portStore.getAllLocks();
      expect(locks[testPorts[0]]).toBeDefined();
      expect(locks[testPorts[1]]).toBeDefined();
      expect(locks[testPorts[0]].sessionId).toBe('session-all-1');
      expect(locks[testPorts[1]].sessionId).toBe('session-all-2');
    });

    it('cleans stale locks during enumeration (dead ownerPid)', () => {
      portStore.acquireLock(testPorts[0], 'session-stale-enum', 'name-stale');

      // Make one lock stale by setting dead ownerPid
      const lockFile = path.join(os.homedir(), '.cdp-mcp', 'locks', `${testPorts[0]}.lock`);
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      lockData.ownerPid = 99994; // Dead ownerPid
      fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), 'utf-8');

      const locks = portStore.getAllLocks();
      expect(locks[testPorts[0]]).toBeUndefined();
    });
  });

  describe('assignPort / releasePort', () => {
    const sessionId = `test-assign-${Date.now()}`;

    beforeEach(() => {
      // Clean any existing locks in the port range that might be left from other tests
      for (let port = 9222; port <= 9250; port++) {
        portStore.releaseLock(port);
      }
    });

    afterEach(() => {
      portStore.releasePort(sessionId);
    });

    it('assigns a port and releases it', () => {
      const port = portStore.assignPort(sessionId, 'test-assign');
      expect(port).not.toBeNull();
      expect(port).toBeGreaterThanOrEqual(9222);
      expect(port).toBeLessThanOrEqual(9250);

      // Verify lock exists
      expect(portStore.readLock(port!)).not.toBeNull();

      // Release
      portStore.releasePort(sessionId);
      expect(portStore.readLock(port!)).toBeNull();
    });

    it('skips excluded ports (9229)', () => {
      // The assigned port should never be 9229
      const port = portStore.assignPort(sessionId, 'test-exclude');
      expect(port).not.toBe(9229);

      portStore.releasePort(sessionId);
    });
  });

  describe('cleanupStaleAssignments', () => {
    it('removes old assignments', () => {
      // Clean any existing locks first
      for (let port = 9222; port <= 9250; port++) {
        portStore.releaseLock(port);
      }

      const sessionId = `stale-cleanup-${Date.now()}`;
      const port = portStore.assignPort(sessionId, 'stale-test');
      expect(port).not.toBeNull();

      // Cleanup with maxAge = -1 to ensure all assignments are "stale"
      const cleaned = portStore.cleanupStaleAssignments(-1);
      expect(cleaned).toBeGreaterThanOrEqual(1);
    });
  });

  describe('EXCLUDED_PORTS', () => {
    it('contains 9229 (Node.js debugger)', () => {
      expect(portStore.EXCLUDED_PORTS.has(9229)).toBe(true);
    });
  });
});
