/**
 * OAuth 2.1 authorization server for the public MCP endpoint.
 *
 *  - Claude registers via Client ID Metadata Documents (CIMD, current spec) or
 *    Dynamic Client Registration (deprecated, kept for compatibility).
 *  - PKCE (S256) is mandatory; tokens are bound to our resource URL (RFC 8707).
 *  - There is NO password. Every authorization has to be approved by the person at the Mac.
 *  - Tokens, codes and refresh tokens are stored as SHA-256 hashes only.
 *  - Refresh tokens rotate; re-use of an old one revokes the whole grant.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import https from "node:https";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Store } from "./state.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rand = () => randomBytes(32).toString("base64url");

export const SCOPE = "cadcraft";
const CODE_TTL = 60_000, ACCESS_TTL = 3600_000, REFRESH_TTL = 30 * 86400_000, PENDING_TTL = 5 * 60_000;
const MAX_CLIENTS = 25, MAX_PENDING = 5;

/** Hosts we recognise as Claude. Anything else is shown to the user as "unrecognised". */
const TRUSTED_REDIRECTS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

export interface PendingApproval {
  id: string; clientName: string; redirectHost: string; trusted: boolean;
  matchCode: string; createdAt: number;
}
interface Pending extends PendingApproval {
  clientId: string; redirectUri: string; state?: string; codeChallenge: string;
  status: "pending" | "approved" | "denied"; redirect?: string;
}
interface Code { clientId: string; redirectUri: string; challenge: string; grant: string; exp: number; challenged?: boolean }

// ---------- SSRF-safe fetching of Client ID Metadata Documents ----------
const priv = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) priv.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) priv.addSubnet(a, p, "ipv6");
export function isPublicAddress(addr: string): boolean {
  const v4mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const a = v4mapped ? v4mapped[1] : addr;
  const fam = isIP(a);
  return fam !== 0 && !priv.check(a, fam === 4 ? "ipv4" : "ipv6");
}
/** Validates the address at connect time, which also closes the DNS-rebinding gap. */
const safeLookup: typeof dnsLookup = ((host: string, opts: any, cb: any) => {
  dnsLookup(host, { ...opts, all: true }, (err, addrs: any) => {
    if (err) return cb(err);
    const ok = addrs.filter((x: any) => isPublicAddress(x.address));
    if (!ok.length) return cb(new Error("blocked: non-public address"));
    opts?.all ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
  });
}) as any;

function fetchSmallJson(url: URL): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { lookup: safeLookup, timeout: 5000, headers: { accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); } // no redirects
      let n = 0; const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => { n += c.length; if (n > 8192) { req.destroy(new Error("too large")); } else chunks.push(c); });
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

export interface ProviderOptions {
  store: Store;
  /** https://host/mcp: the audience tokens are bound to */
  resourceUrl: string;
  issuer: string;
  /** Allow http://localhost redirects (tests / local mode only) */
  allowLoopbackRedirects?: boolean;
}

export class LocalOAuthProvider extends EventEmitter implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  private cimdCache = new Map<string, { at: number; info: OAuthClientInformationFull }>();
  constructor(private o: ProviderOptions) { super(); }

  private redirectOk(uri: string): boolean {
    if (TRUSTED_REDIRECTS.has(uri)) return true;
    try {
      const u = new URL(uri);
      if (u.hash) return false;
      if (u.protocol === "https:") return true;
      return !!this.o.allowLoopbackRedirects && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    } catch { return false; }
  }

  /** DCR is open to the whole internet: Claude's callbacks only (plus loopback in dev/test). */
  private dcrRedirectOk(uri: string): boolean {
    if (TRUSTED_REDIRECTS.has(uri)) return true;
    if (!this.o.allowLoopbackRedirects) return false;
    try { const u = new URL(uri); return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname); } catch { return false; }
  }

  // ---- clients: registered (DCR) or fetched (CIMD) ----
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (id) => {
        if (id.startsWith("https://")) return this.cimd(id);
        return this.o.store.s.clients[id];
      },
      registerClient: (meta) => {
        // DCR is open to the internet, so only accept Claude's callbacks (or loopback in dev).
        const uris = meta.redirect_uris ?? [];
        if (!uris.length || uris.length > 5 || !uris.every((u) => this.dcrRedirectOk(String(u))))
          throw new InvalidClientMetadataError("redirect_uris not allowed");
        const clients = this.o.store.s.clients;
        const ids = Object.keys(clients);
        if (ids.length >= MAX_CLIENTS) delete clients[ids[0]]; // evict oldest
        const full = { ...meta, client_id: "dcr_" + rand(), client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: String(meta.client_name ?? "Unnamed client").slice(0, 80) } as OAuthClientInformationFull;
        clients[full.client_id] = full;
        this.o.store.save();
        return full;
      },
    };
  }

  private async cimd(id: string): Promise<OAuthClientInformationFull | undefined> {
    const hit = this.cimdCache.get(id);
    if (hit && Date.now() - hit.at < 3600_000) return hit.info;
    let url: URL;
    try { url = new URL(id); } catch { return undefined; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/" || isIP(url.hostname.replace(/^\[|\]$/g, ""))) return undefined;
    try {
      const doc = (await fetchSmallJson(url)) as any;
      if (doc.client_id !== id || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || doc.redirect_uris.length > 10) return undefined;
      if (!doc.redirect_uris.every((u: unknown) => typeof u === "string" && this.redirectOk(u))) return undefined;
      if (doc.client_secret || (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== "none")) return undefined; // public clients only
      const info: OAuthClientInformationFull = {
        client_id: id, redirect_uris: doc.redirect_uris, token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        client_name: String(doc.client_name ?? url.hostname).slice(0, 80),
      };
      this.cimdCache.set(id, { at: Date.now(), info });
      return info;
    } catch { return undefined; }
  }

  // ---- /authorize: park the request until a human approves it on the Mac ----
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const fail = (error: string) => res.redirect(302, this.redirectTo(params.redirectUri, { error, state: params.state }));
    if (params.resource && params.resource.href.replace(/\/$/, "") !== this.o.resourceUrl.replace(/\/$/, "")) return fail("invalid_target");
    for (const [k, p] of this.pending) if (Date.now() - p.createdAt > PENDING_TTL) this.pending.delete(k);
    if (this.pending.size >= MAX_PENDING) { res.status(429).type("text/plain").send("Too many pending requests. Try again in a few minutes."); return; }

    const id = rand();
    const matchCode = String(randomInt(0, 1_000_000)).padStart(6, "0").replace(/(\d{3})(\d{3})/, "$1 $2");
    const p: Pending = {
      id, clientId: client.client_id, clientName: client.client_name ?? "Unnamed client",
      redirectUri: params.redirectUri, redirectHost: new URL(params.redirectUri).host,
      trusted: TRUSTED_REDIRECTS.has(params.redirectUri), state: params.state, codeChallenge: params.codeChallenge,
      matchCode, createdAt: Date.now(), status: "pending",
    };
    this.pending.set(id, p);
    this.emit("approval", this.publicView(p));
    res.status(200).setHeader("Cache-Control", "no-store").type("html").send(this.page(p));
  }
  private publicView(p: Pending): PendingApproval {
    const { id, clientName, redirectHost, trusted, matchCode, createdAt } = p; return { id, clientName, redirectHost, trusted, matchCode, createdAt };
  }
  listPending(): PendingApproval[] { return [...this.pending.values()].filter((p) => p.status === "pending").map((p) => this.publicView(p)); }

  /** Called by the Mac app / CLI after the human clicks Approve or Deny. */
  decide(id: string, approve: boolean): boolean {
    const p = this.pending.get(id);
    if (!p || p.status !== "pending" || Date.now() - p.createdAt > PENDING_TTL) return false;
    if (!approve) { p.status = "denied"; p.redirect = this.redirectTo(p.redirectUri, { error: "access_denied", state: p.state }); return true; }
    const code = rand();
    this.codes.set(sha(code), { clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.codeChallenge, grant: rand(), exp: Date.now() + CODE_TTL });
    p.status = "approved";
    p.redirect = this.redirectTo(p.redirectUri, { code, state: p.state });
    return true;
  }
  /** Polled by the waiting browser page. The redirect is handed out once. */
  poll(id: string): { status: string; redirect?: string } {
    const p = this.pending.get(id);
    if (!p || Date.now() - p.createdAt > PENDING_TTL) { this.pending.delete(id); return { status: "expired" }; }
    if (p.status === "pending") return { status: "pending" };
    this.pending.delete(id);
    return { status: p.status, redirect: p.redirect };
  }
  private redirectTo(base: string, q: Record<string, string | undefined>): string {
    const u = new URL(base);
    for (const [k, v] of Object.entries(q)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set("iss", this.o.issuer); // RFC 9207
    return u.toString();
  }
  private page(p: Pending): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Approve connection</title>
<style>body{font:16px system-ui;max-width:30rem;margin:12vh auto;padding:0 1.5rem;color:#111}code{font-size:2rem;letter-spacing:.15em}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>
<h2>Approve on your Mac</h2><p><b>${esc(p.clientName)}</b> (${esc(p.redirectHost)}) wants to control CadCraft.</p>
<p>A prompt is waiting in the CadCraft Connect app. Only approve it if this code matches:</p><p><code>${esc(p.matchCode)}</code></p><p id=s>Waiting…</p>
<script>const id=${JSON.stringify(p.id)};(async function t(){try{const r=await(await fetch('/authorize/wait/'+id,{cache:'no-store'})).json();
if(r.redirect){location.replace(r.redirect);return}if(r.status==='expired'){document.getElementById('s').textContent='This request expired. Go back to Claude and try again.';return}}catch(e){}setTimeout(t,1500)})()</script>`;
  }

  // ---- token endpoint ----
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(sha(code));
    if (!c || c.clientId !== client.client_id || c.exp < Date.now()) throw new InvalidGrantError("invalid or expired code");
    // A legitimate client asks once, then redeems (which deletes the code). A second ask means the
    // first PKCE check failed and someone is guessing: burn the code.
    if (c.challenged) { this.codes.delete(sha(code)); throw new InvalidGrantError("invalid or expired code"); }
    c.challenged = true;
    return c.challenge;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _v?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const h = sha(code), c = this.codes.get(h);
    this.codes.delete(h); // single use, even on failure
    if (!c || c.clientId !== client.client_id || c.exp < Date.now()) throw new InvalidGrantError("invalid or expired code");
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    this.checkResource(resource);
    return this.issue(c.grant, client.client_id);
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _s?: string[], resource?: URL): Promise<OAuthTokens> {
    const s = this.o.store.s, h = sha(refreshToken), r = s.refresh[h];
    if (!r) throw new InvalidGrantError("invalid refresh token");
    delete s.refresh[h]; // rotate
    if (s.revokedGrants.includes(r.grant)) { this.o.store.save(); throw new InvalidGrantError("grant revoked"); }
    if (r.clientId !== client.client_id || r.exp < Date.now()) { this.o.store.save(); throw new InvalidGrantError("invalid refresh token"); }
    this.checkResource(resource);
    return this.issue(r.grant, client.client_id);
  }
  private checkResource(resource?: URL) {
    if (resource && resource.href.replace(/\/$/, "") !== this.o.resourceUrl.replace(/\/$/, "")) throw new InvalidTargetError("resource mismatch");
  }
  private issue(grant: string, clientId: string): OAuthTokens {
    const s = this.o.store.s, at = rand(), rt = rand(), now = Date.now();
    for (const [k, v] of Object.entries(s.access)) if (v.exp < now) delete s.access[k];
    for (const [k, v] of Object.entries(s.refresh)) if (v.exp < now) delete s.refresh[k];
    s.access[sha(at)] = { grant, exp: now + ACCESS_TTL };
    s.refresh[sha(rt)] = { grant, exp: now + REFRESH_TTL, clientId };
    this.o.store.save();
    return { access_token: at, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: rt, scope: SCOPE };
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const s = this.o.store.s, a = s.access[sha(token)];
    if (!a || a.exp < Date.now() || s.revokedGrants.includes(a.grant)) throw new InvalidTokenError("invalid or expired token");
    return { token, clientId: "claude", scopes: [SCOPE], expiresAt: Math.floor(a.exp / 1000), resource: new URL(this.o.resourceUrl) };
  }
  async revokeToken(_c: OAuthClientInformationFull, req: OAuthTokenRevocationRequest): Promise<void> {
    const s = this.o.store.s, h = sha(req.token), g = s.access[h]?.grant ?? s.refresh[h]?.grant;
    if (g) { s.revokedGrants.push(g); this.o.store.save(); }
  }
  /** "Disconnect everything": kills every Claude session at once. */
  revokeAll(): void { const s = this.o.store.s; s.access = {}; s.refresh = {}; this.o.store.save(); }
}
