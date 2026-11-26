# CadCraft Connect

Native macOS app that makes CadCraft Studio's official MCP tools available to Claude through an
authenticated Cloudflare Tunnel.

```
Claude ──HTTPS──▶ Cloudflare Tunnel ──▶ OAuth 2.1 bridge ──stdio──▶ @getcadcraft/mcp ──authenticated loopback──▶ CadCraft Studio
```
**Connect first, open Studio on demand.** Cloudflare sign-in, tunnel setup, and tool discovery do not
launch the CAD app. While Studio is closed, the bridge exposes `studio_status`. When an agent calls
that tool, Connect reuses the installed Studio app or downloads the latest official release,
verifies its published SHA-256 digest and macOS signature, installs it in `~/Applications`, and
opens it. Studio's tools become available after the MCP bridge refreshes; the agent may need to
refresh its tool list and retry. Existing Studio installations are not replaced.

CadCraft Connect checks its GitHub releases for updates daily and offers manual checks plus verified
in-app update installation in **Security & setup**. Installing an update replaces the app bundle and
restarts it. Startup-at-login is opt-in and can be changed there.

## What it does on first launch
1. **Logs into Cloudflare** through Cloudflare's MCP server (OAuth 2.1 + PKCE, system browser, loopback redirect, `state` checked). The login is encrypted at rest with a random AES-256 key stored in macOS Keychain.
2. Lists your active domains (asks which one if you have several).
3. Via Cloudflare MCP `execute`: creates tunnel `cadcraft-connect-xxxx`, sets its ingress to the local bridge, adds ONE proxied CNAME `cadcraft-xxxx.<your-domain>` (refuses to overwrite an existing record), fetches the run token.
4. Starts the bridge and `cloudflared` (token passed by environment variable, not argv).
5. Shows the connector URL: `https://cadcraft-xxxx.<your-domain>/mcp`.

In Claude: **Settings → Connectors → Add custom connector → paste the URL**.

## Requirements
- macOS; CadCraft Studio is installed automatically on the first `studio_status` call if missing
- A domain on Cloudflare (the tunnel needs a hostname). The Cloudflare login must allow: Cloudflare Tunnel (write), DNS (write), Zone (read).

## Native macOS app
The SwiftUI app in the repository root hosts this connection service directly. Build a distributable `.app` with:

```
./scripts/build-app.sh
```

The build machine needs Swift, Node 20.19+, and a `cloudflared` binary (or set `BUNDLED_NODE` and
`BUNDLED_CLOUDFLARED`). The resulting app bundles Node, the compiled service and its production
dependencies, and `cloudflared`; users do not need to install Node, npm packages, or `cloudflared`.
Build separately for each Mac architecture. Set `SIGNING_IDENTITY` to sign the app with a
Developer ID certificate for distribution; otherwise the script creates an ad-hoc signed app for
local testing.

GitHub tag releases (`v*`) are built on separate Intel and Apple Silicon runners and uploaded as
architecture-specific, ad-hoc-signed DMGs with an Applications shortcut for drag-to-install. No
Apple Developer account or signing secrets are required. macOS will show an unverified developer
warning when users first open the app; they can control-click it and choose **Open** to proceed. A
manual workflow run builds test artifacts and does not publish a release.

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
By default, the CLI also connects to official CadCraft Studio. The legacy `--control-port 7979`
and `--cadcraft-app` options select the older control-port integration. For a custom headless MCP
server, use `--stdio` (or `CADCRAFT_CMD`).

Studio determines the tools exposed to Claude. They can modify or save drawings, so only approve
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
- Installing and launching the real CadCraft Studio release requires validation on a Mac with network access
- That claude.ai accepts this server's OAuth metadata. The Claude callback URLs in `src/oauthServer.ts` (`TRUSTED_REDIRECTS`) should be checked against Anthropic's current docs
