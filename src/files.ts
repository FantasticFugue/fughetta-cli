import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function json<T>(path: string, empty: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty; throw error; }
}

export async function save(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

// Runs `work` while this process holds the lock named by `path`. The lock is a listening local socket, so the operating system
// releases it when the holder ends, however it ends.
export async function locked<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = createHash('sha256').update(resolve(path)).digest('hex').slice(0, 32);
  const address = process.platform === 'win32' ? `\\\\?\\pipe\\fughetta-${key}`
    : process.platform === 'linux' ? `\0fughetta-${key}` : join(tmpdir(), `fughetta-${key}.sock`);
  const server = createServer();
  const end = Date.now() + 60_000;
  for (;;) {
    const error = await new Promise<NodeJS.ErrnoException | undefined>(done => {
      server.once('error', done);
      server.listen(address, () => { server.off('error', done); done(undefined); });
    });
    if (!error) break;
    if (error.code !== 'EADDRINUSE') throw error;
    // A socket file outlives a holder that ended; nothing answers on it then.
    if (address.startsWith('/') && !(await answers(address))) { await rm(address, { force: true }); continue; }
    if (Date.now() >= end) throw new Error(`another fug process holds ${path}`);
    await delay(100);
  }
  server.unref();
  try { return await work(); } finally { await new Promise(done => server.close(done)); }
}

const answers = (address: string) => new Promise<boolean>(done => {
  const socket = connect(address, () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});

export function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
