import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ccc-studio-"));
const { ConnectService } = await import("../src/service.js");
const { McpLogin } = await import("../src/mcpLogin.js");
const { Store, plainVault } = await import("../src/state.js");
let ensureCalls = 0;

let pass = 0, fail = 0;
const ok = (condition: unknown, name: string) => {
  condition ? pass++ : fail++;
  console.log(`${condition ? "  ✓" : "  ✗ FAIL"} ${name}`);
};

const port = 7641;
const service = new ConnectService({
  mode: "local",
  port,
  store: new Store(join(tmp, "service.json")),
  studioMcp: {
    command: process.execPath,
    args: ["--import", "tsx", resolve("test/fake-studio-mcp.ts")],
    ensureToolCall: async () => { ensureCalls++; }
  },
  allowLoopbackRedirects: true,
  openUrl: async () => {},
  chooseZone: async (zones) => zones[0]
});
service.on("approval", (approval) => service.decide(approval.id, true));

try {
  const url = await service.start();
  const browser = async (authURL: string) => {
    const id = (await (await fetch(authURL)).text()).match(/const id="([^"]+)"/)![1];
    const poll = await (await fetch(`http://localhost:${port}/authorize/wait/${id}`)).json() as { redirect: string };
    await fetch(poll.redirect);
  };
  const login = new McpLogin({
    serverUrl: url,
    store: new Store(join(tmp, "client.json")),
    vault: plainVault,
    openUrl: browser,
    callbackPort: 38999,
    allowInsecureLoopback: true
  });
  const mcp = await login.connect();
  const names = (await mcp.listTools()).tools.map((tool) => tool.name);
  ok(names.includes("studio_status") && names.includes("cad_test"), "Studio tool discovery works while launch remains deferred");
  ok(ensureCalls === 0, "Studio is not opened for tool discovery");

  const result = await mcp.callTool({ name: "cad_test", arguments: {} }) as { content: { text?: string }[] };
  ok(ensureCalls === 1 && result.content[0]?.text === "Drawing updated.", "the first real tool call starts Studio before forwarding");

  await mcp.close().catch(() => {});
} catch (error) {
  ok(false, `Studio proxy test failed: ${(error as Error).message}`);
} finally {
  await service.stop();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
