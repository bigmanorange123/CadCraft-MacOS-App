import express, { type Request, type Response, type NextFunction } from "express";
import type { Server as HttpServer } from "node:http";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { LocalOAuthProvider, SCOPE } from "./oauthServer.js";
import type { CadcraftProxy } from "./proxy.js";

export interface HttpOptions {
  /** Public origin, e.g. https://cadcraft-ab12cd.example.com (or http://localhost:PORT in local mode) */
  publicOrigin: string;
  port: number;
  provider: LocalOAuthProvider;
  proxy: CadcraftProxy;
}

export function startHttp(o: HttpOptions): Promise<HttpServer> {
  const origin = new URL(o.publicOrigin);
  const resource = new URL("/mcp", origin);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // cloudflared connects from 127.0.0.1

  // Only answer to our own hostname (blocks DNS-rebinding and stray Host headers).
  const okHosts = new Set([origin.host, `127.0.0.1:${o.port}`, `localhost:${o.port}`]);
  app.use((req, res, next) => {
    if (!okHosts.has(req.headers.host ?? "")) return void res.status(421).type("text/plain").send("Misdirected request");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/healthz", (_q, r) => void r.type("text/plain").send("ok"));

  // RFC 9728 Protected Resource Metadata (path-suffixed form + root form)
  const prm = (_q: Request, r: Response) => void r.json({
    resource: resource.href, authorization_servers: [origin.origin], scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"], resource_name: "CadCraft",
  });
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.get("/.well-known/oauth-protected-resource", prm);

  // RFC 8414 AS metadata (ours replaces the SDK's default so we can advertise CIMD + RFC 9207)
  app.get("/.well-known/oauth-authorization-server", (_q, r) => void r.json({
    issuer: origin.origin,
    authorization_endpoint: new URL("/authorize", origin).href,
    token_endpoint: new URL("/token", origin).href,
    registration_endpoint: new URL("/register", origin).href,
    revocation_endpoint: new URL("/revoke", origin).href,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], scopes_supported: [SCOPE],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }));

  // consent polling used by the waiting browser page
  app.get("/authorize/wait/:id", (q, r) => { r.setHeader("Cache-Control", "no-store"); r.json(o.provider.poll(String(q.params.id))); });

  // /authorize /token /register /revoke (rate-limited by the SDK)
  app.use(mcpAuthRouter({
    provider: o.provider, issuerUrl: origin, baseUrl: origin, resourceServerUrl: resource,
    scopesSupported: [SCOPE], resourceName: "CadCraft",
  }));

  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", origin).href;
  app.post("/mcp",
    requireBearerAuth({ verifier: o.provider, requiredScopes: [SCOPE], resourceMetadataUrl: metadataUrl, expectedResource: resource }),
    express.json({ limit: "10mb" }),
    async (req, res) => {
      try { await o.proxy.handle(req, res); }
      catch (e) {
        console.error("[mcp]", (e as Error).message);
        if (!res.headersSent) res.status(502).json({ jsonrpc: "2.0", error: { code: -32603, message: "CadCraft is not reachable" }, id: null });
      }
    });
  app.all("/mcp", (_q, r) => void r.status(405).setHeader("Allow", "POST").json({ error: "Method not allowed (stateless server)" }));

  app.use((_e: unknown, _q: Request, r: Response, _n: NextFunction) => void r.status(500).type("text/plain").send("Server error"));
  return new Promise((resolve) => { const s = app.listen(o.port, "127.0.0.1", () => resolve(s)); });
}
