#!/usr/bin/env bun
/**
 * notion-bugs.ts — Notion Experdy Bug List를 JSON으로 추출하는 스크립트
 *
 * Usage:
 *   bun notion-bugs.ts                          # 전체 버그 목록
 *   bun notion-bugs.ts --assignee 박준석          # 담당자 필터
 *   bun notion-bugs.ts --min-stars 2             # ★★ 이상만
 *   bun notion-bugs.ts --new-only                # 이전 실행 이후 새로 생긴 것만
 *   bun notion-bugs.ts --status "시작 전,진행 중"  # 상태 필터 (콤마 구분)
 *   bun notion-bugs.ts --help
 *
 * Output: JSON array to stdout
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// ─── Args ────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

const hasFlag = (name: string) => args.includes(name);

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage:
  bun notion-bugs.ts [options]

Options:
  --assignee <name>    담당자 필터 (부분 매칭)
  --min-stars <n>      최소 중요도 (1~3)
  --status <s1,s2>     상태 필터 (콤마 구분, 예: "시작 전,진행 중")
  --page <name>        관련 페이지 필터
  --detail             각 버그의 상세 페이지에서 코멘트/설명 추출
  --new-only           이전 실행 이후 새로 생긴 항목만 출력
  --state-file <path>  상태 파일 경로 (기본: ~/.notion-bugs-seen.json)
  --no-save            상태 파일 업데이트 안 함
  --help, -h           이 도움말

Output:
  JSON array (stdout). 필터에 걸리지 않는 항목은 제외됨.
  --new-only 사용 시 새 항목이 없으면 빈 배열 [].

Examples:
  bun notion-bugs.ts --assignee 박준석 --min-stars 2
  bun notion-bugs.ts --new-only --assignee 박준석
  bun notion-bugs.ts --status "시작 전,진행 중" --min-stars 2`);
  process.exit(0);
}

const ASSIGNEE = getArg('--assignee');
const MIN_STARS = Number(getArg('--min-stars') || 0);
const STATUS_FILTER = getArg('--status')?.split(',').map(s => s.trim());
const PAGE_FILTER = getArg('--page');
const NEW_ONLY = hasFlag('--new-only');
const DETAIL = hasFlag('--detail');
const NO_SAVE = hasFlag('--no-save');
const STATE_FILE = getArg('--state-file') || resolve(process.env.HOME!, '.notion-bugs-seen.json');

const CDP_PORT = Number(getArg('--port') || 9225);
const BUG_LIST_URL = 'https://www.notion.so/Experdy-Bug-List-2f6b5a5320dd80da8a21f9090ea8ec1b';

// ─── CDP connection (minimal, inlined from browser.ts) ───────

let _msgId = 0;

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WS timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`WS 연결 실패: ${url}`)); };
  });
}

function wsSend(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
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
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function cdpEval(ws: WebSocket, expression: string): Promise<any> {
  const { result } = await wsSend(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

// ─── Notion page discovery ───────────────────────────────────

async function findBugListPage(): Promise<WebSocket> {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
  if (!resp.ok) throw new Error(`Notion CDP 연결 실패 (port ${CDP_PORT}). Notion 앱이 실행 중인지 확인하세요.`);
  const targets = (await resp.json()) as any[];

  const page = targets.find(
    (t: any) => t.type === 'page' && t.webSocketDebuggerUrl && (
      t.title?.includes('Bug') || t.title?.includes('베타') || t.url?.includes('Experdy-Bug-List')
    ),
  );

  if (!page) {
    // Bug List가 열려있지 않으면 기존 Notion 페이지에서 이동
    const notionPage = targets.find(
      (t: any) => t.type === 'page' && t.webSocketDebuggerUrl && t.url?.includes('notion.so'),
    );
    if (!notionPage) throw new Error('Notion 페이지를 찾을 수 없습니다.');

    const ws = await connectWs(notionPage.webSocketDebuggerUrl);
    await cdpEval(ws, `window.location.href = '${BUG_LIST_URL}'; 'ok'`);
    await new Promise(r => setTimeout(r, 5000));
    return ws;
  }

  return connectWs(page.webSocketDebuggerUrl);
}

// ─── Data extraction ─────────────────────────────────────────

interface Bug {
  name: string;
  status: string;
  stars: number;
  assignee: string;
  page: string;
  createdAt: string;
  lastEditedAt: string;
  creator: string;
  phase: string;
  blockId?: string;
  notionUrl?: string;
  detail?: string; // --detail 시 채워짐: 코멘트 + 설명
}

function countStars(s: string): number {
  return (s.match(/★/g) || []).length;
}

interface RawRow { cells: string[]; blockId: string; }

async function extractBugs(ws: WebSocket): Promise<Bug[]> {
  // Notion 가상 스크롤 대응: 스크롤하면서 모든 행 수집 (blockId 포함)
  const rawRows: RawRow[] = await cdpEval(ws, `
    (() => {
      const seen = new Set();
      const allRows = [];
      const container = document.querySelector('.notion-scroller');

      function collect() {
        const items = document.querySelectorAll('.notion-collection-item');
        for (const row of items) {
          const cells = Array.from(row.querySelectorAll('.notion-table-view-cell'))
            .map(c => c.textContent.trim());
          const blockId = row.getAttribute('data-block-id') || '';
          const key = cells[0] + '|' + cells[5];
          if (!seen.has(key) && cells[0]) {
            seen.add(key);
            allRows.push({ cells, blockId });
          }
        }
      }

      if (container) {
        collect();
        container.scrollTop = container.scrollHeight;
      }
      collect();
      return allRows;
    })()
  `);

  // 스크롤 후 추가 수집
  await new Promise(r => setTimeout(r, 1000));

  const moreRows: RawRow[] = await cdpEval(ws, `
    (() => {
      const rows = [];
      const items = document.querySelectorAll('.notion-collection-item');
      for (const row of items) {
        const cells = Array.from(row.querySelectorAll('.notion-table-view-cell'))
          .map(c => c.textContent.trim());
        const blockId = row.getAttribute('data-block-id') || '';
        if (cells[0]) rows.push({ cells, blockId });
      }
      return rows;
    })()
  `);

  // 합치고 중복 제거
  const allRaw = [...rawRows, ...moreRows];
  const deduped = new Map<string, RawRow>();
  for (const row of allRaw) {
    const key = row.cells[0] + '|' + row.cells[5];
    if (!deduped.has(key)) deduped.set(key, row);
  }

  return Array.from(deduped.values()).map(({ cells, blockId }) => {
    const id = blockId.replace(/-/g, '');
    return {
      name: cells[0] || '',
      status: cells[1] || '',
      stars: countStars(cells[2] || ''),
      assignee: cells[3] || '',
      page: cells[4] || '',
      createdAt: cells[5] || '',
      lastEditedAt: cells[6] || '',
      creator: cells[7] || '',
      phase: cells[8] || '',
      blockId,
      notionUrl: id ? `https://www.notion.so/${id}` : undefined,
    };
  });
}

// ─── Detail extraction ───────────────────────────────────────

async function fetchDetail(ws: WebSocket, bug: Bug): Promise<string> {
  if (!bug.notionUrl) return '';

  // 상세 페이지로 이동
  await cdpEval(ws, `window.location.href = '${bug.notionUrl}'; 'ok'`);
  await new Promise(r => setTimeout(r, 3000));

  // 페이지 텍스트 추출 (프로퍼티 + 코멘트 영역)
  const text: string = await cdpEval(ws, `
    (() => {
      // 코멘트 영역
      const comments = Array.from(document.querySelectorAll('.notion-page-view-discussion, [data-block-id] .notion-comment'))
        .map(el => el.textContent.trim())
        .filter(Boolean);

      // 페이지 본문 (프로퍼티 제외한 컨텐츠)
      const content = document.querySelector('.notion-page-content');
      const body = content ? content.innerText.trim() : '';

      // 전체 페이지에서 Comments 섹션 이후 텍스트
      const fullText = document.body.innerText;
      const commentIdx = fullText.indexOf('Comments');
      const commentSection = commentIdx >= 0 ? fullText.substring(commentIdx, commentIdx + 2000).trim() : '';

      return JSON.stringify({
        body: body.substring(0, 1000),
        commentSection: commentSection.substring(0, 1500),
        comments,
      });
    })()
  `);

  try {
    const parsed = JSON.parse(text);
    const parts: string[] = [];
    if (parsed.body) parts.push(parsed.body);
    if (parsed.commentSection) parts.push(parsed.commentSection);
    else if (parsed.comments?.length) parts.push(parsed.comments.join('\n'));
    return parts.join('\n---\n');
  } catch {
    return text;
  }
}

async function enrichWithDetails(ws: WebSocket, bugs: Bug[]): Promise<void> {
  for (const bug of bugs) {
    try {
      bug.detail = await fetchDetail(ws, bug);
    } catch (e: any) {
      bug.detail = `[추출 실패: ${e.message}]`;
    }
  }

  // Bug List로 복귀
  await cdpEval(ws, `window.location.href = '${BUG_LIST_URL}'; 'ok'`);
  await new Promise(r => setTimeout(r, 3000));
}

// ─── Filtering ───────────────────────────────────────────────

function filterBugs(bugs: Bug[]): Bug[] {
  return bugs.filter(b => {
    if (ASSIGNEE && !b.assignee.includes(ASSIGNEE)) return false;
    if (MIN_STARS && b.stars < MIN_STARS) return false;
    if (STATUS_FILTER && !STATUS_FILTER.includes(b.status)) return false;
    if (PAGE_FILTER && !b.page.includes(PAGE_FILTER)) return false;
    return true;
  });
}

// ─── New-only detection ──────────────────────────────────────

function loadSeen(): Set<string> {
  if (!existsSync(STATE_FILE)) return new Set();
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return new Set(data);
  } catch {
    return new Set();
  }
}

function saveSeen(bugs: Bug[]) {
  const keys = bugs.map(b => b.name + '|' + b.createdAt);
  writeFileSync(STATE_FILE, JSON.stringify(keys, null, 2));
}

function filterNewOnly(bugs: Bug[]): Bug[] {
  const seen = loadSeen();
  return bugs.filter(b => !seen.has(b.name + '|' + b.createdAt));
}

// ─── Main ────────────────────────────────────────────────────

try {
  const ws = await findBugListPage();

  let bugs = await extractBugs(ws);
  const allBugs = [...bugs]; // 상태 저장용 전체 목록

  bugs = filterBugs(bugs);
  if (NEW_ONLY) bugs = filterNewOnly(bugs);
  if (DETAIL && bugs.length > 0) await enrichWithDetails(ws, bugs);

  console.log(JSON.stringify(bugs, null, 2));

  if (!NO_SAVE) saveSeen(allBugs);

  ws.close();
} catch (e: any) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
