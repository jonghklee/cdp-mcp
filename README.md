# cdp-mcp

An [MCP](https://modelcontextprotocol.io) server that wraps the **Chrome DevTools Protocol (CDP)** so AI agents can drive a real Chrome browser — and, unusually, **inspect and QA-test unpacked Chrome extensions** (service worker, `chrome.storage`, IndexedDB) directly.

> Most CDP MCP servers stop at "control a page." This one adds a Chrome-**extension** layer: attach to a service worker, read/write extension storage, and run scripted QA flows against your own extension.

## Why this exists

There are already many "control Chrome over CDP" MCP servers. The distinctive part here is the **extension QA layer**:

| Layer | Tools | What it does |
|-------|-------|--------------|
| **Core** (`cdp_*`) | navigate, click, type, screenshot, evaluate, network capture/intercept… | Generic, framework-free browser control |
| **Intelligence** (`site_*`) | site profiles | Accumulates per-site knowledge (selectors, auth shape, structure) |
| **QA** (`qa_*`) | scripted flows | Verifies extension behaviour end-to-end |
| **Extension** (`ext_*`) | `cdp_ext_attach`, `cdp_ext_idb`, `ext_qaqc_list`, `ext_qaqc_invoke` | Attach to a service worker, drive `chrome.storage` / IndexedDB |

Dependency direction: `QA → Extension → Intelligence → Core`. pnpm monorepo, TypeScript strict.

## ⚠️ Security note — read before running

This server can **copy your existing Chrome profile** (`Cookies`, `Login Data`, `Web Data`, extension settings) into a dedicated CDP profile under `~/.cdp-mcp/chrome-profiles/`, so the launched Chrome inherits your logged-in sessions and installed extensions.

- This is a **local convenience feature** — it copies *your own* profile on *your own* machine. Nothing is uploaded anywhere.
- But it means the spawned Chrome is logged into your accounts. Run it only on a machine you trust, and be aware that any agent connected to this MCP can act as you in the browser.
- The source profile is read from the OS default location via `os.homedir()` (macOS / Windows / Linux). It is **never** hardcoded.
- `cdp-mcp` never kills your Chrome — it only manages its own locked instance and releases the lock on disconnect.

## Requirements

- Node.js ≥ 22
- pnpm
- Google Chrome (or Chrome Canary)

## Install & build

```bash
pnpm install
pnpm -r build      # builds packages/core → dist/
```

## Configure your MCP client

Copy the example config and fill in absolute paths for your machine:

```bash
cp .mcp.json.example .mcp.json
```

```jsonc
{
  "mcpServers": {
    "cdp-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/extension-cdp-mcp/packages/core/dist/server.js"],
      "env": {
        "CDP_MCP_PORT": "9250",
        "CDP_MCP_EXTENSIONS": "/absolute/path/to/your/unpacked-extension"
      }
    }
  }
}
```

`.mcp.json` is git-ignored because it holds machine-specific absolute paths — keep your own copy local.

### Port convention

- `cdp-mcp` uses ports **9250–9278** (`CDP_MCP_PORT`, default `9250`).
- The official `chrome-devtools-mcp` uses 9222 — these never collide, so both can run side by side.
- `cdp-mcp` only ever reconnects to a Chrome instance it holds the lock for; it will not attach to someone else's Chrome.

## Tools (Core)

| Group | Tools |
|-------|-------|
| Navigation / tabs | `cdp_navigate`, `cdp_navigate_and_wait`, `cdp_create_tab`, `cdp_close_tab`, `cdp_list_tabs`, `cdp_switch_tab`, `cdp_page_info` |
| Interaction | `cdp_click`, `cdp_type`, `cdp_press_key`, `cdp_fill_form`, `cdp_select_text`, `cdp_clipboard`, `cdp_upload_file`, `cdp_open_popup`, `cdp_focus_chrome` |
| Observe | `cdp_screenshot`, `cdp_evaluate`, `cdp_console_capture`, `cdp_get_console_message` |
| Network | `cdp_list_network_requests`, `cdp_network_capture`, `cdp_network_intercept`, `cdp_wait_for_request` |
| Extensions | `cdp_list_extensions`, `cdp_reload_extension`, `cdp_ext_attach`, `cdp_ext_idb`, `ext_qaqc_list`, `ext_qaqc_invoke` |
| Connection | `cdp_reconnect` |

Four execution contexts are supported: `page`, `content_script`, `service_worker`, `popup`.

## Extension QA bridge

The `ext_qaqc_*` tools inject a small **bridge script** into an extension's service worker, exposing named commands that read/write that extension's `chrome.storage` and IndexedDB — so an agent can set up fixtures, assert state, and tear down between test runs.

The bridge scripts themselves are **product-specific** and are not included in this repo (they live under a git-ignored `products/` directory). To target your own extension, write a bridge that implements the commands you need and point `ext_qaqc_list(extensionId, bridgePath)` at it.

## Develop

```bash
pnpm test          # vitest unit tests
pnpm inspect       # MCP Inspector
pnpm test:e2e      # connect to Chrome + hit real sites
```

## License

MIT
