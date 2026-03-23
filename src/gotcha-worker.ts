#!/usr/bin/env bun
/**
 * Gotcha Worker — browser.ts 실패를 축적하고 세션 종료 시 패턴 파일에 기록
 *
 * 시작: bun src/gotcha-worker.ts start
 * 종료: bun src/gotcha-worker.ts stop
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const PORT_FILE = "/tmp/web-auto-gotcha-worker.port";
const PID_FILE = "/tmp/web-auto-gotcha-worker.pid";
const PATTERNS_DIR = join(dirname(import.meta.dir), "skills", "web-auto", "patterns");

interface Gotcha {
  site: string;
  command: string;
  error: string;
  timestamp: string;
}

const gotchas: Gotcha[] = [];

function flushToPatterns(): { updated: string[]; count: number } {
  if (gotchas.length === 0) return { updated: [], count: 0 };

  // site별 그룹핑
  const bySite = new Map<string, Gotcha[]>();
  for (const g of gotchas) {
    const list = bySite.get(g.site) ?? [];
    list.push(g);
    bySite.set(g.site, list);
  }

  if (!existsSync(PATTERNS_DIR)) mkdirSync(PATTERNS_DIR, { recursive: true });

  const updated: string[] = [];

  for (const [site, entries] of bySite) {
    const filePath = join(PATTERNS_DIR, `${site}.md`);
    let content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : `# ${site} 패턴\n`;

    let newGotchas = 0;
    for (const entry of entries) {
      // 중복 체크: 같은 에러 메시지가 이미 파일에 있으면 건너뜀
      const shortError = entry.error.substring(0, 60);
      if (content.includes(shortError)) continue;

      // Gotchas 섹션이 없으면 추가
      if (!content.includes("## Gotchas")) {
        content += "\n## Gotchas\n";
      }

      // 항목 추가
      const gotchaEntry = `\n### ${entry.timestamp}\n- **명령**: \`${entry.command}\`\n- **에러**: ${entry.error}\n`;
      content += gotchaEntry;
      newGotchas++;
    }

    if (newGotchas > 0) {
      writeFileSync(filePath, content);
      updated.push(site);
    }
  }

  const count = gotchas.length;
  gotchas.length = 0;
  return { updated, count };
}

const command = process.argv[2];

if (command === "stop") {
  // 기존 worker 종료
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      // flush 먼저
      if (existsSync(PORT_FILE)) {
        const port = readFileSync(PORT_FILE, "utf-8").trim();
        try {
          await fetch(`http://127.0.0.1:${port}/flush`, { method: "POST" });
        } catch {}
      }
      process.kill(pid, "SIGTERM");
    } catch {}
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(PID_FILE);
      unlinkSync(PORT_FILE);
    } catch {}
  }
  process.exit(0);
}

if (command === "start") {
  // 이미 실행 중이면 스킵
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, 0); // 프로세스 존재 확인
      console.log(`Worker already running (pid=${pid})`);
      process.exit(0);
    } catch {
      // dead pid file — 정리
    }
  }

  const server = Bun.serve({
    port: 0, // OS가 빈 포트 할당
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", pending: gotchas.length });
      }

      if (url.pathname === "/gotcha" && req.method === "POST") {
        const body = (await req.json()) as Gotcha;
        gotchas.push(body);
        return Response.json({ ok: true, pending: gotchas.length });
      }

      if (url.pathname === "/flush" && req.method === "POST") {
        const result = flushToPatterns();
        return Response.json(result);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const port = server.port;
  writeFileSync(PORT_FILE, String(port));
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`Gotcha worker listening on port ${port} (pid=${process.pid})`);

  // SIGTERM으로 graceful shutdown
  process.on("SIGTERM", () => {
    flushToPatterns();
    server.stop();
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(PID_FILE);
      unlinkSync(PORT_FILE);
    } catch {}
    process.exit(0);
  });
}
