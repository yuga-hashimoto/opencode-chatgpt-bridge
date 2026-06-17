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

## Features

- Streamable HTTP MCP endpoint at `/mcp` for ChatGPT connectors and MCP clients.
- Per-repository `opencode serve` process management.
- Safe repository allow-listing with realpath checks.
- Optional bridge bearer token for exposed/tunneled use.
- Persistent bridge session mapping in `~/.opencode-chatgpt-bridge/sessions.json`.
- Tools for session creation, async prompts, polling, message retrieval, diff review, abort, permission responses, file reads, file search, VCS status, agents, and slash commands.
- Optional Cloudflare quick tunnel launcher.
- TypeScript, strict typecheck, and unit tests.

## Requirements

- Node.js 20+
- pnpm 10+
- `opencode` installed and authenticated locally
- For ChatGPT mobile use: an HTTPS endpoint via Cloudflare Tunnel, ngrok, Tailscale Funnel, or your own deployment

Check opencode:

```bash
opencode --version
```

## Install from source

```bash
git clone https://github.com/yuga-hashimoto/opencode-chatgpt-bridge.git
cd opencode-chatgpt-bridge
pnpm install
pnpm run build
```

## Configure

Copy the example env file:

```bash
cp .env.example .env
```

Recommended minimum config:

```bash
OPENCODE_BRIDGE_HOST=127.0.0.1
OPENCODE_BRIDGE_PORT=8787
OPENCODE_BRIDGE_TOKEN=replace-with-a-long-random-token
OPENCODE_BRIDGE_ALLOWED_ROOTS=/Users/me/dev:/Volumes/MOVESPEED/Documents/GitHub
OPENCODE_BIN=opencode
```

`OPENCODE_BRIDGE_ALLOWED_ROOTS` is mandatory for safety in real use. Only repositories under those roots can be opened.

## Run locally

```bash
pnpm start
```

The server prints:

```text
opencode-chatgpt-bridge listening at http://127.0.0.1:8787
MCP endpoint: http://127.0.0.1:8787/mcp
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Expose to ChatGPT

ChatGPT connectors need an HTTPS URL. During development, you can use Cloudflare quick tunnel:

```bash
OPENCODE_BRIDGE_TUNNEL=cloudflare pnpm start
```

The bridge will print a public URL like:

```text
Public MCP endpoint: https://example.trycloudflare.com/mcp
```

Use that `/mcp` URL as the ChatGPT connector URL. If `OPENCODE_BRIDGE_TOKEN` is set, configure the connector/client to send:

```text
Authorization: Bearer <your-token>
```

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
- `opencode_capabilities` - list opencode agents and slash commands.

## Example ChatGPT prompt

```text
Use opencode-chatgpt-bridge.
List projects, open /Volumes/MOVESPEED/Documents/GitHub/my-repo,
create an opencode session, ask opencode to fix the README,
poll until idle, then show me the diff.
```

## Security model

This bridge can cause local code modifications through opencode. Treat it as a local automation gateway.

Default protections:

- `opencode` itself is bound to `127.0.0.1`.
- Repositories must be under `OPENCODE_BRIDGE_ALLOWED_ROOTS`.
- The bridge supports bearer-token authentication.
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
