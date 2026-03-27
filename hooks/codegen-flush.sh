#!/bin/bash
# Stop hook: agent-browser 액션 로그 → Playwright 스크립트 자동 생성 (LLM 불필요)

ACTIONS_FILE="/tmp/web-auto-actions.jsonl"
BASE_DIR="$HOME/claude-plugins/web-auto"
PLAYBOOKS_DIR="$BASE_DIR/playbooks"

# 액션 로그가 없으면 스킵
[ -s "$ACTIONS_FILE" ] || exit 0

# 성공 액션만 추출 (에러는 제외)
SUCCESS_ACTIONS=$(grep '"type":"success"' "$ACTIONS_FILE")
[ -z "$SUCCESS_ACTIONS" ] && { rm -f "$ACTIONS_FILE" /tmp/web-auto-current-page.txt /tmp/web-auto-current-site.txt /tmp/web-auto-seq.txt; exit 0; }

# 사이트 추출
SITE=$(echo "$SUCCESS_ACTIONS" | head -1 | python3 -c "import sys,json; print(json.load(sys.stdin).get('site','unknown'))" 2>/dev/null)
[ -z "$SITE" ] || [ "$SITE" = "unknown" ] && { rm -f "$ACTIONS_FILE" /tmp/web-auto-current-page.txt /tmp/web-auto-current-site.txt /tmp/web-auto-seq.txt; exit 0; }

# 태스크명 추출 (첫 navigate의 page path에서)
TASK=$(echo "$SUCCESS_ACTIONS" | grep '"subcmd":"open\|"subcmd":"navigate' | head -1 | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  p=d.get('page','').strip('/')
  print(p.split('/')[-1] if p else 'session')
except: print('session')
" 2>/dev/null)
[ -z "$TASK" ] && TASK="session"
TASK=$(echo "$TASK" | sed 's/[^a-zA-Z0-9_-]/-/g')
TIMESTAMP=$(date '+%Y%m%d-%H%M%S')

# playbooks 디렉토리 생성
mkdir -p "$PLAYBOOKS_DIR/$SITE"

# Playwright 코드 생성
STEPS=""
while IFS= read -r line; do
  # python3으로 subcmd, arg1, arg_rest 파싱
  eval "$(echo "$line" | python3 -c "
import sys,json,re,shlex
d=json.load(sys.stdin)
subcmd=d.get('subcmd','')
cmd=d.get('command','')
# agent-browser [--flag val]* subcmd args → args만 추출
raw=re.sub(r'^agent-browser\s+(?:--\S+\s+\S+\s+)*\S+\s*','',cmd)
# shlex로 따옴표 파싱
try:
  parts=shlex.split(raw)
except:
  parts=raw.replace('\"','').split()
arg1=parts[0] if len(parts)>0 else ''
arg_rest=' '.join(parts[1:]) if len(parts)>1 else ''
# shell 변수로 출력
print(f'SUBCMD={shlex.quote(subcmd)}')
print(f'ARG1={shlex.quote(arg1)}')
print(f'ARG_REST={shlex.quote(arg_rest)}')
print(f'ARGS_RAW={shlex.quote(raw)}')
" 2>/dev/null)"

  case "$SUBCMD" in
    open|navigate)
      URL=$(echo "$ARGS_RAW" | /usr/bin/grep -oE 'https?://[^"\\[:space:]]+' | head -1)
      [ -z "$URL" ] && URL="$ARG1"
      STEPS="${STEPS}  await page.goto('${URL}');\n"
      ;;
    click)
      STEPS="${STEPS}  await page.click('text=${ARG1}');\n"
      ;;
    type)
      STEPS="${STEPS}  await page.type('${ARG1}', '${ARG_REST}');\n"
      ;;
    fill)
      STEPS="${STEPS}  await page.fill('${ARG1}', '${ARG_REST}');\n"
      ;;
    select)
      STEPS="${STEPS}  await page.selectOption('${ARG1}', '${ARG_REST}');\n"
      ;;
    eval|evaluate)
      JS=$(echo "$ARGS_RAW" | sed 's/^"//; s/"$//')
      STEPS="${STEPS}  await page.evaluate(() => { ${JS} });\n"
      ;;
    screenshot)
      STEPS="${STEPS}  await page.screenshot({ path: 'screenshot.png' });\n"
      ;;
    snapshot)
      STEPS="${STEPS}  // snapshot (accessibility tree) — skipped in playbook\n"
      ;;
    scroll)
      PX="${ARG_REST:-500}"
      case "$ARG1" in
        down)  STEPS="${STEPS}  await page.evaluate(() => window.scrollBy(0, ${PX}));\n" ;;
        up)    STEPS="${STEPS}  await page.evaluate(() => window.scrollBy(0, -${PX}));\n" ;;
        left)  STEPS="${STEPS}  await page.evaluate(() => window.scrollBy(-${PX}, 0));\n" ;;
        right) STEPS="${STEPS}  await page.evaluate(() => window.scrollBy(${PX}, 0));\n" ;;
      esac
      ;;
    wait)
      if echo "$ARG1" | /usr/bin/grep -qE '^[0-9]+$'; then
        STEPS="${STEPS}  await page.waitForTimeout(${ARG1});\n"
      else
        STEPS="${STEPS}  await page.waitForSelector('${ARG1}');\n"
      fi
      ;;
    press)
      STEPS="${STEPS}  await page.keyboard.press('${ARG1}');\n"
      ;;
    back)
      STEPS="${STEPS}  await page.goBack();\n"
      ;;
    forward)
      STEPS="${STEPS}  await page.goForward();\n"
      ;;
    reload)
      STEPS="${STEPS}  await page.reload();\n"
      ;;
    *)
      STEPS="${STEPS}  // unknown: ${SUBCMD} — ${ARGS_RAW}\n"
      ;;
  esac
done <<< "$SUCCESS_ACTIONS"

# 스텝이 없으면 스킵
[ -z "$STEPS" ] && { rm -f "$ACTIONS_FILE" /tmp/web-auto-current-page.txt /tmp/web-auto-current-site.txt /tmp/web-auto-seq.txt; exit 0; }

# Playwright 스크립트 생성
OUTFILE="$PLAYBOOKS_DIR/$SITE/${TASK}-${TIMESTAMP}.ts"

cat > "$OUTFILE" << PLAYBOOK
#!/usr/bin/env bun
/**
 * Playbook: ${TASK}
 * Site: ${SITE}
 * Generated: $(date '+%Y-%m-%d %H:%M:%S')
 * Source: web-auto v2 codegen-flush
 */
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

$(echo -e "$STEPS")
}

main().catch(console.error);
PLAYBOOK

chmod +x "$OUTFILE"

# 정리
rm -f "$ACTIONS_FILE" /tmp/web-auto-current-page.txt /tmp/web-auto-current-site.txt /tmp/web-auto-seq.txt

exit 0
