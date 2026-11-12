import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Binding } from "./checkout/index.js";
import { Refused, type Connection } from "./remote.js";
import { worldline } from "./worldline.js";

export interface NamedReference {
    name: string;
    kind: "tag" | "channel";
    worldline: string;
    version: string;
    actor: string;
    intent: string;
    operation_id: string;
    receipt: string;
    previous: string;
    sequence: number;
    created_at: number;
    attestations: { kind: string; receipt: string; conclusion: string }[];
}
export interface SourceFile {
    path: string;
    digest: string;
    size: number;
    executable: boolean;
}
export interface Snapshot {
    version: string;
    files: SourceFile[];
    conflicts?: string[];
    truncated?: boolean;
}
export async function references(core: Connection, binding: Binding): Promise<NamedReference[]> {
    const all: NamedReference[] = [];
    let after = 0;
    for (;;) {
        const page = (await worldline(core, binding, "references", { after })) as {
            references: NamedReference[];
            truncated: boolean;
        };
        all.push(...page.references);
        if (!page.truncated) return all;
        const next = page.references.at(-1)?.sequence;
        if (!next || next <= after) throw new Error("Reference pagination did not advance");
        after = next;
    }
}
export async function snapshot(
    core: Connection,
    binding: Binding,
    version?: string,
): Promise<Snapshot> {
    const tree = (await worldline(core, binding, "inspect", { version })) as Snapshot;
    if (tree.truncated || tree.conflicts?.length)
        throw new Refused(
            "source_conflict",
            "Checkout needs a complete source manifest with resolved conflicts",
        );
    return tree;
}
export function sourcePath(path: string): string {
    if (
        !path ||
        path
            .split("/")
            .some(
                (p) =>
                    !p ||
                    p === "." ||
                    p === ".." ||
                    /[\\\0\r\n]/.test(p) ||
                    p.toLowerCase() === ".git",
            )
    )
        throw new Refused("invalid_path", `Cannot check out source path: ${path}`);
    return path;
}
export async function sourceBytes(
    core: Connection,
    binding: Binding,
    version: string,
    file: SourceFile,
): Promise<Buffer> {
    const read = (await worldline(core, binding, "read", { version, path: file.path })) as {
        version: string;
        data_base64: string;
        truncated?: boolean;
    };
    if (read.truncated || read.version !== version)
        throw new Error(`Incomplete source file: ${file.path}`);
    return Buffer.from(read.data_base64, "base64");
}
export async function checkoutSnapshot(
    core: Connection,
    binding: Binding,
    target: string,
    version: string,
) {
    const selected = await snapshot(core, binding, version);
    await mkdir(target);
    try {
        for (const file of selected.files) {
            const path = sourcePath(file.path);
            if (path === ".fughetta" || path.startsWith(".fughetta/"))
                throw new Refused("invalid_path", "Source uses the checkout metadata directory");
            const destination = join(target, path);
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, await sourceBytes(core, binding, selected.version, file), {
                flag: "wx",
                mode: file.executable ? 0o755 : 0o644,
            });
        }
        return selected.version;
    } catch (error) {
        await rm(target, { recursive: true, force: true });
        throw error;
    }
}
