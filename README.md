# CadCraft Connect

CadCraft Connect exposes a local CadCraft desktop session to Claude through a Cloudflare Tunnel
and an authenticated MCP bridge.

## What it does

- Starts CadCraft with its local control interface, or reconnects to an existing session.
- Signs in to Cloudflare using the system browser and creates a tunnel for a domain you choose.
- Shows the connector URL to add in Claude under **Settings → Connectors → Add custom connector**.
- Requires your approval for every new client. Check the browser's six-digit code against the
  request shown in the app before approving it.

The SwiftUI app bundles Node.js, its production dependencies, and `cloudflared`. Users do not need
to install Node, npm packages, or `cloudflared`. CadCraft.app, a Cloudflare account with a domain,
and network access are still required.

## Releases

GitHub Actions builds separate Apple Silicon (`arm64`) and Intel (`x86_64`) DMGs when a version tag
is pushed. **Pushing `main` alone does not publish a release**, so the Releases page stays empty
until the first tagged release completes.

Before tagging a release, add these repository secrets under **Settings → Secrets and variables →
Actions**:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `MACOS_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Then push a version tag, for example:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow builds, signs, notarizes, and publishes both DMGs on the GitHub Releases page. A
manual **workflow_dispatch** run creates unsigned test DMGs as workflow artifacts; it does not
publish a release.

## Development

Build the app bundle locally with `./scripts/build-app.sh`. The build machine needs Swift, Node.js
20+, and `cloudflared`; these are bundled into the resulting app. For service tests and development
commands, see [`cadcraft-connect/README.md`](./cadcraft-connect/README.md).

## Security

Cloudflare credentials are encrypted with an AES-256 key stored in macOS Keychain. OAuth tokens for
Claude are stored as hashes. Approve only clients you recognize, and only when their displayed
authorization code matches the code in the browser. Approved clients can issue CadCraft commands,
including commands that save or modify drawings.
