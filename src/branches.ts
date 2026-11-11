import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { json, locked, save } from './files.js';
import { push, save as bind, stateDir, type Binding } from './checkout/index.js';
import type { Connection } from './remote.js';
import { worldline } from './worldline.js';

interface Selection { from: string; version?: string; observed?: string; operation_id?: string; intent?: string }
interface Promotion { input: Selection; version: string; observed: string }

function selection(args: string[]): Selection {
  const [from, ...rest] = args;
  if (!from) throw new Error('Supply the source worldline');
  const result: Selection = { from };
  const keys = { '--version': 'version', '--observed': 'observed', '--operation-id': 'operation_id', '--intent': 'intent' } as const;
  for (let at = 0; at < rest.length; at += 2) {
    const flag = rest[at]!;
    if (!Object.hasOwn(keys, flag)) throw new Error(`Unknown worldline option: ${flag}`);
    const key = keys[flag as keyof typeof keys], value = rest[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (result[key] !== undefined) throw new Error(`${flag} was supplied twice`);
    result[key] = value;
  }
  return { from, version: result.version, observed: result.observed, operation_id: result.operation_id, intent: result.intent };
}

interface Fork { binding: Binding; name: string; version: string; operation_id: string }
export async function branches(core: Connection, binding: Binding, root: string, args: string[]): Promise<string> {
  const [action, name, destination] = args;
  if (action === 'list' && args.length === 1)
    return JSON.stringify(await worldline(core, binding, 'list'), null, 2);
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('Supply a worldline name of 1 through 64 letters, digits, dots, underscores or hyphens');
  if (action === 'diff' || action === 'promote') {
    const input = selection(args.slice(1));
    if (action === 'diff') {
      if (input.operation_id || input.intent) throw new Error('diff accepts only --version and --observed');
      return JSON.stringify(await worldline(core, binding, 'diff', { ...input }), null, 2);
    }
    if (!input.operation_id) throw new Error('promote needs --operation-id so an interrupted publication can be recovered');
    const key = createHash('sha256').update(JSON.stringify([binding, input.operation_id])).digest('hex');
    const file = join(stateDir(root), 'promotions', `${key}.json`);
    return locked(file, async () => {
      let draft = await json<Promotion | undefined>(file, undefined);
      if (draft && JSON.stringify(draft.input) !== JSON.stringify(input))
        throw new Error('This promote operation ID was already used with different arguments');
      if (!draft) {
        const source = await worldline(core, { ...binding, worldline: input.from }, 'inspect', { version: input.version }) as { version: string };
        const target = await worldline(core, binding, 'inspect', { version: input.observed }) as { version: string };
        draft = { input, version: source.version, observed: target.version };
        await save(file, draft);
      }
      return JSON.stringify(await worldline(core, binding, 'promote', { ...draft.input, version: draft.version, observed: draft.observed }), null, 2);
    }, core.signal);
  }
  if (action === 'fork' && args.length === 2) {
    const key = createHash('sha256').update(JSON.stringify([binding, name])).digest('hex');
    const file = join(stateDir(root), 'forks', `${key}.json`);
    return locked(file, async () => {
      let draft = await json<Fork | undefined>(file, undefined);
      if (!draft) {
        const synced = await push(core, binding, root);
        if (synced.deferred?.length) throw new Error('Files changed during synchronization; synchronize those edits before forking');
        draft = { binding, name, version: synced.version, operation_id: `fug-fork-${randomUUID()}` };
        await save(file, draft);
      }
      const result = await worldline(core, binding, 'fork', {
        name: draft.name, from: binding.worldline, version: draft.version,
        operation_id: draft.operation_id, intent: `Fork ${binding.worldline} as ${name}`,
      });
      return JSON.stringify(result, null, 2);
    }, core.signal);
  }
  if (action === 'checkout' && args.length === 3 && destination) {
    const target = resolve(destination), inside = relative(root, target);
    if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)))
      throw new Error('Choose a directory outside the current checkout');
    const next = { ...binding, worldline: name };
    await worldline(core, next, 'inspect');
    // A new directory keeps existing working copies and their pending operations intact.
    await mkdir(target);
    await bind(target, next);
    const result = await push(core, next, target);
    return JSON.stringify({ directory: target, worldline: name, ...result }, null, 2);
  }
  throw new Error('Usage: fug worldline list | fork NAME | checkout NAME NEW_DIRECTORY | diff SOURCE [--version VERSION] [--observed VERSION] | promote SOURCE --operation-id ID [--version VERSION] [--observed VERSION] [--intent TEXT]');
}
