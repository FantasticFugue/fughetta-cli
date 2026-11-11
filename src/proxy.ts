import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type Connection, rpc, call, reason } from './remote.js';
import { type Binding, type Pushed, push, changed, stateDir } from './checkout/index.js';
import { object, save } from './files.js';
import { localReports, localExports, reportSchema } from './delivery.js';

const routes: Record<string, [string, boolean]> = Object.fromEntries([
  ...['configurations', 'build', 'test', 'run', 'language'].map(n => [n, ['/mcp', true]]),
  ...['project', 'save_project', 'effective', 'schema'].map(n => [n, ['/mcp/config', false]]),
]);
// Tools that read a worldline version build exactly what the push before them sent.
const pinned = new Set(['build', 'test', 'run', 'language']);
// The binding decides these, so the agent never sees them.
const bound = new Set(['project', 'worldline', 'version']);
const instructions = 'These tools build, test, run and analyze the project in this directory on a Fughetta core. Edit files on disk with your own tools; changes are sent before source-reading calls. Files ignored by .gitignore or .fughettaignore are not sent. Tools take no project argument. Start with configurations. When it lists none, or none that fits, read the repository, then use schema, project and save_project to set up builds, tests and analysis. Long calls return their final result and stream progress while running. Cancel a call with notifications/cancelled.';

export function unbound(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unbound);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'properties' && object(item) ? Object.fromEntries(Object.entries(item).filter(([name]) => !bound.has(name)).map(([n, v]) => [n, unbound(v)]))
      : key === 'required' && Array.isArray(item) ? item.filter(n => !bound.has(n)) : unbound(item)]));
}
export function report(p: Pushed, output: (line: string) => void, details = output) {
  for (const path of p.skipped) details(`skipped ${path}`);
  for (const path of p.kept) details(`kept ${path}`);
  for (const path of p.preserved ?? []) details(`preserved content at ${path}`);
  for (const conflict of p.conflicts ?? []) details(`source conflict ${conflict}`);
  output(changed(p) ? `Sent ${p.created} new, ${p.written} changed and ${p.removed} removed files; the project is at version ${p.version}` : `Nothing to send; the project is at version ${p.version}`);
}

export class Proxy {
  private listing?: Promise<unknown[]>;
  private pushing: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, { path: string; id: string; controller: AbortController; sent: boolean }>();
  constructor(private core: Connection, private binding: Binding, private root: string,
    private send: (reply: unknown) => void, private stderr: (line: string) => void = console.error,
    private sync: typeof push = push) {}
  private reply(id: string | number, result: unknown) { this.send({ jsonrpc: '2.0', id, result }); }
  private fail(id: string | number | null, code: number, message: string) { this.send({ jsonrpc: '2.0', id, error: { code, message } }); }
  private async cancel(target: { path: string; id: string }) {
    try {
      const r = await call(this.core, 'POST', target.path, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: target.id } }, 3_000);
      if (r.status !== 202 && r.status !== 200) throw new Error(reason(r));
    } catch (error) { this.stderr(`fug: cancel: ${String(error)}`); }
  }
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
      const target = this.pending.get(key((req.params as { requestId?: unknown } | undefined)?.requestId));
      if (target) {
        target.controller.abort();
        if (!target.sent) return;
        await this.cancel(target);
      }
      return;
    }
    if (!('id' in req)) return;
    // Number.isSafeInteger above accepts numeric IDs without narrowing their type.
    const id = req.id as string | number;
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
        const args = { ...(p.arguments as Record<string, unknown> | undefined), project: this.binding.project };
        const forwarded = { path, id: `fug-${randomUUID()}`, controller: new AbortController(), sent: false };
        this.pending.set(key(id), forwarded);
        const signal = forwarded.controller.signal;
        let synchronized: Pushed | undefined;
        try {
          if (sources) {
            const task = this.pushing.then(() => {
              signal.throwIfAborted();
              return this.sync({ ...this.core, signal }, this.binding, this.root);
            });
            this.pushing = task.catch(() => {});
            try {
              const sent = await new Promise<Pushed>((resolve, reject) => {
                const abort = () => reject(new Error('The request was cancelled'));
                signal.addEventListener('abort', abort, { once: true });
                task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
                if (signal.aborted) abort();
              });
              report(sent, this.stderr);
              synchronized = sent;
              if (pinned.has(p.name)) Object.assign(args, { worldline: this.binding.worldline, version: sent.version });
            } catch (error) {
              if (signal.aborted) throw error;
              this.reply(id, { content: [{ type: 'text', text: `The directory's changes could not be sent, so the call did not run: ${String(error)}` }], isError: true }); return;
            }
          }
          signal.throwIfAborted();
          const progressToken = randomUUID();
          let progress = 0;
          forwarded.sent = true;
          const reply = await rpc({ ...this.core, signal }, path, { jsonrpc: '2.0', id: forwarded.id, method: 'tools/call',
            params: { ...p, arguments: args, _meta: { ...(p._meta as Record<string, unknown> | undefined), progressToken } } }, 60_000, notification => {
              if (!object(notification) || !object(notification.params) ||
                notification.params.progressToken !== progressToken || (p._meta as { progressToken?: unknown } | undefined)?.progressToken === undefined) return;
              const { total: _total, ...params } = notification.params;
              this.send({ ...notification, params: { ...params, progress: ++progress, progressToken: (p._meta as { progressToken: unknown }).progressToken } });
            });
          if (!object(reply) || (!('result' in reply) && !('error' in reply))) throw new Error('The core sent an invalid MCP reply');
          forwarded.sent = false;
          if (['build', 'test', 'run'].includes(p.name) && object(reply.result)) {
            await localExports({ ...this.core, signal }, this.binding.project, this.root, reply.result);
            signal.throwIfAborted();
            await localReports(this.root, reply.result);
          }
          if (synchronized) {
            const { version, created, written, removed } = synchronized;
            const synchronization: Record<string, unknown> = { version, sent: { created, written, removed } };
            let truncated = false;
            const counts: Record<string, number> = {};
            for (const name of ['updated', 'deferred', 'preserved', 'conflicts', 'skipped'] as const) {
              const values = synchronized[name] ?? [];
              counts[name] = values.length;
              truncated ||= values.length > 16 || values.some(value => value.length > 256);
              synchronization[name] = values.slice(0, 16).map(value => value.length > 256 ? value.slice(0, 253) + '...' : value);
            }
            synchronization.counts = counts;
            if (truncated) {
              const report = join(stateDir(this.root), 'reports', 'sync.json');
              synchronization.truncated = true;
              try {
                await save(report, synchronized);
                synchronization.report = report;
              } catch (error) {
                synchronization.report_error = String(error).slice(0, 256);
              }
            }
            // Preserve spread behavior for the remote content, including invalid non-iterables.
            if (object(reply.result)) reply.result.content = [...((reply.result.content ?? []) as Iterable<unknown>), { type: 'text', text: JSON.stringify({ synchronization }) }];
            else if (object(reply.error)) reply.error.data = { remote: reply.error.data, synchronization };
          }
          this.send({ ...reply, id });
        } catch (error) {
          if (signal.aborted) this.fail(id, -32800, 'The request was cancelled');
          else {
            if (forwarded.sent) await this.cancel(forwarded);
            throw error;
          }
        } finally { this.pending.delete(key(id)); }
      } else this.fail(id, -32601, `method not found: ${req.method}`);
    } catch (error) { this.fail(id, -32603, String(error)); }
  }
  private async tools() {
    const out: unknown[] = [];
    for (const path of ['/mcp', '/mcp/config']) {
      const reply = await rpc(this.core, path, { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' }, 60_000);
      if (!object(reply) || !Array.isArray((reply.result as { tools?: unknown } | undefined)?.tools)) throw new Error('The core sent an invalid tool list');
      for (const tool of (reply.result as { tools: { name: string }[] }).tools) if (Object.hasOwn(routes, tool.name) && routes[tool.name]?.[0] === path) {
        const exposed = unbound(tool) as Record<string, unknown>;
        if (['build', 'test', 'run'].includes(tool.name) && exposed.outputSchema) exposed.outputSchema = reportSchema(exposed.outputSchema);
        out.push(exposed);
      }
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
