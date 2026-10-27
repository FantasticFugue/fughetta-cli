// Makes the bound worldline hold the checkout's files.
//
// Every push compares the checkout with the worldline's current files, not with what an earlier push sent, because other agents
// write to the same worldline. For every path it holds, the checkout wins. A remote path the checkout does not hold is removed only
// when this checkout sent it earlier (the user deleted it); one created by someone else is kept. A path that exists locally but is
// not sent (too large, a link, a name the core refuses), and everything under it, keeps its remote copy. `.fughetta/state/sent.json`
// records the paths this checkout sent, with the binding it sent them to; a different binding starts from nothing.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json, locked, save } from '../files.js';
import { call, reason, tool, type Connection } from '../remote.js';
import { stateDir, type Binding } from './binding.js';
import { digestOf, scan, type File, type Snapshot } from './scan.js';

export interface Pushed {
  version: string;
  created: number;
  written: number;
  removed: number;
  // Local files not sent (too large, links, special files, names the core refuses), each with the reason; their remote copies stay.
  skipped: string[];
  // Remote files this checkout never had, left in place.
  kept: string[];
}

export const changed = (p: Pushed) => p.created + p.written + p.removed > 0;

interface Remote {
  digest: string;
  kind: string;
  size: number;
  executable: boolean;
}

// A batch whose reply never came. The next push settles it before anything else: the core answers that it ran, and then its created
// paths count as sent and its removed paths no longer do, or that it never will. Operation IDs belong to the account that sent them,
// so only that account can settle the batch.
interface Pending {
  operation_id: string;
  author: string;
  created: string[];
  removed: string[];
}

interface Sent {
  binding: Binding;
  paths: string[];
  pending: Pending[];
}

type Change = Record<string, unknown> & { kind: string; path: string };

const sameBinding = (a: Binding, b: Binding) =>
  a.server === b.server && a.workspace === b.workspace && a.project === b.project && a.worldline === b.worldline;

// The account a connection acts as, which owns the operations it sends: its issuer and user, kept apart.
async function author(core: Connection): Promise<string> {
  const reply = await call(core, 'GET', '/api/v1/me');
  if (reply.status !== 200) throw new Error(reason(reply));
  const me = JSON.parse(reply.body);
  return JSON.stringify([me.issuer, me.user]);
}

// The limit on one file from the project's effective configuration.
async function fileLimit(core: Connection, binding: Binding): Promise<number> {
  const reply = await call(core, 'GET', `/api/v1/projects/${binding.project}/effective`);
  if (reply.status !== 200) throw new Error(reason(reply));
  return JSON.parse(reply.body).limits?.max_file_bytes ?? 4 << 20;
}

export async function push(core: Connection, binding: Binding, root: string): Promise<Pushed> {
  return locked(join(stateDir(root), 'push'), () => send(core, binding, root));
}

const args = (binding: Binding, action: string) => ({ project: binding.project, worldline: binding.worldline, action });

// What this checkout sent to its binding, kept in `.fughetta/state/sent.json`.
class Ledger {
  private constructor(private readonly file: string, private readonly binding: Binding, readonly paths: Set<string>, readonly pending: Pending[]) {}

  // The record for `binding`, with every batch whose reply was lost settled.
  static async load(core: Connection, binding: Binding, file: string): Promise<Ledger> {
    const stored = await json<Sent | undefined>(file, undefined);
    if (!stored || !sameBinding(stored.binding, binding)) return new Ledger(file, binding, new Set(), []);
    const record = new Ledger(file, binding, new Set(stored.paths), [...stored.pending]);
    const me = record.pending.length ? await author(core) : '';
    while (record.pending.length) {
      const batch = record.pending[0]!;
      if (batch.author !== me) throw new Error(`A push by ${JSON.parse(batch.author)[1]} lost its reply; sign in as that account and push again`);
      const reply = await call(core, 'POST', `/api/v1/projects/${binding.project}/operations/${encodeURIComponent(batch.operation_id)}/abandon`);
      if (reply.status !== 200) throw new Error(reason(reply));
      if (JSON.parse(reply.body).outcome === 'applied') record.applied(batch);
      record.pending.shift();
      await record.save();
    }
    return record;
  }

  applied(batch: Pending) {
    for (const path of batch.removed) this.paths.delete(path);
    for (const path of batch.created) this.paths.add(path);
  }

  save(paths = [...this.paths]) {
    return save(this.file, { binding: this.binding, paths: paths.sort(), pending: this.pending } satisfies Sent, 0o644);
  }
}

interface Plan {
  out: Pushed;
  // A file is replaced by removing it and creating it again when it changes between text and binary, since a write keeps the
  // kind. One batch cannot both remove a path and create it again, nor change one path twice, so the creations and mode changes
  // go in a second phase, after the batches that removed or wrote those paths.
  phases: Change[][];
}

// Whether `path` is a skipped path or lies under one.
const shadowed = (skipped: Snapshot['skipped'], path: string) => {
  for (let at = path.length; at > 0; at = path.lastIndexOf('/', at - 1)) if (skipped.has(path.slice(0, at))) return true;
  return false;
};

function plan(local: Snapshot, tree: { version: string; files?: (Remote & { path: string })[] }, sent: Set<string>): Plan {
  const remote = new Map<string, Remote>((tree.files ?? []).map(f => [f.path, f]));
  const out: Pushed = { version: tree.version, created: 0, written: 0, removed: 0, skipped: [], kept: [] };
  for (const [path, why] of local.skipped) out.skipped.push(`${path} (${why})`);
  const phases: Change[][] = [[], []];
  const content = (kind: string, path: string, file: File, phase: number) => phases[phase]!.push({ kind, path, file } as Change);
  for (const [path, file] of local.files) {
    const there = remote.get(path);
    if (!there) {
      content('create', path, file, 0);
      ++out.created;
      continue;
    }
    const executable = file.executable ?? there.executable;
    if ((there.kind === 'text') !== file.text) {
      phases[0]!.push({ kind: 'remove', path });
      content('create', path, { ...file, executable }, 1);
      ++out.written;
      continue;
    }
    const rewritten = there.digest !== file.digest;
    if (rewritten) content('write', path, file, 0);
    if (there.executable !== executable) phases[1]!.push({ kind: 'mode', path, executable });
    if (rewritten || there.executable !== executable) ++out.written;
  }
  for (const path of remote.keys()) {
    if (local.files.has(path) || shadowed(local.skipped, path)) continue;
    if (sent.has(path)) {
      phases[0]!.push({ kind: 'remove', path });
      ++out.removed;
    } else out.kept.push(path);
  }
  return { out, phases };
}

async function send(core: Connection, binding: Binding, root: string): Promise<Pushed> {
  const ledger = await Ledger.load(core, binding, join(stateDir(root), 'sent.json'));
  const sent = ledger.paths;
  const local = await scan(root, await fileLimit(core, binding));
  // After this push the checkout answers for the paths it holds, and for paths it sent before that are skipped now.
  const finish = async (out: Pushed) => {
    await ledger.save([...local.files.keys(), ...[...sent].filter(p => shadowed(local.skipped, p))]);
    return out;
  };
  const inspect = () => tool(core, 'worldline', args(binding, 'inspect'));
  const first = plan(local, await inspect(), sent);
  if (!changed(first.out)) return finish(first.out);

  // The worldline may move until the lock is held, so the changes are planned again under it.
  await tool(core, 'worldline', { ...args(binding, 'lock'), scopes: ['::'] });
  let failure: unknown;
  let out = first.out;
  try {
    const held = plan(local, await inspect(), sent);
    out = held.out;
    const sender = await author(core);
    for (const phase of held.phases) {
      for (let next = 0; next < phase.length; ) {
        let bytes = 0;
        const batch: Record<string, unknown>[] = [];
        for (; next < phase.length; ++next) {
          const fields = await fieldsOf(root, phase[next]!);
          const size = JSON.stringify(fields).length;
          if (batch.length && bytes + size > 4 << 20) break;
          bytes += size;
          batch.push(fields);
        }
        const request = { ...args(binding, 'apply'), observed: out.version, intent: 'fug push', changes: batch };
        // A fresh ID per batch: a batch the next push abandons may be planned again with the same content.
        const operation_id = `fug-push-${randomUUID()}`;
        const paths = (removed: boolean) => batch.filter(c => (c.kind === 'remove') === removed).map(c => c.path as string);
        const pending: Pending = { operation_id, author: sender, created: paths(false), removed: paths(true) };
        ledger.pending.push(pending);
        await ledger.save();
        const applied = await tool(core, 'worldline', { ...request, operation_id });
        out.version = applied.version;
        ledger.pending.pop();
        ledger.applied(pending);
        await ledger.save();
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    await tool(core, 'worldline', { ...args(binding, 'unlock'), scopes: ['::'] });
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return finish(out);
}

// The apply fields of one change, reading a file's content now and refusing it if it changed since the scan.
async function fieldsOf(root: string, change: Change): Promise<Record<string, unknown>> {
  const { file, ...fields } = change as Change & { file?: File };
  if (!file) return fields;
  const bytes = await readFile(join(root, change.path));
  if (digestOf(bytes) !== file.digest) throw new Error(`${change.path} changed while it was sent; push again`);
  // The core decides text or binary from the bytes; text that does not survive decoding (an overlong sequence passes the core's
  // rule) goes as base64 too.
  let text: string | undefined;
  try {
    if (file.text) text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {}
  if (text !== undefined && Buffer.byteLength(text) === bytes.length) fields.text = text;
  else fields.data_base64 = bytes.toString('base64');
  if (change.kind === 'create') fields.executable = file.executable ?? false;
  return fields;
}
