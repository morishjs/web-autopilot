# web-autopilot

CLI browser automation tool via Chrome DevTools Protocol.
Navigate, extract structured data, click elements — no screenshots needed.

## Requirements

- [Bun](https://bun.sh) runtime
- Chrome/Chromium with `--remote-debugging-port=9222`

## Install

```bash
bun add -g web-autopilot
```

Or run directly:

```bash
bunx web-autopilot list
```

## Quick Start

1. Launch Chrome with remote debugging:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

2. Run commands:

```bash
web-autopilot list                        # List open pages
web-autopilot navigate "settings"         # Navigate via nav-index
web-autopilot text                        # Get page text
web-autopilot click "Submit"              # Click by text
web-autopilot screenshot --output shot.png
web-autopilot extract "payment"           # Extract via selectors
web-autopilot snapshot                    # Accessibility tree
```

## Commands

| Command | Description |
|---------|-------------|
| `navigate <keyword\|url>` | Navigate with auto nav-index lookup |
| `extract [keyword]` | Extract structured data via nav-index selectors |
| `action <block>` | Execute nav-index action sequence |
| `text` | Page text (innerText) |
| `snapshot` | Accessibility tree snapshot |
| `screenshot [--output path]` | PNG screenshot |
| `click <text>` | Click element by text content |
| `eval <expression>` | Execute JavaScript |
| `list` | List open pages |

## Options

| Option | Description |
|--------|-------------|
| `--port <port>` | CDP port (default: 9222) |
| `--match <keyword>` | Match page by title/URL |
| `--limit <chars>` | Limit text output length |
| `--nav-index <path>` | Path to nav-index YAML file |
| `--answers <a\|b\|c>` | Pipe-separated answers for select_radios |

## Nav-Index

A YAML file that maps pages to selectors and actions:

```yaml
PaymentHistory:
  url: /customer/detail/:id?tab=payment
  selectors:
    total: .payment-total
    items: .payment-item
  actions:
    - click_text: "Refund"
    - wait: 1000
```

Set the path via `--nav-index`, `NAV_INDEX_PATH` env var, or default `docs/ui-nav-index.yaml`.

## License

MIT
