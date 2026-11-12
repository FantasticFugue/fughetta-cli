// Local inspection of `.fughetta/state/`: files set aside by synchronization,
// cache sizes for `fug status` and the `fug clean` sweep.
import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { stateDir } from "./checkout/index.js";
import { json } from "./files.js";
import { collectDeliveries } from "./retention.js";

export interface PendingRecovery {
    kind: "recovered" | "collisions" | "conflicts";
    path?: string;
    version?: string;
    file: string;
    guidance: string;
}

const guidance: Record<PendingRecovery["kind"], string> = {
    recovered:
        "A local edit was set aside during an interrupted sync. Compare it with the checkout copy, merge any changes back by hand and run fug push.",
    collisions:
        "The worldline changed this path at this version; this copy holds the worldline content. Merge it into the checkout by hand and run fug push.",
    conflicts:
        "The checkout holds the merged worldline content; this copy keeps your displaced local version. Merge any changes back by hand and run fug push.",
};

export async function pendingRecovery(root: string): Promise<PendingRecovery[]> {
    const state = stateDir(root);
    const out: PendingRecovery[] = [];
    const names = (dir: string) =>
        readdir(dir).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
            throw error;
        });
    for (const name of (await names(join(state, "recovered"))).sort()) {
        if (!name.endsWith(".file")) continue;
        const record = await json<{ path?: unknown } | undefined>(
            join(state, "recovered", `${name}.json`),
            undefined,
        );
        out.push({
            kind: "recovered",
            ...(typeof record?.path === "string" ? { path: record.path } : {}),
            file: join(state, "recovered", name),
            guidance: guidance.recovered,
        });
    }
    for (const kind of ["collisions", "conflicts"] as const) {
        for (const version of (await names(join(state, kind))).sort()) {
            const base = join(state, kind, version);
            if (!(await lstat(base)).isDirectory()) continue;
            for (const file of await walk(base))
                out.push({
                    kind,
                    path: relative(base, file).split(sep).join("/"),
                    version,
                    file,
                    guidance: guidance[kind],
                });
        }
    }
    return out;
}

async function walk(directory: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(path)));
        else if (entry.isFile()) out.push(path);
    }
    return out.sort();
}

async function bytes(path: string): Promise<number> {
    const status = await lstat(path);
    if (status.isFile()) return status.size;
    if (!status.isDirectory()) return 0;
    let total = 0;
    for (const entry of await readdir(path)) total += await bytes(join(path, entry));
    return total;
}

export interface StateUsage {
    blobs: number;
    reports: number;
    artifacts: number;
    other: number;
    total: number;
}

export async function stateUsage(root: string): Promise<StateUsage> {
    const state = stateDir(root);
    const usage: StateUsage = { blobs: 0, reports: 0, artifacts: 0, other: 0, total: 0 };
    for (const entry of await readdir(state).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
        throw error;
    })) {
        const size = await bytes(join(state, entry)).catch(() => 0);
        if (entry === "blobs" || entry === "reports" || entry === "artifacts") usage[entry] = size;
        else usage.other += size;
        usage.total += size;
    }
    return usage;
}

export interface Cleaned {
    freed: number;
    reports: number;
    artifacts: number;
}

// Removes every delivered log and artifact not touched in the last ten minutes;
// active deliveries and recent ones stay.
export async function clean(root: string): Promise<Cleaned> {
    const state = stateDir(root);
    const before = await stateUsage(root);
    for (const name of ["reports", "artifacts"] as const)
        await collectDeliveries(join(state, name), { force: true, retention: 0, budget: 0 });
    const after = await stateUsage(root);
    return {
        freed: before.reports + before.artifacts - after.reports - after.artifacts,
        reports: after.reports,
        artifacts: after.artifacts,
    };
}
