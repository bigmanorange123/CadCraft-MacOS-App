#!/usr/bin/env node
/**
 * Standalone stdio MCP bridge for CadCraft's control port. The app no longer needs this (it runs the
 * same code in-process), but it stays so `CADCRAFT_CMD=npx CADCRAFT_ARGS="tsx src/control-bridge.ts"` keeps working.
 * Usage: CADCRAFT_CONTROL_PORT=7979 tsx src/control-bridge.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createControlMcpServer } from "./control.js";

const { server, client } = await createControlMcpServer(Number(process.env.CADCRAFT_CONTROL_PORT ?? 7979));
client.on("close", () => process.exit(0));
await server.connect(new StdioServerTransport());
