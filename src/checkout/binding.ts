// The project a directory is bound to: `.fughetta/project.json`, committed with the code. `.fughetta/state/` is local.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { json } from '../files.js';

export interface Binding {
  server: string;
  workspace: string;
  project: string;
  worldline: string;
}

export const stateDir = (root: string) => join(root, '.fughetta', 'state');

// The nearest directory at or above `start` that holds a binding.
export function find(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.fughetta', 'project.json'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

export async function load(root: string): Promise<Binding> {
  const value = await json<Partial<Binding> | undefined>(join(root, '.fughetta', 'project.json'), undefined);
  if (!value?.server || !value.project) throw new Error(`${join(root, '.fughetta', 'project.json')} names no server and project`);
  return { server: value.server, workspace: value.workspace ?? '', project: value.project, worldline: value.worldline || 'main' };
}

export async function save(root: string, binding: Binding): Promise<void> {
  await mkdir(join(root, '.fughetta'), { recursive: true });
  await writeFile(join(root, '.fughetta', 'project.json'), JSON.stringify(binding, null, 2) + '\n');
  await writeFile(join(root, '.fughetta', '.gitignore'), 'state/\n');
}
