/**
 * OAuth 2.1 client login to a remote MCP server (used for Cloudflare's MCP).
 * Native-app best practice (RFC 8252): system browser + loopback redirect, PKCE (done by the SDK),
 * a random `state` that we verify, tokens sealed at rest with the Vault (macOS Keychain in the app).
 */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Store, Vault } from "./state.js";

export interface LoginOptions {
  serverUrl: string; store: Store; vault: Vault;
  openUrl: (url: string) => Promise<void>;
  /** Fixed port: the registered redirect URI must stay the same between runs. */
  callbackPort: number;
  /** Test hook: allow http:// authorization URLs (loopback only) */
  allowInsecureLoopback?: boolean;
}

export class McpLogin implements OAuthClientProvider {
  private verifier = ""; private expectedState = "";
  constructor(private o: LoginOptions) {}

  get redirectUrl() { return `http://127.0.0.1:${this.o.callbackPort}/callback`; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "CadCraft Connect", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() { return (this.expectedState = randomBytes(24).toString("base64url")); }

  private get slot() { return (this.o.store.s.cloudflare ??= {}); }
  private read<T>(k: "clientInfo" | "tokens"): T | undefined {
    const v = this.slot[k]; if (!v) return undefined;
    try { return JSON.parse(this.o.vault.open(v)); } catch { return undefined; }
  }
  private write(k: "clientInfo" | "tokens", v: unknown) { this.slot[k] = this.o.vault.seal(JSON.stringify(v)); this.o.store.save(); }
  clientInformation() { return this.read<OAuthClientInformationMixed>("clientInfo"); }
  saveClientInformation(i: OAuthClientInformationMixed) { this.write("clientInfo", i); }
  tokens() { return this.read<OAuthTokens>("tokens"); }
  saveTokens(t: OAuthTokens) { this.write("tokens", t); }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") delete this.slot.tokens;
    if (scope === "all" || scope === "client") delete this.slot.clientInfo;
    this.o.store.save();
  }
  logout() { delete this.o.store.s.cloudflare; this.o.store.save(); }

  async redirectToAuthorization(url: URL) {
    const ok = url.protocol === "https:" || (this.o.allowInsecureLoopback && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
    if (!ok) throw new Error("Refusing to open a non-HTTPS authorization URL");
    await this.o.openUrl(url.toString());
  }

  /** Listens on loopback for the redirect. Started BEFORE connecting, because the SDK redirects during connect. */
  private listenForCode() {
    let resolve!: (c: string) => void, reject!: (e: Error) => void;
    const code = new Promise<string>((a, b) => { resolve = a; reject = b; });
    code.catch(() => undefined);
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", this.redirectUrl);
      const hostOk = [`127.0.0.1:${this.o.callbackPort}`, `localhost:${this.o.callbackPort}`].includes(req.headers.host ?? "");
      if (u.pathname !== "/callback" || !hostOk) { res.writeHead(404).end(); return; }
      const got = Buffer.from(u.searchParams.get("state") ?? ""), want = Buffer.from(this.expectedState);
      const stateOk = got.length === want.length && want.length > 0 && timingSafeEqual(got, want);
      const err = u.searchParams.get("error"), c = u.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;margin:20vh auto;max-width:28rem"><h3>${stateOk && c && !err ? "Connected. You can close this tab." : "Login failed. Return to CadCraft Connect and try again."}</h3>`);
      if (!stateOk) return reject(new Error("OAuth state mismatch"));
      if (err) return reject(new Error(`Authorization failed: ${err}`));
      if (c) resolve(c);
    });
    const timer = setTimeout(() => reject(new Error("Login timed out")), 5 * 60_000);
    const ready = new Promise<void>((r, j) => { srv.once("error", j); srv.listen(this.o.callbackPort, "127.0.0.1", () => r()); });
    return { ready, code, close: () => { clearTimeout(timer); srv.close(); } };
  }

  async connect(): Promise<Client> {
    const cb = this.listenForCode();
    try {
      await cb.ready;
      const make = () => new StreamableHTTPClientTransport(new URL(this.o.serverUrl), { authProvider: this });
      const client = new Client({ name: "cadcraft-connect", version: "0.1.0" });
      const transport = make();
      try { await client.connect(transport); return client; }
      catch (e) { if (!(e instanceof UnauthorizedError)) throw e; }
      await transport.finishAuth(await cb.code);
      const client2 = new Client({ name: "cadcraft-connect", version: "0.1.0" });
      await client2.connect(make());
      return client2;
    } finally { cb.close(); }
  }
}
