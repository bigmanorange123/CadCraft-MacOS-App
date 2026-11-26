import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fake-cadcraft-studio", version: "0.1.0" });
server.tool("studio_status", "Fake Studio connection status.", {}, async () => ({
  content: [{ type: "text", text: "Studio is running." }],
  structuredContent: { running: true }
}));
server.tool("cad_test", "Fake Studio drawing tool.", {}, async () => ({
  content: [{ type: "text", text: "Drawing updated." }]
}));
await server.connect(new StdioServerTransport());
