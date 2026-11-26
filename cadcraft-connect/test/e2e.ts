import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
process.env.CADCRAFT_CONNECT_HOME = mkdtempSync(join(tmpdir(), "ccc-"));
const { ConnectService } = await import("../src/service.js");
const { McpLogin } = await import("../src/mcpLogin.js");
const { Store, plainVault } = await import("../src/state.js");
const { isPublicAddress } = await import("../src/oauthServer.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

let pass = 0, fail = 0;
const ok = (c: unknown, name: string) => { c ? pass++ : fail++; console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${name}`); };
const PORT = 7611, BASE = `http://localhost:${PORT}`;

// --- address classification (SSRF guard for Client ID Metadata Documents)
ok(!isPublicAddress("127.0.0.1") && !isPublicAddress("10.1.2.3") && !isPublicAddress("192.168.1.9") && !isPublicAddress("169.254.169.254")
  && !isPublicAddress("::1") && !isPublicAddress("fd00::1") && !isPublicAddress("::ffff:10.0.0.1"), "private/loopback/link-local/mapped addresses are blocked");
ok(isPublicAddress("8.8.8.8") && isPublicAddress("2606:4700:4700::1111"), "public addresses are allowed");

const svc = new ConnectService({
  mode: "local", port: PORT, allowLoopbackRedirects: true, openUrl: async () => {}, chooseZone: async (z) => z[0],
  cadcraft: { command: process.execPath, args: ["--import", "tsx", "test/fake-cadcraft.ts"] },
});
let approvals = 0, matchCodeSeen = "";
svc.on("approval", (p: any) => { approvals++; matchCodeSeen = p.matchCode; svc.decide(p.id, true); });
const url = await svc.start();
ok(url === `${BASE}/mcp`, "service starts and reports the connector URL");

// --- unauthenticated + hostile requests
let r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
ok(r.status === 401 && /resource_metadata="[^"]*oauth-protected-resource\/mcp"/.test(r.headers.get("www-authenticate") ?? ""), "no token → 401 with RFC 9728 resource_metadata challenge");
r = await fetch(url, { headers: { Authorization: "Bearer nope" }, method: "POST", body: "{}" });
ok(r.status === 401, "garbage token → 401");
const hostStatus = await new Promise<number>((res) => { // fetch() can't override Host, so use a raw request
  const q = httpRequest({ host: "127.0.0.1", port: PORT, path: "/healthz", headers: { Host: "evil.example" } }, (m) => { m.resume(); res(m.statusCode!); }); q.end(); });
ok(hostStatus === 421, "wrong Host header → 421 (rebinding guard)");
r = await fetch(url, { method: "GET" });
ok(r.status === 401 || r.status === 405, "GET /mcp is not served (stateless)");

// --- discovery
const prm: any = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
ok(prm.resource === url && prm.authorization_servers[0] === BASE, "protected resource metadata is correct");
const asm: any = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
ok(asm.code_challenge_methods_supported?.join() === "S256" && asm.client_id_metadata_document_supported === true && asm.authorization_response_iss_parameter_supported === true, "AS metadata: S256 only, CIMD + iss advertised");

// --- registration abuse
r = await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], client_name: "x" }) });
ok(r.status === 400, "DCR with a non-Claude redirect_uri is rejected");
const bad = new URL(`${BASE}/authorize`);
bad.search = new URLSearchParams({ response_type: "code", client_id: "https://localhost/client.json", redirect_uri: "https://localhost/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" }).toString();
r = await fetch(bad, { redirect: "manual" });
ok(r.status === 400, "CIMD client_id pointing at localhost is refused (SSRF)");

// --- full OAuth login through the SDK client, driven like a browser would
let waitedId = "";
const browser = async (authUrl: string) => {
  const page = await (await fetch(authUrl)).text();
  waitedId = page.match(/const id="([^"]+)"/)![1];
  ok(page.includes(matchCodeSeen), "consent page shows the same match code as the Mac prompt");
  const poll: any = await (await fetch(`${BASE}/authorize/wait/${waitedId}`)).json();
  ok(poll.status === "approved" && !!poll.redirect, "approval on the Mac releases the redirect");
  ok(new URL(poll.redirect).searchParams.get("iss") === BASE, "redirect carries iss (RFC 9207)");
  ok((await (await fetch(`${BASE}/authorize/wait/${waitedId}`)).json() as any).status === "expired", "redirect is handed out only once");
  await fetch(poll.redirect); // hits the loopback callback of the client
};
const clientStore = new Store(join(process.env.CADCRAFT_CONNECT_HOME!, "client.json"));
const login = new McpLogin({ serverUrl: url, store: clientStore, vault: plainVault, openUrl: browser, callbackPort: 38999, allowInsecureLoopback: true });
const mcp = await login.connect();
ok(approvals === 1, "exactly one approval was needed");
const tools = (await mcp.listTools()).tools.map((t) => t.name);
ok(tools.includes("command_line") && tools.includes("inspect_drawing"), "tools are proxied through the authenticated endpoint");
const res: any = await mcp.callTool({ name: "command_line", arguments: { command: "LINE 0,0 0,-1000" } });
ok(res.content[0].text === "ok: LINE 0,0 0,-1000", "tool call reaches the (fake) CadCraft process");
const n: any = await mcp.callTool({ name: "inspect_drawing", arguments: {} });
ok(JSON.parse(n.content[0].text).entities === 1, "CadCraft keeps its state between HTTP requests");

// --- token hygiene
const stateFile = (await import("node:fs")).readFileSync(join(process.env.CADCRAFT_CONNECT_HOME!, "state.json"), "utf8");
const tokens: any = login.tokens();
ok(!stateFile.includes(tokens.access_token) && !stateFile.includes(tokens.refresh_token), "server state holds only token hashes, never the tokens");
const clientInfo: any = login.clientInformation();
const refresh = (rt: string) => fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientInfo.client_id, ...(clientInfo.client_secret ? { client_secret: clientInfo.client_secret } : {}) }) });
const r1 = await refresh(tokens.refresh_token); const t1: any = await r1.json();
ok(r1.status === 200 && t1.access_token && t1.refresh_token !== tokens.refresh_token, "refresh token rotates");
const r2 = await refresh(tokens.refresh_token);
ok(r2.status === 400, "re-using an old refresh token is rejected");
const callWith = (tok: string) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
ok((await callWith(t1.access_token)).status === 200, "rotated access token works");

// --- PKCE: a stolen code is useless without the verifier
const v = randomBytes(32).toString("base64url"), ch = createHash("sha256").update(v).digest("base64url");
const a = new URL(`${BASE}/authorize`);
a.search = new URLSearchParams({ response_type: "code", client_id: clientInfo.client_id, redirect_uri: login.redirectUrl, code_challenge: ch, code_challenge_method: "S256", state: "s1", resource: url }).toString();
const page2 = await (await fetch(a)).text(); const id2 = page2.match(/const id="([^"]+)"/)![1];
const redirect2 = ((await (await fetch(`${BASE}/authorize/wait/${id2}`)).json()) as any).redirect;
const code = new URL(redirect2).searchParams.get("code")!;
const tok = (verifier: string) => fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: login.redirectUrl, client_id: clientInfo.client_id, resource: url, ...(clientInfo.client_secret ? { client_secret: clientInfo.client_secret } : {}) }) });
ok((await tok("w".repeat(50))).status === 400, "wrong PKCE verifier is rejected");
ok((await tok(v)).status === 400, "…and the code is burned after one failed attempt (single use)");

// --- revoke everything
svc.disconnectAllClaudeSessions();
ok((await callWith(t1.access_token)).status === 401, "“Disconnect all Claude sessions” kills tokens immediately");

await mcp.close().catch(() => {}); await svc.stop();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
