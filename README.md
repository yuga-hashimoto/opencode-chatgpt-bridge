# opencode-chatgpt-bridge

A standalone local MCP bridge that lets ChatGPT control `opencode` sessions running on your own computer.

```text
ChatGPT / ChatGPT Mobile
  -> HTTPS tunnel
  -> opencode-chatgpt-bridge /mcp
  -> local opencode serve
  -> local repository
```

This project is intentionally separate from LocalAnt. It is focused only on the ChatGPT <-> opencode bridge use case.

## Quick start

```bash
git clone https://github.com/yuga-hashimoto/opencode-chatgpt-bridge.git
cd opencode-chatgpt-bridge
pnpm install
pnpm run build
pnpm run init -- --allowed-roots /Volumes/MOVESPEED/Documents/GitHub
pnpm start
```

`init` creates a ready-to-use `.env` with a random bridge token, your allowed repo roots, automatic port fallback, and Cloudflare quick tunnel enabled by default.

When the bridge starts, it prints a setup guide with:

- local health URL
- local MCP URL
- automatic fallback port when the preferred port is already in use
- public HTTPS MCP URL when tunnel is enabled
- ChatGPT settings link
- connector name, description, and URL to paste
- header auth and URL-token fallback
- opencode CLI status and setup notes
- first ChatGPT prompt to try

## Requirements

- Node.js 20+
- pnpm 10+
- `opencode` installed and authenticated locally
- `cloudflared` for the default tunnel flow, or your own HTTPS tunnel

Check opencode:

```bash
opencode --version
opencode
```

Run `opencode` once inside a repo and make sure your model provider is configured before expecting ChatGPT to drive it. The bridge starts `opencode serve` for each repo and talks to it over HTTP. After creating a bridge session, call `opencode_capabilities` from ChatGPT to inspect connected providers, available auth methods, and default model configuration.

## Commands

```bash
opencode-chatgpt-bridge init --allowed-roots /path/to/repos
opencode-chatgpt-bridge start
opencode-chatgpt-bridge doctor
```

From source, use pnpm:

```bash
pnpm run init -- --allowed-roots /path/to/repos
pnpm start
pnpm run doctor
```

## ChatGPT setup

Open ChatGPT Web and go to:

```text
https://chatgpt.com/#settings/Connectors
```

Manual path:

```text
Settings -> Apps & Connectors -> Advanced settings -> enable Developer mode
Settings -> Connectors -> Create
```

Use the values printed by the bridge. They look like this:

```text
Connector name: opencode local bridge
Description: Control local opencode sessions, inspect diffs, and manage local coding tasks.
Connector URL: https://example.trycloudflare.com/mcp?token=<generated-token>
```

If your ChatGPT connector UI supports auth headers, you can use the plain `/mcp` URL and set:

```text
Authorization: Bearer <OPENCODE_BRIDGE_TOKEN>
```

If not, use the printed `?token=` URL fallback.

Once linked on ChatGPT Web, the connector should be available in ChatGPT mobile apps as well.

## opencode setup

No extra opencode project configuration is required by the bridge, but opencode itself must be usable locally.

The bridge starts opencode like this:

```bash
OPENCODE_SERVER_USERNAME=opencode \
OPENCODE_SERVER_PASSWORD=<generated-or-env-password> \
opencode serve --hostname 127.0.0.1 --port <auto>
```

Notes:

- If `OPENCODE_SERVER_PASSWORD` is not set, the bridge generates a random password per managed opencode server.
- If `OPENCODE_BASE_URL` is set, the bridge uses that existing opencode server instead of spawning one.
- The opencode server is kept on `127.0.0.1`; only the bridge is exposed to ChatGPT.
- Provider/model login is handled by opencode. Run `opencode` in a terminal first and confirm it can answer/edit before using ChatGPT.

## Features

- Streamable HTTP MCP endpoint at `/mcp` for ChatGPT connectors and MCP clients.
- Per-repository `opencode serve` process management.
- Safe repository allow-listing with realpath checks.
- Bridge bearer token for exposed/tunneled use.
- URL-token fallback for connector UIs that do not support custom headers.
- Persistent bridge session mapping in `~/.opencode-chatgpt-bridge/sessions.json`.
- Tools for session creation, async prompts, polling, message retrieval, diff review, abort, permission responses, file reads, file search, VCS status, agents, slash commands, and provider/model diagnostics.
- Optional Cloudflare quick tunnel launcher.
- TypeScript, strict typecheck, and unit tests.

## MCP tools

### Bridge and project tools

- `bridge_health` - inspect bridge config and managed opencode processes.
- `list_projects` - list Git repos under the allowed roots.

### opencode process/session tools

- `opencode_start` - start or reuse an `opencode serve` process for a repo.
- `opencode_stop` - stop one or all managed opencode servers.
- `opencode_create_session` - create a new opencode session and return a `bridgeSessionId`.
- `opencode_list_sessions` - list bridge sessions known to this bridge.
- `opencode_get_session_status` - poll status for a session.
- `opencode_send_message` - send a prompt; defaults to async mode.
- `opencode_get_messages` - fetch session transcript/messages.
- `opencode_get_diff` - fetch file diffs for a session.
- `opencode_abort` - abort a running session.
- `opencode_respond_permission` - respond to opencode permission prompts.

### project inspection tools

- `opencode_read_file` - read a file through opencode.
- `opencode_find_files` - fuzzy-find files through opencode.
- `opencode_vcs_status` - get VCS and file status.
- `opencode_capabilities` - list opencode agents, slash commands, providers, auth methods, and default model config.

## Example ChatGPT prompt

```text
Use opencode local bridge. First call bridge_health and list_projects.
Then create a session for /Volumes/MOVESPEED/Documents/GitHub/my-repo,
ask opencode to fix the README, poll status, and show opencode_get_diff.
```

## Security model

This bridge can cause local code modifications through opencode. Treat it as a local automation gateway.

Default protections:

- `opencode` itself is bound to `127.0.0.1`.
- Repositories must be under `OPENCODE_BRIDGE_ALLOWED_ROOTS`.
- The bridge supports bearer-token authentication and URL-token fallback.
- No arbitrary shell execution tool is exposed by this bridge.
- Diffs are first-class so clients can inspect changes before committing.

Strongly recommended:

- Always set `OPENCODE_BRIDGE_TOKEN` before exposing through any tunnel.
- Do not bind the bridge to `0.0.0.0` unless you know exactly what network can reach it.
- Keep `OPENCODE_BRIDGE_ALLOWED_ROOTS` narrow.
- Review `opencode_get_diff` before committing or pushing generated changes.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run validate
```

## License

MIT
