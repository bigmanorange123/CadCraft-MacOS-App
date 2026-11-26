/**
 * Bridges CadCraft's stdio MCP server to stateless Streamable HTTP.
 * One long-lived `cadcraft-cli mcp` child (it holds the open drawing); each HTTP request gets a
 * throw-away MCP server/transport, so the HTTP side stays stateless as the 2026-07-28 spec wants.
 * Tool calls are queued one at a time so CAD commands never interleave.
 */
import type { Request, Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export type ProgressReporter = (message: string) => Promise<void>;

export type ProxyOptions =
  | {
      kind: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
      ensureToolCall?: (name: string, reportProgress: ProgressReporter) => Promise<void>;
    }
  /** `open` is called on every (re)connect, so it can relaunch CadCraft if it was closed. */
  | {
      kind: "inprocess";
      open: () => Promise<{ server: McpServer; onClose: (cb: () => void) => void }>;
      ensureToolCall?: (name: string, reportProgress: ProgressReporter) => Promise<void>;
    };

export class CadcraftProxy {
  private ready?: Promise<Client>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private o: ProxyOptions) {}

  private connect(): Promise<Client> {
    const p = (async () => {
      if (this.o.kind === "inprocess") {
        const { server, onClose } = await this.o.open();
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st);
        const c = new Client({ name: "cadcraft-connect", version: "0.1.0" });
        c.onclose = () => { if (this.ready === p) this.ready = undefined; }; // CadCraft quit: reconnect (and relaunch) next request
        onClose(() => { void ct.close(); });
        await c.connect(ct);
        return c;
      }
      const transport = new StdioClientTransport({ command: this.o.command, args: this.o.args, env: this.o.env, stderr: "ignore" });
      const client = new Client({ name: "cadcraft-connect", version: "0.1.0" });
      transport.onclose = () => { if (this.ready === p) this.ready = undefined; }; // respawn on next request
      await client.connect(transport);
      return client;
    })();
    p.catch(() => { if (this.ready === p) this.ready = undefined; });
    return p;
  }
  client(): Promise<Client> { return (this.ready ??= this.connect()); }
  /** Used for the health check and for the "CadCraft found" status in the app. */
  async toolNames(): Promise<string[]> { return (await (await this.client()).listTools()).tools.map((t) => t.name); }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const client = await this.client();
    const server = new Server({ name: "cadcraft", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (r) => {
      const result = await client.listTools(r.params);
      if (this.o.kind !== "stdio" || !this.o.ensureToolCall) return result;
      return {
        ...result,
        tools: result.tools.map((tool) => tool.name === "studio_status"
          ? {
              ...tool,
              description: `${tool.description ?? ""} Calling this status tool from CadCraft Connect installs CadCraft Studio if needed and opens it on demand.`
            }
          : tool)
      };
    });
    server.setRequestHandler(CallToolRequestSchema, (r, extra) => this.serial(async () => {
      const reportProgress: ProgressReporter = async (message) => {
        const progressToken = extra._meta?.progressToken;
        if (progressToken === undefined) return;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: 0, total: 1, message }
        });
      };
      await this.o.ensureToolCall?.(r.params.name, reportProgress);
      if (this.o.kind === "stdio" && this.o.ensureToolCall && r.params.name === "studio_status") {
        let tools = (await client.listTools()).tools;
        const deadline = Date.now() + 5_000;
        while (tools.some((tool) => tool.name === "studio_status") && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          tools = (await client.listTools()).tools;
        }
        return {
          content: [{
            type: "text",
            text: tools.some((tool) => tool.name === "studio_status")
              ? "CadCraft Studio is open and connecting. Refresh the CadCraft tool list in a few seconds."
              : "CadCraft Studio is open. Refresh the CadCraft tool list, then retry the requested action."
          }],
          structuredContent: { running: true, toolCount: tools.length }
        };
      }
      return client.callTool(r.params, undefined, { timeout: 5 * 60_000 });
    }) as Promise<any>);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  async close(): Promise<void> { const c = await this.ready?.catch(() => undefined); await c?.close(); this.ready = undefined; }
}
