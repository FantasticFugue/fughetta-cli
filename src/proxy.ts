import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { type Connection, rpc, call, reason } from './remote.js';
import { type Binding, type Pushed, push, changed } from './checkout/index.js';
import { object } from './files.js';

const routes: Record<string, [string, boolean]> = Object.fromEntries([
  ...['configurations', 'build', 'test', 'run', 'language'].map(n => [n, ['/mcp', true]]),
  ['jobs', ['/mcp', false]],
  ...['project', 'save_project', 'effective', 'schema'].map(n => [n, ['/mcp/config', false]]),
  ...['preview', 'analysis'].map(n => [n, ['/mcp/config', true]]),
]);
// Tools that read a worldline version build exactly what the push before them sent.
const pinned = new Set(['build', 'test', 'run', 'language']);
// The binding decides these, so the agent never sees them.
const bound = new Set(['project', 'worldline', 'version']);
const instructions = 'These tools build, test, run and analyze the project in this directory on a Fughetta core. Edit files on disk with your own tools; changes are sent before source-reading calls. Files ignored by .gitignore or .fughettaignore are not sent. Tools take no project argument. Start with configurations. When it lists none, or none that fits, read the repository, then use schema, project and save_project to set up builds, tests and analysis. Follow long builds with jobs.';

export function unbound(value: any): any {
  if (Array.isArray(value)) return value.map(unbound);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'properties' && object(item) ? Object.fromEntries(Object.entries(item).filter(([name]) => !bound.has(name)).map(([n, v]) => [n, unbound(v)]))
      : key === 'required' && Array.isArray(item) ? item.filter(n => !bound.has(n)) : unbound(item)]));
}
export function report(p: Pushed, output: (line: string) => void, details = output) {
  for (const path of p.skipped) details(`skipped ${path}`);
  for (const path of p.kept) details(`kept ${path}`);
  output(changed(p) ? `Sent ${p.created} new, ${p.written} changed and ${p.removed} removed files; the project is at version ${p.version}` : `Nothing to send; the project is at version ${p.version}`);
}

export class Proxy {
  private listing?: Promise<any[]>;
  private pushing: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, { path: string; id: string }>();
  constructor(private core: Connection, private binding: Binding, private root: string,
    private send: (reply: any) => void, private stderr: (line: string) => void = console.error,
    private sync: typeof push = push) {}
  private reply(id: any, result: any) { this.send({ jsonrpc: '2.0', id, result }); }
  private fail(id: any, code: number, message: string) { this.send({ jsonrpc: '2.0', id, error: { code, message } }); }
  async line(line: string): Promise<void> {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); } catch { this.fail(null, -32700, 'Invalid JSON'); return; }
    if (!object(req) || req.jsonrpc !== '2.0' || typeof req.method !== 'string' ||
      ('id' in req && !(typeof req.id === 'string' || Number.isSafeInteger(req.id)))) {
      this.fail(null, -32600, 'Invalid request'); return;
    }
    const key = (id: unknown) => JSON.stringify(id);
    if (req.method === 'notifications/cancelled') {
      const target = this.pending.get(key(req.params?.requestId));
      if (target) {
        try { const r = await call(this.core, 'POST', target.path, { jsonrpc: '2.0', method: req.method, params: { requestId: target.id } }, 30_000); if (r.status !== 202 && r.status !== 200) throw new Error(reason(r)); }
        catch (error) { this.stderr(`fug: cancel: ${String(error)}`); }
      }
      return;
    }
    if (!('id' in req)) return;
    const id = req.id;
    try {
      if (req.method === 'initialize') {
        this.reply(id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fughetta', version: '0.1.0' }, instructions });
      } else if (req.method === 'ping') this.reply(id, {});
      else if (req.method === 'tools/list') {
        this.listing ??= this.tools().catch(error => { this.listing = undefined; throw error; });
        this.reply(id, { tools: await this.listing });
      } else if (req.method === 'tools/call') {
        const p = req.params;
        if (!object(p) || typeof p.name !== 'string' || ('arguments' in p && !object(p.arguments))) {
          this.fail(id, -32602, 'Tool params need a name and object arguments'); return;
        }
        const route = Object.hasOwn(routes, p.name) ? routes[p.name] : undefined;
        if (!route) { this.fail(id, -32602, `unknown tool: ${p.name}`); return; }
        const [path, sources] = route;
        const args = { ...p.arguments, project: this.binding.project };
        if (sources) {
          const task = this.pushing.then(() => this.sync(this.core, this.binding, this.root));
          this.pushing = task.catch(() => {});
          try {
            const sent = await task;
            report(sent, this.stderr);
            if (pinned.has(p.name)) Object.assign(args, { worldline: this.binding.worldline, version: sent.version });
          } catch (error) {
            this.reply(id, { content: [{ type: 'text', text: `The directory's changes could not be sent, so the call did not run: ${String(error)}` }], isError: true }); return;
          }
        }
        const forwarded = { path, id: `fug-${randomUUID()}` };
        this.pending.set(key(id), forwarded);
        try {
          const reply = await rpc(this.core, path, { jsonrpc: '2.0', id: forwarded.id, method: 'tools/call', params: { ...p, arguments: args } }, 43_200_000);
          if (!object(reply) || (!('result' in reply) && !('error' in reply))) throw new Error('The core sent an invalid MCP reply');
          this.send({ ...reply, id });
        } finally { this.pending.delete(key(id)); }
      } else this.fail(id, -32601, `method not found: ${req.method}`);
    } catch (error) { this.fail(id, -32603, String(error)); }
  }
  private async tools() {
    const out = [];
    for (const path of ['/mcp', '/mcp/config']) {
      const reply = await rpc(this.core, path, { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' }, 60_000);
      if (!Array.isArray(reply.result?.tools)) throw new Error('The core sent an invalid tool list');
      for (const tool of reply.result.tools) if (Object.hasOwn(routes, tool.name) && routes[tool.name]?.[0] === path) out.push(unbound(tool));
    }
    return out;
  }
}
export async function serve(core: Connection, binding: Binding, root: string) {
  const proxy = new Proxy(core, binding, root, reply => process.stdout.write(JSON.stringify(reply) + '\n'));
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const task = proxy.line(line);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}
