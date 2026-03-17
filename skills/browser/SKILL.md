# web-autopilot

Browser automation via Chrome DevTools Protocol. Extract structured data from web pages using nav-index — no screenshots needed.

## When to use

- User asks to check, read, or extract data from a web page
- User asks to navigate to a page and interact with it
- User asks to automate browser actions (click, fill forms, etc.)
- Debugging web UIs by inspecting page content or accessibility tree

## Prerequisites

Chrome/Chromium must be running with `--remote-debugging-port=9222`.

## Commands

```bash
bunx web-autopilot list                          # List open tabs
bunx web-autopilot navigate "keyword_or_url"     # Navigate via nav-index
bunx web-autopilot extract "keyword"             # Extract via selectors
bunx web-autopilot action "block_name"           # Run action sequence
bunx web-autopilot action "block" --answers "a|b"  # With custom answers
bunx web-autopilot text                          # Page innerText
bunx web-autopilot snapshot                      # Accessibility tree
bunx web-autopilot click "Button Text"           # Click by text
bunx web-autopilot eval "expression"             # Execute JS
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
3. Check nav-index for the target page — choose the right extraction strategy:
   - `selectors` field → use `extract` (returns structured JSON)
   - `eval` field → use `eval` with the expression from nav-index (for iframe-based pages)
   - `api` field → use `eval` with fetch() for bulk data (DOM only shows partial data)
   - `actions` field → use `action` for multi-step automation
   - None of the above → use `text` or `snapshot` as fallback
4. Use `navigate` to open pages by keyword (looks up URL from nav-index)

## Nav-Index format

The nav-index YAML maps pages to URLs, selectors, eval expressions, APIs, and actions.

### Basic: selectors (most common)

```yaml
naver-news:
  url: https://n.news.naver.com/mnews/article/*/*
  selectors:
    title: "#title_area span"
    body: "#newsct_article"
    date: ".media_end_head_info_datestamp_bunch span"
```

Use: `bunx web-autopilot extract "naver-news"`
Returns: `{ "title": "...", "body": "...", "date": "..." }`

### iframe pages: eval

Some pages (Naver blog, premium content) use iframes where `extract` can't reach.

```yaml
naver-blog:
  url: https://blog.naver.com/*/*
  eval: "document.querySelector('iframe#mainFrame')?.contentDocument?.body?.innerText"
```

Use: `bunx web-autopilot eval "document.querySelector('iframe#mainFrame')?.contentDocument?.body?.innerText"`

### Bulk data: api

When DOM shows limited rows (e.g. virtual scroll), use the API endpoint instead.

```yaml
insights-list:
  url: https://example.com/insights?*
  selectors:
    rows: table tbody tr
  api:
    endpoint: https://api.example.com/insights/analyses
    params: { category: ALL, sort: LATEST }
    pagination: nextPaginationToken
    auth: browser-session
```

For bulk collection, use `eval` to call the API via fetch() in the browser context (inherits session cookies):
```bash
bunx web-autopilot eval "fetch('https://api.example.com/insights/analyses?category=ALL').then(r=>r.json())"
```

### Multi-step automation: actions + best_answers

```yaml
evaluate-form:
  url: https://example.com/evaluate/*
  selectors:
    title: h1
    body: article .prose
  evaluate:
    actions:
      - click_text: "Submit Review"
      - wait: 1500
      - select_radios: "[role=radio]"
      - click_selector: "[role=checkbox]"
      - wait: 500
      - click_text: "Confirm"
    best_answers:
      - "Highly likely"
      - "Very impactful"
      - "Detailed plan"
```

Use: `bunx web-autopilot action "evaluate-form" --match example`
- `--answers` overrides `best_answers` with pipe-separated values
- Without `--answers`, uses `best_answers` from nav-index
- Comments in nav-index may contain scoring guides — read them before selecting answers

### URL patterns

URLs support wildcards (`*`) and path parameters (`:param`):
```yaml
page:
  url: https://example.com/*/detail/:id?tab=*
```

## Output

- `extract` → JSON object with selector results
- `eval` → JSON-serialized return value
- `text` → raw innerText string
- `snapshot` → `[role] name` lines from accessibility tree (max 200)
- `NAV_INDEX_MISS:<url>` → page not in nav-index; register selectors first
