#!/usr/bin/env bun
/**
 * Playbook: session
 * Site: localhost
 * Generated: 2026-03-26 12:30:45
 * Source: web-auto v2 codegen-flush
 */
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  // unknown: agent-browser — 
}

main().catch(console.error);
