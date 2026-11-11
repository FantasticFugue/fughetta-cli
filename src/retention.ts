import { readdir, lstat, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { locked } from './files.js';

const day = 86400000;
export const deliveryLock = (parent: string) => join(parent, 'retention');

export async function beginDelivery(directory: string): Promise<void> {
  await writeFile(join(directory, '.active'), String(process.pid), { mode: 0o600, flag: 'wx' });
}
export async function endDelivery(directory: string): Promise<void> {
  await rm(join(directory, '.active'), { force: true });
  const now = new Date();
  await utimes(directory, now, now);
}

// These directories hold temporary deliveries; durable user copies belong outside them.
export async function collectDeliveries(parent: string, options: { now?: number; budget?: number; retention?: number; force?: boolean } = {}): Promise<void> {
  try {
    if (!(await lstat(parent)).isDirectory()) return;
    await locked(deliveryLock(parent), async () => {
      const now = options.now ?? Date.now();
      const marker = join(parent, '.collected');
      if (!options.force) {
        try { if (now - (await lstat(marker)).mtimeMs < 60000) return; } catch { /* First collection. */ }
      }
      const entries: { path: string; used: number; size: number }[] = [];
      let total = 0;
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('execution-')) continue;
        const path = join(parent, entry.name);
        try {
          const tree = await measure(path);
          total += tree.size;
          if (!await active(path)) entries.push({ path, ...tree });
        } catch { /* Keep directories that cannot be inspected. */ }
      }
      entries.sort((a, b) => a.used - b.used);
      let remaining = entries.length;
      for (const entry of entries) {
        if (now - entry.used < 600000) continue;
        if (now - entry.used < (options.retention ?? 7 * day) && total <= (options.budget ?? 20 * 2 ** 30) && remaining <= 256) continue;
        try {
          if (await active(entry.path)) continue;
          await rm(entry.path, { recursive: true, force: true });
          total -= entry.size;
          remaining--;
        } catch { /* Retry on a later call. */ }
      }
      const index = join(parent, 'index');
      for (const entry of await readdir(index, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const record = join(index, entry.name);
        try {
          const value = JSON.parse(await readFile(record, 'utf8'));
          const parts = typeof value?.path === 'string' ? value.path.split('/') : [];
          if (!parts[0]?.startsWith('execution-') || parts.some((part: string) => !part || part === '.' || part === '..' || /[\\:]/.test(part))) {
            await rm(record, { force: true }); continue;
          }
          try { await lstat(join(parent, ...parts)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await rm(record, { force: true }); }
        } catch { /* A concurrent index writer or unreadable record can wait. */ }
      }
      await writeFile(marker, '', { mode: 0o600 });
    });
  } catch { /* Maintenance must not replace a completed execution result. */ }
}

async function active(path: string): Promise<boolean> {
  try {
    const pid = Number(await readFile(join(path, '.active'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

async function measure(path: string): Promise<{ used: number; size: number }> {
  const status = await lstat(path);
  let used = status.mtimeMs, size = status.isFile() ? status.size : 0;
  if (status.isDirectory()) for (const entry of await readdir(path)) {
    const child = await measure(join(path, entry));
    used = Math.max(used, child.used);
    size += child.size;
  }
  return { used, size };
}
