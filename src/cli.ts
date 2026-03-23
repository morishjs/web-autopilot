#!/usr/bin/env bun
/**
 * web-auto CLI
 * Browser automation with nav-index driven extraction for Claude Code
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";

const PACKAGE_ROOT = resolve(dirname(import.meta.dir));
const command = process.argv[2];

// ─── helpers ────────────────────────────────────────────────

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, data: any) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/** Merge a value into a nested JSON file. Returns true if changed. */
function mergeJsonKey(filePath: string, key: string, value: any): boolean {
  const data = readJson(filePath) ?? {};
  if (JSON.stringify(data[key]) === JSON.stringify(value)) return false;
  data[key] = value;
  writeJson(filePath, data);
  return true;
}

// ─── init ───────────────────────────────────────────────────

function initNavIndex(): string {
  const targetDir = "docs";
  const targetFile = join(targetDir, "ui-nav-index.yaml");

  if (existsSync(targetFile)) {
    console.log(`  ✅ nav-index: ${targetFile} (already exists)`);
    return resolve(targetFile);
  }

  mkdirSync(targetDir, { recursive: true });

  const examplePath = join(PACKAGE_ROOT, "examples", "nav-index.example.yaml");
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, targetFile);
  } else {
    writeFileSync(
      targetFile,
      `# web-auto nav-index
# 각 블록은 URL 패턴과 CSS 셀렉터를 매핑합니다.
# extract 명령이 이 셀렉터를 사용하여 구조화된 데이터를 추출합니다.

# example-page:
#   url: https://example.com/path/*
#   selectors:
#     title: h1
#     body: article .prose
#   api:
#     data: https://example.com/api/endpoint?param={param}
`
    );
  }

  console.log(`  ✅ nav-index: ${targetFile} (created)`);
  return resolve(targetFile);
}

function initProjectSettings(navIndexAbsPath: string) {
  const settingsPath = ".claude/settings.json";
  const data = readJson(settingsPath) ?? {};

  let changed = false;

  // env.NAV_INDEX_PATH
  if (!data.env) data.env = {};
  if (data.env.NAV_INDEX_PATH !== navIndexAbsPath) {
    data.env.NAV_INDEX_PATH = navIndexAbsPath;
    changed = true;
  }

  // hooks.PostToolUse — nav-index-miss hook
  const hookCommand = join(PACKAGE_ROOT, "hooks", "nav-index-miss.sh");
  if (!data.hooks) data.hooks = {};
  if (!data.hooks.PostToolUse) data.hooks.PostToolUse = [];

  const hasHook = data.hooks.PostToolUse.some(
    (entry: any) =>
      entry.matcher === "Bash" &&
      entry.hooks?.some((h: any) => h.command?.includes("nav-index-miss"))
  );

  if (!hasHook) {
    data.hooks.PostToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: hookCommand, timeout: 5 }],
    });
    changed = true;
  }

  if (changed) {
    writeJson(settingsPath, data);
    console.log(`  ✅ .claude/settings.json (updated)`);
  } else {
    console.log(`  ✅ .claude/settings.json (already configured)`);
  }
}

function initSkillSymlink() {
  const skillDir = join(homedir(), ".claude", "skills", "web-auto");
  const sourceSKILL = join(PACKAGE_ROOT, "skills", "web-auto", "SKILL.md");
  const sourcePrompt = join(PACKAGE_ROOT, "skills", "web-auto", "prompt.md");
  const targetSKILL = join(skillDir, "SKILL.md");
  const targetPrompt = join(skillDir, "prompt.md");

  mkdirSync(skillDir, { recursive: true });

  // Create symlinks (overwrite if exists)
  const { execSync } = require("child_process");
  execSync(`ln -sf "${sourceSKILL}" "${targetSKILL}"`);
  execSync(`ln -sf "${sourcePrompt}" "${targetPrompt}"`);

  console.log(`  ✅ ~/.claude/skills/agent-browser/ (symlinked)`);
}

// ─── main ───────────────────────────────────────────────────

switch (command) {
  case "init": {
    console.log("\n🚀 web-auto init\n");

    // 1. nav-index template
    const navIndexPath = initNavIndex();

    // 2. project .claude/settings.json
    initProjectSettings(navIndexPath);

    // 3. skill symlink
    initSkillSymlink();

    console.log(`
✨ Setup complete!

Next steps:
  1. Edit docs/ui-nav-index.yaml to add your pages and selectors
  2. Start Chrome with CDP: chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-dev-profile"
  3. Use /agent-browser or bun $MEVOPS_ROOT/scripts/browser.ts navigate <url>
`);
    break;
  }

  case "help":
  case "--help":
  case "-h":
  default: {
    console.log(`web-auto - Browser automation with nav-index

Commands:
  init          Set up web-auto for this project
                  → docs/ui-nav-index.yaml (nav-index template)
                  → .claude/settings.json (NAV_INDEX_PATH + hooks)
                  → ~/.claude/skills/agent-browser/ (skill symlink)

Browser commands (via bun src/browser.ts):
  navigate      Navigate to URL/keyword (always run first)
  extract       Extract data using nav-index selectors
  eval          Evaluate JavaScript in page context
  click         Click element by text
  snapshot      Get accessibility tree snapshot
  screenshot    Take screenshot
  list          List open browser tabs
`);
    break;
  }
}
