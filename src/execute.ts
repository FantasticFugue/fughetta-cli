// `fug build`, `fug test`, `fug run` and `fug language`: sync the checkout, call
// the tool on the core with a progress token and print each stage as it arrives.
import { randomUUID } from "node:crypto";
import { type Connection, call, rpc, rpcError, Refused } from "./remote.js";
import { type Binding, push } from "./checkout/index.js";
import { localExports, localReports } from "./delivery.js";
import { object } from "./files.js";
import { report } from "./proxy.js";

export interface Outcome {
    result: Record<string, unknown>;
    ok: boolean;
    cancelled?: boolean;
}

export async function execute(
    core: Connection,
    binding: Binding,
    root: string,
    tool: string,
    args: Record<string, unknown>,
    note: (line: string) => void,
    sync: typeof push = push,
): Promise<Outcome> {
    const sent = await sync(core, binding, root);
    report(sent, note);
    const id = `fug-${randomUUID()}`,
        progressToken = randomUUID();
    const controller = new AbortController();
    let interrupted = false;
    const interrupt = () => {
        interrupted = true;
        controller.abort();
        void call(
            core,
            "POST",
            "/mcp",
            { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } },
            3_000,
        ).catch(() => {});
    };
    process.once("SIGINT", interrupt);
    let stage = "";
    try {
        const reply = await rpc(
            { ...core, signal: controller.signal },
            "/mcp",
            {
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: {
                    name: tool,
                    _meta: {
                        progressToken,
                        "fughetta/client_sync_seconds": sent.client_sync_seconds,
                    },
                    arguments: {
                        ...args,
                        project: binding.project,
                        worldline: binding.worldline,
                        version: sent.version,
                    },
                },
            },
            600_000,
            (value) => {
                if (
                    !object(value) ||
                    !object(value.params) ||
                    value.params.progressToken !== progressToken
                )
                    return;
                const message = value.params.message;
                if (typeof message === "string" && message && message !== stage) {
                    stage = message;
                    note(`${tool}: ${message}`);
                }
            },
        );
        if (!object(reply))
            throw new Refused("invalid_response", "The core sent an invalid MCP reply");
        if (reply.error) throw rpcError(reply.error);
        if (!object(reply.result))
            throw new Refused("invalid_response", "The core sent no MCP result");
        if (
            reply.result.isError &&
            object(reply.result.structuredContent) &&
            typeof reply.result.structuredContent.code === "string"
        )
            throw new Refused(
                reply.result.structuredContent.code,
                String(reply.result.structuredContent.message ?? "The tool refused the call"),
            );
        if (["build", "test", "run"].includes(tool)) {
            await localExports(
                { ...core, signal: controller.signal },
                binding.project,
                root,
                reply.result,
            );
            await localReports(root, reply.result);
        }
        const structured = object(reply.result.structuredContent)
            ? reply.result.structuredContent
            : undefined;
        const ok =
            typeof structured?.ok === "boolean"
                ? structured.ok && reply.result.isError !== true
                : reply.result.isError !== true;
        return { result: reply.result, ok };
    } catch (error) {
        if (interrupted) return { result: {}, ok: false, cancelled: true };
        throw error;
    } finally {
        process.off("SIGINT", interrupt);
    }
}

function formatTimings(value: unknown): string {
    if (!object(value)) return "";
    const stages = [
        ["client_sync_seconds", "local sync"],
        ["sync_seconds", "worker sync"],
        ["queue_seconds", "queue"],
        ["dependency_seconds", "dependencies"],
        ["worker_seconds", "worker total"],
        ["preparation_seconds", "environment preparation"],
        ["execution_seconds", "commands and analysis"],
    ];
    return stages
        .filter(([key]) => typeof value[key!] === "number")
        .map(([key, label]) => `${label} ${(value[key!] as number).toFixed(2)}s`)
        .join(", ");
}

// One summary line per configuration, then the diagnostics and failing steps a human debugs with.
export function format(tool: string, result: Record<string, unknown>): string[] {
    const lines: string[] = [];
    const structured = object(result.structuredContent) ? result.structuredContent : undefined;
    if (!structured || !Array.isArray(structured.results)) {
        if (Array.isArray(result.content))
            for (const item of result.content)
                if (object(item) && item.type === "text" && typeof item.text === "string")
                    lines.push(item.text);
        return lines.length ? lines : [JSON.stringify(result.structuredContent ?? null)];
    }
    for (const item of structured.results) {
        if (!object(item)) continue;
        const seconds = typeof item.seconds === "number" ? ` in ${item.seconds.toFixed(1)}s` : "";
        lines.push(
            `${item.ok === true ? "ok" : "FAILED"}  ${String(item.configuration ?? "?")}${seconds}${item.worker ? ` on ${item.worker}` : ""}`,
        );
        const stages = formatTimings(item.timings);
        if (stages) lines.push(`  ${stages}`);
        if (typeof item.error === "string" && item.error) lines.push(`  ${item.error}`);
        if (object(item.tests) && typeof item.tests.total === "number") {
            lines.push(`  tests: ${item.tests.total} total, ${item.tests.failed} failed`);
            for (const name of Array.isArray(item.tests.failed_tests)
                ? item.tests.failed_tests.slice(0, 10)
                : [])
                lines.push(`    FAILED ${String(name)}`);
        }
        if (Array.isArray(item.diagnostics))
            for (const diagnostic of item.diagnostics.slice(0, 20)) {
                if (!object(diagnostic)) continue;
                const at = [diagnostic.file, diagnostic.line, diagnostic.column]
                    .filter(
                        (v) =>
                            (typeof v === "string" && v !== "") || (typeof v === "number" && v > 0),
                    )
                    .join(":");
                lines.push(
                    `  ${at ? `${at}: ` : ""}${diagnostic.severity ? `${diagnostic.severity}: ` : ""}${String(diagnostic.message ?? "")}`,
                );
            }
        if (Array.isArray(item.steps))
            for (const step of item.steps) {
                if (!object(step) || step.exit_code === 0) continue;
                const where =
                    typeof step.output_file === "string" && step.output_file
                        ? ` (full output: ${step.output_file})`
                        : "";
                lines.push(
                    `  step ${String(step.name ?? "?")} exited with ${String(step.exit_code)}${where}`,
                );
                if (typeof step.output === "string" && step.output.trim())
                    lines.push(
                        ...step.output
                            .trimEnd()
                            .split("\n")
                            .map((line) => `    ${line}`),
                    );
            }
        if (Array.isArray(item.exports))
            for (const file of item.exports) {
                if (!object(file)) continue;
                if (typeof file.local_path === "string" && file.local_path)
                    lines.push(`  exported ${String(file.name ?? "?")}: ${file.local_path}`);
                else if (typeof file.delivery_error === "string" && file.delivery_error)
                    lines.push(
                        `  export ${String(file.name ?? "?")} failed: ${file.delivery_error}`,
                    );
            }
    }
    const total = structured.results.length,
        ok = structured.results.filter((item) => object(item) && item.ok === true).length;
    lines.push(
        `${tool} ${structured.ok === true ? "succeeded" : "failed"}: ${ok}/${total} configuration${total === 1 ? "" : "s"}`,
    );
    return lines;
}

export const languageActions = ["scopes", "symbols", "definitions", "references", "diagnostics"];

// The language query shapes come from the core's semantic model: spans are paths
// with scalar offsets, locations are one-based lines and scalar columns.
export function formatLanguage(result: Record<string, unknown>): string[] {
    const lines: string[] = [];
    const structured = object(result.structuredContent) ? result.structuredContent : undefined;
    if (!structured) {
        if (Array.isArray(result.content))
            for (const item of result.content)
                if (object(item) && item.type === "text" && typeof item.text === "string")
                    lines.push(item.text);
        return lines.length ? lines : [JSON.stringify(result.structuredContent ?? null)];
    }
    lines.push(
        `${String(structured.configuration ?? "?")} on ${String(structured.worldline ?? "?")} at ${String(structured.version ?? "?")}` +
            `${structured.stale === true ? " (stale analysis)" : ""}`,
    );
    const stages = formatTimings(structured.timings);
    if (stages) lines.push(stages);
    const place = (span: unknown): string => {
        const at = object(span) && object(span.place) ? span.place : undefined;
        return at ? `${String(at.path)} +${String(at.begin ?? 0)}` : "";
    };
    if (Array.isArray(structured.diagnostics))
        for (const item of structured.diagnostics) {
            if (!object(item)) continue;
            const at = place(item.range);
            lines.push(
                `${at ? `${at}: ` : ""}${item.severity ? `${item.severity}: ` : ""}${String(item.message ?? "")}`,
            );
        }
    if (Array.isArray(structured.symbols))
        for (const item of structured.symbols) {
            if (!object(item)) continue;
            lines.push(`${String(item.name ?? "?")} (${String(item.kind ?? "other")})`);
            for (const key of ["definitions", "declarations"] as const) {
                const spans = Array.isArray(item[key]) ? item[key] : [];
                for (const span of spans) {
                    const at = place(span);
                    if (at)
                        lines.push(`  ${key === "definitions" ? "defined" : "declared"} at ${at}`);
                }
            }
        }
    if (Array.isArray(structured.scopes))
        for (const item of structured.scopes) {
            if (!object(item)) continue;
            const at = place(item.range);
            lines.push(
                `${String(item.id ?? "?")}  ${String(item.kind ?? "other")} ${String(item.symbol ?? "")}` +
                    `${item.reference ? ` (${item.reference})` : ""}${at ? `  ${at}` : ""}`,
            );
        }
    for (const key of ["definitions", "references"] as const)
        if (Array.isArray(structured[key]))
            for (const item of structured[key] as unknown[]) {
                if (!object(item)) continue;
                lines.push(
                    `${String(item.path ?? "?")}:${String(item.line ?? 0)}:${String(item.column ?? 0)}${item.symbol ? `  ${item.symbol}` : ""}`,
                );
            }
    return lines;
}
