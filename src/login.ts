import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { exchange, reason } from './remote.js';
import { saveToken, tokenFor } from './credentials.js';

export interface Metadata { authorization_endpoint: string; token_endpoint: string }
export async function metadata(server: string, token = ''): Promise<Metadata | undefined> {
  const reply = await exchange(server + '/.well-known/oauth-authorization-server', 'GET', undefined, token ? { authorization: `Bearer ${token}` } : {}, 30_000);
  if (reply.status === 404) return undefined;
  if (reply.status !== 200) throw new Error(reason(reply));
  const value = JSON.parse(reply.body);
  for (const field of ['authorization_endpoint', 'token_endpoint']) new URL(value[field]);
  return value;
}

export function openBrowser(url: string): void {
  const [command, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command!, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export async function authorize(meta: Metadata, show: (url: string) => void = url => { console.log(`Open this URL to sign in:\n${url}`); openBrowser(url); }, timeout = 300_000): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const listener = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid sign-in state'); rejectCode(new Error('Invalid sign-in state')); return;
    }
    if (!url.searchParams.get('code') || url.searchParams.has('error')) {
      res.writeHead(400).end('Sign-in failed'); rejectCode(new Error(url.searchParams.get('error') || 'Missing authorization code')); return;
    }
    res.end('Signed in. You can close this window.');
    resolveCode(url.searchParams.get('code')!);
  });
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const redirect = `http://127.0.0.1:${(listener.address() as { port: number }).port}/callback`;
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({ response_type: 'code', client_id: 'fug', redirect_uri: redirect, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  const timer = setTimeout(() => rejectCode(new Error('Sign-in timed out after five minutes')), timeout);
  try {
    show(url.href);
    const reply = await exchange(meta.token_endpoint, 'POST', new URLSearchParams({ grant_type: 'authorization_code',
      code: await code, code_verifier: verifier, redirect_uri: redirect, client_id: 'fug' }).toString(),
    { 'content-type': 'application/x-www-form-urlencoded' }, 30_000);
    if (reply.status !== 200) throw new Error(reason(reply));
    const token = JSON.parse(reply.body);
    if (typeof token.access_token !== 'string' || !token.access_token || token.token_type?.toLowerCase() !== 'bearer') throw new Error('Invalid token response');
    return token.access_token;
  } finally { clearTimeout(timer); listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
}

export async function connect(server: string, workspace = '', given = '', login = false) {
  let token = await tokenFor(server, given);
  const meta = await metadata(server, token);
  // Signing in replaces a saved token, but not one the user passed.
  if (meta && (!token || (login && !given && !process.env.FUGHETTA_TOKEN))) {
    token = await authorize(meta);
    await saveToken(server, token);
  }
  if (!token) throw new Error(`No token for ${server}; pass --token or set FUGHETTA_TOKEN`);
  if (meta) {
    let reply = await exchange(server + '/api/v1/workspaces', 'GET', undefined, { authorization: `Bearer ${token}` }, 30_000);
    if (reply.status === 401 && !login) {
      token = await authorize(meta);
      await saveToken(server, token);
      reply = await exchange(server + '/api/v1/workspaces', 'GET', undefined, { authorization: `Bearer ${token}` }, 30_000);
    }
    if (reply.status !== 200) throw new Error(reason(reply));
    await saveToken(server, token);
    const choices: { name: string }[] = JSON.parse(reply.body);
    if (!choices.length) throw new Error('Create a workspace in the console, then run fug init again');
    if (workspace) {
      if (!choices.some(c => c.name === workspace)) throw new Error(`Workspace ${workspace} is unavailable; choices: ${choices.map(c => c.name).join(', ')}`);
    } else if (choices.length === 1) workspace = choices[0]!.name;
    else {
      const names = choices.map(c => c.name);
      if (!process.stdin.isTTY) throw new Error(`Choose --workspace from: ${names.join(', ')}`);
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { workspace = (await prompt.question(`Workspace (${names.join(', ')}): `)).trim(); }
      finally { prompt.close(); }
      if (!names.includes(workspace)) throw new Error(`Choose a workspace from: ${names.join(', ')}`);
    }
  } else {
    if (workspace) throw new Error('A core uses no workspace prefix');
    if (given) await saveToken(server, token);
  }
  return { server, workspace, token };
}
