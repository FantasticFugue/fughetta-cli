// The sync against a real core: what is sent and ignored, and how a push converges when the worldline moved, a push failed half
// way, a file stopped being sendable or the binding changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { push, save, changed } from '../build/checkout/index.js';
import { call } from '../build/remote.js';
import { worldline } from '../build/worldline.js';
import { branches } from '../build/branches.js';
import { delta } from '../build/checkout/push.js';
const tool = (core, _name, args) => worldline(core, { project: args.project, worldline: args.worldline ?? 'main' }, args.action, args);
import { scratch, start, service } from './service.mjs';

let core, connection;
const roots = [];
before(async () => {
  if (service) return;
  core = await start('checkout');
  connection = { server: core.origin, workspace: '', token: core.token };
});
after(async () => { if (service) return; assert.equal(await core.stop(), 0); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

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

// A change by another writer uses the version that writer observed.
async function elsewhere(name, operation_id, changes) {
  const tree = await tool(connection, 'worldline', { project: name, action: 'inspect' });
  await tool(connection, 'worldline', { project: name, action: 'apply', observed: tree.version, operation_id, changes });
}

async function files(binding) {
  const tree = await tool(connection, 'worldline', { project: binding.project, action: 'inspect' });
  return new Map(tree.files.map(f => [f.path, f]));
}

// A checkout bound to a new project, with `content` as its files.
async function checkout(name, content) {
  const root = await scratch(name);
  roots.push(root);
  for (const [path, text] of Object.entries(content)) await spit(root, path, text);
  const binding = await project(name);
  await save(root, binding);
  return { root, binding };
}

test('the first push sends what gitignore rules leave, with executable and binary flags', { skip: service }, async () => {
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

test('a push pulls other writers changes and sends only local edits', { skip: service }, async () => {
  const { root, binding } = await checkout('shared', { 'main.cpp': 'int main() {}\n', 'gone.txt': 'x\n' });
  await push(connection, binding, root);
  await elsewhere('shared', 'other-writer',
    [{ kind: 'write', path: 'main.cpp', text: 'changed elsewhere\n' }, { kind: 'create', path: 'theirs.txt', text: 'theirs\n' }]);
  await rm(join(root, 'gone.txt'));
  const pushed = await push(connection, binding, root);
  assert.deepEqual([pushed.created, pushed.written, pushed.removed, pushed.kept], [0, 0, 1, ['theirs.txt']]);
  const remote = await files(binding);
  assert.equal(remote.get('main.cpp').digest, digest('changed elsewhere\n'));
  assert.equal(await readFile(join(root, 'main.cpp'), 'utf8'), 'changed elsewhere\n');
  assert.equal(remote.has('gone.txt'), false);
  assert.equal(remote.has('theirs.txt'), true);
  // Nothing local changed, yet the worldline moved: the push still compares with it.
  await elsewhere('shared', 'other-writer-2', [{ kind: 'write', path: 'main.cpp', text: 'again\n' }]);
  const again = await push(connection, binding, root);
  assert.equal(again.written, 0);
  assert.equal((await files(binding)).get('main.cpp').digest, digest('again\n'));
  assert.equal(await readFile(join(root, 'main.cpp'), 'utf8'), 'again\n');
});

test('a push whose reply was lost converges on the next push, after local edits too', { skip: service }, async () => {
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
  await assert.rejects(tool(connection, 'worldline', { project: 'partial', action: 'locks' }), { code: 'invalid_record' });
});

test('files that stop being sendable keep their remote copies', { skip: service || !posix }, async () => {
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

test('a batch that never reached the core claims none of its paths', { skip: service }, async () => {
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

test('a removal whose reply was lost does not claim the path someone creates again', { skip: service }, async () => {
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

test('a batch without a reply is abandoned by the next push, and its request is refused if it arrives later', { skip: service }, async () => {
  const { root, binding } = await checkout('abandoned', { 'a.txt': 'a\n', 'x.txt': 'x\n' });
  await push(connection, binding, root);
  await rm(join(root, 'x.txt'));
  let held;
  const dropping = await proxy(body => body.includes('"action":"apply"') ? (held = body, 'drop') : undefined);
  await assert.rejects(push(dropping.connection, binding, root));
  dropping.close();
  const pushed = await push(connection, binding, root);
  assert.deepEqual([pushed.removed, pushed.kept], [1, []]);
  const late = JSON.parse(held);
  await assert.rejects(tool(connection, 'worldline', late), { code: 'identity_conflict' });
  assert.deepEqual([...(await files(binding)).keys()], ['a.txt']);
});

test('a batch another account sent waits for that account', { skip: service }, async () => {
  const { root, binding } = await checkout('account', { 'a.txt': 'a\n' });
  await push(connection, binding, root);
  await spit(root, 'x.txt', 'x\n');
  const dropping = await proxy(body => body.includes('"action":"apply"') ? 'drop' : undefined);
  await assert.rejects(push(dropping.connection, binding, root));
  dropping.close();
  const ledger = join(root, '.fughetta', 'state', 'baseline.json');
  const sent = JSON.parse(await readFile(ledger, 'utf8'));
  sent.pending.author = JSON.stringify(['issuer', 'someone-else']);
  await writeFile(ledger, JSON.stringify(sent));
  await assert.rejects(push(connection, binding, root), /sign in as that account/);
});

test('changes made while local edits are sent are pulled too', { skip: service }, async () => {
  const { root, binding } = await checkout('moving', { 'main.cpp': 'int main() {}\n', 'a.txt': 'a\n' });
  await push(connection, binding, root);
  await spit(root, 'a.txt', 'b\n');
  let moved = false;
  const racing = await proxy(async body => {
    if (!moved && body.includes('"action":"apply"')) {
      moved = true;
      await elsewhere('moving', 'racer', [{ kind: 'write', path: 'main.cpp', text: 'raced\n' }]);
    }
  });
  const pushed = await push(racing.connection, binding, root);
  racing.close();
  assert.equal(pushed.written, 1);
  assert.equal((await files(binding)).get('main.cpp').digest, digest('raced\n'));
  assert.equal(await readFile(join(root, 'main.cpp'), 'utf8'), 'raced\n');
});

test('content and mode of one file change in one push', { skip: service || !posix }, async () => {
  const { root, binding } = await checkout('mode', { 'run.sh': 'echo one\n' });
  await push(connection, binding, root);
  await spit(root, 'run.sh', 'echo two\n');
  await chmod(join(root, 'run.sh'), 0o755);
  assert.equal((await push(connection, binding, root)).written, 1);
  const remote = (await files(binding)).get('run.sh');
  assert.deepEqual([remote.digest, remote.executable], [digest('echo two\n'), true]);
});

test('a directory replaced by a link keeps the files under it, and linked ignore files are not read', { skip: service || !posix }, async () => {
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

test('pushes of one checkout wait for each other, and a holder that ended releases its lock', { skip: service }, async () => {
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

test('text deltas count Unicode scalars and preserve distant unchanged edges', { skip: service }, () => {
  assert.deepEqual(delta('😀abc界', '😀aX界'), { offset: 2, count: 2, text: 'X' });
  assert.equal(delta('same', 'same'), undefined);
});

test('two checkouts merge independent edits in one worldline without reverting each other', { skip: service }, async () => {
  const a = await checkout('concurrent', { 'x.txt': '😀abcd\n' });
  await push(connection, a.binding, a.root);
  const b = await scratch('concurrent-b'); roots.push(b);
  await save(b, a.binding);
  await push(connection, a.binding, b);
  assert.equal(await readFile(join(b, 'x.txt'), 'utf8'), '😀abcd\n');
  await spit(a.root, 'x.txt', '😀Abcd\n');
  await spit(b, 'x.txt', '😀abcZ\n');
  await push(connection, a.binding, a.root);
  await push(connection, a.binding, b);
  assert.equal(await readFile(join(b, 'x.txt'), 'utf8'), '😀AbcZ\n');
  await push(connection, a.binding, a.root);
  assert.equal(await readFile(join(a.root, 'x.txt'), 'utf8'), '😀AbcZ\n');
});

test('local edits made during an apply survive writeback and merge on the next push', { skip: service }, async () => {
  const { root, binding } = await checkout('editing', { 'x.txt': 'abcd\n' });
  await push(connection, binding, root);
  await spit(root, 'x.txt', 'Abcd\n');
  let raced = false;
  const racing = await proxy(async body => {
    if (!raced && body.includes('"action":"apply"')) {
      raced = true;
      await elsewhere('editing', 'other', [{ kind: 'edit', path: 'x.txt', offset: 3, count: 1, text: 'Z' }]);
      await spit(root, 'x.txt', 'ABcd\n');
    }
  });
  try {
    const first = await push(racing.connection, binding, root);
    assert.match(first.skipped.join(), /changed locally/);
    assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'ABcd\n');
  } finally { racing.close(); }
  await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'ABcZ\n');
});


test('explicit worldlines pin forks and promotions while keeping separate histories', { skip: service }, async () => {
  const { root, binding } = await checkout('explicit-lines', { 'a.txt': 'main contents' });
  const fork = JSON.parse(await branches(connection, binding, root, ['fork', 'experiment']));
  await writeFile(join(root, 'a.txt'), 'main changed');
  await push(connection, binding, root);
  const retried = JSON.parse(await branches(connection, binding, root, ['fork', 'experiment']));
  assert.equal(retried.version, fork.version);
  assert.equal(retried.replayed, true);
  const listed = JSON.parse(await branches(connection, binding, root, ['list']));
  assert.ok(listed.worldlines.some(line => line.name === 'experiment'));
  const destination = `${root}-experiment`;
  roots.push(destination);
  await branches(connection, binding, root, ['checkout', 'experiment', destination]);
  assert.equal(await readFile(join(destination, 'a.txt'), 'utf8'), 'main contents');
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'main changed');
  const next = JSON.parse(await readFile(join(destination, '.fughetta/project.json'), 'utf8'));
  assert.equal(next.worldline, 'experiment');
  await writeFile(join(destination, 'asset.bin'), Buffer.from([0, 255, 128]));
  if (posix) await chmod(join(destination, 'asset.bin'), 0o755);
  await push(connection, next, destination);
  const diff = JSON.parse(await branches(connection, binding, root, ['diff', 'experiment']));
  assert.ok(diff.changes.some(change => change.before?.path === 'asset.bin' && !change.after));
  const promoted = JSON.parse(await branches(connection, binding, root, ['promote', 'experiment', '--operation-id', 'adopt-asset', '--intent', 'Adopt binary asset']));
  assert.equal(promoted.worldline, 'main');
  const history = await worldline(connection, binding, 'history');
  assert.equal(history.entries.at(-1).parents.length, 1);
  assert.equal(history.entries.at(-1).operation_id, 'adopt-asset');
  await writeFile(join(destination, 'a.txt'), 'other architecture');
  await push(connection, next, destination);
  const replayed = JSON.parse(await branches(connection, binding, root, ['promote', 'experiment', '--intent', 'Adopt binary asset', '--operation-id', 'adopt-asset']));
  assert.equal(replayed.version, promoted.version);
  assert.equal(replayed.replayed, true);
  await assert.rejects(branches(connection, binding, root, ['promote', 'experiment', '--operation-id', 'conflicting-source']), /changed in both worldlines/);
  await assert.rejects(branches(connection, binding, root, ['promote', 'experiment', '--operation-id', 'adopt-asset']), /different arguments/);
  await push(connection, binding, root);
  assert.deepEqual(await readFile(join(root, 'asset.bin')), Buffer.from([0, 255, 128]));
  const current = await worldline(connection, binding, 'inspect');
  assert.equal(current.version, promoted.version);
  if (posix) assert.equal(current.files.find(file => file.path === 'asset.bin').executable, true);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'main changed');
  await assert.rejects(branches(connection, binding, root, ['checkout', 'experiment', root]), /outside/);
  await assert.rejects(branches(connection, binding, root, ['checkout', 'experiment', destination]), /EEXIST/);
});

test('new ignore rules do not delete previously synchronized remote files', { skip: service }, async () => {
  const { root, binding } = await checkout('ignore-after-send', { 'keep.txt': 'remote content' });
  await push(connection, binding, root);
  await writeFile(join(root, '.gitignore'), 'keep.txt\n');
  await rm(join(root, 'keep.txt'));
  const sent = await push(connection, binding, root);
  assert.ok(sent.skipped.some(path => path.startsWith('keep.txt')));
  assert.ok((await files(binding)).has('keep.txt'));
  await assert.rejects(readFile(join(root, 'keep.txt')), /ENOENT/);
});


test('an unchanged rename sends a move to its destination', { skip: service }, async () => {
  const { root, binding } = await checkout('rename-file', { 'old.txt': 'same document' });
  await push(connection, binding, root);
  await rename(join(root, 'old.txt'), join(root, 'new.txt'));
  await push(connection, binding, root);
  const remote = await files(binding);
  assert.ok(!remote.has('old.txt'));
  assert.equal(remote.get('new.txt').digest, digest('same document'));
  const history = await worldline(connection, binding, 'history');
  const detail = await worldline(connection, binding, 'contribution', { target: history.entries.at(-1).id });
  assert.equal(detail.changes.length, 1);
  assert.equal(detail.changes[0].before.path, 'old.txt');
  assert.equal(detail.changes[0].after.path, 'new.txt');
});

test('a changed binding cannot publish an old working copy into another project', { skip: service }, async () => {
  const { root, binding } = await checkout('binding-before', { 'a.txt': 'private work' });
  await push(connection, binding, root);
  const other = await project('binding-after');
  await assert.rejects(push(connection, other, root), /baseline for another binding/);
  assert.equal((await files(other)).size, 0);
});

test('concurrent appends converge without blocking later pushes and preserve displaced local bytes', { skip: service }, async () => {
  const a = await checkout('same-anchor', { 'x.txt': 'start\n' });
  await push(connection, a.binding, a.root);
  const b = await scratch('same-anchor-peer');
  roots.push(b);
  await save(b, a.binding);
  await push(connection, a.binding, b);
  await writeFile(join(a.root, 'x.txt'), 'start\nAlice\n');
  await writeFile(join(b, 'x.txt'), 'start\nBob\n');
  await push(connection, a.binding, a.root);
  const merged = await push(connection, a.binding, b);
  const text = await readFile(join(b, 'x.txt'), 'utf8');
  assert.ok(text.includes('Alice\n') && text.includes('Bob\n'));
  assert.ok(merged.conflicts.some(conflict => conflict.startsWith('text_overlap:')));
  assert.equal(await readFile(merged.preserved[0], 'utf8'), 'start\nBob\n');
  await push(connection, a.binding, a.root);
  await push(connection, a.binding, b);
  assert.equal(await readFile(join(a.root, 'x.txt'), 'utf8'), text);
});


test('unchanged synchronization downloads no file bodies and stores compact baselines', { skip: service }, async () => {
  const content = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`file-${i}.txt`, `${i}:` + 'x'.repeat(8192)]));
  const { root, binding } = await checkout('compact-baseline', content);
  await push(connection, binding, root);
  const ledger = await readFile(join(root, '.fughetta/state/baseline.json'), 'utf8');
  assert.ok(!ledger.includes('data_base64'));
  assert.ok(ledger.length < 30000);
  let downloads = 0;
  const observing = await proxy(body => { if (body.includes('"action":"read"')) downloads++; });
  try { await push(observing.connection, binding, root); }
  finally { observing.close(); }
  assert.equal(downloads, 0);
  assert.equal((await readdir(join(root, '.fughetta/state/blobs'))).length, 40);
});

for (const installed of [false, true]) test(`writeback recovery preserves later edits when installation is ${installed}`, { skip: service }, async () => {
  const { root, binding } = await checkout(`writeback-${installed}`, { 'x.txt': 'abc' });
  await push(connection, binding, root);
  const ledger = JSON.parse(await readFile(join(root, '.fughetta/state/baseline.json'), 'utf8'));
  await elsewhere(binding.project, 'remote-edit', [{ kind: 'edit', path: 'x.txt', offset: 0, count: 1, text: 'A' }]);
  const remote = await worldline(connection, binding, 'inspect');
  const after = remote.files.find(file => file.path === 'x.txt');
  const temp = join(root, '.fughetta/state/writeback-interrupted');
  await writeFile(join(root, '.fughetta/state/blobs', after.digest), 'Abc');
  await writeFile(temp, 'Abc');
  await mkdir(join(root, '.fughetta/state/pulls'), { recursive: true });
  await writeFile(join(root, '.fughetta/state/pulls/interrupted.json'), JSON.stringify({
    path: 'x.txt', before: ledger.files['x.txt'].file, after, version: remote.version, temp, installed,
  }));
  await writeFile(join(root, 'x.txt'), installed ? 'ABc' : 'aBc');
  await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'ABc');
  assert.deepEqual(await readdir(join(root, '.fughetta/state/pulls')), []);
  await assert.rejects(readFile(temp), /ENOENT/);
});

for (const samePath of [false, true]) test(`concurrent creates from an empty baseline recover when paths coincide: ${samePath}`, { skip: service }, async () => {
  const a = await checkout(`create-race-${samePath}`, {});
  await push(connection, a.binding, a.root);
  const b = await scratch('create-peer');
  roots.push(b);
  await save(b, a.binding);
  await push(connection, a.binding, b);
  await writeFile(join(a.root, 'new.txt'), 'Alice created this');
  await writeFile(join(b, samePath ? 'new.txt' : 'other.txt'), 'Bob created this');
  await push(connection, a.binding, a.root);
  const result = await push(connection, a.binding, b);
  assert.equal(await readFile(join(b, samePath ? 'new.txt' : 'other.txt'), 'utf8'), 'Bob created this');
  if (samePath) assert.equal(await readFile(result.preserved[0], 'utf8'), 'Alice created this');
  else assert.equal(await readFile(join(b, 'new.txt'), 'utf8'), 'Alice created this');
  await push(connection, a.binding, b);
});

for (const when of ['before', 'after']) test(`writeback retains editor saves ${when} capturing the previous file`, { skip: service }, async () => {
  const { syncBuiltinESMExports } = await import('node:module');
  const fs = await import('node:fs');
  const { root, binding } = await checkout(`write-race-${when}`, { 'x.txt': 'abc' });
  await push(connection, binding, root);
  await elsewhere(binding.project, 'remote-edit', [{ kind: 'edit', path: 'x.txt', offset: 0, count: 1, text: 'A' }]);
  const original = fs.default.promises.rename;
  let injected = false;
  fs.default.promises.rename = async (from, to) => {
    const capture = !injected && String(from) === join(root, 'x.txt') && String(to).includes('recovered');
    if (capture && when === 'before') { injected = true; await writeFile(from, 'aBc'); }
    await original(from, to);
    if (capture && when === 'after') { injected = true; await writeFile(from, 'aBc'); }
  };
  syncBuiltinESMExports();
  let result;
  try { result = await push(connection, binding, root); }
  finally { fs.default.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'aBc');
  assert.ok(result.deferred.includes('x.txt'));
  assert.equal(result.preserved?.length ?? 0, 0);
  await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'ABc');
});

test('recovery restores a newer file captured before the content check', { skip: service }, async () => {
  const { root, binding } = await checkout('capture-interrupted', { 'x.txt': 'abc' });
  await push(connection, binding, root);
  const ledger = JSON.parse(await readFile(join(root, '.fughetta/state/baseline.json'), 'utf8'));
  await elsewhere(binding.project, 'remote-edit', [{ kind: 'edit', path: 'x.txt', offset: 0, count: 1, text: 'A' }]);
  const remote = await worldline(connection, binding, 'inspect');
  const after = remote.files.find(file => file.path === 'x.txt');
  const temp = join(root, '.fughetta/state/writeback-captured');
  const backup = join(root, '.fughetta/state/recovered/captured.file');
  await mkdir(dirname(backup), { recursive: true });
  await mkdir(join(root, '.fughetta/state/pulls'), { recursive: true });
  await writeFile(join(root, 'x.txt'), 'aBc');
  await rename(join(root, 'x.txt'), backup);
  await writeFile(temp, 'Abc');
  await writeFile(join(root, '.fughetta/state/blobs', after.digest), 'Abc');
  await writeFile(join(root, '.fughetta/state/pulls/captured.json'), JSON.stringify({
    path: 'x.txt', before: ledger.files['x.txt'].file, after, version: remote.version, temp, backup,
  }));
  await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'ABc');
  await assert.rejects(readFile(backup), /ENOENT/);
});

test('recovery restores a captured file after its parent directory disappears', { skip: service }, async () => {
  const { root, binding } = await checkout('capture-interrupted-nested', { 'nested/x.txt': 'abc' });
  await push(connection, binding, root);
  const ledger = JSON.parse(await readFile(join(root, '.fughetta/state/baseline.json'), 'utf8'));
  await elsewhere(binding.project, 'remote-edit', [{ kind: 'edit', path: 'nested/x.txt', offset: 0, count: 1, text: 'A' }]);
  const remote = await worldline(connection, binding, 'inspect');
  const after = remote.files.find(file => file.path === 'nested/x.txt');
  const temp = join(root, '.fughetta/state/writeback-captured');
  const backup = join(root, '.fughetta/state/recovered/captured.file');
  await mkdir(dirname(backup), { recursive: true });
  await mkdir(join(root, '.fughetta/state/pulls'), { recursive: true });
  await writeFile(join(root, 'nested/x.txt'), 'aBc');
  await rename(join(root, 'nested/x.txt'), backup);
  await rm(join(root, 'nested'), { recursive: true });
  await writeFile(temp, 'Abc');
  await writeFile(join(root, '.fughetta/state/blobs', after.digest), 'Abc');
  await writeFile(join(root, '.fughetta/state/pulls/captured.json'), JSON.stringify({
    path: 'nested/x.txt', before: ledger.files['nested/x.txt'].file, after, version: remote.version, temp, backup,
  }));
  await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'nested/x.txt'), 'utf8'), 'ABc');
  await assert.rejects(readFile(backup), /ENOENT/);
});

for (const linked of [false, true]) test(`interrupted capture recognizes installation by inode: ${linked}`, { skip: service }, async () => {
  const { root, binding } = await checkout(`inode-${linked}`, { 'x.txt': 'abc' });
  await push(connection, binding, root);
  const ledger = JSON.parse(await readFile(join(root, '.fughetta/state/baseline.json'), 'utf8'));
  await elsewhere(binding.project, 'remote-edit', [{ kind: 'edit', path: 'x.txt', offset: 0, count: 1, text: 'A' }]);
  const remote = await worldline(connection, binding, 'inspect');
  const after = remote.files.find(file => file.path === 'x.txt');
  const temp = join(root, '.fughetta/state/writeback-inode');
  const backup = join(root, '.fughetta/state/recovered/inode.file');
  await mkdir(dirname(backup), { recursive: true });
  await mkdir(join(root, '.fughetta/state/pulls'), { recursive: true });
  await rename(join(root, 'x.txt'), backup);
  await writeFile(temp, 'Abc');
  await writeFile(join(root, '.fughetta/state/blobs', after.digest), 'Abc');
  if (linked) await link(temp, join(root, 'x.txt'));
  await writeFile(join(root, 'x.txt'), linked ? 'ABc' : 'aBc');
  await writeFile(join(root, '.fughetta/state/pulls/inode.json'), JSON.stringify({
    path: 'x.txt', before: ledger.files['x.txt'].file, after, version: remote.version, temp, backup,
  }));
  await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'ABc');
});

test('remote writeback preserves private file permissions', { skip: service }, async () => {
  if (process.platform === 'win32') return;
  const { root, binding } = await checkout('private-mode', { 'x.txt': 'abc' });
  await chmod(join(root, 'x.txt'), 0o600);
  await push(connection, binding, root);
  await elsewhere(binding.project, 'remote-edit', [{ kind: 'edit', path: 'x.txt', offset: 0, count: 1, text: 'A' }]);
  await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'Abc');
  assert.equal((await lstat(join(root, 'x.txt'))).mode & 0o777, 0o600);
});

for (const corrupt of [false, true]) test(`missing or corrupt baseline cache recovers from its observed version: ${corrupt}`, { skip: service }, async () => {
  const { root, binding } = await checkout(`cache-repair-${corrupt}`, { 'x.txt': 'abc' });
  await push(connection, binding, root);
  const ledger = JSON.parse(await readFile(join(root, '.fughetta/state/baseline.json'), 'utf8'));
  const blob = join(root, '.fughetta/state/blobs', ledger.files['x.txt'].file.digest);
  if (corrupt) await writeFile(blob, 'bad');
  else await rm(blob);
  await elsewhere(binding.project, 'remote-edit', [{ kind: 'edit', path: 'x.txt', offset: 0, count: 1, text: 'A' }]);
  await writeFile(join(root, 'x.txt'), 'aBc');
  const result = await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'ABc');
  assert.ok(result.updated.includes('x.txt'));
});

test('sync collects superseded blobs, unchanged recovery copies and deleted baselines', { skip: service }, async () => {
  const { root, binding } = await checkout('cache-collection', { 'x.txt': 'abc' });
  await push(connection, binding, root);
  for (const text of ['first', 'second', 'third']) {
    await elsewhere(binding.project, `remote-${text}`, [{ kind: 'write', path: 'x.txt', text }]);
    await push(connection, binding, root);
    assert.equal((await readdir(join(root, '.fughetta/state/blobs'))).length, 1);
    assert.equal((await readdir(join(root, '.fughetta/state/recovered'))).length, 2);
  }
  await push(connection, binding, root);
  assert.deepEqual(await readdir(join(root, '.fughetta/state/recovered')), []);
  await rm(join(root, 'x.txt'));
  await push(connection, binding, root);
  const ledger = JSON.parse(await readFile(join(root, '.fughetta/state/baseline.json'), 'utf8'));
  assert.equal(ledger.files['x.txt'], undefined);
  assert.deepEqual(await readdir(join(root, '.fughetta/state/blobs')), []);
});

for (const type of ['directory', 'symlink']) test(`writeback captures a racing ${type} without trapping later syncs`, { skip: service }, async () => {
  const { syncBuiltinESMExports } = await import('node:module');
  const fs = await import('node:fs');
  const { root, binding } = await checkout(`nonregular-${type}`, { 'x.txt': 'abc' });
  await push(connection, binding, root);
  await elsewhere(binding.project, 'remote-edit', [{ kind: 'edit', path: 'x.txt', offset: 0, count: 1, text: 'A' }]);
  const original = fs.default.promises.rename;
  let injected = false;
  fs.default.promises.rename = async (from, to) => {
    if (!injected && String(from) === join(root, 'x.txt') && String(to).includes('recovered')) {
      injected = true;
      await rm(from);
      if (type === 'directory') { await mkdir(from); await writeFile(join(from, 'local.txt'), 'preserve this'); }
      else await symlink('elsewhere', from);
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  let result;
  try { result = await push(connection, binding, root); }
  finally { fs.default.promises.rename = original; syncBuiltinESMExports(); }
  assert.ok(result.deferred.includes('x.txt'));
  const backup = result.preserved[0];
  assert.ok(type === 'directory' ? (await lstat(backup)).isDirectory() : (await lstat(backup)).isSymbolicLink());
  const later = await push(connection, binding, root);
  assert.ok(later.deferred.includes('x.txt'));
  assert.equal((await files(binding)).get('x.txt').digest, createHash('sha256').update('Abc').digest('hex'));
  if (type === 'directory') assert.equal(await readFile(join(backup, 'local.txt'), 'utf8'), 'preserve this');
  await writeFile(join(root, 'x.txt'), 'aBc');
  await push(connection, binding, root);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'ABc');
});

test('sync removes an orphaned prepared writeback file', { skip: service }, async () => {
  const { root, binding } = await checkout('orphaned-writeback', { 'x.txt': 'abc' });
  await push(connection, binding, root);
  const orphan = join(root, '.fughetta/state/writeback-orphan');
  await writeFile(orphan, 'never installed');
  await push(connection, binding, root);
  await assert.rejects(readFile(orphan), /ENOENT/);
});

test('ignored remote files do not block an explicit worldline fork', { skip: service }, async () => {
  const { root, binding } = await checkout('ignored-fork', { '.gitignore': 'remote-only.txt\n', 'x.txt': 'abc' });
  await push(connection, binding, root);
  await elsewhere(binding.project, 'remote-create', [{ kind: 'create', path: 'remote-only.txt', text: 'ignored' }]);
  const result = await push(connection, binding, root);
  assert.deepEqual(result.deferred, []);
  assert.ok(result.skipped.some(path => path.startsWith('remote-only.txt')));
  assert.equal(JSON.parse(await branches(connection, binding, root, ['fork', 'alternative'])).worldline, 'alternative');
});

test('new remote files honor the local umask', { skip: service }, async () => {
  if (process.platform === 'win32') return;
  const { root, binding } = await checkout('private-umask', { 'x.txt': 'abc' });
  await push(connection, binding, root);
  await elsewhere(binding.project, 'remote-create', [{ kind: 'create', path: 'private.txt', text: 'private' }]);
  const previous = process.umask(0o077);
  try { await push(connection, binding, root); } finally { process.umask(previous); }
  assert.equal((await lstat(join(root, 'private.txt'))).mode & 0o777, 0o600);
});

test('oversized remote path segments are reported without blocking sync', { skip: service }, async () => {
  const { root, binding } = await checkout('long-segment', { 'x.txt': 'abc' });
  await push(connection, binding, root);
  const path = '界'.repeat(86);
  await elsewhere(binding.project, 'remote-long', [{ kind: 'create', path, text: 'remote' }]);
  const result = await push(connection, binding, root);
  assert.ok(result.skipped.some(item => item.startsWith(path)));
  assert.deepEqual(result.deferred, []);
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'abc');
});
