import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CdpConnectionError, createLogger, sleep } from '@cdp-mcp/shared';
import { CdpClient } from '../cdp/cdp-client.js';

const logger = createLogger('shared-chrome');

/**
 * 모든 cdp-mcp 서버(= 모든 에이전트)가 같이 쓰는 크롬 하나.
 *
 * - 창 없는 모드로 띄운다. 맥에서 배경 전용 앱이라 화면 앞으로 오지 않는다.
 * - 켤 때마다 평소 크롬 프로필에서 로그인·비밀번호·인증서 목록만 새로 복사한다.
 * - 에이전트는 lease 파일로 자기가 쓰고 있음을 알리고, 마지막 에이전트가 나가면 크롬을 끈다.
 *   그래서 다음에 켤 때 저장 비밀번호까지 최신으로 복사된다.
 */

const HOME = os.homedir();
export const SHARED_PORT = parseInt(process.env.CDP_MCP_PORT ?? '9227', 10);
const ROOT = process.env.CDP_MCP_HOME ?? path.join(HOME, '.cdp-mcp');
const DATA_DIR = path.join(ROOT, 'chrome-profiles', 'shared');
const LEASE_DIR = path.join(ROOT, 'leases');
const LOCK_DIR = path.join(ROOT, 'shared.lock');
const BASELINE_FILE = path.join(ROOT, 'cookie-baseline.json');
const SYNC_STAMP = path.join(ROOT, 'cookie-sync-stamp');
const SOURCE_PROFILE = process.env.CDP_MCP_SOURCE_PROFILE
  ?? path.join(HOME, 'Library/Application Support/Google/Chrome/Default');
const CHROME_APP = process.env.CDP_MCP_CHROME_APP ?? '/Applications/Google Chrome.app';
const CHROME_BIN = path.join(CHROME_APP, 'Contents/MacOS/Google Chrome');
const HEADED = process.env.CDP_MCP_HEADED === '1';
const COOKIE_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** 로그인 유지(Cookies), 저장 비밀번호(Login Data), 공동인증서 목록(Local Storage), 사이트 권한(Preferences) */
const PROFILE_ITEMS = ['Preferences', 'Secure Preferences', 'Cookies', 'Login Data', 'Local Storage'];
const EXTENSION_ITEMS = ['Extensions', 'Local Extension Settings', 'Extension State'];

export interface Lease {
  pid: number;
  windowId?: number;
  startedAt: number;
}

interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  session?: boolean;
  [k: string]: unknown;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function isChromeUp(port: number = SHARED_PORT): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** mkdir 은 원자적이라 여러 서버 프로세스 사이의 잠금으로 쓴다. 주인이 죽었거나 60초 넘게 잡혀 있으면 풀어 준다. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const owner = path.join(LOCK_DIR, 'pid');
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(owner, String(process.pid));
      break;
    } catch {
      try {
        const holder = parseInt(fs.readFileSync(owner, 'utf8'), 10);
        const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
        if (!isAlive(holder) || age > 60_000) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        // 잠금을 막 만든 직후라 pid 파일이 아직 없을 수 있다
      }
      if (i > 600) throw new CdpConnectionError('공유 크롬 잠금을 60초 안에 얻지 못했습니다');
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

function leasePath(pid: number): string {
  return path.join(LEASE_DIR, `${pid}.json`);
}

export function writeLease(lease: Lease): void {
  fs.mkdirSync(LEASE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(leasePath(lease.pid), JSON.stringify(lease));
}

function readLeases(): Lease[] {
  if (!fs.existsSync(LEASE_DIR)) return [];
  const out: Lease[] = [];
  for (const f of fs.readdirSync(LEASE_DIR)) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(LEASE_DIR, f), 'utf8')) as Lease);
    } catch {
      fs.rmSync(path.join(LEASE_DIR, f), { force: true });
    }
  }
  return out;
}

/** 살아 있는 에이전트만 남기고, 죽은 에이전트의 lease 는 지우면서 돌려준다(창 정리용). */
export function sweepLeases(): { live: Lease[]; dead: Lease[] } {
  const live: Lease[] = [];
  const dead: Lease[] = [];
  for (const l of readLeases()) {
    if (isAlive(l.pid)) live.push(l);
    else {
      dead.push(l);
      fs.rmSync(leasePath(l.pid), { force: true });
    }
  }
  return { live, dead };
}

function chromeMajorVersion(): string {
  try {
    const plist = fs.readFileSync(path.join(CHROME_APP, 'Contents/Info.plist'), 'utf8');
    const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./);
    if (m) return m[1];
  } catch {
    // 아래 기본값
  }
  return '140';
}

/** 창 없는 크롬은 UA 에 HeadlessChrome 이 들어가 일부 사이트가 막는다. 평소 크롬과 같은 UA 로 띄운다. */
function normalUserAgent(): string {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajorVersion()}.0.0.0 Safari/537.36`;
}

function copyItems(destProfile: string, items: string[]): void {
  fs.mkdirSync(destProfile, { recursive: true, mode: 0o700 });
  for (const item of items) {
    const src = path.join(SOURCE_PROFILE, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(destProfile, item), { recursive: true });
  }
}

/** 평소 크롬 프로필에서 필요한 것만 새로 복사한다. 크롬 앱은 복사하지 않는다. */
export function copyProfile(dataDir: string = DATA_DIR): void {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const items = process.env.CDP_MCP_COPY_EXTENSIONS === '1' ? [...PROFILE_ITEMS, ...EXTENSION_ITEMS] : PROFILE_ITEMS;
  copyItems(path.join(dataDir, 'Default'), items);
  logger.info(`Profile copied (${items.length} items) → ${dataDir}`);
}

function chromeArgs(port: number, dataDir: string): string[] {
  return [
    ...(HEADED ? [] : ['--headless=new']),
    `--user-data-dir=${dataDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
    `--user-agent=${normalUserAgent()}`,
    ...(process.env.CDP_MCP_COPY_EXTENSIONS === '1' ? ['--enable-unsafe-extension-debugging'] : []),
    'about:blank',
  ];
}

function launchChrome(port: number, dataDir: string): void {
  const args = chromeArgs(port, dataDir);
  if (HEADED) {
    // 창 있는 모드는 예외용. 그래도 포커스를 뺏지 않게 open -g 로 뒤에 띄운다.
    spawnSync('open', ['-g', '-n', '-a', CHROME_APP, '--args', ...args], { stdio: 'ignore' });
    return;
  }
  const child = spawn(CHROME_BIN, args, { stdio: 'ignore', detached: true });
  child.unref();
}

async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await isChromeUp(port)) return;
    await sleep(150);
  }
  throw new CdpConnectionError(`크롬이 포트 ${port} 에서 15초 안에 뜨지 않았습니다`);
}

async function browserClient(port: number): Promise<CdpClient> {
  const client = new CdpClient(await CdpClient.getBrowserWsUrl(port));
  await client.connect();
  return client;
}

/** CHIPS 쿠키는 이름·도메인·경로가 같아도 partitionKey 로 갈린다. */
function cookieKey(c: RawCookie): string {
  return `${c.domain}\t${c.path}\t${c.name}\t${c.partitionKey ? JSON.stringify(c.partitionKey) : ''}`;
}

function hash(v: string): string {
  return createHash('sha256').update(v).digest('hex').slice(0, 16);
}

/** 쿠키 값 자체는 남기지 않고 해시만 기준선으로 둔다. */
function saveBaseline(cookies: RawCookie[]): void {
  const map: Record<string, string> = {};
  for (const c of cookies) map[cookieKey(c)] = hash(c.value);
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(map), { mode: 0o600 });
  fs.writeFileSync(SYNC_STAMP, String(Date.now()), { mode: 0o600 });
}

function loadBaseline(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function readAllCookies(port: number): Promise<RawCookie[]> {
  const c = await browserClient(port);
  try {
    const { cookies } = await c.send<{ cookies: RawCookie[] }>('Storage.getCookies', {});
    return cookies;
  } finally {
    await c.close();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** 평소 크롬의 현재 쿠키를 읽는다. 쿠키는 크롬만 복호화할 수 있어서, 복사본으로 창 없는 크롬을 잠깐 띄워 읽는다. */
async function readSourceCookies(): Promise<RawCookie[]> {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'cookie-read-'));
  fs.chmodSync(tmp, 0o700);
  const port = await freePort();
  copyItems(path.join(tmp, 'Default'), ['Cookies']);
  const child = spawn(CHROME_BIN, ['--headless=new', `--user-data-dir=${tmp}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', detached: true });
  child.unref();
  try {
    await waitUp(port);
    return await readAllCookies(port);
  } finally {
    try { process.kill(child.pid!, 'SIGTERM'); } catch { /* 이미 종료 */ }
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface CookieSyncResult {
  skipped?: string;
  sourceCookies?: number;
  imported?: number;
  failed?: number;
}

/**
 * 평소 크롬에서 «바뀐 것만» 공유 크롬으로 가져온다.
 * 기준선(지난번 가져온 값의 해시)과 다른 쿠키만 넣으므로, 에이전트가 공유 크롬에서 새로 로그인한 세션을
 * 평소 크롬의 옛 쿠키로 덮어쓰지 않는다. 저장 비밀번호는 실행 중에 넣을 수 없어 다음 실행 때 갱신된다.
 */
export async function syncCookies(opts: { force?: boolean } = {}): Promise<CookieSyncResult> {
  return withLock(async () => {
    if (!(await isChromeUp())) return { skipped: '공유 크롬이 꺼져 있음' };
    const last = fs.existsSync(SYNC_STAMP) ? parseInt(fs.readFileSync(SYNC_STAMP, 'utf8'), 10) : 0;
    const srcMtime = fs.statSync(path.join(SOURCE_PROFILE, 'Cookies')).mtimeMs;
    if (!opts.force) {
      if (srcMtime <= last) return { skipped: '평소 크롬 쿠키가 바뀌지 않음' };
      if (Date.now() - last < COOKIE_SYNC_MIN_INTERVAL_MS) return { skipped: '최근에 가져옴' };
    }
    const source = await readSourceCookies();
    const baseline = loadBaseline();
    const changed = source.filter(c => baseline[cookieKey(c)] !== hash(c.value)).map(({ size, session, ...rest }) => {
      const k: RawCookie = { ...rest } as RawCookie;
      if (!(typeof k.expires === 'number' && k.expires > 0)) delete k.expires;
      return k;
    });
    const client = await browserClient(SHARED_PORT);
    let imported = 0;
    let failed = 0;
    try {
      for (let i = 0; i < changed.length; i += 200) {
        const chunk = changed.slice(i, i + 200);
        try {
          await client.send('Storage.setCookies', { cookies: chunk });
          imported += chunk.length;
        } catch {
          for (const one of chunk) {
            try {
              await client.send('Storage.setCookies', { cookies: [one] });
              imported++;
            } catch {
              failed++;
            }
          }
        }
      }
    } finally {
      await client.close();
    }
    saveBaseline(source);
    logger.info(`Cookie sync: ${imported} imported, ${failed} failed of ${source.length}`);
    return { sourceCookies: source.length, imported, failed };
  });
}

/** 이 서버가 공유 크롬을 쓰기 시작한다. 꺼져 있으면 프로필을 새로 복사해 띄운다. */
export async function acquireSharedChrome(): Promise<{ port: number; launched: boolean }> {
  return withLock(async () => {
    writeLease({ pid: process.pid, startedAt: Date.now() });
    if (await isChromeUp()) return { port: SHARED_PORT, launched: false };
    copyProfile();
    launchChrome(SHARED_PORT, DATA_DIR);
    await waitUp(SHARED_PORT);
    try {
      saveBaseline(await readAllCookies(SHARED_PORT));
    } catch (err) {
      logger.warn(`Cookie baseline failed: ${err}`);
    }
    logger.info(`Shared Chrome launched on ${SHARED_PORT}`);
    return { port: SHARED_PORT, launched: true };
  });
}

/** 이 서버가 공유 크롬 사용을 끝낸다. 남은 에이전트가 없으면 크롬을 끈다. */
export async function releaseSharedChrome(): Promise<{ closedChrome: boolean }> {
  fs.rmSync(leasePath(process.pid), { force: true });
  return withLock(async () => {
    const { live } = sweepLeases();
    if (live.length > 0 || !(await isChromeUp())) return { closedChrome: false };
    const c = await browserClient(SHARED_PORT);
    try {
      await c.send('Browser.close', {});
    } catch {
      // 닫히면서 연결이 끊기는 것은 정상
    }
    await c.close().catch(() => {});
    for (let i = 0; i < 50 && (await isChromeUp()); i++) await sleep(100);
    // 복사본에는 쿠키·저장 비밀번호가 들어 있으므로 크롬이 꺼지면 바로 지운다. 다음 실행 때 새로 복사한다.
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(BASELINE_FILE, { force: true });
    logger.info('Last agent left, shared Chrome closed and profile copy removed');
    return { closedChrome: true };
  });
}

/** 다른 에이전트가 없을 때만 크롬을 다시 켠다(저장 비밀번호까지 최신으로 다시 복사). */
export async function restartSharedChrome(): Promise<{ restarted: boolean; reason?: string; otherAgents?: number }> {
  return withLock(async () => {
    const others = sweepLeases().live.filter(l => l.pid !== process.pid);
    if (others.length > 0) return { restarted: false, reason: '다른 에이전트가 쓰는 중', otherAgents: others.length };
    if (await isChromeUp()) {
      const c = await browserClient(SHARED_PORT);
      try { await c.send('Browser.close', {}); } catch { /* 정상 */ }
      await c.close().catch(() => {});
      for (let i = 0; i < 50 && (await isChromeUp()); i++) await sleep(100);
    }
    copyProfile();
    launchChrome(SHARED_PORT, DATA_DIR);
    await waitUp(SHARED_PORT);
    saveBaseline(await readAllCookies(SHARED_PORT));
    return { restarted: true };
  });
}

export const sharedChromePaths = { ROOT, DATA_DIR, LEASE_DIR, SOURCE_PROFILE, CHROME_BIN };
