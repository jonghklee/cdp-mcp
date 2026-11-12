#!/usr/bin/env node
// 공유 크롬 종단 시험: MCP 서버 2개(= 에이전트 2명)를 실제로 띄워 창 분리·화면 미노출·종료 동작을 확인한다.
// 실제 평소 크롬 프로필을 복사해 쓰므로, 시험 전용 폴더(CDP_MCP_HOME)와 포트를 쓰고 끝나면 지운다.
//   node scripts/e2e-shared-chrome.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '../packages/core/dist/server.js');
const PORT = Number(process.env.E2E_PORT ?? 9361);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-mcp-e2e-'));
fs.chmodSync(HOME, 0o700);
const DATA_DIR = path.join(HOME, 'chrome-profiles', 'shared');
const DL = path.join(HOME, 'downloads');
const env = { ...process.env, CDP_MCP_PORT: String(PORT), CDP_MCP_HOME: HOME, CDP_MCP_DOWNLOAD_DIR: DL };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

class Agent {
  constructor(tag) {
    this.tag = tag;
    this.p = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.id = 0;
    this.waiters = new Map();
    this.p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        try { const j = JSON.parse(line); this.waiters.get(j.id)?.(j); } catch { /* 로그 줄 */ }
      }
    });
    this.p.stderr.on('data', () => {});
  }
  rpc(method, params) {
    const id = ++this.id;
    this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.tag} ${method} timeout`)), 90_000);
      this.waiters.set(id, (j) => { clearTimeout(t); res(j); });
    });
  }
  async init() {
    await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-' + this.tag, version: '0' } });
    this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async tool(name, args = {}) {
    const r = await this.rpc('tools/call', { name, arguments: args });
    const text = (r.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.error || r.result?.isError) throw new Error(`${this.tag} ${name}: ${text || JSON.stringify(r.error)}`);
    try { return JSON.parse(text); } catch { return text; }
  }
  stop() { this.p.stdin.end(); return new Promise((r) => this.p.once('exit', r)); }
}

const chromeMainPids = () => {
  try {
    return execSync(`ps ax -o pid=,command= | grep -F -- "--user-data-dir=${DATA_DIR}" | grep -v grep | grep -v -- "--type="`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map((l) => Number(l.trim().split(/\s+/)[0]));
  } catch { return []; }
};
const chromeRam = () => {
  try {
    const out = execSync(`ps ax -o rss=,command= | grep -F -- "--user-data-dir=${DATA_DIR}" | grep -v grep`, { encoding: 'utf8' }).trim().split('\n');
    return { processes: out.length, rssMB: Math.round(out.reduce((s, l) => s + Number(l.trim().split(/\s+/)[0]), 0) / 1024) };
  } catch { return { processes: 0, rssMB: 0 }; }
};
const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; } };

// 맨 앞 앱을 0.1초마다 기록한다(시험 크롬이 한 번이라도 맨 앞에 오면 실패).
const FRONT_LOG = path.join(HOME, 'front.log');
const seenChromePids = new Set();
const sampler = spawn('/bin/zsh', ['-c', `while true; do lsappinfo info -only pid "$(lsappinfo front)" | tr -dc '0-9'; echo; sleep 0.1; done > '${FRONT_LOG}'`], { stdio: 'ignore' });

const A = new Agent('A');
const B = new Agent('B');
try {
  await Promise.all([A.init(), B.init()]);

  const FORM = 'data:text/html,<input id=q><button id=b onclick="document.title=q.value">go</button>';
  const [ta, tb] = await Promise.all([
    A.tool('cdp_create_tab', { url: 'https://example.com/?agent=A' }),
    B.tool('cdp_create_tab', { url: 'https://example.com/?agent=B' }),
  ]);
  check('새 탭은 다 뜬 뒤에 돌려준다', ta.tab.title === 'Example Domain', `title=${ta.tab.title}`);
  const aw = await A.tool('cdp_evaluate', { context: 'page', code: 'await new Promise(r => setTimeout(() => r(7), 50))' });
  check('맨 앞 await 가 된다', JSON.stringify(aw).includes('7'), JSON.stringify(aw).slice(0, 60));
  chromeMainPids().forEach((p) => seenChromePids.add(p));
  check('크롬은 하나만 떴다', chromeMainPids().length === 1, `main pids=${chromeMainPids().length}`);

  const la = await A.tool('cdp_list_tabs');
  const lb = await B.tool('cdp_list_tabs');
  check('A 는 자기 탭만 본다', la.tabs.length === 1 && la.tabs[0].id === ta.tab.id && la.tabs[0].url.includes('agent=A'), JSON.stringify(la.tabs.map((t) => t.url)));
  check('B 는 자기 탭만 본다', lb.tabs.length === 1 && lb.tabs[0].id === tb.tab.id && lb.tabs[0].url.includes('agent=B'), JSON.stringify(lb.tabs.map((t) => t.url)));

  // 실제 창 번호가 다른지 브라우저에 직접 물어본다
  const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let mid = 0; const pend = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); pend.get(j.id)?.(j); };
  const bsend = (method, params) => new Promise((r) => { const i = ++mid; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const winA = (await bsend('Browser.getWindowForTarget', { targetId: ta.tab.id })).result.windowId;
  const winB = (await bsend('Browser.getWindowForTarget', { targetId: tb.tab.id })).result.windowId;
  check('A 와 B 는 서로 다른 창', winA !== winB, `A=${winA} B=${winB}`);

  // 두 에이전트가 동시에 이동·입력·클릭·캡처
  await Promise.all([A.tool('cdp_navigate', { url: FORM }), B.tool('cdp_navigate', { url: FORM })]);
  await Promise.all([A.tool('cdp_type', { selector: '#q', text: 'alpha' }), B.tool('cdp_type', { selector: '#q', text: 'bravo' })]);
  await Promise.all([A.tool('cdp_click', { selector: '#b' }), B.tool('cdp_click', { selector: '#b' })]);
  const [ea, eb] = await Promise.all([A.tool('cdp_evaluate', { context: 'page', code: 'document.title' }), B.tool('cdp_evaluate', { context: 'page', code: 'document.title' })]);
  const sa = JSON.stringify(ea); const sb = JSON.stringify(eb);
  check('동시 입력이 서로 섞이지 않는다', sa.includes('alpha') && !sa.includes('bravo') && sb.includes('bravo') && !sb.includes('alpha'), `A=${sa.slice(0, 60)} B=${sb.slice(0, 60)}`);
  const shot = await A.rpc('tools/call', { name: 'cdp_screenshot', arguments: { format: 'jpeg', quality: 40 } });
  const img = (shot.result?.content ?? []).find((c) => c.type === 'image');
  check('창 없이도 캡처된다', !!img && img.data.length > 1000, img ? `${Math.round(img.data.length * 0.75 / 1024)}KB` : JSON.stringify(shot).slice(0, 120));

  // A 가 연 팝업은 A 것
  await A.tool('cdp_evaluate', { context: 'page', code: "window.open('https://example.com/?popup=A','p','width=500,height=400'); true" });
  await sleep(2500);
  const la2 = await A.tool('cdp_list_tabs');
  const lb2 = await B.tool('cdp_list_tabs');
  check('A 가 연 팝업은 A 목록에만', la2.tabs.some((t) => t.url.includes('popup=A')) && !lb2.tabs.some((t) => t.url.includes('popup=A')), `A=${la2.tabs.length} B=${lb2.tabs.length}`);

  // 남의 탭은 고를 수 없다
  let blocked = false;
  try { await B.tool('cdp_switch_tab', { tabId: ta.tab.id }); } catch { blocked = true; }
  check('B 는 A 의 탭으로 바꿀 수 없다', blocked);

  const pdfPath = path.join(HOME, 'form.pdf');
  const pdf = await A.tool('cdp_save_pdf', { path: pdfPath });
  check('PDF 로 저장된다', fs.existsSync(pdfPath) && fs.readFileSync(pdfPath).subarray(0, 4).toString() === '%PDF', `${pdf.bytes}B`);
  await A.tool('cdp_navigate', { url: 'data:text/html,<a id=d download="hello.txt" href="data:text/plain,hi">d</a>' });
  await A.tool('cdp_click', { selector: '#d' });
  for (let i = 0; i < 30 && !fs.existsSync(path.join(DL, 'hello.txt')); i++) await sleep(200);
  check('내려받기가 지정 폴더에 저장된다', fs.existsSync(path.join(DL, 'hello.txt')));

  const show = await A.tool('cdp_show');
  check('보여주기 주소만 돌려준다', typeof show.viewUrl === 'string' && show.viewUrl.includes(`/devtools/page/${show.tab.id}`));

  const sync = await A.tool('cdp_sync_profile');
  check('로그인 가져오기가 돈다', typeof sync.sync?.sourceCookies === 'number', JSON.stringify(sync.sync));

  // 저장 비밀번호 자동 입력(로그인 버튼은 누르지 않는다)
  await A.tool('cdp_navigate', { url: 'https://auth.dgist.ac.kr/login/' });
  await sleep(3000);
  await A.tool('cdp_click', { selector: 'body' }).catch(() => {});
  await sleep(1500);
  const filled = await A.tool('cdp_evaluate', { context: 'page', code: "[...document.querySelectorAll('input[type=password]')].some(e => e.value.length > 0)" });
  check('저장 비밀번호가 채워진다(DGIST)', JSON.stringify(filled).includes('true'), JSON.stringify(filled).slice(0, 80));

  const ram = chromeRam();
  console.log(`RAM  에이전트 2명, 크롬 1개: 프로세스 ${ram.processes}개, RSS 합 ${ram.rssMB}MB`);
  ws.close();

  // A 가 끝나도 B 는 계속, A 의 탭은 사라진다
  await A.stop();
  await sleep(1500);
  const lb3 = await B.tool('cdp_list_tabs');
  const all = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  check('A 가 끝나면 A 의 탭이 닫힌다', !all.some((t) => /agent=A|popup=A|q=alpha/.test(t.url)) && !all.some((t) => t.title === 'alpha'), `남은 페이지 ${all.filter((t) => t.type === 'page').length}`);
  check('A 가 끝나도 B 는 계속 된다', lb3.tabs.length >= 1 && (await up()));

  await B.stop();
  for (let i = 0; i < 40 && (await up()); i++) await sleep(150);
  check('마지막 에이전트가 끝나면 크롬이 꺼진다', !(await up()) && chromeMainPids().length === 0);
  check('크롬이 꺼지면 프로필 복사본이 지워진다', !fs.existsSync(DATA_DIR));
} catch (e) {
  check('시험 중 예외 없음', false, String(e).slice(0, 300));
} finally {
  sampler.kill();
  chromeMainPids().forEach((p) => seenChromePids.add(p));
  const frontLog = fs.existsSync(FRONT_LOG) ? fs.readFileSync(FRONT_LOG, 'utf8').split('\n').filter(Boolean) : [];
  const fronted = frontLog.filter((p) => seenChromePids.has(Number(p))).length;
  check('시험 크롬이 화면 맨 앞에 온 적 없음', fronted === 0, `기록 ${frontLog.length}번 중 ${fronted}번`);
  for (const a of [A, B]) if (a.p.exitCode === null) a.p.kill();
  for (const pid of chromeMainPids()) { try { process.kill(pid, 'SIGTERM'); } catch { /* 이미 종료 */ } }
  await sleep(800);
  fs.rmSync(HOME, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 통과`);
  process.exit(failed ? 1 : 0);
}
