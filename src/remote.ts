import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function origin(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('The server URL must name an HTTP or HTTPS origin');
  return url.origin;
}

export interface Connection { server: string; workspace: string; token: string }
export class Refused extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export async function exchange(url: string, method = 'GET', body?: string, headers: Record<string, string> = {}, timeout = 600_000): Promise<{ status: number; body: string }> {
  const ca = process.env.FUGHETTA_CA_FILE ? await readFile(process.env.FUGHETTA_CA_FILE) : undefined;
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, {
      method, headers: { accept: 'application/json', ...headers }, ca,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    const timer = setTimeout(() => req.destroy(new Error(`${url} timed out`)), timeout);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(body);
  });
}

export function reason(reply: { status: number; body: string }): string {
  try { const e = JSON.parse(reply.body); return `HTTP ${reply.status}: ${e.message ?? reply.body}`; }
  catch { return `HTTP ${reply.status}: ${reply.body}`; }
}

export async function call(core: Connection, method: string, path: string, body?: unknown, timeout?: number) {
  return exchange(core.server + (core.workspace ? `/w/${core.workspace}` : '') + path, method,
    body === undefined ? undefined : JSON.stringify(body), { 'content-type': 'application/json', authorization: `Bearer ${core.token}` }, timeout);
}

export async function rpc(core: Connection, path: string, request: unknown, timeout?: number): Promise<any> {
  const r = await call(core, 'POST', path, request, timeout);
  if (r.status !== 200) throw new Error(reason(r));
  return JSON.parse(r.body);
}

export async function tool(core: Connection, name: string, args: unknown, path = '/mcp'): Promise<any> {
  const reply = await rpc(core, path, { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } });
  if (reply.error) throw new Error(reply.error.message);
  if (!reply.result) throw new Error('The core sent no MCP result');
  if (reply.result.isError) {
    const e = reply.result.structuredContent;
    throw new Refused(e?.code ?? 'failed', e?.message ?? JSON.stringify(reply.result.content));
  }
  return reply.result.structuredContent;
}
