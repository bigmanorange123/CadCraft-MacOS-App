import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Store, plainVault, type Vault, type TunnelInfo } from "./state.js";
import { LocalOAuthProvider, type PendingApproval } from "./oauthServer.js";
import { CadcraftProxy } from "./proxy.js";
import { createControlMcpServer } from "./control.js";
import { ensureCadcraftRunning, CadcraftNotFound } from "./cadcraftApp.js";
import { startHttp } from "./httpServer.js";
import { McpLogin } from "./mcpLogin.js";
import { CloudflareApi, type Zone } from "./cloudflare.js";
import { CloudflaredRunner, findCloudflared } from "./cloudflared.js";

export type Status = "idle" | "launching-cadcraft" | "logging-in" | "choosing-domain" | "provisioning" | "starting" | "connecting" | "ready" | "error";

export interface ServiceOptions {
  mode: "cloudflare" | "local";
  openUrl: (url: string) => Promise<void>;
  chooseZone: (zones: Zone[]) => Promise<Zone>;
  vault?: Vault;
  store?: Store;
  port?: number;                         // local origin port (cloudflared forwards here)
  /** If set, use a stdio MCP server (e.g. `cadcraft-cli mcp`) instead of the CadCraft app's control port */
  cadcraft?: { command: string; args: string[] };
  /** Control port of the CadCraft desktop app (default 7979) */
  controlPort?: number;
  /** Path to .../CadCraft.app/Contents/MacOS/CADCraft; auto-detected in /Applications */
  cadcraftBin?: string;
  /** Called when the app can't be found; return the binary path the user picked */
  locateApp?: () => Promise<string | undefined>;
  cloudflareMcpUrl?: string;
  cloudflareCallbackPort?: number;
  cloudflaredPath?: string;
  allowLoopbackRedirects?: boolean;      // tests only
}

export class ConnectService extends EventEmitter {
  status: Status = "idle";
  url?: string;
  readonly store: Store;
  provider!: LocalOAuthProvider;
  private http?: HttpServer; private proxy?: CadcraftProxy; private runner?: CloudflaredRunner; private login?: McpLogin;
  private cf?: CloudflareApi;

  constructor(private o: ServiceOptions) { super(); this.store = o.store ?? new Store(); }
  private set(s: Status, detail?: string) { this.status = s; this.emit("status", s, detail); }

  /** Default: drive the CadCraft desktop app (launched with --control). `cadcraft` option: stdio server instead. */
  private async makeProxy(): Promise<CadcraftProxy> {
    if (this.o.cadcraft) return new CadcraftProxy({ kind: "stdio", ...this.o.cadcraft });
    const port = this.o.controlPort ?? 7979;
    const ensure = async () => {
      const bin = this.store.s.settings?.cadcraftBin ?? this.o.cadcraftBin;
      try { return await ensureCadcraftRunning({ port, bin, log: (l) => this.emit("log", l) }); }
      catch (e) {
        if (!(e instanceof CadcraftNotFound) || !this.o.locateApp) throw e;
        const picked = await this.o.locateApp();
        if (!picked) throw e;
        (this.store.s.settings ??= {}).cadcraftBin = picked; this.store.save();
        return ensureCadcraftRunning({ port, bin: picked, log: (l) => this.emit("log", l) });
      }
    };
    this.set("launching-cadcraft");
    await ensure();
    const proxy = new CadcraftProxy({ kind: "inprocess", open: async () => {
      await ensure(); // relaunches CadCraft if it was closed since the last request
      const { server, client } = await createControlMcpServer(port);
      return { server, onClose: (cb) => client.once("close", cb) };
    } });
    await proxy.toolNames(); // fail early (wrong token, port busy…) instead of on Claude's first call
    return proxy;
  }

  private async cloudflare(): Promise<CloudflareApi> {
    if (this.cf) return this.cf;
    this.set("logging-in");
    this.login = new McpLogin({
      serverUrl: this.o.cloudflareMcpUrl ?? "https://mcp.cloudflare.com/mcp", store: this.store, vault: this.o.vault ?? plainVault,
      openUrl: this.o.openUrl, callbackPort: this.o.cloudflareCallbackPort ?? 38472, allowInsecureLoopback: this.o.allowLoopbackRedirects,
    });
    return (this.cf = new CloudflareApi(await this.login.connect()));
  }

  async start(): Promise<string> {
    try {
      const port = this.o.port ?? 7391;
      const proxy = this.proxy = await this.makeProxy();
      let origin: string, tunnel: TunnelInfo | undefined;

      if (this.o.mode === "local") origin = `http://localhost:${port}`;
      else {
        const bin = findCloudflared(this.o.cloudflaredPath);
        if (!bin) throw new Error("cloudflared is not installed. Run: brew install cloudflared");
        const cf = await this.cloudflare();
        tunnel = this.store.s.tunnel;
        if (!tunnel) {
          this.set("choosing-domain");
          const zones = await cf.listZones();
          if (!zones.length) throw new Error("No active domains found in your Cloudflare account. Add a domain to Cloudflare first.");
          const z = zones.length === 1 ? zones[0] : await this.o.chooseZone(zones);
          const id = randomBytes(4).toString("hex");
          tunnel = { accountId: z.accountId, zoneId: z.id, zoneName: z.name, tunnelId: "", tunnelName: `cadcraft-connect-${id}`, hostname: `cadcraft-${id}.${z.name}` };
        }
        origin = `https://${tunnel.hostname}`;
      }

      this.provider = new LocalOAuthProvider({ store: this.store, resourceUrl: `${origin}/mcp`, issuer: origin, allowLoopbackRedirects: this.o.allowLoopbackRedirects });
      this.provider.on("approval", (p: PendingApproval) => this.emit("approval", p));
      this.set("starting");
      this.http = await startHttp({ publicOrigin: origin, port, provider: this.provider, proxy });

      if (tunnel) {
        this.set("provisioning");
        const r = await (await this.cloudflare()).provision({ accountId: tunnel.accountId, zoneId: tunnel.zoneId, tunnelName: tunnel.tunnelName, hostname: tunnel.hostname, service: `http://127.0.0.1:${port}` });
        this.store.s.tunnel = { ...tunnel, tunnelId: r.tunnelId, dnsRecordId: r.dnsRecordId };
        this.store.save();
        this.set("connecting");
        this.runner = new CloudflaredRunner(findCloudflared(this.o.cloudflaredPath)!);
        this.runner.on("log", (l) => this.emit("log", l));
        this.runner.start(r.token);
        await this.waitPublic(origin, port);
      }
      this.url = `${origin}/mcp`;
      this.set("ready");
      return this.url;
    } catch (e) { this.set("error", (e as Error).message); await this.stop(); throw e; }
  }

  /** Two stages so a failure says WHICH part is broken. */
  private async waitPublic(origin: string, port: number) {
    try { if (!(await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) })).ok) throw 0; }
    catch { throw new Error(`The local bridge is not answering on 127.0.0.1:${port}`); }

    // Stage 1: cloudflared must reach Cloudflare's edge.
    const r = this.runner!, t0 = Date.now();
    while (!r.connected && Date.now() - t0 < 45_000) await new Promise((x) => setTimeout(x, 500));
    if (!r.connected) throw new Error(
      "cloudflared started but never connected to Cloudflare (see [cloudflared] lines above). " +
      "Usual causes: a VPN/firewall blocking outbound port 7844, or an invalid tunnel token. Run with CADCRAFT_VERBOSE=1 for full logs.");

    // Stage 2: the public hostname must resolve and route to us.
    const host = new URL(origin).host; let last = "no response";
    for (const until = Date.now() + 90_000; Date.now() < until; await new Promise((x) => setTimeout(x, 3000))) {
      try {
        const res = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(5000) });
        if (res.ok) return;
        last = `HTTP ${res.status}`;
      } catch (e) { last = ((e as any).cause?.code ?? (e as Error).message) as string; }
    }
    throw new Error(`cloudflared is connected, but https://${host}/healthz is not reachable from this Mac (${last}). ` +
      (/ENOTFOUND|EAI_AGAIN/.test(last) ? "Your Mac's DNS hasn't picked up the new record yet (or has cached 'not found'). Wait a minute and run the command again; it reuses the same tunnel." : "Check the tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels)."));
  }

  decide(id: string, approve: boolean) { return this.provider.decide(id, approve); }
  disconnectAllClaudeSessions() { this.provider.revokeAll(); }

  async stop() {
    this.runner?.stop(); this.runner = undefined;
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    this.http = undefined; await this.proxy?.close(); this.proxy = undefined;
    if (this.status !== "error") this.set("idle");
  }

  /** Removes the tunnel and DNS record from Cloudflare and forgets everything locally. */
  async teardown() {
    const t = this.store.s.tunnel;
    await this.stop();
    if (t && t.tunnelId) { await (await this.cloudflare()).teardown(t); }
    delete this.store.s.tunnel; this.store.s.access = {}; this.store.s.refresh = {}; this.store.save();
  }
  logoutCloudflare() { this.login?.logout(); this.cf = undefined; }
}
