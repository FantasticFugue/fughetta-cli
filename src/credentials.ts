import { join } from 'node:path';
import { json, locked, save } from './files.js';

export function credentialFile(): string {
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) throw new Error('APPDATA is not set');
    return join(process.env.APPDATA, 'Fughetta', 'credentials.json');
  }
  const base = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, '.config') : '');
  if (!base) throw new Error('HOME is not set');
  return join(base, 'fughetta', 'credentials.json');
}
interface Credentials { servers: Record<string, { token: string }> }
export async function tokenFor(server: string, given = ''): Promise<string> {
  if (given || process.env.FUGHETTA_TOKEN) return given || process.env.FUGHETTA_TOKEN!;
  return (await json<Credentials>(credentialFile(), { servers: {} })).servers[server]?.token ?? '';
}
export async function saveToken(server: string, token: string): Promise<void> {
  const file = credentialFile();
  await locked(file + '.lock', async () => {
    const credentials = await json<Credentials>(file, { servers: {} });
    credentials.servers[server] = { token };
    await save(file, credentials);
  });
}
