#!/usr/bin/env bun
/**
 * web-autopilot — nav-index + CDP WebSocket browser automation CLI.
 *
 * Supports Chrome and Electron apps (Notion etc.) via HTTP /json.
 *   --port 9225  → HTTP-based (Electron)
 *   default      → Chrome DevTools on port 9222
 *
 * Usage:
 *   bunx web-autopilot navigate "keyword"
 *   bunx web-autopilot --port 9225 list
 *   bunx web-autopilot extract "keyword"
 *   bunx web-autopilot screenshot --output /tmp/shot.png
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// ─── Args parsing ───────────────────────────────────────────

const args = process.argv.slice(2);
let customPort: number | undefined;
let matchKeyword: string | undefined;
let limitChars: number | undefined;

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

const NAV_INDEX_PATH = navIndexOverride
  ?? process.env.NAV_INDEX_PATH
  ?? resolve(process.cwd(), 'docs/ui-nav-index.yaml');

// ─── CDP Connection ─────────────────────────────────────────

interface PageInfo {
  wsUrl: string;
  title: string;
  url: string;
  id?: string;
}

let _ws: WebSocket | null = null;
let _msgId = 0;

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

async function getPagesViaChrome(): Promise<PageInfo[]> {
  return getPagesViaHttp(9222);
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WS timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`WS connect failed: ${url}`)); };
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
  if (customPort) return pages[0];
  return pages.find((p) => p.url.includes('localhost'));
}

async function getAndFindPage(): Promise<{ pages: PageInfo[]; page: PageInfo }> {
  const pages = customPort ? await getPagesViaHttp(customPort) : await getPagesViaChrome();
  const page = findPage(pages, matchKeyword);
  if (!page) {
    console.error(matchKeyword ? `"${matchKeyword}" — no matching page found` : 'No target page found');
    console.error('Open pages:');
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

    if (fullUrl) {
      const urlMatched = blocks.filter(b => b.url && urlMatchesPattern(fullUrl, b.url));
      if (urlMatched.length) return urlMatched;
    }

    return blocks.filter(({ name, content }) => (name + '\n' + content).toLowerCase().includes(q));
  } catch { return []; }
}

function formatNavResult(results: NavBlock[]): string {
  if (!results.length) return 'No nav-index match found.';
  return results.map(({ name, content }) => `## ${name}\n${content.trimEnd()}`).join('\n\n');
}

// ─── nav-index gate ─────────────────────────────────────────

async function requireNavIndex(page: PageInfo): Promise<void> {
  const pageUrl = page.url;
  if (pageUrl.includes('localhost')) return;
  if (!pageUrl.startsWith('http')) return;

  try {
    const raw = readFileSync(NAV_INDEX_PATH, 'utf-8');
    const blocks = parseBlocks(raw);
    const matched = blocks.some(b => b.url && urlMatchesPattern(pageUrl, b.url));
    const domainMatched = !matched && blocks.some(b => {
      if (!b.url) return false;
      const domain = b.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\*/g, '');
      return domain && pageUrl.includes(domain);
    });
    if (matched || domainMatched) return;
  } catch {
    return;
  }

  console.error(`Page not registered in nav-index.`);
  console.error(`NAV_INDEX_MISS:${pageUrl}`);
  console.error(`\nRegister selectors in nav-index first, then use extract.`);
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
      console.log(`-> URL pattern: ${url}`);
      console.log('   Replace placeholders with actual values\n');
    } else {
      console.error('Cannot determine URL.');
      process.exit(1);
    }
  }

  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);
  await cdp(conn, 'Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`Navigated to ${url}`);
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
  if (lines.length > 200) console.log(`... (${lines.length - 200} more)`);
  conn.ws.close();
}

async function cmdScreenshot(outputPath?: string) {
  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);
  const { data } = await cdp(conn, 'Page.captureScreenshot', { format: 'png' });
  const out = outputPath ?? '/tmp/browser-screenshot.png';
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`Screenshot saved: ${out}`);
  conn.ws.close();
}

async function cmdClick(text: string) {
  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);

  const { result } = await cdp(conn, 'Runtime.evaluate', {
    expression: `(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim() === ${JSON.stringify(text)}) {
          const el = walker.currentNode.parentElement;
          const rect = el.getBoundingClientRect();
          el.click();
          return { clicked: true, x: rect.x, y: rect.y, tag: el.tagName };
        }
      }
      return { clicked: false };
    })()`,
    returnByValue: true,
  });

  const val = result.value;
  if (val?.clicked) console.log(`Clicked "${text}" (${val.tag} @ ${val.x},${val.y})`);
  else console.error(`"${text}" not found`);
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
  const query = target ?? matchKeyword ?? '';
  let blocks: NavBlock[] = [];
  try {
    const raw = readFileSync(NAV_INDEX_PATH, 'utf-8');
    blocks = parseBlocks(raw);
  } catch {}

  const q = query.toLowerCase();
  let matched = blocks.filter(({ name, content }) => (name + '\n' + content).toLowerCase().includes(q));

  if (!matched.length) {
    const { page } = await getAndFindPage();
    const pageUrl = page.url;
    matched = blocks.filter(b => b.url && pageUrl.includes(b.url.replace(/\*/g, '')));
    if (!matched.length) {
      matched = blocks.filter(b => {
        if (!b.url) return false;
        const pattern = b.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
        return new RegExp(pattern).test(pageUrl);
      });
    }
  }

  if (!matched.length || !matched[0].selectors) {
    console.error('No nav-index block with selectors found.');
    if (matched.length && !matched[0].selectors) {
      console.error(`  "${matched[0].name}" has no selectors defined.`);
    }
    process.exit(1);
  }

  const block = matched[0];
  const selectors = block.selectors!;

  const allPages = customPort ? await getPagesViaHttp(customPort) : await getPagesViaChrome();
  let page: PageInfo | undefined;

  if (block.url) {
    const pattern = new RegExp(
      '^' + block.url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    page = allPages.find(p => pattern.test(p.url));
  }
  if (!page) {
    const hint = matchKeyword ?? block.url?.match(/https?:\/\/([^/]+)/)?.[1];
    if (hint) page = allPages.find(p => p.url.toLowerCase().includes(hint.toLowerCase()));
  }

  if (!page) {
    console.error('Target page not found. Navigate to the page first.');
    process.exit(1);
  }

  const conn = await connectToPage(page);

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
  type: string;
  value: string;
}

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
    console.error(`No actions block matching "${blockQuery}"`);
    const withActions = blocks.filter((b) => b.content.includes('actions:'));
    if (withActions.length) {
      console.error('Available action blocks:');
      withActions.forEach((b) => console.error(`  - ${b.name}`));
    }
    process.exit(1);
  }

  const { actions, bestAnswers } = parseActions(matchedBlock.content);
  if (!actions.length) {
    console.error(`"${matchedBlock.name}" has no actions to execute.`);
    process.exit(1);
  }

  const answers = answersParam
    ? answersParam.split('|').map((a) => a.trim())
    : bestAnswers.length ? bestAnswers : undefined;

  const { page } = await getAndFindPage();
  const conn = await connectToPage(page);

  console.log(`── action: ${matchedBlock.name} (${actions.length} steps) ──`);
  if (answers) console.log(`  answers: ${answers.length} ${answersParam ? '(custom)' : '(best_answers)'}`);

  for (const step of actions) {
    switch (step.type) {
      case 'click_text': {
        const { result } = await cdp(conn, 'Runtime.evaluate', {
          expression: `(() => {
            const text = ${JSON.stringify(step.value)};
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              if (walker.currentNode.textContent.trim() === text) {
                walker.currentNode.parentElement.click();
                return true;
              }
            }
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text));
            if (btn) { btn.click(); return true; }
            return false;
          })()`,
          returnByValue: true,
        });
        console.log(result.value ? `  click_text: "${step.value}"` : `  FAIL click_text: "${step.value}"`);
        break;
      }

      case 'click_selector': {
        const { result } = await cdp(conn, 'Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(step.value)}); if (el) { el.click(); return true; } return false; })()`,
          returnByValue: true,
        });
        console.log(result.value ? `  click_selector: ${step.value}` : `  FAIL click_selector: ${step.value}`);
        break;
      }

      case 'select_radios': {
        if (!answers) {
          console.error(`  FAIL select_radios: --answers parameter or best_answers required`);
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
        console.log(`  select_radios: ${v.clicked}/${v.total} selected`);
        break;
      }

      case 'wait': {
        const ms = parseInt(step.value);
        await new Promise((r) => setTimeout(r, ms));
        console.log(`  wait: ${ms}ms`);
        break;
      }

      default:
        console.error(`  Unknown action: ${step.type}`);
    }
  }

  console.log(`\nAction complete`);
  conn.ws.close();
}

async function cmdList() {
  const pages = customPort ? await getPagesViaHttp(customPort) : await getPagesViaChrome();
  pages.forEach((p, i) => console.log(`[${i}] ${p.title} - ${p.url}`));
  if (_ws) _ws.close();
}

// ─── main ───────────────────────────────────────────────────

if (!command) {
  console.log(`web-autopilot — Browser automation via Chrome DevTools Protocol

Usage:
  web-autopilot [--port PORT] [--match KEYWORD] <command> [args...]

Commands:
  navigate <keyword|url>      Navigate (auto nav-index lookup)
  extract [keyword]           Extract structured data via nav-index selectors
  action <block> [--answers]  Execute nav-index action sequence
  text                        Page text (innerText)
  snapshot                    Accessibility tree snapshot
  screenshot [--output path]  PNG screenshot
  click <text>                Click element by text
  eval <expression>           Execute JS
  list                        List open pages

Options:
  --port <port>       CDP port (default: 9222)
  --match <keyword>   Match page by title/URL
  --limit <chars>     Limit text output length
  --nav-index <path>  Path to nav-index YAML file
  --answers <a|b|c>   Pipe-separated answers for select_radios

Examples:
  web-autopilot navigate "settings"
  web-autopilot --port 9225 --match "Bug" text
  web-autopilot extract "payment"
  web-autopilot screenshot --output /tmp/shot.png`);
  process.exit(0);
}

try {
  switch (command) {
    case 'navigate': case 'open': case 'go':
      if (!rest[0]) { console.error('navigate requires a keyword or URL'); process.exit(1); }
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
      if (!rest[0]) { console.error('click requires text'); process.exit(1); }
      await cmdClick(rest.join(' '));
      break;
    case 'eval':
      if (!rest[0]) { console.error('eval requires an expression'); process.exit(1); }
      await cmdEval(rest.join(' '));
      break;
    case 'extract':
      await cmdExtract(rest[0]);
      break;
    case 'action':
      if (!rest[0]) { console.error('action requires a block name'); process.exit(1); }
      await cmdAction(rest.join(' '));
      break;
    case 'list': case 'pages':
      await cmdList();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
} catch (e: any) {
  console.error(e.message);
  process.exit(1);
}
