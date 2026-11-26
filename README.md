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
until the first tagged release completes. The app is ad-hoc signed, not notarized, so macOS will
show an **unverified developer** warning when it is first opened.

No Apple Developer account or signing secrets are required. To publish a release, push a version
tag, for example:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow builds and publishes both DMGs on the GitHub Releases page. When installing, drag the
app to Applications, then control-click it and choose **Open** to confirm you want to run it. A
manual **workflow_dispatch** run creates test DMGs as workflow artifacts; it does not publish a
release.

## Development

Build the app bundle locally with `./scripts/build-app.sh`. The build machine needs Swift, Node.js
20+, and `cloudflared`; these are bundled into the resulting app. For service tests and development
commands, see [`cadcraft-connect/README.md`](./cadcraft-connect/README.md).

## Security

Cloudflare credentials are encrypted with an AES-256 key stored in macOS Keychain. OAuth tokens for
Claude are stored as hashes. Approve only clients you recognize, and only when their displayed
authorization code matches the code in the browser. Approved clients can issue CadCraft commands,
including commands that save or modify drawings.
