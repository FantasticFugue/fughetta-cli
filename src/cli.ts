#!/usr/bin/env node
import { basename, join, resolve, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { find, load, save as saveBinding, push } from "./checkout/index.js";
import { call, origin, responseError, Refused, failure } from "./remote.js";
import { tokenFor } from "./credentials.js";
import { connect } from "./login.js";
import { object, save } from "./files.js";
import { report, serve } from "./proxy.js";
import { hostname } from "node:os";
import { mail } from "./mail.js";
import { branches } from "./branches.js";
import { identity, install, run, savedIdentity, service, uninstall } from "./worker.js";
import { execute, format, formatLanguage, languageActions } from "./execute.js";
import { clean, pendingRecovery, stateUsage } from "./inspect.js";

const usage = `Usage: fug init [--server URL] [--workspace NAME] [--name PROJECT] [--token TOKEN]
       fug login [--server URL] [--workspace NAME] [--token TOKEN]
       fug push [--json]
       fug status [--json]
       fug build [CONFIGURATION ...] [--fresh] [--target TARGET] [--json]
       fug test [CONFIGURATION ...] [--filter FILTER] [--labels LABELS] [--json]
       fug run CONFIGURATION [--json]
       fug language [ACTION] [--configuration NAME] [--path PATH] [--symbol NAME] [--line N] [--json]
       fug resolve [--json]
       fug clean [--json]
       fug mcp
       fug worldline list | fork NAME | checkout NAME NEW_DIRECTORY
       fug worldline diff SOURCE [--version VERSION] [--observed VERSION]
       fug worldline promote SOURCE --operation-id ID [--version VERSION] [--observed VERSION] [--intent TEXT]
       fug d-mail send --to RECIPIENT --file TEXT_FILE [--operation-id ID]
       fug d-mail read [--to RECIPIENT] [--after ID] [--output FILE]
       fug worker [install] [--server URL] [--workspace NAME] [--name MACHINE] [--parallel N] [--service PATH] [--token TOKEN]
       fug worker uninstall [--server URL] --workspace NAME

init    create or use a project, send files and register Fughetta in .mcp.json;
        the agent configures builds with the project tools
login   sign in and save the origin's token
push    send this directory's changes
status  show the binding, local cache use and files pending recovery
build   send this directory and build it on the workspace's workers
test    send this directory and run the configurations' tests
run     send this directory and invoke a saved run configuration
language query scopes, symbols, definitions, references or diagnostics
        (the default action) on the sent version
resolve list files set aside by synchronization and how to recover them
clean   remove cached build logs and downloaded artifacts
mcp     serve the agent's tools on stdio
worker  serve this workspace's builds on this machine (owners register it on
        first use); --parallel sets compute threads and build parallelism (default 8);
        install keeps it running as a systemd user service

The default server is https://fughetta.dev.
Token order: --token, FUGHETTA_TOKEN, saved token.
--json or --text selects output for push, status, build, test, run, language, resolve, clean, worldline, d-mail and help.
Worldline and d-mail default to JSON; the other commands default to text. Exit status: 0 success, 1 failure, 2 unknown command, 130 cancelled execution.
`;
type OutputMode = "text" | "json";
interface Command {
    default: OutputMode;
    modes: OutputMode[];
}
const commands: Record<string, Command> = {
    init: { default: "text", modes: ["text"] },
    login: { default: "text", modes: ["text"] },
    push: { default: "text", modes: ["text", "json"] },
    status: { default: "text", modes: ["text", "json"] },
    build: { default: "text", modes: ["text", "json"] },
    test: { default: "text", modes: ["text", "json"] },
    run: { default: "text", modes: ["text", "json"] },
    language: { default: "text", modes: ["text", "json"] },
    resolve: { default: "text", modes: ["text", "json"] },
    clean: { default: "text", modes: ["text", "json"] },
    mcp: { default: "text", modes: [] },
    worldline: { default: "json", modes: ["text", "json"] },
    "d-mail": { default: "json", modes: ["text", "json"] },
    worker: { default: "text", modes: ["text"] },
    help: { default: "text", modes: ["text", "json"] },
};
function outputMode(argv: string[]): OutputMode {
    if (argv.includes("--json")) return "json";
    if (argv.includes("--text")) return "text";
    return commands[argv[0] ?? ""]?.default ?? "text";
}
function render(value: unknown, json: boolean): string {
    if (json) return JSON.stringify(value, null, 2);
    const lines = (item: unknown, indent = ""): string[] => {
        if (Array.isArray(item))
            return item.length
                ? item.flatMap((value) =>
                      lines(value, indent + "  ").map((line, i) =>
                          i ? line : `${indent}- ${line.trimStart()}`,
                      ),
                  )
                : [`${indent}[]`];
        if (object(item))
            return Object.entries(item).flatMap(([key, value]) =>
                value !== null && typeof value === "object"
                    ? [`${indent}${key}:`, ...lines(value, indent + "  ")]
                    : [`${indent}${key}: ${String(value)}`],
            );
        return [`${indent}${String(item)}`];
    };
    return lines(value).join("\n");
}
function options(args: string[], command: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i]!;
        const allowed =
            command === "uninstall"
                ? ["--server", "--workspace"]
                : [
                      "--server",
                      "--workspace",
                      "--token",
                      ...(command === "init"
                          ? ["--name"]
                          : command === "worker"
                            ? ["--name", "--service", "--parallel"]
                            : []),
                  ];
        if (!allowed.includes(key)) throw new Refused("invalid_params", `Unknown option ${key}`);
        if (!args[i + 1] || args[i + 1]!.startsWith("--"))
            throw new Refused("invalid_params", `${key} needs a value`);
        out[key.slice(2)] = args[i + 1]!;
    }
    return out;
}
function name(value: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value))
        throw new Refused("invalid_params", `Invalid project or workspace name: ${value}`);
    return value;
}
function command() {
    const found = (process.env.PATH ?? "")
        .split(delimiter)
        .some((dir) => existsSync(join(dir, process.platform === "win32" ? "fug.cmd" : "fug")));
    return found
        ? { command: "fug", args: ["mcp"] }
        : { command: process.execPath, args: [resolve(process.argv[1]!), "mcp"] };
}
export async function register(file: string, entry = command()) {
    let doc: Record<string, unknown> = {};
    try {
        const value = JSON.parse(await readFile(file, "utf8"));
        if (!object(value)) throw new SyntaxError("Not an object");
        doc = value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.log(
                `${file} is not a JSON object; add the fughetta server by hand: ${JSON.stringify(entry)}`,
            );
            return;
        }
    }
    doc.mcpServers = { ...(object(doc.mcpServers) ? doc.mcpServers : {}), fughetta: entry };
    await save(file, doc, 0o644);
    console.log(`Added the fughetta MCP server to ${file}`);
}
async function checkout() {
    const root = find(process.cwd());
    if (!root)
        throw new Refused(
            "context_required",
            "This directory is not bound to a project; run fug init",
        );
    return { root, binding: await load(root) };
}
async function bound(local?: Awaited<ReturnType<typeof checkout>>) {
    const { root, binding } = local ?? (await checkout());
    const token = await tokenFor(binding.server);
    if (!token)
        throw new Refused(
            "unauthenticated",
            `No token for ${binding.server}; run fug login or set FUGHETTA_TOKEN`,
        );
    return { root, binding, core: { server: binding.server, workspace: binding.workspace, token } };
}
function volume(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB"];
    let value = bytes,
        unit = "B";
    for (const next of units) {
        if (value < 1024) break;
        value /= 1024;
        unit = next;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}
// Positional names plus the options each execution tool accepts.
function executionArgs(cmd: string, args: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const names: string[] = [],
        targets: string[] = [];
    for (let i = 0; i < args.length; ++i) {
        const item = args[i]!;
        if (!item.startsWith("--")) {
            names.push(item);
            continue;
        }
        if (item === "--fresh" && cmd === "build") {
            if (out.fresh) throw new Refused("invalid_params", "Repeated --fresh");
            out.fresh = true;
            continue;
        }
        if ((item === "--filter" || item === "--labels") && cmd === "test") {
            const value = args[++i];
            if (!value || value.startsWith("--"))
                throw new Refused("invalid_params", `${item} needs a value`);
            if (out[item.slice(2)] !== undefined)
                throw new Refused("invalid_params", `Repeated ${item}`);
            out[item.slice(2)] = value;
            continue;
        }
        if (item === "--target" && cmd === "build") {
            const value = args[++i];
            if (!value || value.startsWith("--"))
                throw new Refused("invalid_params", "--target needs a value");
            targets.push(value);
            continue;
        }
        throw new Refused("invalid_params", `Unknown option ${item}`);
    }
    if (cmd === "run") {
        if (names.length !== 1)
            throw new Refused("invalid_params", "fug run needs exactly one run configuration name");
        out.configuration = names[0];
    } else if (names.length) out.configurations = names;
    if (targets.length) out.targets = targets;
    return out;
}
// Positional action plus the query fields each language action accepts.
function languageArgs(args: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const positional: string[] = [];
    for (let i = 0; i < args.length; ++i) {
        const item = args[i]!;
        if (!item.startsWith("--")) {
            positional.push(item);
            continue;
        }
        const value = args[++i];
        if (!value || value.startsWith("--"))
            throw new Refused("invalid_params", `${item} needs a value`);
        if (item === "--path" || item === "--symbol" || item === "--configuration") {
            if (out[item.slice(2)] !== undefined)
                throw new Refused("invalid_params", `Repeated ${item}`);
            out[item.slice(2)] = value;
        } else if (item === "--line") {
            if (out.line !== undefined) throw new Refused("invalid_params", "Repeated --line");
            const line = Number(value);
            if (!Number.isSafeInteger(line) || line < 1)
                throw new Refused("invalid_params", "--line must be a positive integer");
            out.line = line;
        } else throw new Refused("invalid_params", `Unknown option ${item}`);
    }
    if (positional.length > 1)
        throw new Refused("invalid_params", "fug language takes at most one action");
    if (positional.length) {
        if (!languageActions.includes(positional[0]!))
            throw new Refused(
                "invalid_params",
                `Unknown language action ${positional[0]}; use ${languageActions.join(", ")}`,
            );
        out.action = positional[0];
    }
    if ((out.action === "definitions" || out.action === "references") && (!out.path || !out.symbol))
        throw new Refused("invalid_params", `${out.action} needs --path and --symbol`);
    return out;
}
async function main() {
    const argv = process.argv.slice(2);
    const json = outputMode(argv) === "json";
    if (argv.includes("--json") && argv.includes("--text"))
        throw new Refused("invalid_params", "Choose either --json or --text");
    const [command, ...args] = argv.filter((arg) => arg !== "--json" && arg !== "--text");
    const cmd = command === "--help" ? "help" : command;
    const entry = cmd && Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
    if (cmd && !entry) {
        if (json)
            console.error(
                JSON.stringify({ code: "unknown_command", message: `Unknown command: ${cmd}` }),
            );
        else console.log(usage);
        process.exitCode = 2;
        return;
    }
    if (
        entry &&
        (argv.includes("--json") || argv.includes("--text")) &&
        !entry.modes.includes(json ? "json" : "text")
    )
        throw new Refused("invalid_params", `fug ${cmd} has no ${json ? "JSON" : "text"} output`);
    if (cmd === "init" || cmd === "login") {
        const o = options(args, cmd);
        if (o.workspace) name(o.workspace);
        const project =
            cmd === "init"
                ? name(
                      o.name ??
                          (basename(process.cwd())
                              .replace(/[^a-zA-Z0-9._-]/g, "-")
                              .replace(/^[^a-zA-Z0-9]+/, "")
                              .slice(0, 64) ||
                              "project"),
                  )
                : "";
        const core = await connect(
            origin(o.server ?? "https://fughetta.dev"),
            o.workspace,
            o.token,
            cmd === "login",
        );
        if (cmd === "login") {
            console.log(
                `Signed in to ${core.server}${core.workspace ? ` (workspace ${core.workspace})` : ""}`,
            );
            return;
        }
        const root = process.cwd();
        const binding = {
            server: core.server,
            workspace: core.workspace,
            project,
            worldline: "main",
        };
        const path = `/api/v1/projects/${project}`;
        const existing = await call(core, "GET", path);
        if (existing.status === 200)
            console.log(`Using the existing project ${project} on ${core.server}`);
        else if (existing.status === 404) {
            const created = await call(core, "PUT", path, { revision: 0, value: {} });
            if (created.status !== 200) {
                const refusal = responseError(created);
                throw new Refused(
                    refusal.code,
                    `The project could not be created: ${refusal.message}`,
                );
            }
            console.log(`Created the project ${project} on ${core.server}`);
        } else throw responseError(existing);
        await saveBinding(root, binding);
        await register(join(root, ".mcp.json"));
        if (existsSync(join(root, ".cursor"))) await register(join(root, ".cursor", "mcp.json"));
        report(await push(core, binding, root), console.log, console.error);
        console.log(
            "Start your agent in this directory; it finds the Fughetta tools through .mcp.json.",
        );
    } else if (cmd === "status" && !args.length) {
        const local = await checkout();
        const { root, binding } = local;
        const [usage, pending] = await Promise.all([stateUsage(root), pendingRecovery(root)]);
        let configurations: string[] | undefined;
        let remoteError: { code: string; message: string } | undefined;
        try {
            const { core } = await bound(local);
            const reply = await call(
                core,
                "GET",
                `/api/v1/projects/${binding.project}`,
                undefined,
                30_000,
            );
            if (reply.status !== 200) throw responseError(reply);
            configurations = Object.keys(JSON.parse(reply.body).value.build_configurations ?? {});
        } catch (error) {
            remoteError = failure(error);
        }
        if (json) {
            console.log(
                JSON.stringify({
                    server: binding.server,
                    workspace: binding.workspace,
                    project: binding.project,
                    worldline: binding.worldline,
                    build_configurations: configurations,
                    remote_error: remoteError,
                    cache: usage,
                    pending_recovery: pending,
                }),
            );
            return;
        }
        console.log(
            `Directory ${root} is project ${binding.project} on ${binding.server}${binding.workspace ? ` (workspace ${binding.workspace})` : ""}`,
        );
        if (configurations)
            console.log(`Build configurations: ${configurations.join(", ") || "none"}`);
        if (remoteError) console.log(`Remote status unavailable: ${remoteError.message}`);
        console.log(
            `Local state: ${volume(usage.total)} (blobs ${volume(usage.blobs)}, reports ${volume(usage.reports)}, artifacts ${volume(usage.artifacts)})`,
        );
        if (pending.length)
            console.log(
                `Pending recovery: ${pending.length} file${pending.length === 1 ? "" : "s"} set aside by synchronization; run fug resolve`,
            );
    } else if (["push", "mcp"].includes(cmd ?? "") && !args.length) {
        const { root, binding, core } = await bound();
        if (cmd === "push") {
            const sent = await push(core, binding, root);
            if (json) console.log(JSON.stringify(sent));
            else report(sent, console.log, console.error);
        } else await serve(core, binding, root);
    } else if (["build", "test", "run", "language"].includes(cmd ?? "")) {
        const toolArgs = cmd === "language" ? languageArgs(args) : executionArgs(cmd!, args);
        const { root, binding, core } = await bound();
        const outcome = await execute(core, binding, root, cmd!, toolArgs, (line) =>
            console.error(line),
        );
        if (outcome.cancelled) {
            console.error(`fug: ${cmd} cancelled`);
            process.exitCode = 130;
            return;
        }
        if (json) console.log(JSON.stringify(outcome.result.structuredContent ?? outcome.result));
        else
            for (const line of cmd === "language"
                ? formatLanguage(outcome.result)
                : format(cmd!, outcome.result))
                console.log(line);
        if (!outcome.ok) process.exitCode = 1;
    } else if (cmd === "resolve" || cmd === "clean") {
        if (args.length) throw new Refused("invalid_params", `fug ${cmd} takes no arguments`);
        const root = find(process.cwd());
        if (!root)
            throw new Refused(
                "context_required",
                "This directory is not bound to a project; run fug init",
            );
        if (cmd === "clean") {
            const done = await clean(root);
            if (json) console.log(JSON.stringify(done));
            else
                console.log(
                    `Removed ${volume(done.freed)} of cached build logs and artifacts; ${volume(done.reports + done.artifacts)} remain`,
                );
            return;
        }
        const pending = await pendingRecovery(root);
        if (json) {
            console.log(JSON.stringify(pending));
            return;
        }
        if (!pending.length) {
            console.log("Nothing to recover.");
            return;
        }
        for (const item of pending) {
            console.log(
                `${item.kind}: ${item.path ?? "(unknown source path)"}${item.version ? ` at version ${item.version}` : ""}`,
            );
            console.log(`  copy: ${item.file}`);
            console.log(`  ${item.guidance}`);
        }
    } else if (cmd === "worldline") {
        const { root, binding, core } = await bound();
        console.log(render(await branches(core, binding, root, args), json));
    } else if (cmd === "d-mail") {
        const { root, binding, core } = await bound();
        console.log(render(await mail(core, binding, root, args), json));
    } else if (cmd === "worker") {
        const sub = args[0] === "install" || args[0] === "uninstall" ? args.shift()! : "";
        const o = options(args, sub === "uninstall" ? sub : "worker");
        if (o.workspace) name(o.workspace);
        const server = origin(o.server ?? "https://fughetta.dev");
        if (sub === "uninstall") {
            if (!o.workspace)
                throw new Refused("invalid_params", "fug worker uninstall needs --workspace");
            await uninstall(server, o.workspace);
            return;
        }
        const parallel = Number(o.parallel ?? "8");
        if (!Number.isSafeInteger(parallel) || parallel < 1)
            throw new Refused("invalid_params", "--parallel must be a positive integer");
        let id = await savedIdentity(server, o.workspace);
        if (!id) {
            const core = await connect(server, o.workspace, o.token);
            if (!core.workspace)
                throw new Refused(
                    "invalid_params",
                    "fug worker connects through a Fughetta gateway; a core without workspaces runs its Workers itself",
                );
            id = await identity(core, o.name ?? hostname().slice(0, 128));
            console.error(`fug: registered ${id.name} as ${id.worker_id} in ${id.workspace}`);
        }
        const given = o.service ?? process.env.FUGHETTA_SERVICE;
        const binary = given ? resolve(given) : await service();
        if (sub === "install")
            await install(
                server,
                id.workspace,
                [process.execPath, resolve(process.argv[1]!)],
                ["--parallel", String(parallel), ...(given ? ["--service", binary] : [])],
            );
        else process.exitCode = await run(id, binary, parallel);
    } else if (cmd === "help") {
        console.log(json ? JSON.stringify({ usage }) : usage);
    } else if (cmd) {
        throw new Refused("invalid_params", `Invalid arguments for fug ${cmd}`);
    } else {
        console.log(json ? JSON.stringify({ usage }) : usage);
        process.exitCode = 2;
    }
}
main().catch((error) => {
    const value = failure(error);
    console.error(
        outputMode(process.argv.slice(2)) === "json"
            ? JSON.stringify(value)
            : `fug: ${value.message}`,
    );
    process.exitCode = 1;
});
