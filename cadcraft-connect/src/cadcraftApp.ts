import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readToken } from "./control.js";

export class CadcraftNotFound extends Error {}

export function probe(port: number, ms = 800): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { s.destroy(); res(ok); };
    s.setTimeout(ms, () => done(false)); s.once("connect", () => done(true)); s.once("error", () => done(false));
  });
}

export function findCadcraftBin(extra?: string): string | undefined {
  const configured = extra ?? process.env.CADCRAFT_APP;
  if (configured) return existsSync(configured) ? configured : undefined;
  const apps = ["/Applications", join(homedir(), "Applications")];
  const names = ["CadCraft", "CADCraft"];
  return apps.flatMap((a) => names.map((n) => join(a, `${n}.app`, "Contents", "MacOS", "CADCraft")))
    .find((p) => existsSync(p));
}

/** Makes sure CadCraft is up with its control port open. Launches it (detached, so quitting Connect never closes your drawing). */
export async function ensureCadcraftRunning(o: { port: number; bin?: string; timeoutMs?: number; log?: (s: string) => void }): Promise<"already-running" | "launched"> {
  const tokenOk = () => { try { readToken(o.port); return true; } catch { return false; } };
  if ((await probe(o.port)) && tokenOk()) return "already-running";
  const bin = findCadcraftBin(o.bin);
  if (!bin) throw new CadcraftNotFound("CadCraft.app was not found in /Applications. Tell me where it is (CADCRAFT_APP=/path/to/CadCraft.app/Contents/MacOS/CADCraft).");
  o.log?.(`launching ${bin} --control ${o.port}`);
  const child = spawn(bin, ["--control", String(o.port)], { detached: true, stdio: "ignore" });
  let spawnErr: Error | undefined; child.once("error", (e) => (spawnErr = e)); child.unref();
  for (const until = Date.now() + (o.timeoutMs ?? 45_000); Date.now() < until; await new Promise((r) => setTimeout(r, 500))) {
    if (spawnErr) throw new Error(`Could not start CadCraft: ${spawnErr.message}`);
    if ((await probe(o.port)) && tokenOk()) return "launched";
  }
  throw new Error(`CadCraft did not open its control port ${o.port}. If CadCraft was already open without --control, quit it and try again.`);
}
