import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { binary, port, scratch } from './service.mjs';
import { configuration, service, unit } from '../build/worker.js';

const cli = resolve(import.meta.dirname, '../build/cli.js');
const listen = async server => { await new Promise(done => server.listen(0, '127.0.0.1', done)); return server.address().port; };

test('the systemd unit quotes its command and stops restarting a refused Worker', () => {
  const text = unit('https://gateway.example', 'acme', ['/opt/node dir/node', '/opt/fug/cli.js'], ['--service', '/x/100%"service']);
  assert.match(text, /^ExecStart="\/opt\/node dir\/node" "\/opt\/fug\/cli.js" "worker" "--server" "https:\/\/gateway.example" "--workspace" "acme" "--service" "\/x\/100%%\\"service"$/m);
  assert.match(text, /^RestartPreventExitStatus=2$/m);
  assert.match(text, /^Restart=on-failure$/m);
});

test('the Worker configuration names the relay, identity and machine budgets', () => {
  const config = configuration({ server: 'https://g', workspace: 'acme', workspace_id: 'ws-1', worker_id: 'worker_1', secret: 'a'.repeat(64), name: 'box' }, '127.0.0.1:4000', '/state', 8);
  assert.deepEqual(config, { gateway: '127.0.0.1:4000', worker_id: 'worker_1', workspace_id: 'ws-1', token: 'a'.repeat(64), name: 'box',
    data_root: '/state/data', work_root: '/state/work', compute_threads: 8, parallel: 8 });
});

test('the release download checks its digest, caches it and falls back to the cache offline', { timeout: 30_000 }, async () => {
  const dir = await scratch('release');
  const saved = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  const body = Buffer.from('#!/bin/sh\necho service\n');
  let digest = createHash('sha256').update(body).digest('hex');
  let downloads = 0;
  const name = `fughetta-service-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/latest') res.end(JSON.stringify({ tag_name: 'v0.1.0', assets: [{ name, browser_download_url: `${base}/download`, digest: `sha256:${digest}` }] }));
    else { ++downloads; res.end(body); }
  });
  const url = `http://127.0.0.1:${await listen(server)}/latest`;
  const lines = [];
  try {
    digest = '0'.repeat(64);
    await assert.rejects(service(url, l => lines.push(l)), /does not match its published digest/);
    digest = createHash('sha256').update(body).digest('hex');
    const path = await service(url, l => lines.push(l));
    assert.equal(path, join(dir, 'fughetta', 'service', 'v0.1.0', name));
    assert.deepEqual(await readFile(path), body);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o755);
    assert.equal(await service(url, l => lines.push(l)), path);
    assert.equal(downloads, 2, 'a cached release is not downloaded again');
    server.close();
    assert.equal(await service(url, l => lines.push(l)), path);
    assert.match(lines.at(-1), /using the cached/);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

// A stand-in for the hosted gateway: it lists one workspace for the token, forwards /w/acme to a trusted-mode core as an owner,
// and joins the Worker tunnel to the core's remote Worker listener.
function gateway(core, remote, seen) {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization === 'Bearer user-token';
    if (req.url === '/.well-known/oauth-authorization-server')
      return res.end(JSON.stringify({ authorization_endpoint: 'http://127.0.0.1:1/authorize', token_endpoint: 'http://127.0.0.1:1/token' }));
    if (!auth) return res.writeHead(401).end('{"message":"sign in"}');
    if (req.url === '/api/v1/workspaces') return res.end(JSON.stringify([{ name: 'acme' }]));
    if (!req.url.startsWith('/w/acme/')) return res.writeHead(404).end();
    const forward = request(`${core}${req.url.slice('/w/acme'.length)}`, { method: req.method, headers: { 'content-type': 'application/json',
      'x-fughetta-workspace': 'ws-acme', 'x-fughetta-user': 'owner', 'x-fughetta-role': 'owner' } }, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    req.pipe(forward);
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, origin: req.headers.origin, protocol: req.headers['sec-websocket-protocol'] });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: fughetta-worker.v1\r\n\r\n`);
    const tcp = connect(remote, '127.0.0.1');
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      for (;;) {
        if (pending.length < 2) return;
        let size = pending[1] & 0x7f, at = 2;
        if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); at = 4; }
        else if (size === 127) { if (pending.length < 10) return; size = Number(pending.readBigUInt64BE(2)); at = 10; }
        if (pending.length < at + 4 + size) return;
        const mask = pending.subarray(at, at + 4);
        const payload = Buffer.from(pending.subarray(at + 4, at + 4 + size)).map((b, i) => b ^ mask[i & 3]);
        const opcode = pending[0] & 0x0f;
        pending = pending.subarray(at + 4 + size);
        if (opcode === 8) { tcp.end(); socket.end(); return; }
        if (opcode === 2) tcp.write(payload);
      }
    });
    tcp.on('data', data => {
      const head = data.length < 126 ? Buffer.from([0x82, data.length])
        : data.length < 65536 ? Buffer.from([0x82, 126, data.length >> 8, data.length & 0xff])
        : Buffer.concat([Buffer.from([0x82, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(data.length)); return b; })()]);
      socket.write(Buffer.concat([head, data]));
    });
    const end = () => { tcp.destroy(); socket.destroy(); };
    tcp.on('close', end); socket.on('close', end); tcp.on('error', end); socket.on('error', end);
  });
  return server;
}

const scoped = process.platform === 'linux' && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '-p', 'Delegate=yes', 'true']).status === 0;
test('fug worker registers this machine, serves the workspace through the tunnel, and stops when revoked', { timeout: 120_000, skip: !scoped && 'needs systemd-run --user' }, async () => {
  const dir = await scratch('worker');
  const http = await port(), remote = await port();
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({
    runtime: { threads: 6, jobs: 1, workers: 0 },
    server: { http_bind: '127.0.0.1', http_port: http, worker_port: await port(), source: `127.0.0.1:${await port()}`, remote_worker_port: remote,
      remote_worker_enrollment: true, storage: join(dir, 'state'), auth: { mode: 'trusted', workspace: 'ws-acme' } },
    projects: {},
  }));
  const core = spawn(binary, [config], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
  const origin = `http://127.0.0.1:${http}`;
  const seen = [];
  const front = gateway(origin, remote, seen);
  const server = `http://127.0.0.1:${await listen(front)}`;
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state-home'), XDG_CACHE_HOME: join(dir, 'cache') };
  delete env.FUGHETTA_TOKEN;
  let worker;
  const owner = { 'x-fughetta-workspace': 'ws-acme', 'x-fughetta-user': 'owner', 'x-fughetta-role': 'owner' };
  const workers = async () => (await (await fetch(`${origin}/api/v1/workers`, { headers: owner })).json()).filter(w => w.worker_id);
  try {
    for (let i = 0; ; ++i) {
      try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {}
      if (i > 300) throw new Error('fughetta-service did not become ready');
      await delay(100);
    }
    let stderr = '';
    worker = spawn(process.execPath, [cli, 'worker', '--server', server, '--workspace', 'acme', '--token', 'user-token', '--name', 'test-box', '--service', binary],
      { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
    worker.stderr.on('data', b => { stderr += b; });
    const exited = new Promise(done => worker.once('exit', code => done(code)));
    let listed;
    for (let i = 0; ; ++i) {
      listed = await workers();
      if (listed.some(w => w.online)) break;
      if (i > 200 || worker.exitCode !== null) throw new Error(`the Worker did not come online:\n${stderr}`);
      await delay(100);
    }
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'test-box');
    assert.match(stderr, new RegExp(`registered test-box as ${listed[0].worker_id} in acme`));
    assert.ok(seen.every(s => s.url === '/w/acme/workers/tunnel' && s.origin === undefined && s.protocol === 'fughetta-worker.v1'), JSON.stringify(seen));
    const state = join(dir, 'state-home', 'fughetta', 'workers', `${new URL(server).host.replace(/[^a-zA-Z0-9.-]/g, '_')}-acme`);
    const saved = JSON.parse(await readFile(join(state, 'identity.json'), 'utf8'));
    assert.equal(saved.worker_id, listed[0].worker_id);
    assert.equal((await stat(join(state, 'worker.json'))).mode & 0o777, 0o600);
    assert.ok(!stderr.includes(saved.secret), 'the secret leaked into the log');

    assert.equal((await fetch(`${origin}/api/v1/workers/${saved.worker_id}`, { method: 'DELETE', headers: owner })).status, 200);
    assert.equal(await Promise.race([exited, delay(20_000, 'timeout', { ref: false })]), 2, stderr);
    assert.match(stderr, /refused this machine's identity/);
    await assert.rejects(stat(join(state, 'identity.json')), { code: 'ENOENT' });
  } finally {
    worker?.kill('SIGTERM');
    front.close();
    core.kill('SIGTERM');
    await new Promise(done => core.exitCode !== null ? done() : core.once('exit', done));
    await rm(dir, { recursive: true, force: true });
  }
});
