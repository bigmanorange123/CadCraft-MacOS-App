import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findCloudflared(extra?: string): string | undefined {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"];
  return [extra, ...dirs.map((d) => join(d, "cloudflared"))].find((p) => p && existsSync(p));
}

/** Runs `cloudflared tunnel run`. The token goes in via the environment, never on the command line (visible in `ps`). */
export class CloudflaredRunner extends EventEmitter {
  private child?: ChildProcess; private stopped = false; private backoff = 1000;
  connected = false; verbose = !!process.env.CADCRAFT_VERBOSE;
  constructor(private bin: string) { super(); }
  start(token: string) {
    this.stopped = false;
    const c = this.child = spawn(this.bin, ["tunnel", "--no-autoupdate", "run"], { env: { ...process.env, TUNNEL_TOKEN: token }, stdio: ["ignore", "ignore", "pipe"] });
    c.stderr!.on("data", (d: Buffer) => {
      for (const raw of d.toString().split("\n")) {
        const line = raw.split(token).join("***").trim();
        if (!line) continue;
        if (/Registered tunnel connection/i.test(line)) { this.backoff = 1000; this.connected = true; this.emit("connected"); }
        // cloudflared labels levels INF / WRN / ERR, so match those too
        if (this.verbose || /\b(ERR|WRN)\b|error|fail|invalid|refused|timeout/i.test(line)) this.emit("log", line.slice(0, 300));
      }
    });
    c.on("error", (e) => this.emit("log", `could not start cloudflared: ${e.message}`));
    c.on("exit", (code) => {
      this.connected = false;
      this.emit("log", `cloudflared exited (code ${code})${this.stopped ? "" : ", restarting"}`);
      if (!this.stopped) setTimeout(() => this.start(token), (this.backoff = Math.min(this.backoff * 2, 30_000)));
    });
  }
  stop() { this.stopped = true; this.child?.kill("SIGTERM"); }
}
