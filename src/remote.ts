import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { object } from "./files.js";

export function origin(input: string): string {
    const url = new URL(input);
    if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
    )
        throw new Error("The server URL must name an HTTP or HTTPS origin");
    return url.origin;
}

export interface Connection {
    server: string;
    workspace: string;
    token: string;
    signal?: AbortSignal;
}
export class Refused extends Error {
    constructor(
        public code: string,
        message: string,
    ) {
        super(message);
    }
}

// Refusals keep their supplied code; runtime failures map errno and syntax errors to the same CLI categories as their message.
export function failure(error: unknown): { code: string; message: string } {
    if (error instanceof Refused) return { code: error.code, message: error.message };
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const codes: Record<string, string> = {
        ENOENT: "missing_objects",
        ENOTDIR: "missing_objects",
        EACCES: "permission_denied",
        EPERM: "permission_denied",
        ECONNREFUSED: "connection_failed",
        ECONNRESET: "connection_failed",
        ENOTFOUND: "connection_failed",
        EAI_AGAIN: "connection_failed",
        EPIPE: "connection_failed",
        ETIMEDOUT: "timeout",
        ABORT_ERR: "cancelled",
    };
    return {
        code:
            codes[code ?? ""] ?? (error instanceof SyntaxError ? "invalid_data" : "internal_error"),
        message,
    };
}

export function responseError(reply: { status: number; body: string }): Refused {
    let code = `http_${reply.status}`;
    try {
        const value: unknown = JSON.parse(reply.body);
        if (object(value) && typeof value.code === "string") code = value.code;
    } catch {
        /* A non-JSON HTTP error still has its status code. */
    }
    return new Refused(code, reason(reply));
}

export function rpcError(value: unknown): Refused {
    const e = object(value) ? value : {};
    const data = object(e.data) ? e.data : {};
    const codes: Record<string, string> = {
        "-32700": "invalid_data",
        "-32600": "invalid_request",
        "-32601": "method_not_found",
        "-32602": "invalid_params",
        "-32603": "internal_error",
        "-32800": "cancelled",
    };
    const code =
        typeof data.code === "string"
            ? data.code
            : typeof e.code === "string"
              ? e.code
              : (codes[String(e.code)] ?? "rpc_error");
    return new Refused(
        code,
        typeof e.message === "string" ? e.message : "The core returned an MCP error",
    );
}

interface ExchangeOptions {
    signal?: AbortSignal;
    notification?: (value: unknown) => void;
    requestId?: unknown;
}

export async function exchange(
    url: string,
    method = "GET",
    body?: string,
    headers: Record<string, string> = {},
    timeout = 600_000,
    options: ExchangeOptions = {},
): Promise<{ status: number; body: string }> {
    options.signal?.throwIfAborted();
    const ca = process.env.FUGHETTA_CA_FILE
        ? await readFile(process.env.FUGHETTA_CA_FILE)
        : undefined;
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: { status: number; body: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(value!);
        };
        const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(
            url,
            {
                method,
                headers: { accept: "application/json", ...headers },
                ca,
            },
            (res) => {
                const streaming =
                    res.statusCode === 200 &&
                    res.headers["content-type"]?.split(";")[0]?.trim() === "text/event-stream";
                const decoder = new StringDecoder("utf8");
                let text = "",
                    line = "",
                    data: string[] = [],
                    afterCR = false;
                const dispatch = () => {
                    if (!data.length) return;
                    const value = JSON.parse(data.join("\n"));
                    data = [];
                    if (value.method === "notifications/progress") options.notification?.(value);
                    else if (
                        value.id === options.requestId &&
                        ("result" in value || "error" in value)
                    ) {
                        finish(undefined, { status: res.statusCode!, body: JSON.stringify(value) });
                        res.destroy();
                    }
                };
                const consume = (chunk: string) => {
                    if (!chunk) return;
                    let at = 0;
                    if (afterCR && chunk.startsWith("\n")) at = 1;
                    afterCR = false;
                    while (at < chunk.length && !settled) {
                        const cr = chunk.indexOf("\r", at),
                            lf = chunk.indexOf("\n", at);
                        const end = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
                        if (end < 0) {
                            line += chunk.slice(at);
                            break;
                        }
                        line += chunk.slice(at, end);
                        if (!line) dispatch();
                        else if (line === "data") data.push("");
                        else if (line.startsWith("data:"))
                            data.push(line.slice(5).replace(/^ /, ""));
                        line = "";
                        at = end + 1;
                        if (chunk[end] === "\r") {
                            if (at === chunk.length) afterCR = true;
                            else if (chunk[at] === "\n") ++at;
                        }
                    }
                };
                res.on("data", (chunk: Buffer) => {
                    timer.refresh();
                    try {
                        if (streaming) consume(decoder.write(chunk));
                        else text += decoder.write(chunk);
                    } catch (error) {
                        finish(error as Error);
                        req.destroy();
                    }
                });
                res.on("error", (error) => finish(error));
                res.on("end", () => {
                    if (settled) return;
                    if (streaming)
                        finish(
                            new Error(
                                "The core closed the SSE stream without a final MCP response",
                            ),
                        );
                    else finish(undefined, { status: res.statusCode!, body: text + decoder.end() });
                });
            },
        );
        // This is an idle deadline. Execution limits belong to the project configuration.
        const timer = setTimeout(
            () => req.destroy(new Refused("timeout", `${url} timed out`)),
            timeout,
        );
        const abort = () => req.destroy(new Refused("cancelled", "The request was cancelled"));
        options.signal?.addEventListener("abort", abort, { once: true });
        req.on("error", (error) => finish(error));
        req.end(body);
    });
}

export function reason(reply: { status: number; body: string }): string {
    try {
        const e = JSON.parse(reply.body);
        return `HTTP ${reply.status}: ${e.message ?? reply.body}`;
    } catch {
        return `HTTP ${reply.status}: ${reply.body}`;
    }
}

export async function call(
    core: Connection,
    method: string,
    path: string,
    body?: unknown,
    timeout?: number,
) {
    return exchange(
        core.server + (core.workspace ? `/w/${core.workspace}` : "") + path,
        method,
        body === undefined ? undefined : JSON.stringify(body),
        { "content-type": "application/json", authorization: `Bearer ${core.token}` },
        timeout,
        { signal: core.signal },
    );
}

export async function rpc(
    core: Connection,
    path: string,
    request: Record<string, unknown> & { id?: unknown },
    timeout?: number,
    notification?: (value: unknown) => void,
): Promise<unknown> {
    const r = await exchange(
        core.server + (core.workspace ? `/w/${core.workspace}` : "") + path,
        "POST",
        JSON.stringify(request),
        {
            accept: "text/event-stream, application/json",
            "content-type": "application/json",
            authorization: `Bearer ${core.token}`,
        },
        timeout,
        { signal: core.signal, notification, requestId: request.id },
    );
    if (r.status !== 200) throw responseError(r);
    return JSON.parse(r.body);
}

// These views describe fields consumed from MCP; payloads remain unknown.
interface McpResult {
    isError?: unknown;
    structuredContent?: unknown;
    content?: unknown;
}
interface McpFailure {
    code?: string;
    message?: string;
}

export async function tool(
    core: Connection,
    name: string,
    args: unknown,
    path = "/mcp",
): Promise<unknown> {
    const reply = await rpc(core, path, {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
    });
    if (!object(reply)) throw new Refused("invalid_response", "The core sent an invalid MCP reply");
    if (reply.error) throw rpcError(reply.error);
    if (!reply.result) throw new Refused("invalid_response", "The core sent no MCP result");
    const result = reply.result as McpResult;
    if (result.isError) {
        const e = result.structuredContent as McpFailure | undefined;
        throw new Refused(e?.code ?? "tool_error", e?.message ?? JSON.stringify(result.content));
    }
    return result.structuredContent;
}
