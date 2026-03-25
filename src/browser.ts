#!/usr/bin/env bun
/**
 * browser.ts — CDP WebSocket 통합 브라우저 자동화 CLI.
 *
 * Chrome (browser WS) 과 Electron 앱(Notion 등, HTTP /json) 모두 지원.
 *   --port 9225  → HTTP 기반 (Notion 등 Electron)
 *   기본          → Chrome DevToolsActivePort 기반
 *
 * Usage:
 *   bun scripts/browser.ts navigate "http://localhost:5173/path"
 *   bun scripts/browser.ts --port 9225 list
 *   bun scripts/browser.ts --port 9225 text --match "Bug"
 *   bun scripts/browser.ts screenshot --output /tmp/shot.png
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

// ─── Args parsing ───────────────────────────────────────────

const args = process.argv.slice(2);
let customPort: number | undefined;
let matchKeyword: string | undefined;
let limitChars: number | undefined;

// extract --port, --match, --limit, --output, --answers from args
let answersParam: string | undefined;
const cleanArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    customPort = Number(args[++i]);
  } else if ((args[i] === '--match' || args[i] === '-m') && args[i + 1]) {
    matchKeyword = args[++i];
  } else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
    limitChars = Number(args[++i]);
  } else if (args[i] === '--answers' && args[i + 1]) {
    answersParam = args[++i];
  } else {
    cleanArgs.push(args[i]);
  }
}

const [command, ...rest] = cleanArgs;

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
    const m = match.toLowerCase().split('?')[0]; // query string 제거
    return pages.find(
      (p) =>
        p.title.toLowerCase().includes(m) ||
        p.url.toLowerCase().includes(m) ||
        m.includes(p.url.toLowerCase()), // URL을 포함하는 긴 링크도 매칭
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

// ─── commands ───────────────────────────────────────────────

async function cmdNavigate(target: string) {
  const isUrlTarget = /^https?:\/\//.test(target) || target.startsWith('localhost');
  if (!isUrlTarget) {
    console.error('❌ URL을 직접 지정해주세요. (예: http://localhost:5173/path)');
    process.exit(1);
  }

  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);
  await cdp(conn, 'Page.navigate', { url: target });
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`✅ ${target} 로 이동 완료`);
  conn.ws.close();
}

async function cmdText() {
  const { page } = await getAndFindPage();
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
  const conn = await connectToPage(page);
  const resp = await cdp(conn, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (resp.exceptionDetails) {
    console.error('eval error:', JSON.stringify(resp.exceptionDetails, null, 2));
  } else {
    console.log(JSON.stringify(resp.result?.value, null, 2));
  }
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

function printHelp() {
  console.log(`Usage:
  bun browser.ts [options] <command> [args...]

Options:
  --port <PORT>       CDP 포트 (Electron 앱: 9225=Notion, 9226=Ridibooks 등)
  --match <KEYWORD>   페이지 제목/URL 필터 (-m 단축)
  --limit <CHARS>     text 출력 글자 수 제한 (-l 단축)
  --answers <JSON>    dialog 자동 응답 (예: '["확인","예"]')
  --help, -h          이 도움말 출력

Commands:
  navigate <url>               URL로 이동 (aliases: open, go)
  text                         페이지 텍스트 (innerText)
  snapshot                     a11y tree 스냅샷
  screenshot [--output path]   PNG 스크린샷 (alias: shot)
  click <text>                 텍스트로 요소 클릭 (Input.dispatchMouseEvent)
  click-at <x> <y>             좌표 기반 클릭 (React 18 호환)
  hover <x> <y>                좌표 기반 호버 (alias: hover-at)
  click-selector <selector>    CSS 셀렉터 클릭 (React 18 호환)
  eval <expression>            JS 실행
  capture [filter] [--timeout] 네트워크 캡처 (리로드 후 API 응답 수집, alias: network)
  list                         열린 페이지 목록 (alias: pages)

Examples:
  bun browser.ts navigate "http://localhost:5173/nims"
  bun browser.ts --port 9225 -m "Bug" text
  bun browser.ts --port 9225 -m "Bug" click "버그제목"
  bun browser.ts screenshot --output /tmp/shot.png
  bun browser.ts --port 9225 list`);
}

if (!command || command === 'help' || args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

try {
  switch (command) {
    case 'navigate': case 'open': case 'go':
      if (!rest[0]) { console.error('navigate에 URL이 필요합니다.'); process.exit(1); }
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
    case 'capture': case 'network':
      await cmdCapture(rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined);
      break;
    case 'list': case 'pages':
      await cmdList();
      break;
    default:
      console.error(`알 수 없는 명령: ${command}\n`);
      printHelp();
      process.exit(1);
  }
} catch (e: any) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
