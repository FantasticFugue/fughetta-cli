#!/usr/bin/env node
import { basename, join, resolve, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { find, load, save as saveBinding, push } from './checkout/index.js';
import { call, origin, reason } from './remote.js';
import { tokenFor } from './credentials.js';
import { connect } from './login.js';
import { object, save } from './files.js';
import { report, serve } from './proxy.js';
import { hostname } from 'node:os';
import { identity, install, run, savedIdentity, service, uninstall } from './worker.js';

const usage = `Usage: fug init [--server URL] [--workspace NAME] [--name PROJECT] [--token TOKEN]
       fug login [--server URL] [--workspace NAME] [--token TOKEN]
       fug push
       fug status
       fug mcp
       fug worker [install] [--server URL] [--workspace NAME] [--name MACHINE] [--service PATH] [--token TOKEN]
       fug worker uninstall [--server URL] --workspace NAME

init    create or use a project, send files and register Fughetta in .mcp.json;
        the agent configures builds with the project tools
login   sign in and save the origin's token
push    send this directory's changes
status  show the binding and check access
mcp     serve the agent's tools on stdio
worker  serve this workspace's builds on this machine (owners register it on
        first use); install keeps it running as a systemd user service

The default server is https://fughetta.dev.
Token order: --token, FUGHETTA_TOKEN, saved token.
`;
function options(args: string[], command: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const allowed = command === 'uninstall' ? ['--server', '--workspace']
      : ['--server', '--workspace', '--token', ...(command === 'init' ? ['--name'] : command === 'worker' ? ['--name', '--service'] : [])];
    if (!allowed.includes(key)) throw new Error(`Unknown option ${key}`);
    if (!args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`${key} needs a value`);
    out[key.slice(2)] = args[i + 1]!;
  }
  return out;
}
function name(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new Error(`Invalid project or workspace name: ${value}`);
  return value;
}
function command() {
  const found = (process.env.PATH ?? '').split(delimiter).some(dir => existsSync(join(dir, process.platform === 'win32' ? 'fug.cmd' : 'fug')));
  return found ? { command: 'fug', args: ['mcp'] } : { command: process.execPath, args: [resolve(process.argv[1]!), 'mcp'] };
}
export async function register(file: string, entry = command()) {
  let doc: Record<string, any> = {};
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!object(value)) throw new SyntaxError('Not an object');
    doc = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.log(`${file} is not a JSON object; add the fughetta server by hand: ${JSON.stringify(entry)}`); return;
    }
  }
  doc.mcpServers = { ...(object(doc.mcpServers) ? doc.mcpServers : {}), fughetta: entry };
  await save(file, doc, 0o644);
  console.log(`Added the fughetta MCP server to ${file}`);
}
async function bound() {
  const root = find(process.cwd());
  if (!root) throw new Error('This directory is not bound to a project; run fug init');
  const binding = await load(root);
  const token = await tokenFor(binding.server);
  if (!token) throw new Error(`No token for ${binding.server}; run fug login or set FUGHETTA_TOKEN`);
  return { root, binding, core: { server: binding.server, workspace: binding.workspace, token } };
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'init' || cmd === 'login') {
    const o = options(args, cmd);
    if (o.workspace) name(o.workspace);
    const project = cmd === 'init' ? name(o.name ?? (basename(process.cwd()).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 64) || 'project')) : '';
    const core = await connect(origin(o.server ?? 'https://fughetta.dev'), o.workspace, o.token, cmd === 'login');
    if (cmd === 'login') { console.log(`Signed in to ${core.server}${core.workspace ? ` (workspace ${core.workspace})` : ''}`); return; }
    const root = process.cwd();
    const binding = { server: core.server, workspace: core.workspace, project, worldline: 'main' };
    const path = `/api/v1/projects/${project}`;
    const existing = await call(core, 'GET', path);
    if (existing.status === 200) console.log(`Using the existing project ${project} on ${core.server}`);
    else if (existing.status === 404) {
      const created = await call(core, 'PUT', path, { revision: 0, value: {} });
      if (created.status !== 200) throw new Error(`The project could not be created: ${reason(created)}`);
      console.log(`Created the project ${project} on ${core.server}`);
    } else throw new Error(reason(existing));
    await saveBinding(root, binding);
    await register(join(root, '.mcp.json'));
    if (existsSync(join(root, '.cursor'))) await register(join(root, '.cursor', 'mcp.json'));
    report(await push(core, binding, root), console.log, console.error);
    console.log('Start your agent in this directory; it finds the Fughetta tools through .mcp.json.');
  } else if (['push', 'status', 'mcp'].includes(cmd ?? '') && !args.length) {
    const { root, binding, core } = await bound();
    if (cmd === 'push') report(await push(core, binding, root), console.log, console.error);
    else if (cmd === 'mcp') await serve(core, binding, root);
    else {
      console.log(`Directory ${root} is project ${binding.project} on ${binding.server}${binding.workspace ? ` (workspace ${binding.workspace})` : ''}`);
      const reply = await call(core, 'GET', `/api/v1/projects/${binding.project}`, undefined, 30_000);
      if (reply.status !== 200) throw new Error(reason(reply));
      console.log(`Build configurations: ${Object.keys(JSON.parse(reply.body).value.build_configurations ?? {}).join(', ') || 'none'}`);
    }
  } else if (cmd === 'worker') {
    const sub = args[0] === 'install' || args[0] === 'uninstall' ? args.shift()! : '';
    const o = options(args, sub === 'uninstall' ? sub : 'worker');
    if (o.workspace) name(o.workspace);
    const server = origin(o.server ?? 'https://fughetta.dev');
    if (sub === 'uninstall') {
      if (!o.workspace) throw new Error('fug worker uninstall needs --workspace');
      await uninstall(server, o.workspace); return;
    }
    let id = await savedIdentity(server, o.workspace);
    if (!id) {
      const core = await connect(server, o.workspace, o.token);
      if (!core.workspace) throw new Error('fug worker connects through a Fughetta gateway; a core without workspaces runs its Workers itself');
      id = await identity(core, o.name ?? hostname().slice(0, 128));
      console.error(`fug: registered ${id.name} as ${id.worker_id} in ${id.workspace}`);
    }
    const given = o.service ?? process.env.FUGHETTA_SERVICE;
    const binary = given ? resolve(given) : await service();
    if (sub === 'install') await install(server, id.workspace, [process.execPath, resolve(process.argv[1]!)], given ? ['--service', binary] : []);
    else process.exitCode = await run(id, binary);
  } else { console.log(usage); process.exitCode = cmd === '--help' || cmd === 'help' ? 0 : 2; }
}
main().catch(error => { console.error(`fug: ${error.message}`); process.exitCode = 1; });
