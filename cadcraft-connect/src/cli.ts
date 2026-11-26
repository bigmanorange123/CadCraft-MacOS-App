#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { ConnectService } from "./service.js";
import type { PendingApproval } from "./oauthServer.js";

const args = process.argv.slice(2), cmd = args[0] && !args[0].startsWith("--") ? args[0] : "start";
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const rl = createInterface({ input: process.stdin, output: process.stdout });

const openUrl = (u: string) => new Promise<void>((res, rej) =>
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [u], (e) => (e ? rej(e) : res())));

const svc = new ConnectService({
  mode: args.includes("--local") ? "local" : "cloudflare", openUrl,
  chooseZone: async (zones) => {
    const want = flag("--zone"); const hit = zones.find((z) => z.name === want);
    if (hit) return hit;
    zones.forEach((z, i) => console.log(`  ${i + 1}. ${z.name}`));
    return zones[Number(await rl.question("Which domain should the tunnel use? #")) - 1] ?? zones[0];
  },
  port: flag("--port") ? Number(flag("--port")) : undefined,
  // Default: drive the CadCraft desktop app. --stdio or CADCRAFT_CMD uses a stdio MCP server instead.
  cadcraft: process.env.CADCRAFT_CMD ? { command: process.env.CADCRAFT_CMD, args: (process.env.CADCRAFT_ARGS ?? "mcp").split(" ") }
    : args.includes("--stdio") ? { command: "cadcraft-cli", args: ["mcp"] } : undefined,
  controlPort: flag("--control-port") ? Number(flag("--control-port")) : undefined,
  cadcraftBin: flag("--cadcraft-app"),
  allowLoopbackRedirects: args.includes("--dev"),
});
svc.on("status", (s, d) => console.log(`[${s}]${d ? " " + d : ""}`));
svc.on("log", (l) => console.log("[cloudflared]", l));
if (args.includes("--verbose")) process.env.CADCRAFT_VERBOSE = "1";
svc.on("approval", async (p: PendingApproval) => {
  console.log(`\nConnection request from ${p.clientName} (${p.redirectHost})${p.trusted ? "" : "  ⚠ NOT a recognised Claude address"}\nCode shown in browser must be: ${p.matchCode}`);
  const a = (await rl.question("Approve? [y/N] ")).trim().toLowerCase() === "y";
  console.log(svc.decide(p.id, a) ? (a ? "Approved." : "Denied.") : "Request expired.");
});

if (cmd === "teardown") { await svc.teardown(); console.log("Tunnel and DNS record removed."); process.exit(0); }
if (cmd === "start") {
  let url: string;
  try { url = await svc.start(); } catch (e) { console.error("\nCould not start:", (e as Error).message); process.exit(1); }
  console.log(`\nAdd this in Claude → Settings → Connectors → Add custom connector:\n\n  ${url}\n`);
  process.on("SIGINT", async () => { await svc.stop(); process.exit(0); });
} else { console.log("usage: cadcraft-connect [start|teardown] [--zone example.com] [--local] [--port 7391] [--control-port 7979] [--cadcraft-app /path/CADCraft] [--stdio] [--verbose]"); process.exit(1); }
