#!/usr/bin/env bun
/**
 * browser.ts — nav-lookup + CDP WebSocket 통합 브라우저 자동화 CLI.
 *
 * Chrome (browser WS) 과 Electron 앱(Notion 등, HTTP /json) 모두 지원.
 *   --port 9225  → HTTP 기반 (Notion 등 Electron)
 *   기본          → Chrome DevToolsActivePort 기반
 *
 * Usage:
 *   bun scripts/browser.ts navigate "수납내역"
 *   bun scripts/browser.ts --port 9225 list
 *   bun scripts/browser.ts --port 9225 text --match "Bug"
 *   bun scripts/browser.ts screenshot --output /tmp/shot.png
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// ─── Args parsing ───────────────────────────────────────────

const args = process.argv.slice(2);
let customPort: number | undefined;
let matchKeyword: string | undefined;
let limitChars: number | undefined;

// extract --port, --match, --limit, --output, --nav-index, --answers from args
let navIndexOverride: string | undefined;
let answersParam: string | undefined;
const cleanArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    customPort = Number(args[++i]);
  } else if ((args[i] === '--match' || args[i] === '-m') && args[i + 1]) {
    matchKeyword = args[++i];
  } else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
    limitChars = Number(args[++i]);
  } else if (args[i] === '--nav-index' && args[i + 1]) {
    navIndexOverride = args[++i];
  } else if (args[i] === '--answers' && args[i + 1]) {
    answersParam = args[++i];
  } else {
    cleanArgs.push(args[i]);
  }
}

const [command, ...rest] = cleanArgs;

const ROOT = resolve(import.meta.dirname ?? __dirname, '..');
const NAV_INDEX_PATH = navIndexOverride
  ?? process.env.NAV_INDEX_PATH
  ?? resolve(ROOT, 'docs/ui-nav-index.yaml');

// ─── CDP Connection ─────────────────────────────────────────

interface PageInfo {
  wsUrl: string;
  title: string;
  url: string;
  id?: string;
}

let _ws: WebSocket | null = null;
let _msgId = 0;

/** HTTP 기반 (Notion/Electron): /json 으로 페이지 목록 + 개별 WS URL */
async function getPagesViaHttp(port: number): Promise<PageInfo[]> {
  const resp = await fetch(`http://localhost:${port}/json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from CDP port ${port}`);
  const targets = (await resp.json()) as any[];
  return targets
    .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    .map((t) => ({
      wsUrl: t.webSocketDebuggerUrl,
      title: t.title ?? '',
      url: t.url ?? '',
      id: t.id,
    }));
}

/** Chrome: HTTP /json 으로 페이지 목록 (--user-data-dir + --remote-debugging-port 필요) */
async function getPagesViaChrome(): Promise<PageInfo[]> {
  const port = 9222;
  return getPagesViaHttp(port);
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WS timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`WS 연결 실패: ${url}`)); };
  });
}

function wsSend(ws: WebSocket, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++_msgId;
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    const handler = (e: MessageEvent) => {
      const data = JSON.parse(String(e.data));
      if (data.id === id) {
        ws.removeEventListener('message', handler);
        clearTimeout(timer);
        data.error ? reject(new Error(data.error.message)) : resolve(data.result);
      }
    };
    ws.addEventListener('message', handler);
    const msg: any = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
}

/** 페이지에 연결된 WS (HTTP /json 으로 받은 wsUrl 직접 연결) */
async function connectToPage(page: PageInfo): Promise<{ ws: WebSocket; sessionId?: string }> {
  const ws = await connectWs(page.wsUrl);
  return { ws };
}

function cdp(conn: { ws: WebSocket; sessionId?: string }, method: string, params: Record<string, unknown> = {}) {
  return wsSend(conn.ws, method, params, conn.sessionId);
}

// ─── Page finding ───────────────────────────────────────────

function findPage(pages: PageInfo[], match?: string): PageInfo | undefined {
  if (match) {
    return pages.find(
      (p) =>
        p.title.toLowerCase().includes(match.toLowerCase()) ||
        p.url.toLowerCase().includes(match.toLowerCase()),
    );
  }
  // default: localhost 페이지 (Chrome), 또는 첫 번째 Notion 페이지
  if (customPort) return pages[0];
  return pages.find((p) => p.url.includes('localhost'));
}

async function getAndFindPage(): Promise<{ pages: PageInfo[]; page: PageInfo }> {
  const pages = customPort ? await getPagesViaHttp(customPort) : await getPagesViaChrome();
  const page = findPage(pages, matchKeyword);
  if (!page) {
    console.error(matchKeyword ? `❌ "${matchKeyword}" 매칭 페이지 없음` : '❌ 대상 페이지 없음');
    console.error('열린 페이지:');
    pages.forEach((p, i) => console.error(`  [${i}] ${p.title} - ${p.url}`));
    process.exit(1);
  }
  return { pages, page };
}

// ─── nav-index lookup ───────────────────────────────────────

interface NavBlock {
  name: string;
  content: string;
  url?: string;
  component?: string;
  api?: string;
  selectors?: Record<string, string>;
}

function parseBlocks(raw: string): NavBlock[] {
  const blocks: NavBlock[] = [];
  const lines = raw.split('\n');
  let name = '', contentLines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([^\s#][^:]*):$/);
    if (m) {
      if (name) blocks.push(buildBlock(name, contentLines));
      name = m[1].trim(); contentLines = [];
      continue;
    }
    if (name) contentLines.push(line);
  }
  if (name) blocks.push(buildBlock(name, contentLines));
  return blocks;
}

function buildBlock(name: string, lines: string[]): NavBlock {
  const content = lines.join('\n');
  const selectors: Record<string, string> = {};
  let inSelectors = false;
  for (const line of lines) {
    if (/^\s+selectors:\s*$/.test(line)) { inSelectors = true; continue; }
    if (inSelectors) {
      const sm = line.match(/^\s{4,}(\w+):\s*(.+)/);
      if (sm) { selectors[sm[1]] = sm[2].trim(); continue; }
      if (!/^\s{4}/.test(line)) inSelectors = false;
    }
  }
  return {
    name, content,
    url: content.match(/url:\s*(.+)/)?.[1].trim(),
    component: content.match(/component:\s*(.+)/)?.[1].trim(),
    api: content.match(/api:\s*(.+)/)?.[1].trim(),
    selectors: Object.keys(selectors).length ? selectors : undefined,
  };
}

/** nav-index content에서 api 섹션의 URL prefix를 추출 */
function extractKnownApiPrefixes(blocks: NavBlock[]): string[] {
  const prefixes: string[] = [];
  for (const block of blocks) {
    let inApi = false;
    for (const line of block.content.split('\n')) {
      if (/^\s+api:\s*$/.test(line)) { inApi = true; continue; }
      if (inApi) {
        // 주석 안의 URL도 포함 (# 확인된 종목별 infos 등)
        const urlMatch = line.match(/(https?:\/\/[^\s"'{}]+)/);
        if (urlMatch) prefixes.push(urlMatch[1].split('?')[0]);
        // api 섹션 종료 감지 (indent 감소)
        if (line.trim() && !/^\s{4}/.test(line) && !/^\s*#/.test(line) && !/^\s+api:/.test(line)) inApi = false;
      }
    }
  }
  return [...new Set(prefixes)];
}

/** navigate 후 페이지가 호출한 API를 감지하여 nav-index에 없는 패턴 보고 */
async function detectStaleNavIndex(conn: { ws: any }, url: string, blocks: NavBlock[]) {
  try {
    const knownPrefixes = extractKnownApiPrefixes(blocks);
    const { result } = await cdp(conn, 'Runtime.evaluate', {
      expression: `JSON.stringify(
        performance.getEntriesByType('resource')
          .filter(r => r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')
          .map(r => r.name)
      )`,
      returnByValue: true,
    });
    const liveUrls: string[] = JSON.parse(result?.value ?? '[]');
    // API 호출만 필터 (정적 리소스 제외)
    const apiUrls = liveUrls.filter(u => u.includes('/api/'));
    // nav-index에 등록된 prefix와 비교
    const newPatterns = apiUrls.filter(u => {
      const uPath = u.split('?')[0];
      return !knownPrefixes.some(known => uPath.startsWith(known));
    });
    // 중복 제거 (경로 prefix 기준)
    const uniqueNew = [...new Set(newPatterns.map(u => u.split('?')[0]))];
    if (uniqueNew.length > 0) {
      console.log(`\nNAV_INDEX_STALE:${url}`);
      console.log(`nav-index에 미등록된 API 엔드포인트 ${uniqueNew.length}건:`);
      uniqueNew.slice(0, 10).forEach(p => console.log(`  - ${p}`));
      if (uniqueNew.length > 10) console.log(`  ... 외 ${uniqueNew.length - 10}건`);
    }
  } catch {
    // 감지 실패 시 조용히 무시 — navigate 자체에 영향 없음
  }
}

/** URL이 nav-index의 와일드카드 패턴에 매칭되는지 확인 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return re.test(url);
}

function navLookup(query: string, fullUrl?: string): NavBlock[] {
  try {
    const raw = readFileSync(NAV_INDEX_PATH, 'utf-8');
    const blocks = parseBlocks(raw);
    const q = query.toLowerCase();

    // 1차: fullUrl이 있으면 와일드카드 URL 패턴 매칭 시도
    if (fullUrl) {
      const urlMatched = blocks.filter(b => b.url && urlMatchesPattern(fullUrl, b.url));
      if (urlMatched.length) return urlMatched;
    }

    // 2차: 기존 텍스트 포함 매칭 (키워드 검색)
    return blocks.filter(({ name, content }) => (name + '\n' + content).toLowerCase().includes(q));
  } catch { return []; }
}

function formatNavResult(results: NavBlock[]): string {
  if (!results.length) return '❌ nav-index 매칭 없음.';
  return results.map(({ name, content }) => `## ${name}\n${content.trimEnd()}`).join('\n\n');
}

// ─── nav-index gate ─────────────────────────────────────────

/** 현재 페이지 URL이 nav-index에 등록되어 있는지 확인. 없으면 NAV_INDEX_MISS 출력 후 exit. */
async function requireNavIndex(page: PageInfo): Promise<void> {
  const pageUrl = page.url;
  // localhost 페이지는 게이트 제외 (개발 서버)
  if (pageUrl.includes('localhost')) return;
  // chrome:// 등 브라우저 내부 페이지 제외
  if (!pageUrl.startsWith('http')) return;

  try {
    const raw = readFileSync(NAV_INDEX_PATH, 'utf-8');
    const blocks = parseBlocks(raw);

    // URL 패턴 매칭
    const matched = blocks.some(b => b.url && urlMatchesPattern(pageUrl, b.url));

    // 도메인 포함 매칭 (부분 매칭)
    const domainMatched = !matched && blocks.some(b => {
      if (!b.url) return false;
      const domain = b.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\*/g, '');
      return domain && pageUrl.includes(domain);
    });

    if (matched || domainMatched) return;
  } catch {
    // nav-index 파일 읽기 실패 시 게이트 통과
    return;
  }

  console.error(`❌ nav-index에 등록되지 않은 페이지입니다.`);
  console.error(`NAV_INDEX_MISS:${pageUrl}`);
  console.error(`\n→ 먼저 reviewer로 nav-index에 셀렉터를 등록한 후 extract를 사용하세요.`);
  console.error(`→ text/eval/snapshot 우회는 허용되지 않습니다.`);
  process.exit(2);
}

// ─── commands ───────────────────────────────────────────────

async function cmdNavigate(target: string) {
  const isUrlTarget = /^https?:\/\//.test(target) || target.startsWith('localhost');
  let url: string;

  if (isUrlTarget) {
    const pathPart = target.match(/tab=(\w+)/)?.[1] ?? target.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const results = navLookup(pathPart, target);
    console.log('── nav context ──');
    console.log(formatNavResult(results));
    if (!results.length) console.log(`NAV_INDEX_MISS:${target}`);
    console.log('');
    url = target;
  } else {
    const results = navLookup(target);
    console.log('── nav context ──');
    console.log(formatNavResult(results));
    console.log('');
    if (results.length > 0 && results[0].url) {
      url = `http://localhost:5173${results[0].url}`;
      console.log(`→ URL 패턴: ${url}`);
      console.log('⚠️  placeholder는 실제 값으로 교체 필요\n');
    } else {
      console.error('❌ URL을 결정할 수 없습니다.');
      process.exit(1);
    }
  }

  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);
  await cdp(conn, 'Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`✅ ${url} 로 이동 완료`);

  // nav-index에 미등록된 API 엔드포인트 감지
  if (isUrlTarget) {
    try {
      const raw = readFileSync(NAV_INDEX_PATH, 'utf-8');
      const blocks = parseBlocks(raw);
      await detectStaleNavIndex(conn, url, blocks);
    } catch { /* nav-index 읽기 실패 시 무시 */ }
  }

  conn.ws.close();
}

async function cmdText() {
  const { page } = await getAndFindPage();
  await requireNavIndex(page);
  const conn = await connectToPage(page);

  const { result } = await cdp(conn, 'Runtime.evaluate', {
    expression: 'document.body.innerText',
    returnByValue: true,
  });

  let text = result.value as string;
  if (limitChars && text.length > limitChars) text = text.slice(0, limitChars);
  console.log(text);
  conn.ws.close();
}

async function cmdSnapshot() {
  const { page } = await getAndFindPage();
  await requireNavIndex(page);
  const conn = await connectToPage(page);

  await cdp(conn, 'Accessibility.enable');
  const { nodes } = await cdp(conn, 'Accessibility.getFullAXTree');

  const lines: string[] = [];
  for (const node of nodes) {
    const role = node.role?.value;
    const name = node.name?.value;
    if (!role || role === 'none' || role === 'generic') continue;
    if (name) lines.push(`[${role}] ${name}`);
  }

  console.log(`── snapshot (${page.title}) ──`);
  console.log(lines.slice(0, 200).join('\n'));
  if (lines.length > 200) console.log(`... (${lines.length - 200}개 더)`);
  conn.ws.close();
}

async function cmdScreenshot(outputPath?: string) {
  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);
  const { data } = await cdp(conn, 'Page.captureScreenshot', { format: 'png' });
  const out = outputPath ?? '/tmp/browser-screenshot.png';
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`📸 ${out}`);
  conn.ws.close();
}

/** Input.dispatchMouseEvent로 브라우저 레벨 클릭 (React 18 root delegation 호환)
 *  mouseMoved → mousePressed → mouseReleased 3단계 (Puppeteer 동일 시퀀스) */
async function dispatchClick(conn: { ws: WebSocket; sessionId?: string }, x: number, y: number) {
  await cdp(conn, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp(conn, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp(conn, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function cmdClick(text: string) {
  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);

  // 텍스트로 요소를 찾아 중심 좌표를 반환 (클릭은 하지 않음)
  const { result } = await cdp(conn, 'Runtime.evaluate', {
    expression: `(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim() === ${JSON.stringify(text)}) {
          const el = walker.currentNode.parentElement;
          const rect = el.getBoundingClientRect();
          return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName };
        }
      }
      // fallback: 텍스트 포함 버튼
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes(${JSON.stringify(text)}));
      if (btn) {
        const rect = btn.getBoundingClientRect();
        return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: btn.tagName };
      }
      return { found: false };
    })()`,
    returnByValue: true,
  });

  const val = result.value;
  if (val?.found) {
    await dispatchClick(conn, val.x, val.y);
    console.log(`✅ "${text}" 클릭 (${val.tag} @ ${Math.round(val.x)},${Math.round(val.y)}) [Input.dispatchMouseEvent]`);
  } else {
    console.error(`❌ "${text}" 텍스트를 찾을 수 없습니다.`);
  }
  conn.ws.close();
}

async function cmdClickAt(x: number, y: number) {
  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);
  await dispatchClick(conn, x, y);
  console.log(`✅ 좌표 클릭 (${x}, ${y}) [Input.dispatchMouseEvent]`);
  conn.ws.close();
}

async function cmdHoverAt(x: number, y: number) {
  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);
  await cdp(conn, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  console.log(`✅ 호버 (${x}, ${y}) [Input.dispatchMouseEvent]`);
  conn.ws.close();
}

async function cmdClickSelector(selector: string) {
  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);

  const { result } = await cdp(conn, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      const rect = el.getBoundingClientRect();
      return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName };
    })()`,
    returnByValue: true,
  });

  const val = result.value;
  if (val?.found) {
    await dispatchClick(conn, val.x, val.y);
    console.log(`✅ "${selector}" 클릭 (${val.tag} @ ${Math.round(val.x)},${Math.round(val.y)}) [Input.dispatchMouseEvent]`);
  } else {
    console.error(`❌ "${selector}" 셀렉터를 찾을 수 없습니다.`);
  }
  conn.ws.close();
}

async function cmdEval(expression: string) {
  const { page } = await getAndFindPage();
  await requireNavIndex(page);
  const conn = await connectToPage(page);
  const { result } = await cdp(conn, 'Runtime.evaluate', { expression, returnByValue: true });
  console.log(JSON.stringify(result.value, null, 2));
  conn.ws.close();
}

async function cmdExtract(target?: string) {
  // 1. nav-index에서 셀렉터 찾기
  const query = target ?? matchKeyword ?? '';
  let blocks: NavBlock[] = [];
  try {
    const raw = readFileSync(NAV_INDEX_PATH, 'utf-8');
    blocks = parseBlocks(raw);
  } catch {}

  // URL이나 키워드로 매칭
  const q = query.toLowerCase();
  let matched = blocks.filter(({ name, content }) => (name + '\n' + content).toLowerCase().includes(q));

  // 현재 페이지 URL로도 매칭 시도
  if (!matched.length) {
    const { page } = await getAndFindPage();
    const pageUrl = page.url;
    matched = blocks.filter(b => b.url && pageUrl.includes(b.url.replace(/\*/g, '')));
    if (!matched.length) {
      // URL 패턴 와일드카드 매칭
      matched = blocks.filter(b => {
        if (!b.url) return false;
        const pattern = b.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
        return new RegExp(pattern).test(pageUrl);
      });
    }
  }

  if (!matched.length || !matched[0].selectors) {
    console.error('❌ 셀렉터가 정의된 nav-index 블록을 찾을 수 없습니다.');
    if (matched.length && !matched[0].selectors) {
      console.error(`   "${matched[0].name}" 블록에 selectors가 없습니다.`);
    }
    process.exit(1);
  }

  const block = matched[0];
  const selectors = block.selectors!;

  // 2. 페이지 연결
  const allPages = customPort ? await getPagesViaHttp(customPort) : await getPagesViaChrome();
  let page: PageInfo | undefined;

  // nav-index URL 패턴으로 탭 매칭 (와일드카드 → regex)
  if (block.url) {
    const pattern = new RegExp(
      '^' + block.url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    page = allPages.find(p => pattern.test(p.url));
  }
  // fallback: --match 또는 블록 이름의 도메인 부분
  if (!page) {
    const hint = matchKeyword ?? block.url?.match(/https?:\/\/([^/]+)/)?.[1];
    if (hint) page = allPages.find(p => p.url.toLowerCase().includes(hint.toLowerCase()));
  }

  if (!page) {
    console.error(`❌ 대상 페이지를 찾을 수 없습니다. 먼저 navigate로 페이지를 열어주세요.`);
    process.exit(1);
  }

  const conn = await connectToPage(page);

  // 3. 셀렉터로 데이터 추출
  const selectorEntries = JSON.stringify(Object.entries(selectors));
  const { result } = await cdp(conn, 'Runtime.evaluate', {
    expression: `(() => {
      const entries = ${selectorEntries};
      const result = {};
      const getText = (el) => el.innerText?.trim() || el.textContent?.trim() || el.alt || el.getAttribute?.('alt') || el.src || null;
      for (const [key, selector] of entries) {
        const els = document.querySelectorAll(selector);
        if (els.length === 0) {
          result[key] = null;
        } else if (els.length === 1) {
          result[key] = getText(els[0]);
        } else {
          result[key] = Array.from(els).map(el => getText(el)).filter(Boolean);
        }
      }
      return result;
    })()`,
    returnByValue: true,
  });

  console.log(`── extract: ${block.name} ──`);
  console.log(JSON.stringify(result.value, null, 2));
  conn.ws.close();
}

// ─── action parsing & execution ─────────────────────────────

interface ActionStep {
  type: string;   // click_text, click_selector, select_radios, wait
  value: string;
}

/** nav-index 블록의 content에서 actions 배열과 best_answers 배열을 추출 */
function parseActions(content: string): { actions: ActionStep[]; bestAnswers: string[] } {
  const actions: ActionStep[] = [];
  const bestAnswers: string[] = [];
  let inActions = false;
  let inBestAnswers = false;

  for (const line of content.split('\n')) {
    if (/^\s+actions:\s*$/.test(line)) { inActions = true; inBestAnswers = false; continue; }
    if (/^\s+best_answers:\s*$/.test(line)) { inBestAnswers = true; inActions = false; continue; }

    if (inActions) {
      const m = line.match(/^\s+-\s+(\w+):\s*(.+)/);
      if (m) {
        actions.push({ type: m[1], value: m[2].replace(/^["']|["']$/g, '') });
        continue;
      }
      if (line.trim() && !line.trim().startsWith('#') && !/^\s+-/.test(line)) inActions = false;
    }

    if (inBestAnswers) {
      const m = line.match(/^\s+-\s*"([^"]+)"/);
      if (m) { bestAnswers.push(m[1]); continue; }
      if (line.trim() && !line.trim().startsWith('#') && !/^\s+-/.test(line)) inBestAnswers = false;
    }
  }

  return { actions, bestAnswers };
}

async function cmdAction(blockQuery: string) {
  // 1. nav-index에서 actions가 있는 블록 찾기
  let blocks: NavBlock[] = [];
  try {
    const raw = readFileSync(NAV_INDEX_PATH, 'utf-8');
    blocks = parseBlocks(raw);
  } catch {}

  const q = blockQuery.toLowerCase();
  const matchedBlock = blocks.find(
    (b) => b.content.includes('actions:') && (b.name.toLowerCase().includes(q) || b.content.toLowerCase().includes(q))
  );

  if (!matchedBlock) {
    console.error(`❌ "${blockQuery}" 매칭하는 actions 블록 없음`);
    const withActions = blocks.filter((b) => b.content.includes('actions:'));
    if (withActions.length) {
      console.error('사용 가능한 action 블록:');
      withActions.forEach((b) => console.error(`  - ${b.name}`));
    }
    process.exit(1);
  }

  const { actions, bestAnswers } = parseActions(matchedBlock.content);
  if (!actions.length) {
    console.error(`❌ "${matchedBlock.name}" 블록에 실행할 actions가 없습니다.`);
    process.exit(1);
  }

  // answers 결정: --answers > best_answers
  const answers = answersParam
    ? answersParam.split('|').map((a) => a.trim())
    : bestAnswers.length ? bestAnswers : undefined;

  // 2. 페이지 연결
  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);

  console.log(`── action: ${matchedBlock.name} (${actions.length}단계) ──`);
  if (answers) console.log(`  답변: ${answers.length}개 ${answersParam ? '(커스텀)' : '(best_answers)'}`);

  // 3. 액션 순차 실행
  for (const step of actions) {
    switch (step.type) {
      case 'click_text': {
        const { result } = await cdp(conn, 'Runtime.evaluate', {
          expression: `(() => {
            const text = ${JSON.stringify(step.value)};
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              if (walker.currentNode.textContent.trim() === text) {
                const el = walker.currentNode.parentElement;
                const rect = el.getBoundingClientRect();
                return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              }
            }
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text));
            if (btn) {
              const rect = btn.getBoundingClientRect();
              return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
            return { found: false };
          })()`,
          returnByValue: true,
        });
        if (result.value?.found) {
          await dispatchClick(conn, result.value.x, result.value.y);
          console.log(`  ✅ click_text: "${step.value}"`);
        } else {
          console.log(`  ❌ click_text: "${step.value}" 실패`);
        }
        break;
      }

      case 'click_selector': {
        const { result } = await cdp(conn, 'Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(step.value)});
            if (!el) return { found: false };
            const rect = el.getBoundingClientRect();
            return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()`,
          returnByValue: true,
        });
        if (result.value?.found) {
          await dispatchClick(conn, result.value.x, result.value.y);
          console.log(`  ✅ click_selector: ${step.value}`);
        } else {
          console.log(`  ❌ click_selector: ${step.value} 실패`);
        }
        break;
      }

      case 'select_radios': {
        if (!answers) {
          console.error(`  ❌ select_radios: --answers 파라미터 또는 best_answers가 필요합니다.`);
          break;
        }
        const { result } = await cdp(conn, 'Runtime.evaluate', {
          expression: `(() => {
            const answers = ${JSON.stringify(answers)};
            const radios = [...document.querySelectorAll(${JSON.stringify(step.value)})];
            let clicked = 0;
            answers.forEach(a => {
              const r = radios.find(r => r.textContent?.trim().startsWith(a));
              if (r) { r.click(); clicked++; }
            });
            return { total: answers.length, clicked };
          })()`,
          returnByValue: true,
        });
        const v = result.value;
        console.log(`  ✅ select_radios: ${v.clicked}/${v.total}개 선택`);
        break;
      }

      case 'wait': {
        const ms = parseInt(step.value);
        await new Promise((r) => setTimeout(r, ms));
        console.log(`  ⏱ wait: ${ms}ms`);
        break;
      }

      default:
        console.error(`  ❌ 알 수 없는 액션: ${step.type}`);
    }
  }

  console.log(`\n✅ action 완료`);
  conn.ws.close();
}

async function cmdList() {
  const pages = customPort ? await getPagesViaHttp(customPort) : await getPagesViaChrome();
  pages.forEach((p, i) => console.log(`[${i}] ${p.title} - ${p.url}`));
  if (_ws) _ws.close();
}

/**
 * capture [filter] [--timeout N]
 *
 * 현재 페이지를 리로드하면서 네트워크 요청/응답을 캡처한다.
 * CDP Network 도메인을 활성화하고, 페이지가 로드하면서 호출하는 API 응답을 수집.
 *
 * - filter: URL에 포함된 문자열로 필터 (예: "api", "financial-statement"). 없으면 XHR/Fetch 전부.
 * - --timeout N: 캡처 대기 시간 초 (기본 8초)
 * - 출력: JSON 배열 [{url, status, body}, ...]
 */
async function cmdCapture(filter?: string) {
  const pages = customPort ? await getPagesViaHttp(customPort) : await getPagesViaChrome();
  const page = findPage(pages, matchKeyword);
  if (!page) {
    console.error(matchKeyword ? `❌ "${matchKeyword}" 매칭 페이지 없음` : '❌ 대상 페이지 없음');
    console.error('열린 페이지:');
    pages.forEach((p, i) => console.error(`  [${i}] ${p.title} - ${p.url}`));
    process.exit(1);
  }

  const ws = await connectWs(page.wsUrl);

  // timeout 파싱 (--timeout 는 이미 cleanArgs에서 제거되지 않으므로 rest에서 찾기)
  let timeoutSec = 8;
  const tIdx = rest.indexOf('--timeout');
  if (tIdx >= 0 && rest[tIdx + 1]) timeoutSec = Number(rest[tIdx + 1]) || 8;

  const captured: { url: string; status: number; keys?: string; body: string }[] = [];
  const pendingRequests = new Map<string, string>(); // requestId → url

  return new Promise<void>((resolve) => {
    ws.addEventListener('message', async (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data));

      // Network.enable 완료 → 페이지 리로드
      if (msg.id === 1) {
        wsSend(ws, 'Page.reload');
      }

      // 요청 시작 — URL 기록
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params?.request?.url || '';
        const resourceType = msg.params?.type || '';
        // XHR/Fetch만 (이미지, 스크립트 등 제외)
        if (resourceType === 'XHR' || resourceType === 'Fetch') {
          if (!filter || url.includes(filter)) {
            pendingRequests.set(msg.params.requestId, url);
          }
        }
      }

      // 응답 수신 — 본문 요청
      if (msg.method === 'Network.responseReceived') {
        const requestId = msg.params?.requestId;
        const url = pendingRequests.get(requestId);
        if (url) {
          const status = msg.params?.response?.status || 0;
          try {
            const bodyResult = await wsSend(ws, 'Network.getResponseBody', { requestId });
            const body = bodyResult?.body || '';
            // URL에서 keys 파라미터 추출 (Valley 등 차트 API용)
            let keys: string | undefined;
            try { keys = new URL(url).searchParams.get('keys') || undefined; } catch {}
            captured.push({ url, status, keys, body });
          } catch { /* 본문 없는 응답 무시 */ }
          pendingRequests.delete(requestId);
        }
      }
    });

    // Network 활성화 (id=1로 보내서 응답 시 리로드 트리거)
    ws.send(JSON.stringify({ id: 1, method: 'Network.enable', params: {} }));

    // timeout 후 결과 출력
    setTimeout(() => {
      wsSend(ws, 'Network.disable', {}).catch(() => {});
      ws.close();

      if (captured.length === 0) {
        console.error(`❌ ${timeoutSec}초 내 캡처된 응답 없음${filter ? ` (filter: "${filter}")` : ''}`);
        process.exit(1);
      }

      // JSON 출력
      const output = captured.map(c => ({
        url: c.url,
        status: c.status,
        keys: c.keys,
        bodyLength: c.body.length,
        body: c.body.length > 50000 ? c.body.substring(0, 50000) + '...(truncated)' : c.body,
      }));
      console.log(JSON.stringify(output, null, 2));
      resolve();
    }, timeoutSec * 1000);
  });
}

// ─── main ───────────────────────────────────────────────────

if (!command) {
  console.log(`Usage:
  bun scripts/browser.ts [--port PORT] [--match KEYWORD] <command> [args...]

Commands:
  navigate <keyword_or_url>    Navigate (nav-lookup 자동 실행)
  extract [keyword]            nav-index 셀렉터로 구조화된 데이터 추출
  action <block> [--answers]   nav-index actions 시퀀스 실행
  text                         페이지 텍스트 (innerText)
  snapshot                     a11y tree 스냅샷
  screenshot [--output path]   PNG 스크린샷
  click <text>                 텍스트로 요소 클릭 (Input.dispatchMouseEvent)
  click-at <x> <y>             좌표 기반 클릭 (React 18 호환)
  click-selector <selector>    CSS 셀렉터 클릭 (React 18 호환)
  eval <expression>            JS 실행
  capture [filter] [--timeout] 네트워크 캡처 (리로드 후 API 응답 수집)
  list                         열린 페이지 목록

Examples:
  bun scripts/browser.ts navigate "수납내역"
  bun scripts/browser.ts --port 9225 --match "Bug" text
  bun scripts/browser.ts --port 9225 --match "Bug" click "버그제목"
  bun scripts/browser.ts screenshot --output /tmp/shot.png
  bun scripts/browser.ts action valley-evaluate --match valley
  bun scripts/browser.ts action valley-evaluate --match valley --answers "가능성 있음|영향력 큼"`);
  process.exit(0);
}

try {
  switch (command) {
    case 'navigate': case 'open': case 'go':
      if (!rest[0]) { console.error('navigate에 키워드 또는 URL이 필요합니다.'); process.exit(1); }
      await cmdNavigate(rest.join(' '));
      break;
    case 'text':
      await cmdText();
      break;
    case 'snapshot':
      await cmdSnapshot();
      break;
    case 'screenshot': case 'shot': {
      const outIdx = rest.indexOf('--output');
      await cmdScreenshot(outIdx >= 0 ? rest[outIdx + 1] : undefined);
      break;
    }
    case 'click':
      if (!rest[0]) { console.error('click에 텍스트가 필요합니다.'); process.exit(1); }
      await cmdClick(rest.join(' '));
      break;
    case 'click-at': {
      const cx = Number(rest[0]), cy = Number(rest[1]);
      if (isNaN(cx) || isNaN(cy)) { console.error('click-at에 x y 좌표가 필요합니다.'); process.exit(1); }
      await cmdClickAt(cx, cy);
      break;
    }
    case 'hover': case 'hover-at': {
      const hx = Number(rest[0]), hy = Number(rest[1]);
      if (isNaN(hx) || isNaN(hy)) { console.error('hover에 x y 좌표가 필요합니다.'); process.exit(1); }
      await cmdHoverAt(hx, hy);
      break;
    }
    case 'click-selector':
      if (!rest[0]) { console.error('click-selector에 CSS 셀렉터가 필요합니다.'); process.exit(1); }
      await cmdClickSelector(rest.join(' '));
      break;
    case 'eval':
      if (!rest[0]) { console.error('eval에 expression이 필요합니다.'); process.exit(1); }
      await cmdEval(rest.join(' '));
      break;
    case 'extract':
      await cmdExtract(rest[0]);
      break;
    case 'action':
      if (!rest[0]) { console.error('action에 블록명이 필요합니다.'); process.exit(1); }
      await cmdAction(rest.join(' '));
      break;
    case 'capture': case 'network':
      await cmdCapture(rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined);
      break;
    case 'list': case 'pages':
      await cmdList();
      break;
    default:
      console.error(`알 수 없는 명령: ${command}`);
      process.exit(1);
  }
} catch (e: any) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
