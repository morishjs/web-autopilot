# web-autopilot

Browser automation via Chrome DevTools Protocol. Extract structured data from web pages using nav-index selectors — no screenshots needed.

## When to use

- User asks to check, read, or extract data from a web page
- User asks to navigate to a page and interact with it
- User asks to automate browser actions (click, fill forms, etc.)
- Debugging web UIs by inspecting page content or accessibility tree

## Prerequisites

Chrome/Chromium must be running with `--remote-debugging-port=9222`.

## Commands

```bash
# List open browser tabs
bunx web-autopilot list

# Navigate to a page (auto-lookup from nav-index)
bunx web-autopilot navigate "keyword_or_url"

# Extract structured data using nav-index selectors
bunx web-autopilot extract "keyword"

# Execute nav-index action sequence
bunx web-autopilot action "block_name"
bunx web-autopilot action "block_name" --answers "answer1|answer2"

# Get page text
bunx web-autopilot text

# Get accessibility tree snapshot (max 200 nodes)
bunx web-autopilot snapshot

# Click element by visible text
bunx web-autopilot click "Button Text"

# Execute JavaScript and return result
bunx web-autopilot eval "document.title"

# Take screenshot
bunx web-autopilot screenshot --output /tmp/shot.png
```

## Key options

- `--port <port>` — CDP port (default: 9222). Use for Electron apps (e.g. `--port 9225`)
- `--match <keyword>` — Select browser tab by title/URL match
- `--nav-index <path>` — Path to nav-index YAML (default: `docs/ui-nav-index.yaml` or `NAV_INDEX_PATH` env)
- `--limit <n>` — Truncate text output to n characters

## Workflow

1. **Always run `list` first** to see available pages
2. Use `--match` to target a specific tab if multiple are open
3. Prefer `extract` over `text`/`snapshot` when nav-index selectors are available — it returns clean structured JSON
4. Use `navigate` to open pages by keyword (looks up URL from nav-index)
5. Use `action` to run predefined multi-step sequences from nav-index

## Nav-Index format

The nav-index YAML file maps pages to metadata, selectors, and actions:

```yaml
PageName:
  url: /path/with/:param?tab=something
  component: src/components/SomePage.tsx
  api: GET /v2/some-endpoint
  sections:
    - Description of page section
  selectors:
    fieldName: .css-selector
    listItems: .list-item
  actions:
    - click_text: "Button"
    - wait: 1000
    - select_radios: ".radio-group label"
  best_answers:
    - "Default answer 1"
    - "Default answer 2"
```

## Output

- `extract` returns JSON: `{ "fieldName": "value", "listItems": ["a", "b"] }`
- `text` returns raw innerText
- `snapshot` returns `[role] name` lines from accessibility tree
- `eval` returns JSON-serialized result
- `NAV_INDEX_MISS:<url>` means the page needs selectors registered in nav-index first
