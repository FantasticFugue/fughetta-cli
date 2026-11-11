import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile, readFile, rm, stat, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { authorize, metadata, connect } from '../build/login.js';
import { origin, call, tool, rpc, Refused } from '../build/remote.js';
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
const pushed = { version: 'v1', created: 0, written: 0, removed: 0, skipped: ['link (link)'], kept: ['remote.txt'], updated: ['remote.txt'], deferred: ['editing.txt'], preserved: ['/checkout/.fughetta/state/recovered/copy'], conflicts: ['text:overlap'] };

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
    if (r.method === 'tools/list') return reply(res, { result: { tools: ['build', 'jobs', 'read', 'worldline', 'save_project', 'schema', 'save_server'].map(name => ({ name, inputSchema: { properties: { project: { type: 'string' }, worldline: {}, version: {}, nested: { properties: { project: {} }, required: ['project'] } }, required: ['project'] } })) } });
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
    const sync = JSON.parse(answers.at(-1).result.content.at(-1).text).synchronization;
    assert.deepEqual(sync.updated, pushed.updated);
    assert.deepEqual(sync.deferred, pushed.deferred);
    assert.deepEqual(sync.preserved, pushed.preserved);
    assert.deepEqual(sync.conflicts, pushed.conflicts);
    await send(7, 'tools/call', { name: 'schema', arguments: {} });
    assert.deepEqual(requests.at(-1).params.arguments, { project: 'demo' });
    assert.ok(errors.includes('skipped link (link)')); assert.ok(errors.includes('kept remote.txt'));
    const failed = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, '', a => answers.push(a), () => {}, async () => { throw new Error('offline'); });
    const count = requests.length;
    await failed.line(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'build' } }));
    assert.equal(answers.at(-1).result.isError, true); assert.match(answers.at(-1).result.content[0].text, /offline/); assert.equal(requests.length, count);
    await send(5, 'resources/list'); assert.equal(answers.at(-1).error.code, -32601);
    await send(6, 'tools/call', { name: 'read' }); assert.match(answers.at(-1).error.message, /unknown tool: read/);
    await send(8, 'tools/call', { name: 'jobs' }); assert.match(answers.at(-1).error.message, /unknown tool: jobs/);
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
    const answers = [], p = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, '', a => answers.push(a), () => {}, async () => pushed);
    const tasks = [[1, 'build'], ['1', 'project']].map(([id, name]) => p.line(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } })));
    await arrived;
    for (const requestId of [1, '1']) await p.line(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }));
    assert.deepEqual(cancellations, [{ path: '/mcp', id: received.get('/mcp') }, { path: '/mcp/config', id: received.get('/mcp/config') }]);
    assert.notEqual(received.get('/mcp'), received.get('/mcp/config'));
    release(); await Promise.all(tasks); assert.deepEqual(new Set(answers.map(a => a.id)), new Set([1, '1']));
  } finally { release(); await s.stop(); }
});

test('SSE streams progress before completion across byte and CRLF boundaries', async () => {
  let complete, sawProgress;
  const held = new Promise(resolve => { complete = resolve; });
  const progress = new Promise(resolve => { sawProgress = resolve; });
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req));
    assert.match(req.headers.accept, /text\/event-stream/);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const note = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: r.params._meta.progressToken, progress: 1, message: '编译' } };
    const bytes = Buffer.from(': keepalive\r\n\r\nevent: message\r\ndata: ' + JSON.stringify(note) + '\r\n\r\n');
    for (const byte of bytes) res.write(Buffer.from([byte]));
    await held;
    res.end('data: ' + JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { done: true } }) + '\n\n');
  });
  try {
    const answers = [];
    const p = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, '', a => {
      answers.push(a); if (a.method) sawProgress();
    }, () => {}, async () => pushed);
    const task = p.line(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'build', _meta: { progressToken: 0 } } }));
    await progress;
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0].params, { progressToken: 0, progress: 1, message: '编译' });
    complete(); await task;
    assert.equal(answers[1].jsonrpc, '2.0'); assert.equal(answers[1].id, 7);
    const final = { ...answers[1].result }; delete final.content;
    assert.deepEqual(final, { done: true });
    assert.equal(JSON.parse(answers[1].result.content.at(-1).text).synchronization.version, 'v1');
    await p.line(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'build' } }));
    assert.equal(answers.length, 3, 'clients without a progress token only receive the final result');
    assert.equal(answers[2].jsonrpc, '2.0'); assert.equal(answers[2].id, 8);
    const final8 = { ...answers[2].result }; delete final8.content;
    assert.deepEqual(final8, { done: true });
  } finally { complete(); await s.stop(); }
});

test('SSE keepalive renews idle deadline and incomplete streams fail', async () => {
  let incomplete = false;
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (incomplete) return res.end(': keepalive\n\n');
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 10);
    setTimeout(() => {
      clearInterval(heartbeat);
      res.end('data: ' + JSON.stringify({ id: r.id, result: {} }) + '\n\n');
    }, 120);
  });
  try {
    const core = { server: s.url, workspace: '', token: 't' };
    assert.deepEqual(await rpc(core, '/mcp', { id: 1 }, 60), { id: 1, result: {} });
    incomplete = true;
    await assert.rejects(rpc(core, '/mcp', { id: 2 }), /without a final MCP response/);
  } finally { await s.stop(); }
});

test('cancellation interrupts sync and skips a cancelled queued sync', async () => {
  const answers = [];
  let entered, release, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let syncSignal;
  const p = new Proxy({ server: 'http://127.0.0.1:1', workspace: '', token: 't' }, binding, '', a => answers.push(a), () => {}, async core => {
    ++calls; syncSignal = core.signal; entered(); await held; core.signal.throwIfAborted(); return pushed;
  });
  const invoke = id => p.line(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'build' } }));
  const cancel = requestId => p.line(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }));
  const first = invoke(1); await ready;
  const second = invoke(2);
  await cancel(2); await second;
  await cancel(1); await first;
  assert.equal(syncSignal.aborted, true);
  assert.deepEqual(answers.map(a => [a.id, a.error.code]), [[2, -32800], [1, -32800]]);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('a broken downstream stream cancels its remote request', async () => {
  const cancelled = [], answers = [];
  let remoteId;
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req));
    if (r.method === 'notifications/cancelled') { cancelled.push(r.params.requestId); return res.writeHead(202).end(); }
    remoteId = r.id;
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(': keepalive\n\n');
  });
  try {
    const p = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, '', a => answers.push(a), () => {}, async () => pushed);
    await p.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'build' } }));
    assert.deepEqual(cancelled, [remoteId]);
    assert.match(answers[0].error.message, /without a final MCP response/);
  } finally { await s.stop(); }
});

test('real push cancellation releases its lock and retains an unresolved apply', async () => {
  const { push } = await import('../build/checkout/index.js');
  for (const stage of ['inspect', 'apply']) {
    const root = await scratch('cancel-push'), controller = new AbortController(), actions = [];
    const s = await server(async (req, res) => {
      if (req.url.endsWith('/effective')) return reply(res, { limits: { max_file_bytes: 4096 } });
      if (req.url.endsWith('/me')) return reply(res, { issuer: 'test', user: 'me' });
      if (req.url.includes('/operations/')) return reply(res, { outcome: 'unknown' });
      const r = JSON.parse(await body(req)), action = r.action;
      actions.push(action);
      if (action === stage && !controller.signal.aborted) { controller.abort(); return res.destroy(); }
      if (action === 'inspect') return reply(res, { version: 'v1', files: [] });
      return reply(res, { written_version: 'v1', version: 'v1' });
    });
    try {
      await writeFile(join(root, 'a.txt'), 'local\n');
      await assert.rejects(push({ server: s.url, workspace: '', token: 't', signal: controller.signal }, binding, root));
      const saved = JSON.parse(await readFile(join(root, '.fughetta/state/baseline.json'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '{}';
        throw error;
      }));
      assert.equal(saved.pending ? 1 : 0, stage === 'apply' ? 1 : 0, 'an aborted apply keeps its pending batch');
      if (stage === 'inspect') assert.equal(actions.includes('apply'), false, 'no apply runs before the abort');
      const before = actions.length;
      await push({ server: s.url, workspace: '', token: 't' }, binding, root);
      assert.ok(actions.length > before && actions.includes('apply'), 'a later push acquires the released lock');
    } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
  }
});

for (const failed of [false, true]) test(`MCP synchronization summary stays bounded on remote failure: ${failed}`, async () => {
  const root = await scratch('sync-summary');
  const answers = [];
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req));
    reply(res, { jsonrpc: '2.0', id: r.id, ...(failed ? { error: { code: -32603, message: 'failed', data: { retry: true } } } : { result: { content: [] } }) });
  });
  try {
    const skipped = Array.from({ length: 50 }, (_, n) => `ignored-${n}`);
    const proxy = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, root,
      answer => answers.push(answer), () => {}, async () => ({ ...pushed, skipped }));
    await proxy.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'build' } }));
    const result = answers[0];
    const summary = failed ? result.error.data.synchronization : JSON.parse(result.result.content[0].text).synchronization;
    assert.equal(summary.skipped.length, 16);
    assert.equal(summary.counts.skipped, 50);
    assert.equal(summary.truncated, true);
    assert.deepEqual(JSON.parse(await readFile(summary.report, 'utf8')).skipped, skipped);
    if (failed) assert.deepEqual(result.error.data.remote, { retry: true });
  } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
});

for (const failed of [false, true]) test(`MCP preserves completed replies when synchronization report storage fails: ${failed}`, async () => {
  const root = await scratch('sync-summary');
  const answers = [];
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req));
    reply(res, { jsonrpc: '2.0', id: r.id, ...(failed ? { error: { code: -32603, message: 'failed', data: { retry: true } } } : { result: { content: [] } }) });
  });
  try {
    await mkdir(join(root, '.fughetta/state'), { recursive: true });
    await writeFile(join(root, '.fughetta/state/reports'), 'occupied');
    const skipped = Array.from({ length: 50 }, (_, n) => `ignored-${n}`);
    const proxy = new Proxy({ server: s.url, workspace: '', token: 't' }, binding, root,
      answer => answers.push(answer), () => {}, async () => ({ ...pushed, skipped }));
    await proxy.line(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'build' } }));
    const result = answers[0];
    const summary = failed ? result.error.data.synchronization : JSON.parse(result.result.content[0].text).synchronization;
    assert.equal(summary.skipped.length, 16);
    assert.equal(summary.counts.skipped, 50);
    assert.equal(summary.truncated, true);
    assert.equal(summary.report, undefined);
    assert.match(summary.report_error, /EEXIST|ENOTDIR/);
    assert.equal(answers.length, 1);
    if (failed) assert.deepEqual(result.error.data.remote, { retry: true });
  } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
});

test('execute syncs, injects the binding, streams progress and reports results', async () => {
  const requests = [], notes = [];
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req)); requests.push(r);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const token = r.params._meta.progressToken;
    for (const [progress, message] of [[1, 'waiting for a worker'], [2, 'compiling']])
      res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, message } }) + '\n\n');
    res.end('data: ' + JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { isError: false, content: [{ type: 'text', text: '{}' }],
      structuredContent: { ok: true, results: [{ configuration: 'debug', ok: true, seconds: 1.25, worker: 'w1', steps: [] }] } } }) + '\n\n');
  });
  const root = await scratch('execute');
  try {
    const { execute, format } = await import('../build/execute.js');
    const outcome = await execute({ server: s.url, workspace: '', token: 't' }, binding, root, 'build',
      { configurations: ['debug'], fresh: true }, line => notes.push(line), async () => pushed);
    assert.equal(outcome.ok, true);
    assert.deepEqual(requests[0].params.arguments, { configurations: ['debug'], fresh: true, project: 'demo', worldline: 'main', version: 'v1' });
    assert.ok(notes.includes('build: waiting for a worker')); assert.ok(notes.includes('build: compiling'));
    assert.ok(notes.some(line => line.includes('Nothing to send')));
    const lines = format('build', outcome.result);
    assert.ok(lines.some(line => line.includes('ok  debug in 1.3s on w1')));
    assert.ok(lines.some(line => line.includes('build succeeded: 1/1 configuration')));
  } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
});

test('execute surfaces a failed result and transport errors', async () => {
  let failed = true;
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req));
    if (failed) return reply(res, { jsonrpc: '2.0', id: r.id, result: { isError: true, content: [],
      structuredContent: { ok: false, results: [{ configuration: 'debug', ok: false, seconds: 0.5, worker: 'w1',
        steps: [{ name: 'build', exit_code: 1, output: 'boom\n' }],
        diagnostics: [{ file: 'main.cpp', line: 3, column: 5, severity: 'error', message: 'expected a semicolon' }] }] } } });
    reply(res, { jsonrpc: '2.0', id: r.id, error: { code: -32603, message: 'kaput' } });
  });
  const root = await scratch('execute');
  try {
    const { execute, format } = await import('../build/execute.js');
    const core = { server: s.url, workspace: '', token: 't' };
    const outcome = await execute(core, binding, root, 'test', {}, () => {}, async () => pushed);
    assert.equal(outcome.ok, false);
    const lines = format('test', outcome.result);
    assert.ok(lines.some(line => line.includes('FAILED  debug')));
    assert.ok(lines.some(line => line.includes('main.cpp:3:5: error: expected a semicolon')));
    assert.ok(lines.some(line => line.includes('step build exited with 1')));
    assert.ok(lines.some(line => line.includes('    boom')));
    assert.ok(lines.some(line => line.includes('test failed: 0/1 configuration')));
    failed = false;
    await assert.rejects(execute(core, binding, root, 'build', {}, () => {}, async () => pushed), /kaput/);
  } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
});

test('execute runs a language query and formats its results', async () => {
  const requests = [];
  const s = await server(async (req, res) => {
    const r = JSON.parse(await body(req)); requests.push(r);
    reply(res, { jsonrpc: '2.0', id: r.id, result: { isError: false, content: [],
      structuredContent: { configuration: 'cpp', worldline: 'main', version: 'v1', stale: false, analyzed: true,
        diagnostics: [{ range: { place: { path: 'main.cpp', begin: 40, end: 45 } }, severity: 'error', message: 'unknown name' }],
        symbols: [{ id: 's1', name: 'main', kind: 'function', scope: '', declarations: [], definitions: [{ place: { path: 'main.cpp', begin: 0, end: 4 } }] }],
        definitions: [{ path: 'main.cpp', line: 3, column: 5, end_line: 3, end_column: 9, symbol: 'main' }] } } });
  });
  const root = await scratch('language');
  try {
    const { execute, formatLanguage } = await import('../build/execute.js');
    const outcome = await execute({ server: s.url, workspace: '', token: 't' }, binding, root, 'language',
      { action: 'diagnostics' }, () => {}, async () => pushed);
    assert.equal(outcome.ok, true, 'a language result has no ok field and counts by isError');
    assert.deepEqual(requests[0].params.arguments, { action: 'diagnostics', project: 'demo', worldline: 'main', version: 'v1' });
    const lines = formatLanguage(outcome.result);
    assert.ok(lines[0].includes('cpp on main at v1'));
    assert.ok(lines.some(line => line.includes('main.cpp +40: error: unknown name')));
    assert.ok(lines.some(line => line.includes('main (function)')));
    assert.ok(lines.some(line => line.includes('defined at main.cpp +0')));
    assert.ok(lines.some(line => line.includes('main.cpp:3:5  main')));
  } finally { await s.stop(); await rm(root, { recursive: true, force: true }); }
});
