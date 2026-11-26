// Stand-in for `cadcraft-cli mcp` so the bridge can be tested without CadCraft installed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const s = new McpServer({ name: "fake-cadcraft", version: "0" });
const lines: string[] = [];
s.tool("command_line", { command: z.string() }, async ({ command }) => { lines.push(command); return { content: [{ type: "text", text: `ok: ${command}` }] }; });
s.tool("inspect_drawing", {}, async () => ({ content: [{ type: "text", text: JSON.stringify({ entities: lines.length }) }] }));
await s.connect(new StdioServerTransport());
