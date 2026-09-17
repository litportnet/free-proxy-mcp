<!-- shared-readme:banner:start -->
[![Litport free proxies: live lists, API and SDKs](https://raw.githubusercontent.com/litportnet/free-proxy-sdk/main/assets/free-proxy-banner-static.png)](https://litport.net/free-proxy)
<!-- shared-readme:banner:end -->

# Litport Free Proxy MCP Server

A local, stdio [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP
client (Claude Desktop, Claude Code, or any other MCP-compatible agent) three bounded, read-only
tools over Litport's public free-proxy snapshot: list verified HTTP, SOCKS4, and SOCKS5 proxies,
pick the highest-ranked ones, and summarize the current snapshot. It never forwards traffic, never
accepts arbitrary URLs from tool callers, and exposes no write or side-effecting tools; it is a thin
wrapper around [`@litportnet/free-proxy-sdk`](https://github.com/litportnet/free-proxy-sdk).

## Install / Use with Claude Desktop, Claude Code, and other MCP clients

Add this to your client's MCP server configuration (for Claude Desktop, `claude_desktop_config.json`;
for Claude Code, `.mcp.json` or `claude mcp add`):

```json
{
  "mcpServers": {
    "free-proxy": {
      "command": "npx",
      "args": ["-y", "@litportnet/free-proxy-mcp"]
    }
  }
}
```

No installation step is required beyond having Node.js 20+ available; `npx` fetches and runs the
package on demand. To install it explicitly instead:

```sh
npm install -g @litportnet/free-proxy-mcp
```

## Tools

All three tools are read-only and share the same underlying filters. `country` is a two-letter ISO
3166-1 alpha-2 code (case-insensitive). `checkedWithinMin` limits results to proxies checked within
the last 1-1440 minutes.

| Tool | Description | Inputs |
| --- | --- | --- |
| `list_proxies` | List verified free proxies matching filters. | `protocol` (`http`\|`socks4`\|`socks5`), `country`, `anonymity` (`transparent`\|`anonymous`\|`elite`\|`unknown`), `https` (boolean), `maxLatencyMs` (int ≥ 0), `minUptime7d` (int 0-100), `minChecks7d` (int ≥ 0), `checkedWithinMin` (int 1-1440, default 30), `limit` (int 1-50, default 10) |
| `pick_best_proxies` | Return the highest-ranked proxies matching filters. | `count` (int 1-25, default 5), plus the same filters as `list_proxies` except `limit` |
| `proxy_snapshot_stats` | Summarize the current proxy snapshot. | `checkedWithinMin` (int 1-1440, default 30), `protocol`, `country` |

`list_proxies` and `pick_best_proxies` return a `count` and a `proxies` array of normalized records
exactly as returned by the SDK. `proxy_snapshot_stats` returns the total matching count, counts by
protocol and anonymity, the top 10 countries by count, the share of matching proxies that support
HTTPS, latency min/median/p90/max across records that report latency, how many records have a known
seven-day uptime, and the newest and oldest `lastChecked` timestamps. Every response includes a
`disclaimer` field. Errors from the underlying SDK (invalid filters, request timeouts, malformed or
stale snapshots) are returned as `{ isError: true, content: [...] }` rather than thrown, and never
include a stack trace.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `LITPORT_FREE_PROXY_API_URL` | the SDK's built-in snapshot URL | Absolute `http://` or `https://` URL for the snapshot endpoint. The server validates this and exits with a clear error on startup if it is set to something else. |
| `LITPORT_FREE_PROXY_TIMEOUT_MS` | `10000` | Per-request timeout in milliseconds passed to the SDK client. |

## Test

```sh
npm install
npm test
```

`npm test` runs `node --test` over `test/*.test.mjs`: in-process unit tests that drive the server
through the MCP SDK's in-memory transport with an injected `@litportnet/free-proxy-sdk` client, and
an end-to-end test that spawns the server over stdio against a local HTTP fixture server, plus a
regression test that launches the server through a `bin` symlink the way `npx` does.

## Resources

- [Free proxy list](https://litport.net/free-proxy)
- [API documentation](https://litport.net/docs/free-proxy-api)
- [SDK source](https://github.com/litportnet/free-proxy-sdk)

Free proxies are for testing only. Never route credentials, cookies, payment data, or private data through them.
