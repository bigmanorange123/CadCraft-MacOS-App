// Stand-in for `CADCraft --control PORT`: same JSON-lines protocol and token file as the real app.
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const port = Number(process.argv[process.argv.indexOf("--control") + 1]);
const token = randomBytes(16).toString("hex");
const dir = process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".cache");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `cadcraft-control-${port}.token`), token, { mode: 0o600 });
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));

const lines: string[] = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const methods: Record<string, (p: any) => unknown> = {
  ping: () => "pong",
  "engine.commands": () => [{ id: "line", label: "Line", aliases: ["L"], params: { x1: "number", y1: "number", x2: "number", y2: "number" } }],
  "engine.execute": (p) => { if (/^line$/i.test(p.command)) lines.push(JSON.stringify(p.params)); return { ok: true }; },
  "drawing.inspect": () => ({ entityCount: lines.length }),
  "cmdline.input": (p) => ({ prompt: "Command:", output: [String(p.text)], running: null }),
  "cmdline.script": (p) => { for (const l of String(p.text).split("\n")) if (/^line\b/i.test(l.trim())) lines.push(l.trim()); return { prompt: "Command:", running: null }; },
  "cmdline.key": () => ({ prompt: "Command:" }),
  "cmdline.state": () => ({ prompt: "Command:", running: null }),
  "ui.render": () => ({ pngBase64: PNG, width: 1, height: 1 }),
  "app.save": () => "saved",
};
createServer((sock) => {
  createInterface({ input: sock }).on("line", (l) => {
    const m = JSON.parse(l);
    if (m.token !== token) return void sock.write(JSON.stringify({ id: m.id, ok: false, error: "unauthorized" }) + "\n");
    const h = methods[m.method];
    sock.write(JSON.stringify(h ? { id: m.id, ok: true, result: h(m.params ?? {}) } : { id: m.id, ok: false, error: `unknown method ${m.method}` }) + "\n");
  });
  sock.on("error", () => {});
}).listen(port, "127.0.0.1");
