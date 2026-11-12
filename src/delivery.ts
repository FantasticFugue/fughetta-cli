import { mkdir, mkdtemp, writeFile, rm, open, chmod, lstat, utimes } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { object, json, save, locked } from "./files.js";
import { beginDelivery, endDelivery, collectDeliveries, deliveryLock } from "./retention.js";
import { stateDir } from "./checkout/index.js";
import { type Connection, call, responseError } from "./remote.js";

// Property views preserve the existing optional access and parse failures for malformed reports.
type TextContent = Record<string, unknown> & { type: "text"; text: string };
type StructuredReport = Record<string, unknown> & { results: unknown[] };

export function reportSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reportSchema);
    if (!object(value)) return value;
    const out = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, reportSchema(child)]),
    );
    const properties = out.properties as Record<string, { type?: unknown }> | undefined;
    if (properties?.output?.type === "string" && properties?.truncated?.type === "boolean") {
        Object.assign(properties, {
            output_file: {
                type: "string",
                description: "Absolute local path to the captured step output.",
            },
            output_bytes: { type: "integer", minimum: 0 },
            output_shortened: {
                type: "boolean",
                description:
                    "The inline output is shortened; output_file holds the captured log. truncated still reports worker capture truncation.",
            },
        });
    }
    if (properties?.digest && properties?.executable && properties?.size && properties?.name) {
        Object.assign(properties, {
            local_path: {
                type: "string",
                description: "Verified artifact on the local filesystem.",
            },
            delivery_error: { type: "string" },
        });
    }
    return out;
}

function replaceStructured(result: Record<string, unknown>, copied: unknown) {
    const original = result.structuredContent;
    if (Array.isArray(result.content))
        result.content = result.content.map((item: unknown) => {
            const content = item as TextContent | undefined;
            if (content?.type === "text")
                try {
                    if (isDeepStrictEqual(JSON.parse(content.text), original))
                        return { ...content, text: JSON.stringify(copied) };
                } catch {
                    /* Not the structured report. */
                }
            return item;
        });
    result.structuredContent = copied;
}

function portablePath(path: unknown): string {
    if (
        typeof path !== "string" ||
        !path ||
        path
            .split("/")
            .some(
                (part) =>
                    !part ||
                    part === "." ||
                    part === ".." ||
                    Buffer.byteLength(part) > 255 ||
                    /[\\\x00-\x1f\x7f:]/.test(part) ||
                    /[. ]$/.test(part) ||
                    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
            )
    )
        throw new Error("Unsupported export path");
    return path;
}

export async function localExports(
    core: Connection,
    project: string,
    root: string,
    result: Record<string, unknown>,
): Promise<void> {
    if (!object(result?.structuredContent) || !Array.isArray(result.structuredContent.results))
        return;
    const copied = structuredClone(result.structuredContent) as StructuredReport;
    await collectDeliveries(resolve(stateDir(root), "artifacts"));
    let directory: string | undefined;
    for (const [index, value] of copied.results.entries()) {
        const configuration = value as { exports?: unknown; steps?: unknown } | null | undefined;
        let total = 0,
            logged = 0,
            count = 0;
        const files = [
            ...(Array.isArray(configuration?.exports)
                ? configuration.exports.map((file: unknown) => ({ file, step: undefined }))
                : []),
            ...(Array.isArray(configuration?.steps)
                ? configuration.steps
                      .filter((step: unknown): step is Record<string, unknown> =>
                          object((step as { log?: unknown } | undefined)?.log),
                      )
                      .map((step) => ({ file: step.log, step }))
                : []),
        ];
        for (const { file, step } of files) {
            if (!object(file)) continue;
            delete file.local_path;
            if (typeof file.delivery_error === "string" && file.delivery_error) {
                file.delivery_error = file.delivery_error.slice(0, 512);
                continue;
            }
            file.delivery_error = "";
            let target: string | undefined;
            try {
                core.signal?.throwIfAborted();
                if (
                    (!step && ++count > 4096) ||
                    !Number.isSafeInteger(file.size) ||
                    (file.size as number) < 0 ||
                    (file.size as number) > (step ? (64 << 20) - logged : 1073741824 - total) ||
                    typeof file.digest !== "string" ||
                    !/^[a-f0-9]{64}$/.test(file.digest) ||
                    typeof file.executable !== "boolean"
                )
                    throw new Error("Invalid export metadata");
                const metadata = file as Record<string, unknown> & ExportMetadata;
                if (step) logged += metadata.size;
                else total += metadata.size;
                const name = portablePath(file.name),
                    path = portablePath(file.path);
                if (name.includes("/")) throw new Error("Invalid export name");
                const parent = resolve(stateDir(root), "artifacts");
                const key = createHash("sha256")
                    .update(
                        JSON.stringify([
                            core.server,
                            core.workspace,
                            project,
                            name,
                            path,
                            file.digest,
                            file.size,
                            file.executable,
                        ]),
                    )
                    .digest("hex");
                const record = join(parent, "index", key + ".json");
                const reused = await reusableExport(parent, record, metadata, core.signal);
                if (reused) {
                    file.local_path = reused;
                    if (step && !step.log_truncated)
                        Object.assign(step, { output_file: reused, output_bytes: file.size });
                    continue;
                }
                if (!directory) {
                    await mkdir(parent, { recursive: true, mode: 0o700 });
                    directory = await mkdtemp(join(parent, "execution-"));
                    await beginDelivery(directory);
                }
                const destination = join(
                    directory,
                    String(index),
                    step ? "logs" : "exports",
                    name,
                    path,
                );
                await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
                const handle = await open(destination, "wx", 0o600);
                target = destination;
                const hash = createHash("sha256");
                try {
                    let offset = 0;
                    do {
                        core.signal?.throwIfAborted();
                        const length = Math.min(4 << 20, metadata.size - offset);
                        const response = await call(
                            core,
                            "GET",
                            `/api/v1/projects/${encodeURIComponent(project)}/exports/${file.digest}?offset=${offset}&length=${length}`,
                        );
                        if (response.status !== 200) throw responseError(response);
                        const part = JSON.parse(response.body);
                        if (
                            part.digest !== file.digest ||
                            part.total !== file.size ||
                            part.offset !== offset ||
                            typeof part.data_base64 !== "string"
                        )
                            throw new Error("Export chunk does not match the requested file");
                        const bytes = Buffer.from(part.data_base64, "base64");
                        if (
                            bytes.length !== length ||
                            bytes.toString("base64") !== part.data_base64
                        )
                            throw new Error("Invalid export chunk data");
                        hash.update(bytes);
                        await handle.writeFile(bytes);
                        offset += bytes.length;
                    } while (offset < metadata.size);
                    if (hash.digest("hex") !== file.digest)
                        throw new Error("Export digest mismatch");
                } finally {
                    await handle.close();
                }
                if (file.executable && process.platform !== "win32")
                    await chmod(destination, 0o700);
                file.local_path = destination;
                if (step && !step.log_truncated)
                    Object.assign(step, { output_file: destination, output_bytes: file.size });
                // An index failure only prevents reuse; the verified download is still delivered.
                await save(record, {
                    path: relative(parent, destination).split(sep).join("/"),
                }).catch(() => {});
            } catch (error) {
                if (target) await rm(target, { force: true }).catch(() => {});
                file.delivery_error = String(error).slice(0, 256);
            }
        }
    }
    replaceStructured(result, copied);
    if (directory) await endDelivery(directory).catch(() => {});
}

// The caller has checked these metadata fields; the original object retains delivery fields.
interface ExportMetadata {
    size: number;
    digest: string;
    executable: boolean;
}

async function reusableExport(
    parent: string,
    record: string,
    file: ExportMetadata,
    signal?: AbortSignal,
): Promise<string | undefined> {
    return locked(
        deliveryLock(parent),
        async () => {
            try {
                const stored = await json<unknown>(record, undefined);
                const path = portablePath((stored as { path?: unknown } | undefined)?.path);
                if (!path.startsWith("execution-")) return;
                let candidate = parent;
                for (const component of path.split("/")) {
                    candidate = join(candidate, component);
                    if ((await lstat(candidate)).isSymbolicLink()) return;
                }
                const handle = await open(
                    candidate,
                    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
                );
                try {
                    const before = await handle.stat();
                    if (
                        !before.isFile() ||
                        before.size !== file.size ||
                        (process.platform !== "win32" &&
                            Boolean(before.mode & 0o111) !== file.executable)
                    )
                        return;
                    const hash = createHash("sha256"),
                        buffer = Buffer.alloc(64 << 10);
                    let offset = 0;
                    while (offset < file.size) {
                        signal?.throwIfAborted();
                        const { bytesRead } = await handle.read(
                            buffer,
                            0,
                            Math.min(buffer.length, file.size - offset),
                            offset,
                        );
                        if (!bytesRead) return;
                        hash.update(buffer.subarray(0, bytesRead));
                        offset += bytesRead;
                    }
                    const after = await handle.stat();
                    if (
                        after.size !== before.size ||
                        after.mtimeMs !== before.mtimeMs ||
                        hash.digest("hex") !== file.digest
                    )
                        return;
                    const now = new Date();
                    await utimes(join(parent, path.split("/")[0]!), now, now);
                    return candidate;
                } finally {
                    await handle.close();
                }
            } catch {
                signal?.throwIfAborted();
                return;
            }
        },
        signal,
    );
}

// Keep compiler output out of the model's context without discarding the captured log.
export async function localReports(root: string, result: Record<string, unknown>): Promise<void> {
    if (!object(result?.structuredContent) || !Array.isArray(result.structuredContent.results))
        return;
    const original = result.structuredContent;
    const copied = structuredClone(original) as StructuredReport;
    const steps = copied.results.flatMap((configuration: unknown) =>
        object(configuration) && Array.isArray(configuration.steps)
            ? configuration.steps.filter(
                  (step: unknown): step is Record<string, unknown> & { output: string } =>
                      object(step) && typeof step.output === "string",
              )
            : [],
    );
    if (steps.reduce((bytes, step) => bytes + Buffer.byteLength(step.output), 0) <= 8192) return;
    const duplicates = new Set<number>();
    if (Array.isArray(result.content))
        result.content.forEach((item: unknown, index: number) => {
            const content = item as TextContent | undefined;
            if (content?.type !== "text") return;
            try {
                if (isDeepStrictEqual(JSON.parse(content.text), original)) duplicates.add(index);
            } catch {
                /* Not the structured report. */
            }
        });
    let directory: string | undefined;
    try {
        const parent = resolve(stateDir(root), "reports");
        await collectDeliveries(parent);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(join(parent, "execution-"));
        await beginDelivery(directory);
        let remaining = 4096;
        for (const [index, step] of [...steps.entries()].reverse()) {
            if (!step.output) continue;
            const completeLog = step.output_file && !step.log_truncated;
            const file = completeLog
                ? (step.output_file as string)
                : join(directory, `step-${index + 1}.log`);
            if (!completeLog) await writeFile(file, step.output, { mode: 0o600, flag: "wx" });
            const length = Math.min(remaining, 512, step.output.length);
            remaining -= length;
            const output = length ? step.output.slice(-length) : "";
            Object.assign(step, {
                output,
                output_file: file,
                output_bytes: completeLog ? step.output_bytes : Buffer.byteLength(step.output),
                output_shortened: output.length < step.output.length,
            });
        }
        result.structuredContent = copied;
        if (Array.isArray(result.content))
            result.content = result.content.map((item: unknown, index: number) =>
                duplicates.has(index)
                    ? { ...(item as TextContent), text: JSON.stringify(copied) }
                    : item,
            );
    } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        // A local disk failure must not turn a completed remote operation into a failed call.
        result.content = [
            ...(Array.isArray(result.content) ? result.content : []),
            { type: "text", text: JSON.stringify({ delivery_error: String(error).slice(0, 256) }) },
        ];
    } finally {
        if (directory) await endDelivery(directory).catch(() => {});
    }
}
