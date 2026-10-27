import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { call, reason, type Connection } from './remote.js';
import { json, save } from './files.js';
import { relay } from './tunnel.js';

export const releases = 'https://api.github.com/repos/FantasticFugue/fughetta-service/releases/latest';
// The Worker exits with this status when the core refuses its identity: revoked, unknown, or registered to another workspace.
const refused = 2;

export interface Identity { server: string; workspace: string; workspace_id: string; worker_id: string; secret: string; name: string }

function home(): string {
  if (!process.env.HOME) throw new Error('HOME is not set');
  return process.env.HOME;
}
function local(): string {
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set');
  return join(process.env.LOCALAPPDATA, 'Fughetta');
}
const workersDir = () => process.platform === 'win32' ? join(local(), 'workers')
  : join(process.env.XDG_STATE_HOME || join(home(), '.local', 'state'), 'fughetta', 'workers');
export function stateDir(server: string, workspace: string): string {
  return join(workersDir(), `${new URL(server).host.replace(/[^a-zA-Z0-9.-]/g, '_')}-${workspace}`);
}
function cacheDir(): string {
  return process.platform === 'win32' ? join(local(), 'cache', 'service')
    : join(process.env.XDG_CACHE_HOME || join(home(), '.cache'), 'fughetta', 'service');
}
export const unitName = (server: string, workspace: string) => `fughetta-worker-${stateDir(server, workspace).split(/[\\/]/).pop()}.service`;

// Returns this machine's saved identity for the workspace, registering a new one with the owner's token when there is none.
export async function identity(core: Connection, name: string): Promise<Identity> {
  const file = join(stateDir(core.server, core.workspace), 'identity.json');
  const saved = await json<Identity | null>(file, null);
  if (saved) return saved;
  const reply = await call(core, 'POST', '/api/v1/workers', { name }, 30_000);
  if (reply.status === 403) throw new Error(`Only an owner of ${core.workspace} can add a build machine (${reason(reply)})`);
  if (reply.status !== 201) throw new Error(`The build machine could not be registered: ${reason(reply)}`);
  const credential = JSON.parse(reply.body);
  const result = { server: core.server, workspace: core.workspace, workspace_id: credential.workspace_id, worker_id: credential.worker_id, secret: credential.secret, name };
  await save(file, result);
  return result;
}
// Returns the identity saved for the workspace, or, with no workspace named, the only one saved for the server.
export async function savedIdentity(server: string, workspace = ''): Promise<Identity | null> {
  if (workspace) return json<Identity | null>(join(stateDir(server, workspace), 'identity.json'), null);
  const base = workersDir();
  const found: Identity[] = [];
  for (const entry of await readdir(base).catch(() => [] as string[])) {
    const id = await json<Identity | null>(join(base, entry, 'identity.json'), null);
    if (id?.server === server) found.push(id);
  }
  return found.length === 1 ? found[0]! : null;
}

const asset = () => `fughetta-service-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;

// Downloads the latest fughetta-service release for this platform once, checks its SHA-256 digest, and returns its path.
// Without network access the newest cached release is used.
export async function service(url = process.env.FUGHETTA_RELEASES || releases, log: (line: string) => void = console.error): Promise<string> {
  const name = asset();
  let release: { tag_name: string; assets: { name: string; browser_download_url: string; digest?: string }[] };
  try {
    const reply = await fetch(url, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
    release = await reply.json() as typeof release;
  } catch (error) {
    const cached = await newest(name);
    if (cached) { log(`fug: using the cached ${cached} (the release list is unavailable: ${(error as Error).message})`); return cached; }
    throw new Error(`The fughetta-service release list is unavailable (${(error as Error).message}); pass --service PATH`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(release.tag_name)) throw new Error(`Unexpected release tag ${release.tag_name}`);
  const target = join(cacheDir(), release.tag_name, name);
  try { await stat(target); return target; } catch {}
  const entry = release.assets.find(a => a.name === name);
  if (!entry) throw new Error(`Release ${release.tag_name} has no build for ${process.platform}-${process.arch}; pass --service PATH`);
  const digest = /^sha256:([0-9a-f]{64})$/.exec(entry.digest ?? '')?.[1];
  if (!digest) throw new Error(`Release ${release.tag_name} lists no SHA-256 digest for ${name}`);
  log(`fug: downloading fughetta-service ${release.tag_name}`);
  const reply = await fetch(entry.browser_download_url, { signal: AbortSignal.timeout(600_000) });
  if (!reply.ok) throw new Error(`Downloading ${name} failed: HTTP ${reply.status}`);
  const bytes = Buffer.from(await reply.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`${name} from ${release.tag_name} does not match its published digest`);
  await mkdir(join(cacheDir(), release.tag_name), { recursive: true });
  const temp = `${target}.${process.pid}`;
  try {
    await writeFile(temp, bytes, { mode: 0o755 });
    await rename(temp, target);
  } finally { await rm(temp, { force: true }); }
  return target;
}
async function newest(name: string): Promise<string | undefined> {
  let best: { path: string; time: number } | undefined;
  for (const tag of await readdir(cacheDir()).catch(() => [] as string[])) {
    const path = join(cacheDir(), tag, name);
    const info = await stat(path).catch(() => undefined);
    if (info && (!best || info.mtimeMs > best.time)) best = { path, time: info.mtimeMs };
  }
  return best?.path;
}

export function configuration(id: Identity, gateway: string, dir: string, threads = availableParallelism()) {
  return { gateway, worker_id: id.worker_id, workspace_id: id.workspace_id, token: id.secret, name: id.name,
    data_root: join(dir, 'data'), work_root: join(dir, 'work'), compute_threads: threads, parallel: threads };
}

// Linux Workers isolate builds under the cgroup they start in, so each start gets a delegated systemd scope of its own.
const scope = process.platform === 'linux' ? ['systemd-run', '--user', '--scope', '--quiet', '-p', 'Delegate=yes', '--'] : [];

// Runs the Worker behind a loopback relay until it is stopped or refused, restarting it after other exits.
export async function run(id: Identity, binary: string, log: (line: string) => void = console.error): Promise<number> {
  if (scope.length && spawnSync(scope[0]!, [...scope.slice(1), 'true'], { stdio: 'ignore' }).status !== 0)
    throw new Error('fug worker needs a systemd user session on Linux (systemd-run --user) to give builds their own cgroup');
  const dir = stateDir(id.server, id.workspace);
  const ca = process.env.FUGHETTA_CA_FILE ? await readFile(process.env.FUGHETTA_CA_FILE) : undefined;
  const tunnel = await relay(`${id.server}/w/${id.workspace}/workers/tunnel`, ca, log);
  const config = join(dir, 'worker.json');
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => { stopping = true; child?.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log(`fug: ${id.name} serves builds for ${id.workspace} on ${id.server}; stop with Ctrl-C`);
  try {
    await save(config, configuration(id, tunnel.address, dir));
    for (let wait = 1000; !stopping;) {
      const started = Date.now();
      const command = [...scope, resolve(binary), 'worker', 'run', '--config', config];
      child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
      const code = await new Promise<number>(done => {
        child!.once('error', error => { log(`fug: ${error.message}`); done(1); });
        child!.once('exit', (status, signal) => done(status ?? (signal ? 1 : 0)));
      });
      if (stopping) return 0;
      if (code === refused) {
        await rm(join(dir, 'identity.json'), { force: true });
        log(`fug: ${id.workspace} refused this machine's identity (it was revoked or removed); run fug worker again to register it anew`);
        return refused;
      }
      if (Date.now() - started > 60_000) wait = 1000;
      log(`fug: the Worker exited with status ${code}; restarting in ${wait / 1000} seconds`);
      await delay(wait);
      wait = Math.min(wait * 2, 30_000);
    }
    return 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    tunnel.server.close();
  }
}

const quote = (arg: string) => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
export function unit(server: string, workspace: string, command: string[], extra: string[] = []): string {
  const env = process.env.FUGHETTA_CA_FILE ? `Environment=${quote(`FUGHETTA_CA_FILE=${resolve(process.env.FUGHETTA_CA_FILE)}`)}\n` : '';
  return `[Unit]
Description=Fughetta Worker for ${workspace} on ${new URL(server).host}
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${[...command, 'worker', '--server', server, '--workspace', workspace, ...extra].map(quote).join(' ')}
${env}Restart=on-failure
RestartSec=5
RestartPreventExitStatus=${refused}

[Install]
WantedBy=default.target
`;
}
function unitFile(server: string, workspace: string): string {
  return join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'systemd', 'user', unitName(server, workspace));
}
function systemctl(...args: string[]) {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) throw new Error(`systemctl is unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`systemctl --user ${args.join(' ')} failed with status ${result.status}`);
}
export async function install(server: string, workspace: string, command: string[], extra: string[] = []): Promise<void> {
  if (process.platform !== 'linux') throw new Error('fug worker install needs systemd; on this system keep fug worker running instead');
  const file = unitFile(server, workspace);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, unit(server, workspace, command, extra), { mode: 0o644 });
  systemctl('daemon-reload');
  systemctl('enable', '--now', unitName(server, workspace));
  console.log(`Installed ${unitName(server, workspace)}; it starts when you sign in. Follow it with: journalctl --user -u ${unitName(server, workspace)} -f`);
  console.log(`To keep it running while you are signed out: loginctl enable-linger ${process.env.USER ?? '$USER'}`);
}
export async function uninstall(server: string, workspace: string): Promise<void> {
  if (process.platform !== 'linux') throw new Error('fug worker uninstall needs systemd');
  const file = unitFile(server, workspace);
  try { await stat(file); } catch { throw new Error(`${file} does not exist`); }
  systemctl('disable', '--now', unitName(server, workspace));
  await rm(file);
  systemctl('daemon-reload');
  console.log(`Removed ${unitName(server, workspace)}. The machine stays registered; revoke it in the console to retire it.`);
}
