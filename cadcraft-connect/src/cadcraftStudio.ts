import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const STUDIO_BUNDLE_ID = "com.getcadcraft.studio";
const RELEASE_API = "https://api.github.com/repos/getcadcraft/studio/releases/latest";
const MAX_DMG_SIZE = 600 * 1024 * 1024;
const CONNECT_FILE = join(homedir(), "Library", "Application Support", "CadCraft Studio", "connect.json");

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

interface StudioConnection {
  url: string;
  token: string;
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

async function* webStreamChunks(
  stream: ReadableStream<Uint8Array>,
  totalBytes: number,
  log?: (message: string) => void
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let downloadedBytes = 0;
  let nextPercentage = 10;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      downloadedBytes += value.byteLength;
      const percentage = Math.floor(downloadedBytes / totalBytes * 100);
      if (percentage >= nextPercentage) {
        log?.(`Downloading CadCraft Studio: ${Math.min(percentage, 100)}%.`);
        nextPercentage = Math.floor(percentage / 10) * 10 + 10;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function bundleIdentifier(app: string): Promise<string> {
  return (await run("plutil", [
    "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents", "Info.plist")
  ])).trim();
}

async function verifyStudioApp(app: string): Promise<void> {
  if (await bundleIdentifier(app) !== STUDIO_BUNDLE_ID) {
    throw new Error("The selected application is not the official CadCraft Studio bundle.");
  }
  const executable = (await run("plutil", [
    "-extract", "CFBundleExecutable", "raw", "-o", "-", join(app, "Contents", "Info.plist")
  ])).trim();
  if (!executable || basename(executable) !== executable || !existsSync(join(app, "Contents", "MacOS", executable))) {
    throw new Error("The CadCraft Studio application executable is missing.");
  }
  await run("codesign", ["--verify", "--deep", "--strict", app]);
  await run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
}

async function findStudioApp(log?: (message: string) => void): Promise<string | undefined> {
  const candidates = [
    "/Applications/CadCraft Studio.app",
    join(homedir(), "Applications", "CadCraft Studio.app"),
    "/Applications/CadCraft.app",
    join(homedir(), "Applications", "CadCraft.app")
  ];
  for (const app of candidates) {
    if (!existsSync(app)) continue;
    try {
      if (await bundleIdentifier(app) === STUDIO_BUNDLE_ID) return app;
      log?.(`Ignoring ${app}: it is not CadCraft Studio.`);
    } catch (error) {
      log?.(`Could not inspect ${app}: ${(error as Error).message}`);
    }
  }
  return undefined;
}

export async function installLatestCadcraftStudio(log?: (message: string) => void): Promise<string> {
  const releaseResponse = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "CadCraft-Connect" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!releaseResponse.ok) throw new Error(`Could not check the official CadCraft Studio release (HTTP ${releaseResponse.status}).`);

  const release = await releaseResponse.json() as GitHubRelease;
  const versionMatch = /^studio-v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "");
  if (!versionMatch || !Array.isArray(release.assets)) throw new Error("The official CadCraft Studio release metadata is invalid.");
  const version = versionMatch[1];
  const assetName = `CadCraft-Studio-${version}.dmg`;
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DMG_SIZE) {
    throw new Error(`The official release does not contain a valid ${assetName} installer.`);
  }
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "")?.[1].toLowerCase();
  if (!digest) throw new Error("The official CadCraft Studio installer has no valid SHA-256 digest.");

  const downloadURL = new URL(asset.browser_download_url);
  const expectedPath = `/getcadcraft/studio/releases/download/${release.tag_name}/${assetName}`;
  if (downloadURL.origin !== "https://github.com" || downloadURL.pathname !== expectedPath) {
    throw new Error("The CadCraft Studio installer URL did not match the expected GitHub release.");
  }

  log?.(`Downloading official CadCraft Studio v${version} (${Math.ceil(asset.size / 1024 / 1024)} MB).`);
  const temp = await mkdtemp(join(tmpdir(), "cadcraft-studio-install-"));
  const archive = join(temp, assetName);
  const mountPoint = join(temp, "mounted");
  let mounted = false;
  let installedApp: string | undefined;

  try {
    const response = await fetch(downloadURL, { signal: AbortSignal.timeout(900_000) });
    const finalURL = new URL(response.url);
    if (!response.ok || !response.body ||
        (finalURL.hostname !== "github.com" && !finalURL.hostname.endsWith(".githubusercontent.com"))) {
      throw new Error(`Could not download the official CadCraft Studio installer (HTTP ${response.status}).`);
    }
    await pipeline(
      Readable.from(webStreamChunks(response.body, asset.size, log)),
      createWriteStream(archive, { flags: "wx" })
    );
    if ((await stat(archive)).size !== asset.size || await sha256(archive) !== digest) {
      throw new Error("The Studio installer failed its published size or SHA-256 verification.");
    }

    await mkdir(mountPoint);
    await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mountPoint, archive]);
    mounted = true;
    const entries = await readdir(mountPoint);
    const appName = ["CadCraft.app", "CadCraft Studio.app"].find((name) => entries.includes(name));
    if (!appName) throw new Error("The official disk image did not contain the CadCraft Studio application.");

    const mountedApp = join(mountPoint, appName);
    await verifyStudioApp(mountedApp);
    const applications = join(homedir(), "Applications");
    const destination = join(applications, "CadCraft Studio.app");
    if (existsSync(destination)) throw new Error(`An unexpected application already exists at ${destination}.`);
    await mkdir(applications, { recursive: true });

    log?.("Installing CadCraft Studio in your user Applications folder.");
    try {
      await run("ditto", [mountedApp, destination]);
      await verifyStudioApp(destination);
      installedApp = destination;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  } finally {
    if (mounted) {
      try {
        await run("hdiutil", ["detach", mountPoint, "-quiet"]);
      } catch (error) {
        log?.(`Could not detach the Studio installer image: ${(error as Error).message}`);
      }
    }
    await rm(temp, { recursive: true, force: true });
  }

  if (!installedApp) throw new Error("CadCraft Studio installation did not complete.");
  log?.(`CadCraft Studio v${version} is installed.`);
  return installedApp;
}

async function readStudioConnection(): Promise<StudioConnection | undefined> {
  let raw: string;
  try {
    raw = await readFile(CONNECT_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let connection: StudioConnection;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    connection = parsed as StudioConnection;
  } catch {
    return undefined;
  }
  if (typeof connection.url !== "string" || typeof connection.token !== "string") return undefined;

  let url: URL;
  try {
    url = new URL(connection.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.pathname !== "/mcp" ||
      !/^\d{5}$/.test(url.port) ||
      !/^[A-Za-z0-9_-]{43}$/.test(connection.token)) {
    return undefined;
  }
  const port = Number(url.port);
  return port >= 47615 && port <= 47634 ? connection : undefined;
}

async function studioEndpointReady(): Promise<boolean> {
  const connection = await readStudioConnection();
  if (!connection) return false;
  try {
    const response = await fetch(connection.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(1_500)
    });
    if (response.status === 405) return true;
    if (response.status === 401) return false;
    throw new Error(`CadCraft Studio's local MCP endpoint returned HTTP ${response.status}.`);
  } catch (error) {
    if (error instanceof TypeError || (error as Error).name === "TimeoutError") return false;
    throw error;
  }
}

export async function ensureCadcraftStudioReady(log?: (message: string) => void): Promise<void> {
  let app = await findStudioApp(log);
  if (!app) app = await installLatestCadcraftStudio(log);
  if (await studioEndpointReady()) return;

  await verifyStudioApp(app);
  log?.("Opening CadCraft Studio for the requested tool call.");
  await run("open", ["-a", app]);

  let lastError = "Studio has not written its local connection file yet.";
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if (await studioEndpointReady()) {
        log?.("CadCraft Studio's secure local MCP connection is ready.");
        return;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`CadCraft Studio did not start its local MCP connection: ${lastError}`);
}
