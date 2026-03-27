#!/usr/bin/env bun
/**
 * Playbook: session
 * Site: localhost
 * Generated: 2026-03-26 11:31:14
 * Source: web-auto v2 codegen-flush
 */
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  // unknown: agent-browser/default.pid) — agent-browser/default.pid) 2>/dev/null; rm -f ~/.agent-browser/default.pid ~/.agent-browser/default.sock; agent-browser connect 9222 2>&1 && agent-browser open 
}

main().catch(console.error);
