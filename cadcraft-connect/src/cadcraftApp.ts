import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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

interface GitHubAsset {
  name: string;
  size: number;
  digest?: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${String(stderr).trim() || error.message}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function* webStreamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Downloads and installs the latest official universal macOS release into ~/Applications. */
export async function installLatestCadcraft(log?: (message: string) => void): Promise<string> {
  const apiURL = "https://api.github.com/repos/storytold/cadcraft/releases/latest";
  const releaseResponse = await fetch(apiURL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "CadCraft-Connect" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!releaseResponse.ok) throw new Error(`Could not check the official CadCraft release (HTTP ${releaseResponse.status}).`);

  const release = await releaseResponse.json() as GitHubRelease;
  const versionMatch = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "");
  if (!versionMatch || !Array.isArray(release.assets)) throw new Error("The official CadCraft release metadata is invalid.");
  const version = versionMatch[1];
  const assetName = `cadcraft-${version}-macos-universal.dmg`;
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 250 * 1024 * 1024) {
    throw new Error(`The official CadCraft release does not contain a valid ${assetName} installer.`);
  }
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "")?.[1].toLowerCase();
  if (!digest) throw new Error("The official CadCraft installer has no valid SHA-256 digest.");

  const downloadURL = new URL(asset.browser_download_url);
  const expectedPath = `/storytold/cadcraft/releases/download/${release.tag_name}/${assetName}`;
  if (downloadURL.origin !== "https://github.com" || downloadURL.pathname !== expectedPath) {
    throw new Error("The official CadCraft installer URL did not match the expected GitHub release.");
  }

  log?.(`Downloading official CadCraft v${version} (${Math.ceil(asset.size / 1024 / 1024)} MB).`);
  const temp = await mkdtemp(join(tmpdir(), "cadcraft-connect-install-"));
  const archive = join(temp, assetName);
  const mountPoint = join(temp, "mounted");
  let mounted = false;
  let installedBin: string | undefined;

  try {
    const response = await fetch(downloadURL, { signal: AbortSignal.timeout(180_000) });
    const finalURL = new URL(response.url);
    if (!response.ok || !response.body ||
        (finalURL.hostname !== "github.com" && !finalURL.hostname.endsWith(".githubusercontent.com"))) {
      throw new Error(`Could not download the official CadCraft installer (HTTP ${response.status}).`);
    }
    await pipeline(Readable.from(webStreamChunks(response.body)), createWriteStream(archive, { flags: "wx" }));
    const downloadedSize = (await stat(archive)).size;
    if (downloadedSize !== asset.size || await sha256(archive) !== digest) {
      throw new Error("The CadCraft installer failed its published size or SHA-256 verification.");
    }

    await mkdir(mountPoint);
    await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mountPoint, archive]);
    mounted = true;
    const mountedEntries = await readdir(mountPoint);
    const appName = ["CADCraft.app", "CadCraft.app"].find((name) => mountedEntries.includes(name));
    if (!appName) throw new Error("The official CadCraft disk image did not contain CADCraft.app.");

    const mountedApp = join(mountPoint, appName);
    const mountedBin = join(mountedApp, "Contents", "MacOS", "CADCraft");
    const bundleID = (await run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(mountedApp, "Contents", "Info.plist")])).trim();
    if (bundleID !== "ai.storyteller.cadcraft" || !existsSync(mountedBin)) {
      throw new Error("The downloaded app did not match the official CADCraft application bundle.");
    }
    await run("codesign", ["--verify", "--deep", "--strict", mountedApp]);

    const applications = join(homedir(), "Applications");
    const destination = join(applications, "CadCraft.app");
    if (existsSync(destination)) throw new Error(`An incomplete CadCraft.app already exists at ${destination}; move it aside and try again.`);
    await mkdir(applications, { recursive: true });

    log?.("Installing CadCraft in your user Applications folder.");
    try {
      await run("ditto", [mountedApp, destination]);
      installedBin = join(destination, "Contents", "MacOS", "CADCraft");
      if (!existsSync(installedBin)) throw new Error("The installed CadCraft executable is missing.");
      await run("codesign", ["--verify", "--deep", "--strict", destination]);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  } finally {
    if (mounted) {
      try {
        await run("hdiutil", ["detach", mountPoint, "-quiet"]);
      } catch (error) {
        log?.(`Could not detach the CadCraft installer image: ${(error as Error).message}`);
      }
    }
    await rm(temp, { recursive: true, force: true });
  }

  if (!installedBin) throw new Error("CadCraft installation did not complete.");
  log?.(`CadCraft v${version} is installed and ready.`);
  return installedBin;
}

/** Makes sure CadCraft is up with its control port open. Launches it (detached, so quitting Connect never closes your drawing). */
export async function ensureCadcraftRunning(o: {
  port: number;
  bin?: string;
  timeoutMs?: number;
  log?: (s: string) => void;
  installIfMissing?: (log?: (message: string) => void) => Promise<string>;
}): Promise<"already-running" | "launched"> {
  const tokenOk = () => { try { readToken(o.port); return true; } catch { return false; } };
  if ((await probe(o.port)) && tokenOk()) return "already-running";
  let bin = findCadcraftBin(o.bin);
  if (!bin) {
    o.log?.("CadCraft is not installed; installing the latest official release.");
    bin = await (o.installIfMissing ?? installLatestCadcraft)(o.log);
  }
  o.log?.(`launching ${bin} --control ${o.port}`);
  const child = spawn(bin, ["--control", String(o.port)], { detached: true, stdio: "ignore" });
  let spawnErr: Error | undefined; child.once("error", (e) => (spawnErr = e)); child.unref();
  for (const until = Date.now() + (o.timeoutMs ?? 45_000); Date.now() < until; await new Promise((r) => setTimeout(r, 500))) {
    if (spawnErr) throw new Error(`Could not start CadCraft: ${spawnErr.message}`);
    if ((await probe(o.port)) && tokenOk()) return "launched";
  }
  throw new Error(`CadCraft did not open its control port ${o.port}. If CadCraft was already open without --control, quit it and try again.`);
}
