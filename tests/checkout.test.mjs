// The sync against a real core: what is sent and ignored, and how a push converges when the worldline moved, a push failed half
// way, a file stopped being sendable or the binding changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { push, save, changed } from '../build/checkout/index.js';
import { call, tool } from '../build/remote.js';
import { scratch, start } from './service.mjs';

let core, connection;
before(async () => {
  core = await start('checkout');
  connection = { server: core.origin, workspace: '', token: core.token };
});
after(async () => assert.equal(await core.stop(), 0));

const digest = text => createHash('sha256').update(text).digest('hex');
const posix = process.platform !== 'win32';

async function spit(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function project(name) {
  const reply = await call(connection, 'PUT', `/api/v1/projects/${name}`, { revision: 0, value: {} });
  assert.equal(reply.status, 200, reply.body);
  return { server: core.origin, workspace: '', project: name, worldline: 'main' };
}

// A change by another writer, which locks the file-level scope as every writer must.
async function elsewhere(name, operation_id, changes) {
  const tree = await tool(connection, 'worldline', { project: name, action: 'inspect' });
  await tool(connection, 'worldline', { project: name, action: 'lock', scopes: ['::'] });
  await tool(connection, 'worldline', { project: name, action: 'apply', observed: tree.version, operation_id, changes });
  await tool(connection, 'worldline', { project: name, action: 'unlock', scopes: ['::'] });
}

async function files(binding) {
  const tree = await tool(connection, 'worldline', { project: binding.project, action: 'inspect' });
  return new Map(tree.files.map(f => [f.path, f]));
}

// A checkout bound to a new project, with `content` as its files.
async function checkout(name, content) {
  const root = await scratch(name);
  for (const [path, text] of Object.entries(content)) await spit(root, path, text);
  const binding = await project(name);
  await save(root, binding);
  return { root, binding };
}

test('the first push sends what gitignore rules leave, with executable and binary flags', async () => {
  const { root, binding } = await checkout('rules', {
    'main.cpp': 'int main() {}\n',
    'logo.bin': Buffer.from([0x89, 0x50, 0, 1]),
    '.gitignore': 'build/\n*.log\n[ab].tmp\n\\#notes\n/top.txt\nCase.txt\n',
    'build/out.o': 'object',
    'debug.log': 'noise',
    'docs/.gitignore': '!keep.log\n',
    'docs/keep.log': 'kept',
    'a.tmp': 'ignored by a class', 'c.tmp': 'sent',
    '#notes': 'ignored by an escaped hash',
    'top.txt': 'ignored at the top', 'sub/top.txt': 'sent below', 'case.txt': 'case differs',
    '.git': 'gitdir: ../repo/.git/worktrees/rules\n',
    'node_modules/x/index.js': 'installed',
    'src/.fughettaignore': 'generated.cpp\n', 'src/generated.cpp': 'generated', 'src/lib.cpp': 'int lib;\n',
  });
  await spit(root, 'tool.sh', '#!/bin/sh\n');
  if (posix) await chmod(join(root, 'tool.sh'), 0o755);
  const pushed = await push(connection, binding, root);
  const remote = await files(binding);
  // Rules match without case only where the file system usually ignores it.
  assert.deepEqual([...remote.keys()], ['.gitignore', 'c.tmp', ...(process.platform === 'linux' ? ['case.txt'] : []), 'docs/.gitignore', 'docs/keep.log',
    'logo.bin', 'main.cpp', 'src/.fughettaignore', 'src/lib.cpp', 'sub/top.txt', 'tool.sh']);
  assert.equal(pushed.created, remote.size);
  assert.equal(remote.get('logo.bin').kind, 'binary');
  assert.equal(remote.get('tool.sh').executable, posix);
  assert.equal(remote.get('main.cpp').executable, false);
  assert.equal(remote.get('main.cpp').digest, digest('int main() {}\n'));
  assert.equal(pushed.version, (await tool(connection, 'worldline', { project: 'rules', action: 'inspect' })).version);

  // Changes, a removal, a text file becoming binary and a mode change; then nothing is left to send, also from a subdirectory.
  await spit(root, 'main.cpp', 'int main() { return 1; }\n');
  await rm(join(root, 'c.tmp'));
  await spit(root, 'src/lib.cpp', Buffer.from([0, 1, 2]));
  if (posix) await chmod(join(root, 'tool.sh'), 0o644);
  await spit(root, 'new.txt', 'new\n');
  const second = await push(connection, binding, root);
  assert.deepEqual([second.created, second.written, second.removed], [1, posix ? 3 : 2, 1]);
  const after = await files(binding);
  assert.equal(after.has('c.tmp'), false);
  assert.equal(after.get('src/lib.cpp').kind, 'binary');
  assert.equal(after.get('tool.sh').executable, false);
  assert.equal(changed(await push(connection, binding, root)), false);
});

test('a push restores files another writer changed and keeps files it created', async () => {
  const { root, binding } = await checkout('shared', { 'main.cpp': 'int main() {}\n', 'gone.txt': 'x\n' });
  await push(connection, binding, root);
  await elsewhere('shared', 'other-writer',
    [{ kind: 'write', path: 'main.cpp', text: 'changed elsewhere\n' }, { kind: 'create', path: 'theirs.txt', text: 'theirs\n' }]);
  await rm(join(root, 'gone.txt'));
  const pushed = await push(connection, binding, root);
  assert.deepEqual([pushed.created, pushed.written, pushed.removed, pushed.kept], [0, 1, 1, ['theirs.txt']]);
  const remote = await files(binding);
  assert.equal(remote.get('main.cpp').digest, digest('int main() {}\n'));
  assert.equal(remote.has('gone.txt'), false);
  assert.equal(remote.has('theirs.txt'), true);
  // Nothing local changed, yet the worldline moved: the push still compares with it.
  await elsewhere('shared', 'other-writer-2', [{ kind: 'write', path: 'main.cpp', text: 'again\n' }]);
  const again = await push(connection, binding, root);
  assert.equal(again.written, 1);
  assert.equal((await files(binding)).get('main.cpp').digest, digest('int main() {}\n'));
});

test('a push whose reply was lost converges on the next push, after local edits too', async () => {
  // Three files of 1.5 MiB make two batches; the proxy forwards the second apply but answers it with an error. Rewriting one of
  // them afterwards erases more characters than one collection of the engine holds.
  const big = n => String(n).repeat(1536 * 1024);
  const { root, binding } = await checkout('partial', { 'one.txt': big(1), 'two.txt': big(2), 'three.txt': big(3) });
  let applies = 0;
  const losing = await proxy(body => body.includes('"action":"apply"') && ++applies === 2 ? 'lose' : undefined);
  await assert.rejects(push(losing.connection, binding, root));
  losing.close();
  assert.equal((await files(binding)).size, 3);

  await spit(root, 'one.txt', 'edited after the failure\n');
  await rm(join(root, 'two.txt'));
  const pushed = await push(connection, binding, root);
  assert.deepEqual([pushed.written, pushed.removed], [1, 1]);
  const remote = await files(binding);
  assert.deepEqual([...remote.keys()].sort(), ['one.txt', 'three.txt']);
  assert.equal(remote.get('one.txt').digest, digest('edited after the failure\n'));
  // The lock of the failed push was released.
  const locks = await tool(connection, 'worldline', { project: 'partial', action: 'locks' });
  assert.deepEqual(locks.locks ?? [], []);
});

test('files that stop being sendable keep their remote copies', { skip: !posix }, async () => {
  const { root, binding } = await checkout('skipped', { 'data.txt': 'data\n', 'target.txt': 'target\n' });
  await push(connection, binding, root);
  await rm(join(root, 'data.txt'));
  await symlink('target.txt', join(root, 'data.txt'));
  await spit(root, 'huge.bin', Buffer.alloc((4 << 20) + 1));
  const pushed = await push(connection, binding, root);
  assert.equal(changed(pushed), false);
  assert.deepEqual(pushed.skipped.map(s => s.split(' ')[0]).sort(), ['data.txt', 'huge.bin']);
  assert.equal((await files(binding)).get('data.txt').digest, digest('data\n'));
  // Still skipped later: the checkout answers for it, so deleting it afterwards removes it.
  await rm(join(root, 'data.txt'));
  assert.equal((await push(connection, binding, root)).removed, 1);
});

test('a new binding starts from nothing, so files it never sent are kept', async () => {
  const { root, binding } = await checkout('first', { 'x.txt': 'x\n', 'y.txt': 'y\n' });
  await push(connection, binding, root);
  await rm(join(root, 'x.txt'));
  const other = await project('second');
  await elsewhere('second', 'seed', [{ kind: 'create', path: 'x.txt', text: 'someone else\n' }]);
  await save(root, other);
  const pushed = await push(connection, other, root);
  assert.deepEqual([pushed.created, pushed.removed, pushed.kept], [1, 0, ['x.txt']]);
});

// A proxy to the core that lets `hook` see each request body first; `hook` returns 'drop' to answer 502 without forwarding,
// 'lose' to forward and answer 502, or nothing to pass the request through.
async function proxy(hook) {
  const server = createServer((incoming, answer) => {
    const chunks = [];
    incoming.on('data', c => chunks.push(c));
    incoming.on('end', async () => {
      const body = Buffer.concat(chunks);
      const verdict = await hook(body.toString());
      if (verdict === 'drop') return answer.writeHead(502).end('dropped');
      const out = request(core.origin + incoming.url, { method: incoming.method, headers: incoming.headers }, reply => {
        const parts = [];
        reply.on('data', c => parts.push(c));
        reply.on('end', () => {
          if (verdict === 'lose') answer.writeHead(502).end('lost');
          else answer.writeHead(reply.statusCode, reply.headers).end(Buffer.concat(parts));
        });
      });
      out.end(body);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { connection: { ...connection, server: `http://127.0.0.1:${server.address().port}` }, close: () => server.close() };
}

test('a batch that never reached the core claims none of its paths', async () => {
  const { root, binding } = await checkout('unsent', { 'a.txt': 'a\n' });
  await push(connection, binding, root);
  await spit(root, 'x.txt', 'mine\n');
  const dropping = await proxy(body => body.includes('"action":"apply"') ? 'drop' : undefined);
  await assert.rejects(push(dropping.connection, binding, root));
  dropping.close();
  // Someone else creates the path the lost batch would have created; deleting the local copy must not remove theirs.
  await elsewhere('unsent', 'theirs', [{ kind: 'create', path: 'x.txt', text: 'theirs\n' }]);
  await rm(join(root, 'x.txt'));
  const pushed = await push(connection, binding, root);
  assert.deepEqual([pushed.removed, pushed.kept], [0, ['x.txt']]);
  assert.equal((await files(binding)).get('x.txt').digest, digest('theirs\n'));
});

test('a removal whose reply was lost does not claim the path someone creates again', async () => {
  const { root, binding } = await checkout('relost', { 'a.txt': 'a\n', 'x.txt': 'x\n' });
  await push(connection, binding, root);
  await rm(join(root, 'x.txt'));
  const losing = await proxy(body => body.includes('"action":"apply"') ? 'lose' : undefined);
  await assert.rejects(push(losing.connection, binding, root));
  losing.close();
  await elsewhere('relost', 'again', [{ kind: 'create', path: 'x.txt', text: 'again\n' }]);
  const pushed = await push(connection, binding, root);
  assert.deepEqual([pushed.removed, pushed.kept], [0, ['x.txt']]);
});

test('a batch without a reply is abandoned by the next push, and its request is refused if it arrives later', async () => {
  const { root, binding } = await checkout('abandoned', { 'a.txt': 'a\n', 'x.txt': 'x\n' });
  await push(connection, binding, root);
  await rm(join(root, 'x.txt'));
  let held;
  const dropping = await proxy(body => body.includes('"action":"apply"') ? (held = body, 'drop') : undefined);
  await assert.rejects(push(dropping.connection, binding, root));
  dropping.close();
  const pushed = await push(connection, binding, root);
  assert.deepEqual([pushed.removed, pushed.kept], [1, []]);
  const late = JSON.parse(held).params.arguments;
  await assert.rejects(tool(connection, 'worldline', late), { code: 'identity_conflict' });
  assert.deepEqual([...(await files(binding)).keys()], ['a.txt']);
});

test('a batch another account sent waits for that account', async () => {
  const { root, binding } = await checkout('account', { 'a.txt': 'a\n' });
  await push(connection, binding, root);
  await spit(root, 'x.txt', 'x\n');
  const dropping = await proxy(body => body.includes('"action":"apply"') ? 'drop' : undefined);
  await assert.rejects(push(dropping.connection, binding, root));
  dropping.close();
  const ledger = join(root, '.fughetta', 'state', 'sent.json');
  const sent = JSON.parse(await readFile(ledger, 'utf8'));
  sent.pending[0].author = JSON.stringify(['issuer', 'someone-else']);
  await writeFile(ledger, JSON.stringify(sent));
  await assert.rejects(push(connection, binding, root), /sign in as that account/);
});

test('changes made between the first look and the lock are answered too', async () => {
  const { root, binding } = await checkout('moving', { 'main.cpp': 'int main() {}\n', 'a.txt': 'a\n' });
  await push(connection, binding, root);
  await spit(root, 'a.txt', 'b\n');
  let moved = false;
  const racing = await proxy(async body => {
    if (!moved && body.includes('"action":"lock"')) {
      moved = true;
      await elsewhere('moving', 'racer', [{ kind: 'write', path: 'main.cpp', text: 'raced\n' }]);
    }
  });
  const pushed = await push(racing.connection, binding, root);
  racing.close();
  assert.equal(pushed.written, 2);
  assert.equal((await files(binding)).get('main.cpp').digest, digest('int main() {}\n'));
});

test('content and mode of one file change in one push', { skip: !posix }, async () => {
  const { root, binding } = await checkout('mode', { 'run.sh': 'echo one\n' });
  await push(connection, binding, root);
  await spit(root, 'run.sh', 'echo two\n');
  await chmod(join(root, 'run.sh'), 0o755);
  assert.equal((await push(connection, binding, root)).written, 1);
  const remote = (await files(binding)).get('run.sh');
  assert.deepEqual([remote.digest, remote.executable], [digest('echo two\n'), true]);
});

test('a directory replaced by a link keeps the files under it, and linked ignore files are not read', { skip: !posix }, async () => {
  const { root, binding } = await checkout('linked', { 'dir/a.txt': 'a\n', 'dir/b/c.txt': 'c\n', 'all': '*\n', 'sub/x.txt': 'x\n' });
  await symlink('../all', join(root, 'sub/.gitignore'));
  await push(connection, binding, root);
  assert.equal((await files(binding)).has('sub/x.txt'), true);
  await rm(join(root, 'dir'), { recursive: true });
  await mkdir(join(root, 'elsewhere'));
  await symlink('elsewhere', join(root, 'dir'));
  const pushed = await push(connection, binding, root);
  assert.equal(pushed.removed, 0);
  const remote = await files(binding);
  assert.equal(remote.has('dir/a.txt') && remote.has('dir/b/c.txt'), true);
});

test('pushes of one checkout wait for each other, and a holder that ended releases its lock', async () => {
  const { root, binding } = await checkout('held', { 'a.txt': 'a\n' });
  const files = new URL('../build/files.js', import.meta.url).href;
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `const { locked } = await import(${JSON.stringify(files)}); await locked(${JSON.stringify(join(root, '.fughetta/state/push'))}, () => { console.log('held'); setInterval(() => {}, 1000); return new Promise(() => {}); });`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(done => holder.stdout.once('data', done));
  let finished = false;
  const waiting = push(connection, binding, root).then(p => { finished = true; return p; });
  await new Promise(done => setTimeout(done, 500));
  assert.equal(finished, false);
  holder.kill('SIGKILL');
  assert.equal((await waiting).created, 1);
});
