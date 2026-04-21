# BrowserGenie

A Chrome extension (Manifest V3) that gives AI models full, real browser control. It connects to the [BrowserGenie MCP Server](https://github.com/BrowserGenie/mcp) over a local WebSocket and executes browser commands — navigation, clicking, typing, screenshots, and full DevTools access — on behalf of the AI.

> **Two-repo setup:** This is the Chrome extension half. The MCP server that bridges your AI client lives in a separate repository. Both are required.

## How It Works

```
AI Client (Claude, Cursor, etc.)
    │  stdio  (JSON-RPC / MCP)
    ▼
MCP Server
    │  WebSocket  ws://localhost:7890
    ▼
Chrome Extension  ◄── this repo
    ├── chrome.tabs         → Navigation, tab management
    ├── chrome.debugger     → DevTools Protocol (CDP)
    ├── chrome.scripting    → Content script injection
    ├── chrome.cookies      → Cookie management
    └── Content Scripts      → Real DOM event simulation
```

The extension runs as a Manifest V3 service worker inside Chrome. It holds the WebSocket connection to the MCP server and dispatches every incoming command to the appropriate Chrome API or content script.

## Requirements

- Google Chrome (or any Chromium-based browser)
- Node.js 18+ and npm (build-time only)
- The companion [BrowserGenie MCP Server](https://github.com/BrowserGenie/mcp)

## Installation

### 1. Clone and build

```bash
git clone https://github.com/BrowserGenie/browser-extension.git
cd browser-extension
npm install
npm run build
```

This produces a `dist/` directory — the built extension ready to be loaded into Chrome.

### 2. Load into Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `dist/` folder inside this repository
5. The extension icon appears in the Chrome toolbar

### 3. Start the MCP server

Install and run the [BrowserGenie MCP Server](https://github.com/BrowserGenie/mcp). The extension connects to it automatically on startup.

### 4. Verify the connection

Click the extension icon in Chrome. The popup should show a green **Connected** indicator. If it shows **Disconnected**, make sure the MCP server is running.

## Extension Popup

The popup gives you runtime control over the extension's behaviour.

### API Key

Optionally secure the extension so only authenticated MCP tool calls are accepted.

| Control | Description |
|---------|-------------|
| **Require API Key** toggle | When on, all tool calls must include a matching `apiKey` parameter |
| **Generate Key** | Creates a new random UUID key |
| **Copy** | Copies the key to clipboard |
| **Rotate Key** | Generates a new key, invalidating the previous one |

When the toggle is off (default), all tool calls are accepted without authentication.

### URL Blocklist

Protect sensitive sites by refusing to execute any commands on matching URLs.

**Supported patterns:**

| Pattern | Example |
|---------|---------|
| Exact URL | `https://mybank.com/accounts` |
| Domain wildcard | `*.mybank.com` |
| Path wildcard | `https://example.com/admin/*` |
| Full wildcard | `*://internal.corp/*` |

### Feature Toggles

Enable or disable entire capability categories at runtime without reloading the extension.

| Toggle | Tools controlled |
|--------|-----------------|
| Navigation | `navigate_to_url`, `navigate_back`, `navigate_forward`, `navigate_reload` |
| Tab Management | `list_tabs`, `select_tab`, `new_tab`, `close_tab` |
| Keyboard Input | `press_key`, `type_text` |
| Click / Drag / Hover | `click_element`, `input_and_type`, `drag_and_drop`, `hover_element` |
| Screenshots | `screenshot_viewport`, `screenshot_full_page` |

| DevTools: Sources | `read_page_html`, `read_stylesheets`, `read_scripts`, `read_page_resources` |
| DevTools: Modify DOM/CSS | `modify_html`, `modify_css` |
| DevTools: Network Logs | `get_network_logs`, `get_network_request_detail`, `clear_network_logs` |
| DevTools: Storage | cookies, localStorage, sessionStorage (get/set/delete) |
| DevTools: Console | `get_console_logs`, `execute_javascript` |

## Project Structure

```
browser-genie-extension/
├── manifest.json               # Chrome Extension manifest (MV3)
├── webpack.config.js           # Webpack build config
├── src/
│   ├── background/             # Service worker (runs persistently in Chrome)
│   │   ├── index.ts            # Entry point — WebSocket client + message dispatch
│   │   ├── websocket-client.ts # WebSocket reconnect logic
│   │   ├── command-router.ts   # Routes incoming commands to handlers
│   │   ├── debugger-manager.ts # CDP debugger attach/detach lifecycle
│   │   ├── blocklist.ts        # URL blocklist matching
│   │   └── handlers/           # One handler per tool category
│   │       ├── navigation.ts
│   │       ├── tab-management.ts
│   │       ├── click.ts
│   │       ├── input.ts
│   │       ├── keyboard.ts
│   │       ├── hover.ts
│   │       ├── drag-drop.ts
│   │       ├── screenshot.ts

│   │       ├── devtools-sources.ts
│   │       ├── devtools-modify.ts
│   │       ├── devtools-network.ts
│   │       ├── devtools-storage.ts
│   │       └── devtools-console.ts
│   ├── content/                # Content scripts injected into pages
│   │   ├── click-handler.ts    # Real mouse event simulation
│   │   ├── drag-handler.ts     # Drag & drop simulation
│   │   ├── hover-handler.ts    # Hover / :hover state triggering
│   │   └── input-handler.ts    # Input field interaction

│   ├── popup/                  # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.ts
│   └── shared/                 # Shared utilities (extension-internal)
│       ├── constants.ts        # WebSocket URL, port defaults
│       ├── storage.ts          # chrome.storage helpers
│       └── types.ts            # Internal message types
├── icons/                      # Extension icons (16, 48, 128px)
├── dist/                       # Webpack output — load this folder in Chrome
├── package.json
├── tsconfig.json
├── .gitignore
└── LICENSE
```

## Development

### Watch mode

Webpack rebuilds the extension automatically when you save a file:

```bash
npm run dev
```

After each rebuild, go to `chrome://extensions` and click the **reload** button (↻) on the extension card to pick up the changes.

### One-shot build

```bash
npm run build
```

### Changing the WebSocket port

The default port is `7890`. If you change it on the MCP server side, update the constant here:

```ts
// src/shared/constants.ts
export const WEBSOCKET_URL = 'ws://localhost:7890';
```

Then rebuild and reload the extension.

## Important Notes

### Debugger Banner
When any DevTools feature is used (full-page screenshot, source reading, network logs, console, DOM/CSS modification, JS execution), Chrome shows a persistent **"Extension is debugging this browser"** banner at the top of the screen. This is a Chrome security requirement and cannot be suppressed. The debugger attaches lazily — only on the first DevTools tool call per tab.

### Service Worker Lifecycle
Chrome MV3 service workers terminate after ~30 seconds of inactivity. The extension keeps the WebSocket alive using `chrome.alarms` and reconnects automatically with exponential backoff (1 s → 2 s → 4 s → … → 30 s max) if the connection drops.

### Network Log Collection
Network log collection starts from when the debugger first attaches to a tab. To capture traffic from the beginning of a page load, call a DevTools tool (e.g. `execute_javascript`) before the navigation.


## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change, then submit a pull request.

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push and open a Pull Request

## Related

- [BrowserGenie MCP Server](https://github.com/BrowserGenie/mcp) — the MCP server that connects your AI client to this extension
- [Model Context Protocol](https://modelcontextprotocol.io) — the open protocol powering the integration

## License

[Apache License 2.0](LICENSE)
