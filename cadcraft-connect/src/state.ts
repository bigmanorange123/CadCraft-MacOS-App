import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Where everything lives. macOS: ~/Library/Application Support/CadCraft Connect */
export function dataDir(): string {
  const d = process.env.CADCRAFT_CONNECT_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "CadCraft Connect")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "cadcraft-connect"));
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Encrypts secrets at rest. The Mac app swaps in Electron safeStorage (macOS Keychain-backed). */
export interface Vault { seal(plain: string): string; open(sealed: string): string }
export const plainVault: Vault = { seal: (s) => s, open: (s) => s };

export interface TunnelInfo {
  accountId: string; zoneId: string; zoneName: string;
  tunnelId: string; tunnelName: string; hostname: string; dnsRecordId?: string;
}
export interface State {
  /** OAuth clients (Claude) registered with OUR authorization server */
  clients: Record<string, OAuthClientInformationFull>;
  /** SHA-256 of issued tokens. The tokens themselves are never stored. */
  access: Record<string, { grant: string; exp: number }>;
  refresh: Record<string, { grant: string; exp: number; clientId: string }>;
  revokedGrants: string[];
  tunnel?: TunnelInfo;
  settings?: { cadcraftAppPath?: string; cadcraftBin?: string };
  /** OUR login to Cloudflare's MCP server, sealed with the Vault */
  cloudflare?: { clientInfo?: string; tokens?: string };
}

export class Store {
  private data: State;
  constructor(private file = join(dataDir(), "state.json")) {
    this.data = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { clients: {}, access: {}, refresh: {}, revokedGrants: [] };
  }
  get s(): State { return this.data; }
  save(): void {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
