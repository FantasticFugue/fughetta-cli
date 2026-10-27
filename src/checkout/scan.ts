// The files of a checkout that are sent, with their digests. Hashes of files unchanged since the last scan come from an index in
// `.fughetta/state/index.json`, keyed by modification time, change time, inode and size.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json, save } from '../files.js';
import { stateDir } from './binding.js';
import { Rules } from './ignore.js';

export interface File {
  digest: string;
  size: number;
  text: boolean;
  // Unknown where the file system has no executable flag (Windows); the remote flag is kept then.
  executable?: boolean;
}

export interface Snapshot {
  files: Map<string, File>;
  // Paths that exist but are not sent, each with the reason.
  skipped: Map<string, string>;
}

// The core's rule: no NUL byte and well-formed UTF-8 sequences.
export function textual(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; ) {
    const c = bytes[i]!;
    if (c === 0) return false;
    const n = c < 0x80 ? 1 : c >> 5 === 6 ? 2 : c >> 4 === 14 ? 3 : c >> 3 === 30 ? 4 : 0;
    if (!n || i + n > bytes.length) return false;
    for (let k = 1; k < n; ++k) if (bytes[i + k]! >> 6 !== 2) return false;
    i += n;
  }
  return true;
}

export const digestOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Why the core refuses a path, or undefined when it accepts it.
function refusal(path: string): string | undefined {
  if (path.includes('\\')) return 'a name with a backslash';
  if (path.includes('�')) return 'a name that is not UTF-8';
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'a name with a control character';
  return undefined;
}

interface Indexed {
  stamp: string;
  file: File;
}

export async function scan(root: string, limit: number): Promise<Snapshot> {
  const indexFile = join(stateDir(root), 'index.json');
  const index = await json<Record<string, Indexed>>(indexFile, {});
  const next: Record<string, Indexed> = {};
  const out: Snapshot = { files: new Map(), skipped: new Map() };
  const now = BigInt(Date.now()) * 1_000_000n;
  const posix = process.platform !== 'win32';

  const walk = async (dir: string, relative: string, parent: Rules): Promise<void> => {
    const rules = await parent.enter(dir, relative);
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      const full = join(dir, name);
      const status = await lstat(full, { bigint: true });
      const directory = status.isDirectory();
      if (rules.ignored(path, directory)) continue;
      const refused = refusal(path);
      if (refused) {
        out.skipped.set(path, refused);
        continue;
      }
      if (directory) {
        await walk(full, path, rules);
        continue;
      }
      if (!status.isFile()) {
        out.skipped.set(path, status.isSymbolicLink() ? 'a link' : 'not a regular file');
        continue;
      }
      if (status.size > BigInt(limit)) {
        out.skipped.set(path, `${status.size} bytes, over the ${limit} byte limit`);
        continue;
      }
      const stamp = `${status.mtimeNs}:${status.ctimeNs}:${status.ino}:${status.size}`;
      const known = index[path];
      let file: File;
      if (known?.stamp === stamp) file = { ...known.file };
      else {
        const bytes = await readFile(full);
        file = { digest: digestOf(bytes), size: bytes.length, text: textual(bytes) };
      }
      if (posix) file.executable = (Number(status.mode) & 0o100) !== 0;
      out.files.set(path, file);
      // A file written in the last two seconds may change again within the clock's resolution; it is hashed again next time.
      if (now - status.mtimeNs > 2_000_000_000n && now - status.ctimeNs > 2_000_000_000n) next[path] = { stamp, file };
    }
  };
  await walk(root, '', Rules.root());
  await save(indexFile, next, 0o644);
  return out;
}
