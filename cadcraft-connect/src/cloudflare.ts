/**
 * Everything we do to the user's Cloudflare account goes through Cloudflare's MCP `execute` tool
 * (OpenAPI calls). Only four things are touched: zones (read), one tunnel, its ingress config,
 * and ONE DNS record. An existing DNS record that points elsewhere is never overwritten.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TunnelInfo } from "./state.js";

export interface Zone { id: string; name: string; accountId: string }
export interface Provisioned { tunnelId: string; dnsRecordId: string; token: string }

export class CloudflareApi {
  constructor(private client: Client) {}

  private async run<T>(code: string, accountId?: string): Promise<T> {
    const r: any = await this.client.callTool(
      { name: "execute", arguments: { code, truncate: false, ...(accountId ? { account_id: accountId } : {}) } },
      undefined, { timeout: 120_000 });
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    if (r.isError) throw new Error("Cloudflare: " + text.slice(0, 500));
    try { return JSON.parse(text); } catch {
      const m = text.match(/[\[{][\s\S]*[\]}]/);
      if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
      throw new Error("Unexpected Cloudflare response: " + text.slice(0, 200));
    }
  }

  listZones(): Promise<Zone[]> {
    return this.run(`async () => {
      const out = []; let page = 1;
      for (;;) {
        const r = await cloudflare.request({ method: 'GET', path: '/zones', query: { page, per_page: 50, status: 'active' } });
        out.push(...r.result.map(z => ({ id: z.id, name: z.name, accountId: z.account.id })));
        if (!r.result_info || page >= r.result_info.total_pages) break; page++;
      }
      return out; }`);
  }

  provision(p: { accountId: string; zoneId: string; tunnelName: string; hostname: string; service: string }): Promise<Provisioned> {
    return this.run(`async () => {
      const P = ${JSON.stringify(p)};
      const acc = P.accountId;
      const found = await cloudflare.request({ method: 'GET', path: '/accounts/' + acc + '/cfd_tunnel', query: { name: P.tunnelName, is_deleted: false } });
      let t = found.result[0];
      if (t && t.config_src && t.config_src !== 'cloudflare') throw new Error('A locally-managed tunnel named ' + P.tunnelName + ' already exists');
      if (!t) t = (await cloudflare.request({ method: 'POST', path: '/accounts/' + acc + '/cfd_tunnel', body: { name: P.tunnelName, config_src: 'cloudflare' } })).result;
      await cloudflare.request({ method: 'PUT', path: '/accounts/' + acc + '/cfd_tunnel/' + t.id + '/configurations',
        body: { config: { ingress: [ { hostname: P.hostname, service: P.service }, { service: 'http_status:404' } ] } } });
      const target = t.id + '.cfargotunnel.com';
      const recs = await cloudflare.request({ method: 'GET', path: '/zones/' + P.zoneId + '/dns_records', query: { name: P.hostname } });
      let rec = recs.result[0];
      if (rec && !(rec.type === 'CNAME' && rec.content === target)) throw new Error('DNS record ' + P.hostname + ' already exists and points elsewhere; not overwriting it');
      if (!rec) rec = (await cloudflare.request({ method: 'POST', path: '/zones/' + P.zoneId + '/dns_records',
        body: { type: 'CNAME', name: P.hostname, content: target, proxied: true, comment: 'CadCraft Connect' } })).result;
      const tok = await cloudflare.request({ method: 'GET', path: '/accounts/' + acc + '/cfd_tunnel/' + t.id + '/token' });
      return { tunnelId: t.id, dnsRecordId: rec.id, token: tok.result };
    }`, p.accountId);
  }

  teardown(t: TunnelInfo): Promise<{ deleted: boolean }> {
    return this.run(`async () => {
      const P = ${JSON.stringify({ accountId: t.accountId, zoneId: t.zoneId, tunnelId: t.tunnelId, dnsRecordId: t.dnsRecordId })};
      if (P.dnsRecordId) await cloudflare.request({ method: 'DELETE', path: '/zones/' + P.zoneId + '/dns_records/' + P.dnsRecordId });
      await cloudflare.request({ method: 'DELETE', path: '/accounts/' + P.accountId + '/cfd_tunnel/' + P.tunnelId + '/connections' }).catch(() => {});
      await cloudflare.request({ method: 'DELETE', path: '/accounts/' + P.accountId + '/cfd_tunnel/' + P.tunnelId });
      return { deleted: true }; }`, t.accountId);
  }
}
