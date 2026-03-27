#!/usr/bin/env bun
/**
 * Playbook: schedule
 * Site: mevops
 * Generated: 2026-03-26 08:36:45
 * Source: web-auto v2 codegen-flush
 */
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  await page.goto('https://localhost:5173/schedule');
  await page.fill('#startDate', '2026-03-01');
  await page.evaluate(() => { document.title });
  await page.click('text=CSV 다운로드');
}

main().catch(console.error);
