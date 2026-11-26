/**
 * Talks to the running CadCraft desktop app over its control port (started with `--control PORT`)
 * and exposes it as an MCP server. In-process: no helper process or terminal tab needed.
 * Protocol: https://github.com/getcadcraft/cadcraft docs/control-protocol.md (JSON lines over 127.0.0.1,
 * every request carries the per-session token CadCraft writes to an owner-only file).
 */
import { createConnection, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** `$XDG_RUNTIME_DIR` first, else `~/.cache` (per the protocol docs). */
export function tokenPaths(port: number): string[] {
  const f = `cadcraft-control-${port}.token`;
  return [...new Set([process.env.XDG_RUNTIME_DIR && join(process.env.XDG_RUNTIME_DIR, f), join(homedir(), ".cache", f)].filter(Boolean) as string[])];
}
export function readToken(port: number): string {
  for (const p of tokenPaths(port)) { try { const t = readFileSync(p, "utf8").trim(); if (t) return t; } catch { /* try next */ } }
  throw new Error(`No CadCraft control token found (looked in ${tokenPaths(port).join(", ")}). Is CadCraft running with --control ${port}?`);
}

export class ControlClient extends EventEmitter {
  private sock?: Socket; private nextId = 1; private closed = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private port: number) { super(); }

  async connect(): Promise<void> {
    this.token = readToken(this.port);
    const sock = (this.sock = createConnection({ host: "127.0.0.1", port: this.port }));
    await new Promise<void>((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    sock.on("error", () => { /* surfaced through close */ });
    sock.on("close", () => {
      this.closed = true;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("CadCraft closed the control connection")); this.pending.delete(id); }
      this.emit("close");
    });
    createInterface({ input: sock }).on("line", (line) => {
      let m: any; try { m = JSON.parse(line); } catch { return; }
      const p = this.pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error((m.error ?? "control error") + (m.state === "may-have-run" ? " (the command may still have run: inspect the drawing before retrying)" : "")));
    });
    await this.call("ping"); // proves the token is accepted before we serve anything
  }
  private token = "";

  call(method: string, params?: unknown, timeoutMs = 70_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.sock) return reject(new Error("Not connected to CadCraft"));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CadCraft did not answer in time")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, token: this.token, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    });
  }
  close() { this.sock?.destroy(); }
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v ?? "ok") }] });

export async function createControlMcpServer(port: number): Promise<{ server: McpServer; client: ControlClient }> {
  const client = new ControlClient(port);
  await client.connect();
  const server = new McpServer({ name: "cadcraft", version: "0.1.0" });

  server.tool("engine_execute", "Run a CadCraft command with JSON parameters. Never opens a dialog.",
    { command: z.string().describe("Command id, e.g. LINE, CIRCLE, ZOOM_EXTENTS"), params: z.record(z.any()).optional().describe("Command parameters") },
    async ({ command, params }) => text(await client.call("engine.execute", { command, params })));
  server.tool("drawing_inspect", "Get a summary of the current drawing and its entities.",
    { entities: z.array(z.string()).optional().describe("Filter by entity handles"), limit: z.number().optional().describe("Max entities to return") },
    async ({ entities, limit }) => text(await client.call("drawing.inspect", { entities, limit })));
  server.tool("cmdline_input", "Type text at the CadCraft command line, exactly as a user would.",
    { text: z.string().describe("Text to type; empty string = Enter") },
    async ({ text: t }) => text(await client.call("cmdline.input", { text: t })));
  server.tool("cmdline_script", "Run a multi-line script at the command line (like an AutoCAD .scr file): one command or answer per line, a blank line = Enter.",
    { text: z.string().describe("The script text, lines separated by \\n") },
    async ({ text: t }) => text(await client.call("cmdline.script", { text: t })));
  server.tool("cmdline_key", "Press Enter or Escape at the command line.", { key: z.enum(["enter", "escape"]) },
    async ({ key }) => text(await client.call("cmdline.key", { key })));
  server.tool("cmdline_state", "Get the current command line prompt, keywords, and history.", {},
    async () => text(await client.call("cmdline.state")));
  server.tool("engine_commands", "List every available CadCraft command with its id, label, aliases and params.", {},
    async () => text(await client.call("engine.commands")));
  server.tool("ui_render", "Render the current drawing as a PNG and return it as base64.",
    { width: z.number().optional(), height: z.number().optional(), background: z.string().optional() },
    async ({ width, height, background }) => {
      const r = await client.call("ui.render", { width, height, background });
      if (!r?.pngBase64) throw new Error("CadCraft returned no image");
      return { content: [{ type: "image" as const, data: r.pngBase64, mimeType: "image/png" }] };
    });
  server.tool("app_save", "Save the current drawing.", { path: z.string().optional().describe("Save-as path; omit to save in place") },
    async ({ path }) => text(await client.call("app.save", path ? { path } : undefined)));

  return { server, client };
}
