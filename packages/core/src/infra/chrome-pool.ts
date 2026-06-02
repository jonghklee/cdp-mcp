import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CdpConnectionError, createLogger, sleep } from '@cdp-mcp/shared';
import { PortManager } from './port-manager.js';
import { acquireLock, releaseLock, isMyLock, readLock } from './port-store.js';

const logger = createLogger('chrome-manager');

/** 플랫폼별 Chrome 기본 프로필 경로 */
const DEFAULT_CHROME_PROFILES: Record<string, string> = {
  darwin: path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default'),
  win32: path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data/Default'),
  linux: path.join(os.homedir(), '.config/google-chrome/Default'),
};

/** CDP-MCP 전용 Chrome 프로필 디렉토리 */
const CDP_MCP_PROFILES_DIR = path.join(os.homedir(), '.cdp-mcp', 'chrome-profiles');

/**
 * 기존 Chrome 프로필에서 주요 파일을 복제 (로그인, 쿠키, 익스텐션 설정 유지)
 */
function copyProfile(sourceDir: string, targetDir: string): boolean {
  try {
    if (fs.existsSync(path.join(targetDir, 'Preferences'))) {
      logger.debug(`Profile already exists at ${targetDir}, skipping copy`);
      return true;
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const itemsToCopy = [
      'Preferences',
      'Secure Preferences',
      'Cookies',
      'Login Data',
      'Web Data',
      'Extension State',
      'Local Extension Settings',
      'Sync Extension Settings',
      'Extensions',
    ];

    for (const item of itemsToCopy) {
      const sourcePath = path.join(sourceDir, item);
      const targetPath = path.join(targetDir, item);

      if (fs.existsSync(sourcePath)) {
        const stat = fs.statSync(sourcePath);
        if (stat.isDirectory()) {
          execSync(`cp -r "${sourcePath}" "${targetPath}"`, { stdio: 'ignore' });
        } else {
          fs.copyFileSync(sourcePath, targetPath);
        }
        logger.debug(`Copied: ${item}`);
      }
    }

    logger.info(`Profile copied from ${sourceDir} to ${targetDir}`);
    return true;
  } catch (error) {
    logger.error(`Error copying profile: ${error}`);
    return false;
  }
}

/**
 * 기존 CDP 프로필을 삭제하고 현재 Chrome 프로필에서 다시 복제.
 * 쿠키/세션 만료 시 최신 로그인 상태를 반영하기 위해 사용.
 * @returns 삭제된 바이트 수 (대략적)
 */
function refreshProfile(port: number): { deleted: boolean; copied: boolean } {
  const userDataDir = path.join(CDP_MCP_PROFILES_DIR, `port-${port}`);
  const profileDir = path.join(userDataDir, 'Default');

  let deleted = false;
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.mkdirSync(profileDir, { recursive: true });
    deleted = true;
    logger.info(`Profile deleted for port ${port}`);
  }

  const sourceProfile = DEFAULT_CHROME_PROFILES[process.platform];
  let copied = false;
  if (sourceProfile && fs.existsSync(sourceProfile)) {
    copied = copyProfile(sourceProfile, profileDir);
    ensureDeveloperMode(profileDir);
  } else {
    logger.warn(`Source profile not found: ${sourceProfile}`);
  }

  return { deleted, copied };
}

/**
 * Preferences 파일에 개발자 모드 활성화
 */
function ensureDeveloperMode(profileDir: string): void {
  const prefsPath = path.join(profileDir, 'Preferences');

  try {
    let prefs: Record<string, any> = {};

    if (fs.existsSync(prefsPath)) {
      const content = fs.readFileSync(prefsPath, 'utf-8');
      prefs = JSON.parse(content);
    }

    if (!prefs.extensions) prefs.extensions = {};
    if (!prefs.extensions.ui) prefs.extensions.ui = {};
    prefs.extensions.ui.developer_mode = true;

    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
    logger.debug('Developer mode enabled');
  } catch (error) {
    logger.error(`Error setting developer mode: ${error}`);
  }
}

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export interface ChromeLaunchOptions {
  port?: number;
  userDataDir?: string;
  headless?: boolean;
  /** Chrome 실행 시 창에 포커스를 줄지 여부. (기본: false — 포커스를 가져가지 않음. 환경변수 CDP_MCP_CHROME_FOCUS=true로 활성화 가능) */
  focusOnLaunch?: boolean;
  /** unpacked 익스텐션 경로 목록. 환경변수 CDP_MCP_EXTENSIONS (쉼표 구분)로도 설정 가능 */
  extensionPaths?: string[];
  args?: string[];
}

/**
 * 익스텐션 경로 목록 결정: 옵션 > 환경변수 CDP_MCP_EXTENSIONS (쉼표 구분)
 * 존재하지 않는 경로는 경고 후 제외
 */
export function resolveExtensionPaths(optionPaths?: string[]): string[] {
  const raw = optionPaths
    ?? (process.env.CDP_MCP_EXTENSIONS
      ? process.env.CDP_MCP_EXTENSIONS.split(',').map(p => p.trim()).filter(Boolean)
      : []);

  const valid: string[] = [];
  for (const p of raw) {
    if (fs.existsSync(p)) {
      valid.push(p);
    } else {
      logger.warn(`Extension path not found, skipping: ${p}`);
    }
  }
  return valid;
}

export class ChromeManager {
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private wsUrl: string | null = null;
  private sessionId: string | null = null;
  private chromePid: number | null = null;
  private portManager = new PortManager();
  private cleanupRegistered = false;

  async launch(options?: ChromeLaunchOptions): Promise<{ port: number; wsUrl: string }> {
    const port = options?.port ?? await this.portManager.findAvailablePort();
    const chromePath = this.findChromePath();
    const focusOnLaunch = options?.focusOnLaunch ?? (process.env.CDP_MCP_CHROME_FOCUS === 'true');

    // 포트별 별도 프로필 디렉토리 (기존 Chrome과 충돌 방지)
    const userDataDir = options?.userDataDir ?? path.join(CDP_MCP_PROFILES_DIR, `port-${port}`);
    const profileDir = path.join(userDataDir, 'Default');

    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    // 기존 Chrome 프로필에서 복제 (로그인, 쿠키, 익스텐션 유지)
    const sourceProfile = DEFAULT_CHROME_PROFILES[process.platform];
    if (sourceProfile && fs.existsSync(sourceProfile)) {
      copyProfile(sourceProfile, profileDir);
    } else {
      logger.warn(`Source profile not found: ${sourceProfile}`);
    }

    ensureDeveloperMode(profileDir);

    // 익스텐션 경로: 옵션 > 환경변수 > 없음
    const extensionPaths = resolveExtensionPaths(options?.extensionPaths);

    const args = [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(options?.headless ? ['--headless=new'] : []),
      ...(options?.args ?? []),
    ];

    if (extensionPaths.length > 0) {
      args.push(`--load-extension=${extensionPaths.join(',')}`);
      logger.info(`Loading extensions: ${extensionPaths.join(', ')}`);
    }

    logger.info(`Launching Chrome: ${chromePath} with port ${port}`);

    // macOS: 포커스 유지가 필요하면 현재 최전면 앱을 기록
    let previousApp: string | null = null;
    if (!focusOnLaunch && process.platform === 'darwin') {
      try {
        previousApp = execSync(
          'osascript -e \'tell application "System Events" to get name of first application process whose frontmost is true\'',
          { encoding: 'utf-8' },
        ).trim();
        logger.debug(`Current frontmost app: ${previousApp}`);
      } catch {
        logger.debug('Failed to get frontmost app');
      }
    }

    this.process = spawn(chromePath, args, {
      stdio: 'ignore',
      detached: true,
    });

    // Chrome이 MCP 재시작에도 살아남도록 unref
    this.process.unref();
    this.chromePid = this.process.pid ?? null;

    this.process.on('exit', (code) => {
      logger.info(`Chrome exited with code ${code}`);
      this.process = null;
    });

    this.port = port;

    // Wait for Chrome to start and get the WebSocket URL
    const wsUrl = await this.waitForDebugEndpoint(port);
    this.wsUrl = wsUrl;

    // macOS: Chrome이 뜬 뒤 원래 앱으로 포커스 복귀
    if (previousApp) {
      try {
        execSync(
          `osascript -e 'tell application "${previousApp}" to activate'`,
          { stdio: 'ignore' },
        );
        logger.debug(`Focus restored to ${previousApp}`);
      } catch {
        logger.debug(`Failed to restore focus to ${previousApp}`);
      }
    }

    // Acquire lock after successful launch (chromePid 포함)
    this.sessionId = `cdp-mcp_${port}_${Date.now()}`;
    acquireLock(port, this.sessionId, `cdp-mcp-${port}`, this.chromePid ?? undefined);

    this.registerCleanupHandlers();

    return { port, wsUrl };
  }

  async connect(port: number = 9222): Promise<string> {
    const url = `http://127.0.0.1:${port}/json/version`;
    logger.info(`Connecting to Chrome at ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new CdpConnectionError(`Chrome debug endpoint returned ${response.status}`);
      }
      const data = await response.json() as { webSocketDebuggerUrl: string; Browser?: string };
      this.port = port;
      this.wsUrl = data.webSocketDebuggerUrl;

      // Acquire or update lock on successful connect
      if (isMyLock(port)) {
        // 내 lock — mcpPid 갱신, 기존 chromePid 보존
        const existing = readLock(port);
        this.sessionId = existing?.sessionId ?? `cdp-mcp_${port}_${Date.now()}`;
        this.chromePid = existing?.chromePid ?? null;
        acquireLock(port, this.sessionId, existing?.sessionName ?? `cdp-mcp-${port}`, this.chromePid ?? undefined);
      } else {
        // 새 lock 획득
        this.sessionId = `cdp-mcp_${port}_${Date.now()}`;
        acquireLock(port, this.sessionId, `cdp-mcp-${port}`);
      }

      this.registerCleanupHandlers();

      logger.info(`Connected to Chrome (${data.Browser ?? 'unknown version'})`);
      return data.webSocketDebuggerUrl;
    } catch (err) {
      if (err instanceof CdpConnectionError) throw err;
      throw new CdpConnectionError(
        `Failed to connect to Chrome at port ${port}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Shared mode: 기존 Chrome에 연결만 (lock 없음, lifecycle 관리 안 함).
   * subagent가 부모의 Chrome 세션을 공유할 때 사용.
   */
  async connectShared(port: number): Promise<string> {
    const url = `http://127.0.0.1:${port}/json/version`;
    logger.info(`Connecting to Chrome in shared mode at ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new CdpConnectionError(`Chrome debug endpoint returned ${response.status}`);
      }
      const data = await response.json() as { webSocketDebuggerUrl: string; Browser?: string };
      this.port = port;
      this.wsUrl = data.webSocketDebuggerUrl;
      // shared mode: lock 획득 안 함, cleanup handler 등록 안 함
      logger.info(`Connected to Chrome in shared mode (${data.Browser ?? 'unknown version'})`);
      return data.webSocketDebuggerUrl;
    } catch (err) {
      if (err instanceof CdpConnectionError) throw err;
      throw new CdpConnectionError(
        `Failed to connect to Chrome (shared) at port ${port}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async status(): Promise<{ connected: boolean; port?: number; version?: string }> {
    if (!this.port) {
      return { connected: false };
    }

    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
      if (!response.ok) {
        return { connected: false, port: this.port };
      }
      const data = await response.json() as { Browser?: string };
      return {
        connected: true,
        port: this.port,
        version: data.Browser,
      };
    } catch {
      return { connected: false, port: this.port };
    }
  }

  async close(): Promise<void> {
    // Release lock before closing
    if (this.port && this.sessionId) {
      releaseLock(this.port, this.sessionId);
    }

    // Chrome 프로세스는 종료하지 않음 — lock만 해제하고 연결만 끊음
    // Chrome은 사용자가 직접 관리하거나, 다음 세션에서 재활용
    if (this.process) {
      this.process.unref();
      this.process = null;
    }
    this.port = null;
    this.wsUrl = null;
    this.sessionId = null;
    this.chromePid = null;
    logger.info('Chrome manager closed');
  }

  getPort(): number | null {
    return this.port;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private findChromePath(): string {
    const platform = process.platform;
    const paths = CHROME_PATHS[platform] ?? [];

    if (paths.length === 0) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    return paths[0];
  }

  private async waitForDebugEndpoint(port: number, maxRetries = 10): Promise<string> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.connect(port);
      } catch {
        await sleep(500);
      }
    }
    throw new CdpConnectionError(`Chrome did not start within ${maxRetries * 500}ms`);
  }

  /**
   * 해당 포트의 프로필을 삭제하고 현재 Chrome에서 다시 복제.
   * Chrome이 해당 프로필을 사용 중이면 안 됨 — 먼저 disconnect 필요.
   */
  refreshProfile(port: number): { deleted: boolean; copied: boolean } {
    return refreshProfile(port);
  }

  private registerCleanupHandlers(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    // MCP 종료 시: lock만 해제, Chrome은 살려둠 (MCP 재시작 대응)
    // Chrome은 ownerPid(Claude Code)가 죽을 때 stale lock 정리로 종료됨
    const cleanup = () => {
      if (this.port && this.sessionId) {
        releaseLock(this.port, this.sessionId);
      }
    };

    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  }
}
