// Text records between worldlines or named recipients, independent of source merging.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { call, responseError, Refused, failure, type Connection } from "./remote.js";
import { json, save, locked } from "./files.js";
import { stateDir, type Binding } from "./checkout/binding.js";

interface Message {
    id: number;
    at: number;
    sender: string;
    worldline: string;
    recipient: string;
    body: string;
}
interface Page {
    messages: Message[];
    next: number;
    more: boolean;
    replayed: boolean;
}
interface Draft {
    binding: Binding;
    operation_id: string;
    recipient: string;
    body: string;
}

function options(args: string[], allowed: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        const flag = args[i]!;
        if (!allowed.includes(flag) || !args[i + 1])
            throw new Refused("invalid_params", `Invalid d-mail option ${flag}`);
        if (out[flag] !== undefined) throw new Refused("invalid_params", `Repeated option ${flag}`);
        out[flag] = args[i + 1]!;
    }
    return out;
}

export async function mail(
    core: Connection,
    binding: Binding,
    root: string,
    args: string[],
): Promise<unknown> {
    const [action, ...rest] = args;
    const endpoint = `/api/v1/projects/${encodeURIComponent(binding.project)}/d-mail`;
    if (action === "send") {
        const values = options(rest, ["--to", "--file", "--operation-id"]);
        if (!values["--to"] || !values["--file"])
            throw new Refused(
                "invalid_params",
                "fug d-mail send needs --to RECIPIENT --file TEXT_FILE",
            );
        const operation_id = values["--operation-id"] ?? randomUUID();
        if (!/^[a-zA-Z0-9._-]{1,128}$/.test(operation_id))
            throw new Refused("invalid_params", "Invalid d-mail operation ID");
        const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            await readFile(resolve(values["--file"])),
        );
        if (!body || Buffer.byteLength(body) > 1024 * 1024 || body.includes("\0"))
            throw new Refused(
                "invalid_params",
                "d-mail must contain 1 byte through 1 MiB of UTF-8 text",
            );
        const draft: Draft = { binding, operation_id, recipient: values["--to"], body };
        const file = join(stateDir(root), "d-mail", `${operation_id}.json`);
        return locked(
            file,
            async () => {
                const previous = await json<Draft | undefined>(file, undefined);
                if (previous && JSON.stringify(previous) !== JSON.stringify(draft))
                    throw new Refused(
                        "invalid_params",
                        `Operation ${operation_id} already names another d-mail`,
                    );
                await save(file, draft);
                try {
                    const reply = await call(core, "POST", endpoint, {
                        worldline: binding.worldline,
                        operation_id,
                        recipient: draft.recipient,
                        body,
                    });
                    if (reply.status !== 200) throw responseError(reply);
                    const page = JSON.parse(reply.body) as Page;
                    return {
                        operation_id,
                        replayed: page.replayed,
                        messages: page.messages,
                    };
                } catch (error) {
                    throw new Refused(
                        failure(error).code,
                        `${failure(error).message}; retained draft ${file}. Retry the same file with --operation-id ${operation_id}`,
                    );
                }
            },
            core.signal,
        );
    }
    if (action === "read") {
        const values = options(rest, ["--to", "--after", "--limit", "--output"]);
        const after = Number(values["--after"] ?? 0),
            limit = Number(values["--limit"] ?? 20);
        if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 100
        )
            throw new Refused("invalid_params", "Invalid d-mail cursor or limit");
        const query = new URLSearchParams({
            recipient: values["--to"] ?? binding.worldline,
            after: String(after),
            limit: String(limit),
        });
        const reply = await call(core, "GET", `${endpoint}?${query}`);
        if (reply.status !== 200) throw responseError(reply);
        const page = JSON.parse(reply.body) as Page;
        if (values["--output"]) {
            const file = resolve(values["--output"]);
            await save(file, page);
            return {
                path: file,
                next: page.next,
                more: page.more,
                count: page.messages.length,
            };
        }
        return page;
    }
    throw new Refused(
        "invalid_params",
        "Use fug d-mail send --to RECIPIENT --file TEXT_FILE or fug d-mail read [--to RECIPIENT] [--after ID]",
    );
}
