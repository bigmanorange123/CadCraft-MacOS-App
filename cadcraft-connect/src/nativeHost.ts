#!/usr/bin/env node
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectService } from "./service.js";
import type { PendingApproval } from "./oauthServer.js";
import type { Zone } from "./cloudflare.js";

type Message = Record<string, unknown> & { type?: string; id?: string };

const input = createInterface({ input: process.stdin });
const waitingForBootstrap = new Promise<Buffer>((resolveKey, rejectKey) => {
  const timer = setTimeout(() => rejectKey(new Error("Native host did not receive its secure-storage key")), 10_000);
  input.on("line", (line) => {
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch { return; }
    if (message.type !== "bootstrap") return;
    const key = Buffer.from(String(message.key ?? ""), "base64");
    if (key.length !== 32) return rejectKey(new Error("Invalid secure-storage key"));
    clearTimeout(timer);
    resolveKey(key);
  });
});

const pending = new Map<string, (value: unknown) => void>();
let service: ConnectService | undefined;

function emit(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function prompt(kind: string, data: Record<string, unknown>): Promise<unknown> {
  const id = randomBytes(16).toString("hex");
  emit({ type: "prompt", id, kind, ...data });
  return new Promise((resolvePrompt) => pending.set(id, resolvePrompt));
}

function openUrl(url: string): Promise<void> {
  return new Promise((resolveOpen, rejectOpen) => {
    execFile("/usr/bin/open", [url], (error) => error ? rejectOpen(error) : resolveOpen());
  });
}

async function initialize(): Promise<ConnectService> {
  const key = await waitingForBootstrap;
  const vault = {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
    },
    open(sealed: string): string {
      const [version, ivText, tagText, encryptedText] = sealed.split(":");
      if (version !== "v1" || !ivText || !tagText || !encryptedText) {
        throw new Error("Stored Cloudflare credentials have an unsupported format");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
      decipher.setAuthTag(Buffer.from(tagText, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
  const zonesById = new Map<string, Zone>();
  const resources = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const bundledCloudflared = process.env.CADCRAFT_BUNDLED_CLOUDFLARED ??
    resolve(resources, "bin", "cloudflared");

  service = new ConnectService({
    mode: "cloudflare",
    controlPort: 7979,
    vault,
    openUrl,
    cloudflaredPath: existsSync(bundledCloudflared) ? bundledCloudflared : undefined,
    chooseZone: async (zones) => {
      zones.forEach((zone) => zonesById.set(zone.id, zone));
      const choice = await prompt("chooseZone", {
        zones: zones.map(({ id, name }) => ({ id, name })),
      }) as { id?: string } | undefined;
      const zone = choice?.id ? zonesById.get(choice.id) : undefined;
      if (!zone) throw new Error("Choose one of the listed Cloudflare domains to continue.");
      return zone;
    },
  });
  service.on("status", (status: string, detail?: string) =>
    emit({ type: "status", status, detail }));
  service.on("log", (message: string) =>
    emit({ type: "log", message, time: Date.now() }));
  service.on("approval", (approval: PendingApproval) =>
    emit({ type: "approval", approval }));
  emit({ type: "status", status: service.status });
  return service;
}

async function handle(message: Message): Promise<void> {
  if (message.type === "response" && typeof message.id === "string") {
    pending.get(message.id)?.(message.value);
    pending.delete(message.id);
    return;
  }
  if (message.type !== "command" || typeof message.id !== "string") return;
  try {
    const svc = await serviceReady;
    let result: unknown;
    switch (message.command) {
    case "start":
      result = await svc.start();
      break;
    case "stop":
      await svc.stop();
      break;
    case "teardown":
      await svc.teardown();
      break;
    case "logout":
      await svc.stop();
      svc.logoutCloudflare();
      break;
    case "disconnectAll":
      svc.disconnectAllClaudeSessions();
      break;
    case "getCadcraftAppPath":
      result = svc.getCadcraftAppPath();
      break;
    case "setCadcraftAppPath":
      if (message.path === null || message.path === "") {
        svc.setCadcraftAppPath(undefined);
      } else if (typeof message.path === "string") {
        svc.setCadcraftAppPath(message.path);
      } else {
        throw new Error("The CadCraft app location must be a path or empty.");
      }
      break;
    case "decide":
      result = svc.decide(String(message.approvalId ?? ""), message.approve === true);
      break;
    default:
      throw new Error("Unknown native host command");
    }
    emit({ type: "response", id: message.id, ok: true, result });
  } catch (error) {
    emit({
      type: "response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

input.on("line", (line) => {
  let message: Message;
  try { message = JSON.parse(line) as Message; } catch { return; }
  if (message.type === "bootstrap") return;
  void handle(message).catch((error: unknown) => {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });
});

const serviceReady = initialize();
void serviceReady.catch((error: unknown) => {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
});

process.on("SIGTERM", () => {
  if (!service) {
    process.exit(0);
    return;
  }
  void service.stop().finally(() => process.exit(0));
});
