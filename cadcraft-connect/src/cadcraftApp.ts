import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { readToken } from "./control.js";

export class CadcraftNotFound extends Error {}

export function probe(port: number, ms = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (connected: boolean) => { socket.destroy(); resolve(connected); };
    socket.setTimeout(ms, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function findCadcraftBin(extra?: string): string | undefined {
  const configured = extra ?? process.env.CADCRAFT_APP;
  if (configured) {
    const executable = configured.toLowerCase().endsWith(".app")
      ? join(configured, "Contents", "MacOS", "CADCraft")
      : configured;
    return existsSync(executable) ? executable : undefined;
  }

  const applications = ["/Applications", join(homedir(), "Applications")];
  const appNames = ["CadCraft", "CADCraft"];
  return applications
    .flatMap((directory) => appNames.map((name) => join(directory, `${name}.app`, "Contents", "MacOS", "CADCraft")))
    .find((path) => existsSync(path));
}

export async function ensureCadcraftRunning(options: {
  port: number;
  bin?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
  reportProgress?: (message: string) => Promise<void>;
}): Promise<"already-running" | "launched"> {
  const tokenAvailable = () => {
    try { readToken(options.port); return true; } catch { return false; }
  };
  if ((await probe(options.port)) && tokenAvailable()) return "already-running";

  const bin = findCadcraftBin(options.bin);
  if (!bin) {
    throw new CadcraftNotFound(
      "CadCraft isn't installed or wasn't found at the selected location. " +
      "Install it with ArtCraft Launcher from https://getartcraft.com/apps/cadcraft, then choose its app bundle " +
      "in CadCraft Connect > Security & setup > CadCraft app."
    );
  }

  await options.reportProgress?.("CadCraft is opening. Give it a moment; I'll continue your request when it's ready.");
  options.log?.(`Launching ${bin} --control ${options.port}.`);
  const child = spawn(bin, ["--control", String(options.port)], { detached: true, stdio: "ignore" });
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not start CadCraft: ${spawnError.message}`);
    if ((await probe(options.port)) && tokenAvailable()) return "launched";
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `CadCraft did not open its control port ${options.port}. If CadCraft was already open without --control, quit it and try again.`
  );
}
