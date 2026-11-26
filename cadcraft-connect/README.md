# CadCraft Connect

Mac menu-bar app that makes your local CadCraft usable from Claude in the browser.

```
Claude ──HTTPS──▶ Cloudflare Tunnel ──▶ 127.0.0.1:7391 (OAuth 2.1 bridge) ──in-process──▶ control port 127.0.0.1:7979 ──▶ CadCraft.app
```
**One click / one launch does everything.** It starts CadCraft with `--control 7979` (or reuses it if it's already
running that way), talks to it over the control port, and if CadCraft is closed later it relaunches it and reconnects on
the next request. No helper tabs, no `npx tsx`.

## What it does on first launch
1. **Logs into Cloudflare** through Cloudflare's MCP server (OAuth 2.1 + PKCE, system browser, loopback redirect, `state` checked). The login is encrypted at rest with a random AES-256 key stored in macOS Keychain.
2. Lists your active domains (asks which one if you have several).
3. Via Cloudflare MCP `execute`: creates tunnel `cadcraft-connect-xxxx`, sets its ingress to the local bridge, adds ONE proxied CNAME `cadcraft-xxxx.<your-domain>` (refuses to overwrite an existing record), fetches the run token.
4. Starts the bridge and `cloudflared` (token passed by environment variable, not argv).
5. Shows the connector URL: `https://cadcraft-xxxx.<your-domain>/mcp`.

In Claude: **Settings → Connectors → Add custom connector → paste the URL**.

## Requirements
- macOS and CadCraft.app in `/Applications` (otherwise select it in the app's dialog)
- A domain on Cloudflare (the tunnel needs a hostname). The Cloudflare login must allow: Cloudflare Tunnel (write), DNS (write), Zone (read).

## Native macOS app
The SwiftUI app in the repository root hosts this connection service directly. Build a distributable `.app` with:

```
./scripts/build-app.sh
```

The build machine needs Swift, Node 20+, and a `cloudflared` binary (or set `BUNDLED_NODE` and
`BUNDLED_CLOUDFLARED`). The resulting app bundles Node, the compiled service and its production
dependencies, and `cloudflared`; users do not need to install Node, npm packages, or `cloudflared`.
Build separately for each Mac architecture. Set `SIGNING_IDENTITY` to sign the app with a
Developer ID certificate for distribution; otherwise the script creates an ad-hoc signed app for
local testing.

GitHub tag releases (`v*`) are built on separate Intel and Apple Silicon runners and uploaded as
architecture-specific DMGs with an Applications shortcut for drag-to-install. Release automation requires these repository secrets: `MACOS_CERTIFICATE_P12_BASE64`,
`MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. The workflow signs and notarizes each app before
publishing it. A manual workflow run builds unsigned test artifacts and does not publish a release.

## Run
```
cd cadcraft-connect
npm ci
npm test             # service and control bridge tests
npm run cli -- start --zone example.com   # command-line development mode
npm run cli -- teardown                   # delete tunnel + DNS record
```
The distributed app uses the SwiftUI interface and is built by GitHub Actions into separate Intel
and Apple Silicon DMGs. Consumers do not run these npm commands.
Options: `--control-port 7979`, `--cadcraft-app /path/to/CadCraft.app/Contents/MacOS/CADCraft`.
Headless instead of the desktop app: `--stdio` (uses `cadcraft-cli mcp`; each process keeps its own drawing).

Tools Claude gets: `drawing_inspect`, `cmdline_script`, `cmdline_input`, `cmdline_key`, `cmdline_state`, `engine_commands`,
`engine_execute`, `ui_render`, `app_save`. These can run ANY CadCraft command, including saving files, so only approve
Claude sessions you trust.

## Auth design (public endpoint)
| Concern | What it does |
|---|---|
| Spec | MCP 2026-07-28 authorization: bridge is an OAuth 2.1 resource server; RFC 9728 protected-resource metadata + `WWW-Authenticate` challenge; RFC 8414 AS metadata |
| Client registration | Client ID Metadata Documents (current) and Dynamic Client Registration (deprecated, kept for compatibility). DCR only accepts Claude's callback URLs |
| Who may connect | **Nobody without a click on your Mac.** Each authorization shows a prompt in the app with a 6-digit code that must match the one in the browser |
| Tokens | PKCE S256 only; audience-bound to `https://host/mcp` (RFC 8707); 1 h access, 30 d refresh, refresh rotation with reuse-revokes-grant; stored only as SHA-256 hashes |
| Codes | 60 s, single use; burned if PKCE is attempted twice |
| CIMD fetch | HTTPS only, no redirects, 8 KB cap, 5 s timeout, private/loopback/link-local addresses blocked at connect time (SSRF/DNS-rebinding safe) |
| Redirects | `iss` returned on authorization responses (RFC 9207) |
| Other | Host-header allowlist, stateless (no sessions), CAD commands serialized, "Disconnect all Claude sessions", one-click teardown |

## Not verified (could not be tested where this was written)
- Real Cloudflare login/tunnel creation (the Cloudflare MCP call needed approval that wasn't given, so the provisioning code follows the OpenAPI schemas but has never run against an account)
- `cloudflared` startup and the signed/notarized GitHub release workflow
- (verified by you on a real Mac: Cloudflare login, tunnel creation, tunnel connect, control bridge)
- Auto-launching the real CadCraft.app and reconnect-after-quit are tested only against a fake control server
- That claude.ai accepts this server's OAuth metadata. The Claude callback URLs in `src/oauthServer.ts` (`TRUSTED_REDIRECTS`) should be checked against Anthropic's current docs
