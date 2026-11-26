import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const tmp = mkdtempSync(join(tmpdir(), "ccc-ctl-"));
process.env.CADCRAFT_CONNECT_HOME = join(tmp, "home");
process.env.XDG_RUNTIME_DIR = tmp;               // where the fake app writes its token (as CadCraft does)
process.env.FAKE_PID_FILE = join(tmp, "app.pid");
const { ConnectService } = await import("../src/service.js");
const { McpLogin } = await import("../src/mcpLogin.js");
const { Store, plainVault } = await import("../src/state.js");
const { ensureCadcraftRunning, CadcraftNotFound, probe } = await import("../src/cadcraftApp.js");

let pass = 0, fail = 0;
const ok = (c: unknown, n: string) => { c ? pass++ : fail++; console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${n}`); };
const PORT = 7633, CPORT = 7981, BASE = `http://localhost:${PORT}`;

// a fake "CadCraft.app" executable, so we can watch Connect launch it with --control
const bin = join(tmp, "CADCraft");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --import tsx "${resolve("test/fake-control.ts")}" "$@"\n`); chmodSync(bin, 0o755);

try { await ensureCadcraftRunning({ port: 7999, bin: join(tmp, "nope"), timeoutMs: 500 }); ok(false, "missing app is reported"); }
catch (e) { ok(e instanceof CadcraftNotFound, "missing CadCraft.app gives a clear 'not found' error"); }

const statuses: string[] = [];
const svc = new ConnectService({ mode: "local", port: PORT, controlPort: CPORT, cadcraftBin: bin, allowLoopbackRedirects: true, openUrl: async () => {}, chooseZone: async (z) => z[0] });
svc.on("status", (s: string) => statuses.push(s));
svc.on("approval", (p: any) => svc.decide(p.id, true));
ok(!(await probe(CPORT)), "CadCraft control port is closed before we start");
const url = await svc.start();
ok(await probe(CPORT) && existsSync(process.env.FAKE_PID_FILE!), "Connect launched CadCraft with --control by itself");
ok(statuses.includes("launching-cadcraft") && statuses.at(-1) === "ready", "status goes launching-cadcraft → … → ready");
ok((await ensureCadcraftRunning({ port: CPORT })) === "already-running", "an already-running CadCraft is reused, not launched twice");

// OAuth login as Claude would, then use the tools
const browser = async (authUrl: string) => {
  const id = (await (await fetch(authUrl)).text()).match(/const id="([^"]+)"/)![1];
  const poll: any = await (await fetch(`${BASE}/authorize/wait/${id}`)).json();
  await fetch(poll.redirect);
};
const login = new McpLogin({ serverUrl: url, store: new Store(join(tmp, "client.json")), vault: plainVault, openUrl: browser, callbackPort: 38998, allowInsecureLoopback: true });
const mcp = await login.connect();
const names = (await mcp.listTools()).tools.map((t) => t.name);
ok(["engine_execute", "drawing_inspect", "cmdline_input", "cmdline_script", "cmdline_key", "cmdline_state", "engine_commands", "ui_render", "app_save"].every((n) => names.includes(n)), "all CadCraft control tools are exposed over the authenticated endpoint");
const call = async (name: string, args: any = {}) => (await mcp.callTool({ name, arguments: args })) as any;

const cmds = await call("engine_commands");
ok(JSON.parse(cmds.content[0].text)[0].id === "line", "engine_commands reaches CadCraft");
await call("cmdline_script", { text: "LINE 0,0 0,-1000\n\nLINE 0,-1000 900,-1000\n\n" });
await call("engine_execute", { command: "line", params: { x1: 1, y1: 1, x2: 2, y2: 2 } });
ok(JSON.parse((await call("drawing_inspect")).content[0].text).entityCount === 3, "script + engine_execute draw into the live drawing");
const img = await call("ui_render");
ok(img.content[0].type === "image" && img.content[0].mimeType === "image/png", "ui_render returns an image through the bridge");

// CadCraft gets quit/killed: next request must relaunch it and carry on
process.kill(Number(readFileSync(process.env.FAKE_PID_FILE!, "utf8")), "SIGKILL");
unlinkSync(process.env.FAKE_PID_FILE!);
await new Promise((r) => setTimeout(r, 700));
const after = await call("drawing_inspect");
ok(!after.isError && JSON.parse(after.content[0].text).entityCount === 0 && existsSync(process.env.FAKE_PID_FILE!), "CadCraft closed → next request relaunches it and reconnects");

await mcp.close().catch(() => {}); await svc.stop();
try { process.kill(Number(readFileSync(process.env.FAKE_PID_FILE!, "utf8")), "SIGKILL"); } catch {}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
