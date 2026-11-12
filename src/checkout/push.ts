// Compare local edits with the source version last written to disk, then pull the merged tree.
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { json, locked, object, save } from '../files.js';
import { call, reason, Refused, type Connection } from '../remote.js';
import { worldline } from '../worldline.js';
import { stateDir, type Binding } from './binding.js';
import { digestOf, scan, type Snapshot } from './scan.js';
import { Rules } from './ignore.js';
import { prefetch } from './concurrent.js';

export interface Pushed {
  version: string;
  created: number;
  written: number;
  removed: number;
  skipped: string[];
  kept: string[];
  deferred?: string[];
  preserved?: string[];
  conflicts?: string[];
  updated?: string[];
}
export const changed = (p: Pushed) => p.created + p.written + p.removed > 0;
interface Entry { digest: string; kind: string; size: number; executable: boolean; data_base64?: string }
interface Baseline { version: string; file?: Entry }
interface Pending { operation_id: string; author: string; after: Record<string, Entry | null> }
interface Pull { path: string; before?: Entry; after?: Entry; version: string; temp?: string; backup?: string; installed?: boolean }
interface State { binding: Binding; version: string; files: Record<string, Baseline>; pending?: Pending; pull?: Pull }
interface Tree { version: string; files: (Omit<Entry, 'data_base64'> & { path: string })[]; truncated?: boolean; conflicts?: string[] }
interface Change { kind: string; path: string; destination?: string; text?: string; data_base64?: string; offset?: number; count?: number; executable?: boolean }
interface Edit { change: Change; version: string; after: Record<string, Entry | null> }
const sameBinding = (a: Binding, b: Binding) => a.server === b.server && a.workspace === b.workspace && a.project === b.project && a.worldline === b.worldline;
const same = (a?: Pick<Entry, 'digest' | 'executable'>, b?: Pick<Entry, 'digest' | 'executable'>) =>
  !a || !b ? a === b : a.digest === b.digest && (process.platform === 'win32' || a.executable === b.executable);
const decode = async (ledger: Ledger, value: Entry) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await ledger.bytes(value));

// One contiguous replacement, counted in Unicode scalar values instead of UTF-16 units.
export function delta(before: string, after: string): { offset: number; count: number; text: string } | undefined {
  if (before === after) return undefined;
  const a = [...before], b = [...after];
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) ++start;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) ++end;
  return { offset: start, count: a.length - start - end, text: b.slice(start, b.length - end).join('') };
}

async function author(core: Connection): Promise<string> {
  const reply = await call(core, 'GET', '/api/v1/me');
  if (reply.status !== 200) throw new Error(reason(reply));
  const me = JSON.parse(reply.body);
  return JSON.stringify([me.issuer, me.user]);
}
async function fileLimit(core: Connection, binding: Binding): Promise<number> {
  const reply = await call(core, 'GET', `/api/v1/projects/${binding.project}/effective`);
  if (reply.status !== 200) throw new Error(reason(reply));
  return JSON.parse(reply.body).limits?.max_file_bytes ?? 4 << 20;
}
const shadowed = (skipped: Snapshot['skipped'], path: string) => {
  for (let at = path.length; at > 0; at = path.lastIndexOf('/', at - 1)) if (skipped.has(path.slice(0, at))) return true;
  return false;
};
async function unavailable(root: string, path: string): Promise<'ignored' | 'blocked' | undefined> {
  const parts = path.split('/');
  if (parts.some(p => Buffer.byteLength(p, 'utf8') > 255 || !p || p === '.' || p === '..' || /[\\\0-\x1f]/.test(p) || (process.platform === 'win32' && p.includes(':')))) return 'ignored';
  let rules = await Rules.root().enter(root, ''), relative = '';
  for (let i = 0; i < parts.length; ++i) {
    relative = relative ? `${relative}/${parts[i]}` : parts[i]!;
    const directory = i < parts.length - 1;
    if (rules.ignored(relative, directory)) return 'ignored';
    try {
      const stat = await lstat(join(root, relative));
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) return 'blocked';
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (directory) rules = await rules.enter(join(root, relative), relative);
  }
  return undefined;
}
const allowed = async (root: string, path: string) => await unavailable(root, path) === undefined;
async function localFile(root: string, path: string): Promise<Entry | undefined> {
  if (!await allowed(root, path)) throw new Error(`${path} is not a writable regular checkout path`);
  return readEntry(join(root, path));
}
async function readEntry(path: string): Promise<Entry | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    const bytes = await readFile(path);
    let kind = 'text';
    try { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) kind = 'binary'; }
    catch { kind = 'binary'; }
    return { digest: digestOf(bytes), size: bytes.length, executable: process.platform !== 'win32' && !!(stat.mode & 0o100), kind, data_base64: bytes.toString('base64') };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function remoteFile(core: Connection, binding: Binding, version: string, path: string, expected?: { digest: string }): Promise<Entry> {
  const file = await worldline(core, binding, 'read', { version, path }) as Entry;
  const bytes = Buffer.from(file.data_base64!, 'base64');
  if (digestOf(bytes) !== file.digest || bytes.length !== file.size || (expected && expected.digest !== file.digest)) throw new Error(`Source content verification failed for ${path}`);
  return { digest: file.digest, size: file.size, kind: file.kind, executable: file.executable, data_base64: file.data_base64 };
}
async function tree(core: Connection, binding: Binding): Promise<Tree> {
  const value = await worldline(core, binding, 'inspect') as Tree;
  if (value.truncated) throw new Error('Cannot synchronize a truncated source manifest');
  const identities = value.conflicts?.filter(conflict => conflict.startsWith('identity:'));
  if (identities?.length) throw new Error(`Source identity conflicts require resolution: ${identities.join(', ')}`);
  return value;
}

class Ledger {
  constructor(readonly path: string, readonly state: State, readonly core: Connection) {}
  readonly preserved: string[] = [];
  readonly blocked = new Set<string>();
  rescan = false;
  private cached = new Set<string>();
  private journals = new Map<string, Pull>();
  private metadata(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, (key, item) => key === 'data_base64' ? undefined : item));
  }
  async bytes(file: Entry): Promise<Buffer> {
    let bytes: Buffer | undefined;
    try {
      bytes = file.data_base64 === undefined
        ? await readFile(join(dirname(this.path), 'blobs', file.digest))
        : Buffer.from(file.data_base64, 'base64');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (bytes && bytes.length === file.size && digestOf(bytes) === file.digest) return bytes;
    const baseline = Object.entries(this.state.files).find(([, item]) => item.file?.digest === file.digest);
    if (!baseline) throw new Error('Cached source content failed verification and has no saved source version');
    const [path, item] = baseline;
    const restored = await remoteFile(this.core, this.state.binding, item.version, path, file);
    this.cached.delete(file.digest);
    await this.cache(restored);
    return Buffer.from(restored.data_base64!, 'base64');
  }
  async collectRecovered(root: string) {
    const directory = join(dirname(this.path), 'recovered');
    for (const name of await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
      throw error;
    })) {
      if (!name.endsWith('.file.json')) continue;
      const record = join(directory, name), backup = record.slice(0, -5);
      const pull = await json<Pull>(record, undefined as never);
      if (!await exists(backup)) { await rm(record); continue; }
      if (!(await lstat(backup)).isFile()) {
        this.preserved.push(backup);
        if (!await allowed(root, pull.path) || !await exists(join(root, pull.path))) this.blocked.add(pull.path);
        continue;
      }
      if (await sameInode(backup, join(root, pull.path)) || same(await readEntry(backup), pull.before)) {
        await rm(backup);
        await rm(record);
      } else this.preserved.push(backup);
    }
  }
  private async cache(file?: Entry | null) {
    if (!file || file.data_base64 === undefined || this.cached.has(file.digest)) return;
    const directory = join(dirname(this.path), 'blobs');
    await mkdir(directory, { recursive: true });
    const target = join(directory, file.digest);
    const temp = `${target}.${randomUUID()}`;
    try {
      await writeFile(temp, await this.bytes(file), { flag: 'wx', mode: 0o600 });
      await rename(temp, target);
    } finally { await rm(temp, { force: true }); }
    this.cached.add(file.digest);
  }
  async save() {
    for (const item of Object.values(this.state.files)) await this.cache(item.file);
    for (const file of Object.values(this.state.pending?.after ?? {})) await this.cache(file);
    await save(this.path, this.metadata(this.state));
  }
  async journal(pull: Pull): Promise<string> {
    await this.cache(pull.before); await this.cache(pull.after);
    const file = join(dirname(this.path), 'pulls', `${randomUUID()}.json`);
    await save(file, this.metadata(pull));
    this.journals.set(file, pull);
    return file;
  }
  async flush() {
    await this.save();
    for (const file of [...this.journals.keys()]) await this.cancelJournal(file);
    this.journals.clear();
    const keep = new Set(Object.values(this.state.files).flatMap(item => item.file ? [item.file.digest] : []));
    for (const file of Object.values(this.state.pending?.after ?? {})) if (file) keep.add(file.digest);
    const directory = join(dirname(this.path), 'blobs');
    for (const name of await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
      throw error;
    })) if (!keep.has(name)) await rm(join(directory, name), { force: true });
  }
  async installed(file: string) {
    const pull = this.journals.get(file)!;
    pull.installed = true;
    await save(file, this.metadata(pull));
  }
  async cancelJournal(file: string) {
    const pull = this.journals.get(file);
    if (pull?.backup && await exists(pull.backup)) {
      await rename(file, `${pull.backup}.json`);
      if (!(await lstat(pull.backup)).isFile() || !same(await readEntry(pull.backup), pull.before))
        this.preserved.push(pull.backup);
    }
    else await rm(file, { force: true });
    if (pull?.temp) await rm(pull.temp, { force: true });
    this.journals.delete(file);
  }
  async complete(core: Connection, pending: Pending, receipt?: unknown) {
    const done = receipt ?? await worldline(core, this.state.binding, 'receipt', { operation_id: pending.operation_id });
    if (!object(done) || !done.written_version) throw new Error('The server must support written_version for optimistic synchronization');
    // Receipt versions are server strings; retain the existing presence check.
    for (const [path, file] of Object.entries(pending.after)) this.state.files[path] = { version: done.written_version as string, ...(file ? { file } : {}) };
    this.state.version = done.version as string;
    delete this.state.pending;
    await this.save();
  }
  async settle(core: Connection) {
    const pending = this.state.pending;
    if (!pending) return;
    if (pending.author !== await author(core)) throw new Error(`A push by ${JSON.parse(pending.author)[1]} lost its reply; sign in as that account and push again`);
    const reply = await call(core, 'POST', `/api/v1/projects/${this.state.binding.project}/operations/${encodeURIComponent(pending.operation_id)}/abandon`);
    if (reply.status !== 200) throw new Error(reason(reply));
    if (JSON.parse(reply.body).outcome === 'applied') await this.complete(core, pending);
    else { delete this.state.pending; await this.save(); }
  }
  async recoverPull(root: string) {
    const directory = join(dirname(this.path), 'pulls');
    const files = await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
      throw error;
    });
    const pulls: Pull[] = this.state.pull ? [this.state.pull] : [];
    for (const name of files.sort()) {
      const file = join(directory, name);
      const pull = await json<Pull>(file, undefined as never);
      pulls.push(pull);
      this.journals.set(file, pull);
    }
    for (const pull of pulls) {
      if (pull.installed) {
        this.state.files[pull.path] = { version: pull.version, ...(pull.after ? { file: pull.after } : {}) };
        continue;
      }
      if (pull.backup) {
        let installed: boolean = false;
        if (!installed && await exists(pull.backup)) {
          if (!(await lstat(pull.backup)).isFile()) {
            this.blocked.add(pull.path);
            continue;
          }
          if (!same(await readEntry(pull.backup), pull.before)) {
            if (await allowed(root, pull.path)) {
              await restoreCaptured(pull.backup, join(root, pull.path));
              this.rescan = true;
            }
            continue;
          }
          // A recreated target belongs to the editor. Leave its bytes in place.
          // If the path is still absent, finish installing the prepared content.
          if (pull.after && pull.temp && !await exists(join(root, pull.path)) && await allowed(root, pull.path)) {
            await mkdir(dirname(join(root, pull.path)), { recursive: true });
            await link(pull.temp, join(root, pull.path)).catch(error => {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            });
            this.rescan = true;
          }
          installed = pull.after ? !!pull.temp && await sameInode(pull.temp, join(root, pull.path)) : !await exists(join(root, pull.path));
        }
        if (installed) this.state.files[pull.path] = { version: pull.version, ...(pull.after ? { file: pull.after } : {}) };
        continue;
      }
      if (pull.temp) {
        const installed = !!pull.after && await sameInode(pull.temp, join(root, pull.path));
        if (installed) this.state.files[pull.path] = { version: pull.version, ...(pull.after ? { file: pull.after } : {}) };
        continue;
      }
      const current = await localFile(root, pull.path);
      if (same(current, pull.after)) this.state.files[pull.path] = { version: pull.version, ...(pull.after ? { file: pull.after } : {}) };
      else if (!same(current, pull.before)) throw new Error(`${pull.path} changed during interrupted writeback; preserve it and resolve the saved baseline in ${this.path}`);
    }
    if (pulls.length) { delete this.state.pull; await this.flush(); }
  }
}

async function open(core: Connection, binding: Binding, root: string, local: Snapshot): Promise<Ledger> {
  const path = join(stateDir(root), 'baseline.json');
  const stored = await json<State | undefined>(path, undefined);
  if (stored && !sameBinding(stored.binding, binding)) throw new Error('This directory has a baseline for another binding; use fug worldline checkout in a new directory');
  if (stored && sameBinding(stored.binding, binding)) {
    stored.files = Object.assign(Object.create(null), stored.files);
    const ledger = new Ledger(path, stored, core);
    await ledger.collectRecovered(root);
    await ledger.settle(core);
    await ledger.recoverPull(root);
    for (const name of await readdir(stateDir(root)))
      if (name.startsWith('writeback-')) await rm(join(stateDir(root), name), { force: true });
    return ledger;
  }
  if (await exists(join(stateDir(root), 'sent.json')))
    throw new Error('This directory has an obsolete sync ledger; preserve it and use fug worldline checkout in a new directory');
  const remote = await tree(core, binding);
  const state: State = { binding, version: remote.version, files: Object.create(null) };
  for await (const { item: file, value } of prefetch(remote.files, async file =>
    local.files.has(file.path) && await allowed(root, file.path)
      ? remoteFile(core, binding, remote.version, file.path, file) : undefined)) {
    if (value) state.files[file.path] = { version: remote.version, file: value };
  }
  const ledger = new Ledger(path, state, core);
  await ledger.save();
  return ledger;
}

async function edits(local: Map<string, Entry>, ledger: Ledger, skipped: Snapshot['skipped']): Promise<Edit[]> {
  const state = ledger.state;
  const out: Edit[] = [];
  for (const path of new Set([...Object.keys(state.files), ...local.keys()])) {
    if (shadowed(skipped, path)) continue;
    const before = state.files[path], a = before?.file, b = local.get(path), version = before?.version ?? state.version;
    if (same(a, b)) continue;
    if (!b || (a && a.kind !== b.kind)) { out.push({ change: { kind: 'remove', path }, version, after: { [path]: null } }); continue; }
    if (!a) { out.push({ change: { kind: 'create', path, ...(b.kind === 'text' ? { text: await decode(ledger, b) } : { data_base64: (await ledger.bytes(b)).toString('base64') }), executable: b.executable }, version, after: { [path]: b } }); continue; }
    if (a.digest !== b.digest) {
      const change: Change = a.kind === 'text' ? { kind: 'edit', path, ...delta(await decode(ledger, a), await decode(ledger, b))! } : { kind: 'write', path, data_base64: (await ledger.bytes(b)).toString('base64') };
      out.push({ change, version, after: { [path]: { ...b, executable: a.executable } } });
    } else out.push({ change: { kind: 'mode', path, executable: b.executable }, version, after: { [path]: b } });
  }
  // An unambiguous unchanged rename keeps the source document's identity.
  for (const removal of out.filter(e => e.change.kind === 'remove')) {
    const old = state.files[removal.change.path]?.file;
    if (!old || local.has(removal.change.path)) continue;
    if (out.filter(e => e.change.kind === 'remove' && same(old, state.files[e.change.path]?.file)).length !== 1) continue;
    const matches = out.filter(e => e.change.kind === 'create' && e.version === removal.version && same(old, local.get(e.change.path)));
    if (matches.length !== 1) continue;
    const creation = matches[0]!;
    removal.change = { kind: 'move', path: removal.change.path, destination: creation.change.path };
    removal.after[creation.change.path] = local.get(creation.change.path)!;
    out.splice(out.indexOf(creation), 1);
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
}

async function sameInode(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([lstat(a), lstat(b)]);
    return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function restoreCaptured(backup: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  try { await link(backup, target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!await sameInode(backup, target)) return;
  }
  await rm(backup);
}

async function writeback(root: string, ledger: Ledger, path: string, before: Entry | undefined, after: Entry | undefined, version: string): Promise<boolean> {
  if (ledger.blocked.has(path)) return false;
  if (!await allowed(root, path)) return false;
  const current = await localFile(root, path);
  if (!same(current, before)) return false;
  if (same(current, after)) {
    ledger.state.files[path] = { version, ...(after ? { file: after } : {}) };
    return true;
  }
  const id = randomUUID(), target = join(root, path), temp = join(stateDir(root), `writeback-${id}`);
  const backup = before ? join(stateDir(root), 'recovered', `${id}.file`) : undefined;
  if (after) {
    await mkdir(dirname(target), { recursive: true });
    const previous = before ? (await lstat(target)).mode : 0o644;
    const mode = (previous & 0o666) | (after.executable ? ((previous & 0o111) || ((previous & 0o444) >> 2) || 0o100) : 0);
    await writeFile(temp, await ledger.bytes(after), { flag: 'wx', mode });
    if (before && process.platform !== 'win32') await chmod(temp, mode);
  }
  let journal: string;
  try { journal = await ledger.journal({ path, before, after, version, temp, backup }); }
  catch (error) { await rm(temp, { force: true }); throw error; }
  if (!await allowed(root, path)) { await ledger.cancelJournal(journal); return false; }
  if (backup) {
    await mkdir(dirname(backup), { recursive: true });
    try { await rename(target, backup); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await ledger.cancelJournal(journal); return false;
    }
    if (!(await lstat(backup)).isFile()) {
      ledger.blocked.add(path);
      await ledger.cancelJournal(journal);
      return false;
    }
    if (!same(await readEntry(backup), before)) {
      await restoreCaptured(backup, target);
      await ledger.cancelJournal(journal);
      return false;
    }
  }
  if (after) {
    try { await link(temp, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await ledger.cancelJournal(journal); return false;
    }
  }
  await ledger.installed(journal);
  ledger.state.files[path] = { version, ...(after ? { file: after } : {}) };
  return true;
}

export async function push(core: Connection, binding: Binding, root: string): Promise<Pushed> {
  return locked(join(stateDir(root), 'push'), () => send(core, binding, root), core.signal);
}
async function send(core: Connection, binding: Binding, root: string): Promise<Pushed> {
  const limit = await fileLimit(core, binding);
  const snapshot = await scan(root, limit, core.signal);
  const ledger = await open(core, binding, root, snapshot);
  // Rescan when recovery restored a captured file or finished an installation.
  const local = new Map<string, Entry>();
  const current = ledger.rescan ? await scan(root, limit, core.signal) : snapshot;
  for (const path of ledger.blocked) current.skipped.set(path, 'captured non-regular path retained in state/recovered; restore or replace the checkout path');
  // A tracked file becoming ignored or inaccessible is not a deletion request.
  for (const path of Object.keys(ledger.state.files))
    if (!current.files.has(path) && !shadowed(current.skipped, path) && !await allowed(root, path))
      current.skipped.set(path, 'excluded by checkout rules');
  for (const [path, file] of current.files) {
    core.signal?.throwIfAborted();
    const baseline = ledger.state.files[path]?.file;
    const value = baseline?.digest === file.digest ? { ...baseline, executable: file.executable ?? baseline.executable } : await localFile(root, path);
    if (!value || value.digest !== file.digest) throw new Error(`${path} changed during scanning; synchronize again`);
    if (file.executable === undefined) value.executable = ledger.state.files[path]?.file?.executable ?? false;
    local.set(path, value);
  }
  const out: Pushed = { version: ledger.state.version, created: 0, written: 0, removed: 0,
    skipped: [...current.skipped].map(([p, why]) => `${p} (${why})`), kept: [], deferred: [...ledger.blocked] };
  const counted = new Set<string>();
  const rebased = new Set<string>();
  const sender = await author(core);
  for (;;) {
    core.signal?.throwIfAborted();
    const plan = await edits(local, ledger, current.skipped);
    if (!plan.length) break;
    const version = plan[0]!.version, batch: Edit[] = [];
    let bytes = 0;
    for (const edit of plan) {
      if (edit.version !== version) continue;
      const size = Buffer.byteLength(JSON.stringify(edit.change));
      if (batch.length && bytes + size > 4 << 20) break;
      bytes += size; batch.push(edit);
    }
    const pending: Pending = { operation_id: `fug-push-${randomUUID()}`, author: sender, after: Object.fromEntries(batch.flatMap(e => Object.entries(e.after))) };
    ledger.state.pending = pending;
    await ledger.save();
    let receipt: unknown;
    try {
      receipt = await worldline(core, binding, 'apply', { observed: version, operation_id: pending.operation_id, intent: 'fug push', changes: batch.map(e => e.change) });
    } catch (error) {
      if (!(error instanceof Refused) || !['source_conflict', 'stale_frontier'].includes(error.code)) throw error;
      await ledger.settle(core);
      const latest = await tree(core, binding);
      let repaired = false;
      for (const { change } of batch) {
        const path = change.kind === 'create' ? change.path : change.kind === 'move' ? change.destination : undefined;
        if (!path) continue;
        const found = latest.files.find(file => file.path === path);
        if (!await allowed(root, path)) continue;
        const key = `${latest.version}:${path}`;
        if (rebased.has(key) || rebased.size >= 32) continue;
        if (!found) {
          if (error.code !== 'stale_frontier' || change.kind !== 'create' || latest.version === version) continue;
          ledger.state.files[path] = { version: latest.version };
          rebased.add(key);
          repaired = true;
          continue;
        }
        const file = await remoteFile(core, binding, latest.version, path, found);
        const backup = join(stateDir(root), 'collisions', latest.version, path);
        await mkdir(dirname(backup), { recursive: true });
        await writeFile(backup, await ledger.bytes(file), { flag: 'wx', mode: 0o600 }).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
        (out.preserved ??= []).push(backup);
        ledger.state.files[path] = { version: latest.version, file };
        rebased.add(key);
        repaired = true;
      }
      if (!repaired) throw error;
      ledger.state.version = latest.version;
      await ledger.save();
      continue;
    }
    await ledger.complete(core, pending, receipt);
    for (const { change } of batch) if (!counted.has(change.path)) {
      counted.add(change.path);
      if (change.kind === 'create') ++out.created;
      else if (change.kind === 'remove' && !local.has(change.path)) ++out.removed;
      else ++out.written;
    }
  }
  const remote = await tree(core, binding);
  out.conflicts = remote.conflicts ?? [];
  // CRDT conflicts do not prevent engineering tools from diagnosing the merged source.
  // Preserve displaced local bytes before installing a deterministic remote projection.
  if (out.conflicts.length) {
    const remoteFiles = new Map(remote.files.map(file => [file.path, file]));
    for (const [path, file] of local) if (counted.has(path) && !same(file, remoteFiles.get(path))) {
      const backup = join(stateDir(root), 'conflicts', remote.version, path);
      await mkdir(dirname(backup), { recursive: true });
      await writeFile(backup, await ledger.bytes(file), { mode: 0o600, flag: 'wx' }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      (out.preserved ??= []).push(backup);
    }
  }
  const present = new Set(remote.files.map(f => f.path));
  for await (const { item: file, value: fetched } of prefetch(remote.files, async file => {
    core.signal?.throwIfAborted();
    if (file.size > limit || shadowed(current.skipped, file.path)) return;
    const stored = ledger.state.files[file.path]?.file;
    if (stored?.digest === file.digest || await unavailable(root, file.path)) return;
    return remoteFile(core, binding, remote.version, file.path, file);
  })) {
    core.signal?.throwIfAborted();
    if (file.size > limit || shadowed(current.skipped, file.path)) continue;
    const baseline = ledger.state.files[file.path]?.file;
    if (same(local.get(file.path), file) && same(baseline, file)) {
      ledger.state.files[file.path] = { version: remote.version, file: baseline! };
      continue;
    }
    const unavailablePath = await unavailable(root, file.path);
    if (unavailablePath) {
      out.skipped.push(`${file.path} (${unavailablePath})`);
      if (unavailablePath === 'blocked') out.deferred!.push(file.path);
      continue;
    }
    const content = baseline?.digest === file.digest ? { ...baseline, executable: file.executable } : fetched ?? await remoteFile(core, binding, remote.version, file.path, file);
    const wrote = await writeback(root, ledger, file.path, local.get(file.path), content, remote.version);
    if (!wrote) { out.skipped.push(`${file.path} (changed locally during synchronization)`); out.deferred!.push(file.path); }
    else {
      if (!same(local.get(file.path), content)) (out.updated ??= []).push(file.path);
      if (!local.has(file.path)) out.kept.push(file.path);
    }
  }
  for (const path of Object.keys(ledger.state.files)) if (!present.has(path) && !shadowed(current.skipped, path)) {
    const wrote = await writeback(root, ledger, path, local.get(path), undefined, remote.version);
    if (!wrote) { out.skipped.push(`${path} (changed locally during synchronization)`); out.deferred!.push(path); }
    else {
      if (local.has(path)) (out.updated ??= []).push(path);
      delete ledger.state.files[path];
    }
  }
  ledger.state.version = remote.version;
  await ledger.flush();
  if (ledger.preserved.length) (out.preserved ??= []).push(...ledger.preserved);
  out.version = remote.version;
  return out;
}
