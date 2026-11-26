/**
 * CadCraft Connect: macOS menu-bar app.
 * Logs into Cloudflare (OAuth, via Cloudflare's MCP), creates the tunnel + DNS record, starts the
 * authenticated bridge, and shows the connector URL. Every Claude connection must be approved here.
 */
import { app, Tray, Menu, dialog, shell, clipboard, safeStorage, nativeImage, Notification } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ConnectService } from "../src/service.js";
import type { PendingApproval } from "../src/oauthServer.js";

if (!app.requestSingleInstanceLock()) app.quit();
app.dock?.hide();

let tray: Tray, svc: ConnectService, status = "idle", url: string | undefined;

function render() {
  const ready = status === "ready";
  tray.setTitle(ready ? "CAD ●" : "CAD ○");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: ready ? "Connected to Cloudflare" : `Status: ${status}`, enabled: false },
    { label: "Copy connector URL", enabled: ready, click: () => url && clipboard.writeText(url) },
    { type: "separator" },
    { label: "Disconnect all Claude sessions", enabled: ready, click: () => { svc.disconnectAllClaudeSessions(); new Notification({ title: "CadCraft Connect", body: "All Claude sessions were signed out." }).show(); } },
    { label: "Remove tunnel and DNS record…", click: removeTunnel },
    { label: "Sign out of Cloudflare", click: () => svc.logoutCloudflare() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

async function removeTunnel() {
  const { response } = await dialog.showMessageBox({ type: "warning", buttons: ["Cancel", "Remove"], defaultId: 0, cancelId: 0,
    message: "Remove the tunnel and DNS record from Cloudflare?", detail: "Claude will lose access until you set it up again." });
  if (response !== 1) return;
  try { await svc.teardown(); dialog.showMessageBox({ message: "Removed from Cloudflare." }); } catch (e) { dialog.showErrorBox("Could not remove", (e as Error).message); }
}

async function approve(p: PendingApproval) {
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: p.trusted ? "question" : "warning", buttons: ["Deny", "Approve"], defaultId: 0, cancelId: 0,
    message: `${p.clientName} wants to control CadCraft`,
    detail: `Requested from ${p.redirectHost}${p.trusted ? "" : "\n\n⚠ This is NOT a recognised Claude address. Deny unless you know what it is."}\n\n` +
      `Approve only if this code matches the one in your browser:\n\n${p.matchCode}`,
  });
  svc.decide(p.id, response === 1);
}

app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) { dialog.showErrorBox("Keychain unavailable", "Secure storage is not available, so CadCraft Connect cannot store your Cloudflare login safely."); return app.quit(); }
  tray = new Tray(nativeImage.createEmpty());
  svc = new ConnectService({
    mode: "cloudflare",
    openUrl: (u) => shell.openExternal(u),
    vault: { seal: (s) => safeStorage.encryptString(s).toString("base64"), open: (s) => safeStorage.decryptString(Buffer.from(s, "base64")) }, // macOS Keychain-backed
    locateApp: async () => {
      const r = await dialog.showOpenDialog({ title: "Where is CadCraft?", message: "Select CadCraft.app", defaultPath: "/Applications", properties: ["openFile", "openDirectory"] });
      const bin = r.filePaths[0] && join(r.filePaths[0], "Contents", "MacOS", "CADCraft");
      return bin && existsSync(bin) ? bin : undefined;
    },
    cloudflaredPath: join(process.resourcesPath ?? "", "bin", "cloudflared"),
    chooseZone: async (zones) => {
      const shown = zones.slice(0, 8);
      const { response } = await dialog.showMessageBox({ message: "Which domain should the tunnel use?", detail: "A random subdomain will be created on it.", buttons: shown.map((z) => z.name) });
      return shown[response];
    },
  });
  svc.on("status", (s: string, d?: string) => { status = s; render(); if (s === "error") dialog.showErrorBox("CadCraft Connect", d ?? "Something went wrong"); });
  svc.on("approval", approve);
  render();
  try {
    url = await svc.start();
    clipboard.writeText(url);
    dialog.showMessageBox({ message: "Ready. Connector URL copied.", detail: `${url}\n\nIn Claude: Settings → Connectors → Add custom connector → paste this URL.` });
  } catch { /* shown by the status handler */ }
});
app.on("window-all-closed", () => {}); // menu-bar app: keep running
app.on("before-quit", () => { void svc?.stop(); });
