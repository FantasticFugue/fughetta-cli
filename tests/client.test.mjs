import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { authorize, metadata, connect } from '../build/login.js';
import { origin, call, tool, Refused } from '../build/remote.js';
import { tokenFor, credentialFile } from '../build/credentials.js';
import { Proxy } from '../build/proxy.js';
import { scratch } from './service.mjs';

async function server(handler, host = '127.0.0.1') {
  const s = createServer(handler);
  await new Promise((done, fail) => { s.once('error', fail); s.listen(0, host, done); });
  return { url: `http://${host === '::1' ? '[::1]' : host}:${s.address().port}`, stop: () => new Promise(done => s.close(done)) };
}
const body = async req => { let out = ''; for await (const chunk of req) out += chunk; return out; };
const reply = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const binding = { server: '', workspace: '', project: 'demo', worldline: 'main' };
const pushed = { version: 'v1', created: 0, written: 0, removed: 0, skipped: ['link (link)'], kept: ['remote.txt'] };

test('origin validation and IPv6 HTTP with workspace and bearer token', async () => {
  for (const url of ['ftp://example.com', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com/?q=1']) assert.throws(() => origin(url));
  const s = await server((req, res) => { assert.equal(req.url, '/w/team/api/v1/projects/demo'); assert.equal(req.headers.authorization, 'Bearer secret'); reply(res, {}); }, '::1');
  try { assert.equal(origin(s.url + '/'), s.url); assert.equal((await call({ server: s.url, workspace: 'team', token: 'secret' }, 'GET', '/api/v1/projects/demo')).status, 200); }
  finally { await s.stop(); }
});

test('credential updates serialize across processes and token priority is preserved', async () => {
  const dir = await scratch('credentials');
  const old = process.env.XDG_CONFIG_HOME;
  const envToken = process.env.FUGHETTA_TOKEN;
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.FUGHETTA_TOKEN;
  try {
    const module = new URL('../build/credentials.js', import.meta.url).href;
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `import {saveToken} from ${JSON.stringify(module)}; await saveToken('http://server${i}', 'token${i}')`], { env: process.env, stdio: 'inherit' });
      child.on('error', fail); child.on('exit', code => code === 0 ? done() : fail(new Error(`exit ${code}`)));
    })));
    const saved = JSON.parse(await readFile(credentialFile(), 'utf8'));
    assert.equal(Object.keys(saved.servers).length, 8);
    assert.equal(await tokenFor('http://server0'), 'token0');
    process.env.FUGHETTA_TOKEN = 'env';
    assert.equal(await tokenFor('http://server0'), 'env');
    assert.equal(await tokenFor('http://server0', 'given'), 'given');
    if (process.platform !== 'win32') assert.equal((await stat(credentialFile())).mode & 0o777, 0o600);
    assert.equal((await readdir(join(dir, 'fughetta'))).length, 1);
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old;
    if (envToken === undefined) delete process.env.FUGHETTA_TOKEN; else process.env.FUGHETTA_TOKEN = envToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth metadata, code flow and PKCE exchange', async () => {
  let challenge, redirect, state;
  const s = await server(async (req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') return reply(res, { authorization_endpoint: s.url + '/authorize', token_endpoint: s.url + '/token' });
    if (req.url === '/token') {
      const form = new URLSearchParams(await body(req));
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('client_id'), 'fug');
      assert.equal(form.get('code'), 'code'); assert.equal(form.get('redirect_uri'), redirect);
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge);
      return reply(res, { access_token: 'sk_oauth', token_type: 'Bearer' });
    }
    res.writeHead(404).end();
  });
  try {
    const meta = await metadata(s.url);
    const token = await authorize(meta, text => {
      const url = new URL(text); challenge = url.searchParams.get('code_challenge'); redirect = url.searchParams.get('redirect_uri'); state = url.searchParams.get('state');
      assert.equal(url.searchParams.get('response_type'), 'code'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(new URL(redirect).hostname, '127.0.0.1');
      void fetch(`${redirect}?code=code&state=${state}`);
    });
    assert.equal(token, 'sk_oauth');
    await assert.rejects(authorize(meta, text => { const u = new URL(text); void fetch(`${u.searchParams.get('redirect_uri')}?code=bad&state=wrong`); }), /state/);
    await assert.rejects(authorize(meta, () => {}, 10), /timed out/);
    assert.equal(await metadata(s.url + '/missing'), undefined);
  } finally { await s.stop(); }
});

test('host workspace selection, saved credentials and core discovery', async () => {
  const root = await scratch('workspaces'), previous = process.env.XDG_CONFIG_HOME, token = process.env.FUGHETTA_TOKEN;
  process.env.XDG_CONFIG_HOME = root; delete process.env.FUGHETTA_TOKEN;
  let choices = [{ name: 'one' }], hosted = true;
  const s = await server((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') return hosted ? reply(res, { authorization_endpoint: s.url + '/authorize', token_endpoint: s.url + '/token' }) : res.writeHead(404).end();
    assert.equal(req.url, '/api/v1/workspaces'); assert.equal(req.headers.authorization, 'Bearer saved'); reply(res, choices);
  });
  try {
    assert.equal((await connect(s.url, '', 'saved')).workspace, 'one'); assert.equal(await tokenFor(s.url), 'saved');
    choices = [{ name: 'one' }, { name: 'two' }];
    assert.equal((await connect(s.url, 'two')).workspace, 'two');
    await assert.rejects(connect(s.url), /one, two/); await assert.rejects(connect(s.url, 'three'), /unavailable/);
    choices = []; await assert.rejects(connect(s.url), /Create a workspace/);
    hosted = false; assert.equal((await connect(s.url)).workspace, ''); await assert.rejects(connect(s.url, 'one'), /no workspace/);
  } finally {
    await s.stop(); if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    if (token !== undefined) process.env.FUGHETTA_TOKEN = token;
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP request errors, push failure, reports, tool filtering and project injection', async () => {
  const answers = [], errors = [], requests = [];
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req)); requests.push({ path: req.url, ...r });
    if (r.method === 'tools/list') return reply(res, { result: { tools: ['build', 'read', 'worldline', 'save_project', 'schema', 'save_server'].map(name => ({ name, inputSchema: { properties: { project: { type: 'string' }, worldline: {}, version: {}, nested: { properties: { project: {} }, required: ['project'] } }, required: ['project'] } })) } });
    reply(res, { jsonrpc: '2.0', id: r.id, result: { isError: false } });
  });
  try {
    const p = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, '', a => answers.push(a), e => errors.push(e), async () => pushed);
    for (const input of ['{', 'null', '[]', '{}', '{"jsonrpc":"2.0","id":null,"method":"ping"}']) await p.line(input);
    assert.deepEqual(answers.map(a => [a.id, a.error.code]), [[null, -32700], [null, -32600], [null, -32600], [null, -32600], [null, -32600]]);
    for (const value of [null, [], 's', 3, true]) { await p.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'build', arguments: value } })); assert.equal(answers.at(-1).error.code, -32602); }
    const send = (id, method, params) => p.line(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    await send(2, 'tools/list'); const tools = answers.at(-1).result.tools;
    assert.deepEqual(tools.map(t => t.name), ['build', 'save_project', 'schema']);
    for (const name of ['project', 'worldline', 'version']) assert.ok(!JSON.stringify(tools).includes(`"${name}"`));
    await send(3, 'tools/call', { name: 'build', arguments: { project: 'wrong', version: 'old' } });
    assert.deepEqual(requests.at(-1).params.arguments, { project: 'demo', worldline: 'main', version: 'v1' }, 'a build runs on the version the push sent');
    assert.notEqual(requests.at(-1).id, 3); assert.equal(answers.at(-1).id, 3);
    await send(7, 'tools/call', { name: 'schema', arguments: {} });
    assert.deepEqual(requests.at(-1).params.arguments, { project: 'demo' });
    assert.ok(errors.includes('skipped link (link)')); assert.ok(errors.includes('kept remote.txt'));
    const failed = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, '', a => answers.push(a), () => {}, async () => { throw new Error('offline'); });
    const count = requests.length;
    await failed.line(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'build' } }));
    assert.equal(answers.at(-1).result.isError, true); assert.match(answers.at(-1).result.content[0].text, /offline/); assert.equal(requests.length, count);
    await send(5, 'resources/list'); assert.equal(answers.at(-1).error.code, -32601);
    await send(6, 'tools/call', { name: 'read' }); assert.match(answers.at(-1).error.message, /unknown tool: read/);
  } finally { await s.stop(); }
});

test('MCP cancellation distinguishes string and numeric client IDs', async () => {
  const received = new Map(), cancellations = [];
  let release, ready;
  const held = new Promise(done => { release = done; });
  const arrived = new Promise(done => { ready = done; });
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req));
    if (r.method === 'tools/call') {
      received.set(req.url, r.id); if (received.size === 2) ready();
      await held; reply(res, { jsonrpc: '2.0', id: r.id, result: {} });
    } else { cancellations.push({ path: req.url, id: r.params.requestId }); res.writeHead(202).end(); }
  });
  try {
    const answers = [], p = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, '', a => answers.push(a));
    const tasks = [[1, 'jobs'], ['1', 'project']].map(([id, name]) => p.line(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } })));
    await arrived;
    for (const requestId of [1, '1']) await p.line(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }));
    assert.deepEqual(cancellations, [{ path: '/mcp', id: received.get('/mcp') }, { path: '/mcp/config', id: received.get('/mcp/config') }]);
    assert.notEqual(received.get('/mcp'), received.get('/mcp/config'));
    release(); await Promise.all(tasks); assert.deepEqual(new Set(answers.map(a => a.id)), new Set([1, '1']));
  } finally { release(); await s.stop(); }
});
