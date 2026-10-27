// Starts a real fughetta-service core for a test, with managed workers off and one owner token.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const binary = process.env.FUGHETTA_SERVICE ?? resolve(import.meta.dirname, '../../fughetta-service/build/debug/fughetta-service');

export async function port() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

export async function scratch(name) {
  return mkdtemp(join(tmpdir(), `fug-${name}-`));
}

// { origin, token, dir, stop() }: `dir` is a scratch directory the core keeps its state in; stop() also removes it.
export async function start(name) {
  const dir = await scratch(name);
  const http = await port();
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({
    runtime: { threads: 6, jobs: 1, workers: 0 },
    server: { http_bind: '127.0.0.1', http_port: http, worker_port: await port(), source: `127.0.0.1:${await port()}`,
      storage: join(dir, 'state'), auth: { mode: 'token', tokens: [] } },
    projects: {},
  }));
  const token = execFileSync(binary, ['token', 'tester', 'owner', config], { cwd: dir, encoding: 'utf8' }).trim().split(/\s+/).pop();
  const child = spawn(binary, [config], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = new Promise(done => child.once('exit', code => done(code)));
  const origin = `http://127.0.0.1:${http}`;
  for (let i = 0; ; ++i) {
    if (child.exitCode !== null) throw new Error(`fughetta-service exited with ${child.exitCode}`);
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {}
    if (i > 300) throw new Error('fughetta-service did not become ready');
    await delay(100);
  }
  return {
    origin, token, dir,
    async stop() {
      child.kill('SIGTERM');
      const code = await exited;
      await rm(dir, { recursive: true, force: true });
      return code;
    },
  };
}
