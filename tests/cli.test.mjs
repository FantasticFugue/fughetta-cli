import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm, chmod, stat, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { start, scratch, service } from "./service.mjs";
import { call } from "../build/remote.js";
import { worldline } from "../build/worldline.js";

const cli = resolve(import.meta.dirname, "../build/cli.js");
function run(cwd, home, args, input = "", extra = {}, onOutput = () => {}) {
    return new Promise((done, fail) => {
        const env = { ...process.env, XDG_CONFIG_HOME: home, APPDATA: home, ...extra };
        if (!Object.hasOwn(extra, "FUGHETTA_TOKEN")) delete env.FUGHETTA_TOKEN;
        const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: "pipe" });
        let stdout = "",
            stderr = "";
        child.stdout.on("data", (b) => {
            stdout += b;
            onOutput(stdout);
        });
        child.stderr.on("data", (b) => {
            stderr += b;
        });
        child.on("error", fail);
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            fail(new Error(`Command timed out: ${args.join(" ")}\n${stderr}`));
        }, 60_000);
        child.on("exit", (code) => {
            clearTimeout(timer);
            done({ code, stdout, stderr });
        });
        child.stdin.end(input);
    });
}
function ok(result) {
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return result.stdout;
}

test(
    "CLI init, credentials, MCP registration and source sync against a real core",
    { timeout: 120_000, skip: service },
    async () => {
        const service = await start("client");
        const root = join(service.dir, "demo"),
            home = join(service.dir, "home");
        const core = { server: service.origin, workspace: "", token: service.token };
        const put = async (path, text) => {
            await mkdir(join(root, path, ".."), { recursive: true });
            await writeFile(join(root, path), text);
        };
        try {
            await put(
                "CMakeLists.txt",
                "cmake_minimum_required(VERSION 3.20)\nproject(demo CXX)\nadd_executable(demo main.cpp)\n",
            );
            await put("main.cpp", "int main() { return 0; }\n");
            await put("tool.sh", "#!/bin/sh\necho tool\n");
            await chmod(join(root, "tool.sh"), 0o755);
            await put("logo.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
            await put(".gitignore", "build/\n*.log\n");
            await put("build/demo.o", "object");
            await put("debug.log", "noise");
            await put("docs/.gitignore", "!keep.log\n");
            await put("docs/keep.log", "kept");
            await put(".git/HEAD", "ref: refs/heads/main\n");
            const created = ok(
                await run(root, home, [
                    "init",
                    "--server",
                    service.origin,
                    "--token",
                    service.token,
                ]),
            );
            assert.match(created, /Created the project demo/);
            assert.match(created, /Sent 8 new/);
            const inspect = () =>
                worldline(core, { project: "demo", worldline: "main" }, "inspect");
            let tree = await inspect();
            assert.deepEqual(
                tree.files.map((f) => f.path),
                [
                    ".gitignore",
                    ".mcp.json",
                    "CMakeLists.txt",
                    "docs/.gitignore",
                    "docs/keep.log",
                    "logo.bin",
                    "main.cpp",
                    "tool.sh",
                ],
            );
            const file = (tree, path) => {
                const f = tree.files.find((f) => f.path === path);
                assert.ok(f, path);
                return f;
            };
            assert.equal(file(tree, "tool.sh").executable, true);
            assert.equal(file(tree, "main.cpp").executable, false);
            assert.equal(file(tree, "logo.bin").kind, "binary");
            const project = await call(core, "GET", "/api/v1/projects/demo");
            assert.doesNotMatch(project.body, /"debug"/);
            const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
            assert.ok(mcp.mcpServers.fughetta);
            assert.equal(mcp.mcpServers.fughetta.args.at(-1), "mcp");
            assert.equal(await readFile(join(root, ".fughetta/.gitignore"), "utf8"), "state/\n");
            const credentials = join(
                home,
                process.platform === "win32" ? "Fughetta" : "fughetta",
                "credentials.json",
            );
            assert.match(await readFile(credentials, "utf8"), new RegExp(service.token));
            if (process.platform !== "win32")
                assert.equal((await stat(credentials)).mode & 0o777, 0o600);
            await put("main.cpp", "int main() { return 1; }\n");
            await rm(join(root, "tool.sh"));
            await put("logo.bin", "now text\n");
            await put("src/extra.cpp", "int extra;\n");
            assert.match(
                ok(await run(root, home, ["push"])),
                /Sent 1 new, 2 changed and 1 removed files/,
            );
            tree = await inspect();
            assert.ok(!tree.files.some((f) => f.path === "tool.sh"));
            assert.equal(file(tree, "logo.bin").kind, "text");
            assert.equal(
                file(tree, "main.cpp").digest,
                createHash("sha256").update("int main() { return 1; }\n").digest("hex"),
            );
            assert.match(ok(await run(join(root, "src"), home, ["push"])), /Nothing to send/);
            assert.match(
                ok(await run(join(root, "src"), home, ["status"])),
                /Build configurations: none/,
            );
            // The agent configures the project through the proxy.
            const session = async (name, args) => {
                const lines =
                    [
                        {
                            id: 1,
                            method: "initialize",
                            params: {
                                protocolVersion: "2025-06-18",
                                capabilities: {},
                                clientInfo: { name: "test", version: "1" },
                            },
                        },
                        { method: "notifications/initialized" },
                        { id: 2, method: "tools/call", params: { name, arguments: args } },
                    ]
                        .map((r) => JSON.stringify({ jsonrpc: "2.0", ...r }))
                        .join("\n") + "\n";
                const reply = JSON.parse(
                    ok(await run(root, home, ["mcp"], lines))
                        .trim()
                        .split("\n")
                        .at(-1),
                );
                assert.equal(reply.result.isError, false, JSON.stringify(reply));
                return reply.result.structuredContent;
            };
            const { revision } = await session("project", {});
            const debug = {
                builders: { main: { adapter: "cmake", options: { build_dir: "build/debug" } } },
                tasks: {
                    configure: { builder: "main", operation: "configure" },
                    build: { builder: "main", operation: "build", after: ["configure"] },
                },
                operations: { build: { tasks: ["build"] } },
            };
            await session("save_project", {
                body: {
                    revision,
                    value: { build_configurations: { debug }, default_configurations: ["debug"] },
                },
            });
            assert.match(
                ok(await run(join(root, "src"), home, ["status"])),
                /Build configurations: debug/,
            );
            const statusJson = JSON.parse(
                ok(await run(join(root, "src"), home, ["status", "--json"])),
            );
            assert.equal(statusJson.project, "demo");
            assert.deepEqual(statusJson.build_configurations, ["debug"]);
            assert.equal(typeof statusJson.cache.total, "number");
            assert.deepEqual(statusJson.pending_recovery, []);
            const pushedJson = JSON.parse(ok(await run(root, home, ["push", "--json"])));
            assert.equal(typeof pushedJson.version, "string");
            assert.equal(pushedJson.created + pushedJson.written + pushedJson.removed, 0);
            await put("main.cpp", "int main() { return 2; }\n");
            const lines =
                [
                    {
                        id: 1,
                        method: "initialize",
                        params: {
                            protocolVersion: "2025-06-18",
                            capabilities: {},
                            clientInfo: { name: "test", version: "1" },
                        },
                    },
                    { method: "notifications/initialized" },
                    { id: 2, method: "tools/list" },
                    { id: 3, method: "ping" },
                    {
                        id: 4,
                        method: "tools/call",
                        params: { name: "configurations", arguments: {} },
                    },
                    {
                        id: 5,
                        method: "tools/call",
                        params: { name: "read", arguments: { path: "main.cpp" } },
                    },
                    { id: 6, method: "resources/list" },
                ]
                    .map((r) => JSON.stringify({ jsonrpc: "2.0", ...r }))
                    .join("\n") + "\n";
            const result = await run(root, home, ["mcp"], lines);
            ok(result);
            const replies = new Map(
                result.stdout
                    .trim()
                    .split("\n")
                    .map((text) => {
                        const r = JSON.parse(text);
                        return [r.id, r];
                    }),
            );
            assert.equal(replies.size, 6);
            assert.ok(replies.get(1).result.instructions);
            assert.equal(replies.get(1).result.protocolVersion, "2025-06-18");
            const names = replies.get(2).result.tools.map((t) => t.name);
            for (const n of ["build", "test", "language", "save_project", "schema"])
                assert.ok(names.includes(n), n);
            for (const n of ["read", "worldline", "write", "save_server"])
                assert.ok(!names.includes(n), n);
            assert.ok(!JSON.stringify(replies.get(2)).includes('"project":{'));
            assert.deepEqual(replies.get(3).result, {});
            assert.equal(replies.get(4).result.isError, false);
            assert.match(JSON.stringify(replies.get(4)), /"name":"debug"/);
            assert.match(replies.get(5).error.message, /unknown tool: read/);
            assert.equal(replies.get(6).error.code, -32601);
            assert.equal(
                file(await inspect(), "main.cpp").digest,
                createHash("sha256").update("int main() { return 2; }\n").digest("hex"),
            );
            // Re-initializing preserves other MCP entries and uses the saved token.
            await put(
                ".mcp.json",
                JSON.stringify({ custom: true, mcpServers: { other: { command: "other" } } }),
            );
            await mkdir(join(root, ".cursor"));
            assert.match(
                ok(await run(root, home, ["init", "--server", service.origin])),
                /Using the existing project demo/,
            );
            const updated = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
            assert.equal(updated.custom, true);
            assert.equal(updated.mcpServers.other.command, "other");
            assert.ok(updated.mcpServers.fughetta);
            assert.ok(
                JSON.parse(await readFile(join(root, ".cursor/mcp.json"), "utf8")).mcpServers
                    .fughetta,
            );
            await put(".mcp.json", "{invalid");
            assert.match(
                ok(await run(root, home, ["init", "--server", service.origin])),
                /add the fughetta server by hand/,
            );
            assert.equal(await readFile(join(root, ".mcp.json"), "utf8"), "{invalid");
        } finally {
            assert.equal(await service.stop(), 0);
        }
    },
);

test("CLI command errors and usage", async () => {
    const dir = await scratch("cli-options");
    try {
        assert.match(ok(await run(dir, dir, ["--help"])), /fug login/);
        assert.match(ok(await run(dir, dir, ["--help", "--text"])), /fug login/);
        const jsonError = await run(dir, dir, ["status", "--json"]);
        assert.equal(jsonError.code, 1);
        assert.match(JSON.parse(jsonError.stderr).message, /not bound/);
        assert.equal(JSON.parse(jsonError.stderr).code, "context_required");
        assert.match((await run(dir, dir, ["status", "--text"])).stderr, /fug: .*not bound/);
        assert.match(
            JSON.parse((await run(dir, dir, ["status", "--json", "--text"])).stderr).message,
            /Choose either/,
        );
        assert.equal((await run(dir, dir, ["--text"])).code, 2);
        assert.equal((await run(dir, dir, ["unknown"])).code, 2);
        assert.equal((await run(dir, dir, ["unknown", "--text"])).code, 2);
        const unknownJson = await run(dir, dir, ["unknown", "--json"]);
        assert.equal(unknownJson.code, 2);
        assert.equal(JSON.parse(unknownJson.stderr).code, "unknown_command");
        assert.match(
            (await run(dir, dir, ["worker", "--parallel", "0"])).stderr,
            /--parallel must be a positive integer/,
        );
        assert.equal((await run(dir, dir, ["status"])).code, 1);
        assert.match((await run(dir, dir, ["init", "--server"])).stderr, /needs a value/);
        assert.match((await run(dir, dir, ["init", "--bad", "v"])).stderr, /Unknown option/);
        assert.match((await run(dir, dir, ["init", "--name", "../x"])).stderr, /Invalid project/);
        assert.match(
            (await run(dir, dir, ["init", "--server", "https://example.com/path"])).stderr,
            /origin/,
        );
        assert.match((await run(dir, dir, ["run"])).stderr, /needs exactly one run configuration/);
        assert.match((await run(dir, dir, ["test", "--fresh"])).stderr, /Unknown option --fresh/);
        assert.match(
            (await run(dir, dir, ["build", "--fresh", "--fresh"])).stderr,
            /Repeated --fresh/,
        );
        assert.match((await run(dir, dir, ["init", "--json"])).stderr, /has no JSON output/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test(
    "hosted CLI init signs in with PKCE, selects a workspace and uses its prefix",
    { timeout: 120_000, skip: service },
    async () => {
        const core = await start("hosted-client");
        const root = join(core.dir, "demo"),
            home = join(core.dir, "home");
        await mkdir(root);
        await writeFile(join(root, "main.cpp"), "int main() {}\n");
        let challenge,
            redirect,
            tokenCalls = 0,
            workspaceCalls = 0,
            prefixed = 0;
        const host = createServer(async (req, res) => {
            const url = `http://127.0.0.1:${host.address().port}`;
            const json = (value) =>
                res
                    .writeHead(200, { "content-type": "application/json" })
                    .end(JSON.stringify(value));
            if (req.url === "/.well-known/oauth-authorization-server")
                return json({
                    authorization_endpoint: url + "/authorize",
                    token_endpoint: url + "/token",
                });
            if (req.url === "/token") {
                let text = "";
                for await (const chunk of req) text += chunk;
                const form = new URLSearchParams(text);
                assert.equal(form.get("client_id"), "fug");
                assert.equal(form.get("grant_type"), "authorization_code");
                assert.equal(form.get("code"), "approved");
                assert.equal(form.get("redirect_uri"), redirect);
                assert.equal(
                    createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
                    challenge,
                );
                tokenCalls++;
                return json({ access_token: core.token, token_type: "Bearer" });
            }
            assert.equal(req.headers.authorization, `Bearer ${core.token}`);
            if (req.url === "/api/v1/workspaces") {
                workspaceCalls++;
                return json([{ name: "team", workspace_id: "team-id", role: "owner" }]);
            }
            assert.ok(req.url.startsWith("/w/team/"));
            prefixed++;
            let text = "";
            for await (const chunk of req) text += chunk;
            const upstream = await fetch(core.origin + req.url.slice("/w/team".length), {
                method: req.method,
                headers: {
                    authorization: req.headers.authorization,
                    "content-type": "application/json",
                },
                ...(text ? { body: text } : {}),
            });
            res.writeHead(upstream.status, { "content-type": "application/json" }).end(
                await upstream.text(),
            );
        });
        await new Promise((done) => host.listen(0, "127.0.0.1", done));
        const url = `http://127.0.0.1:${host.address().port}`;
        let callback;
        function signIn(output) {
            const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/);
            if (!found || callback) return;
            const auth = new URL(found[0]);
            challenge = auth.searchParams.get("code_challenge");
            redirect = auth.searchParams.get("redirect_uri");
            assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
            callback = fetch(`${redirect}?code=approved&state=${auth.searchParams.get("state")}`);
        }
        try {
            const result = await run(
                root,
                home,
                ["init", "--server", url],
                "",
                { PATH: home },
                signIn,
            );
            assert.match(ok(result), /Created the project demo/);
            assert.equal((await callback).status, 200);
            assert.equal(tokenCalls, 1);
            assert.equal(workspaceCalls, 1);
            assert.ok(prefixed > 0);
            const binding = JSON.parse(
                await readFile(join(root, ".fughetta/project.json"), "utf8"),
            );
            assert.equal(binding.workspace, "team");
            assert.equal(binding.server, url);
            const tree = await worldline(
                { server: core.origin, workspace: "", token: core.token },
                { project: "demo", worldline: "main" },
                "inspect",
            );
            assert.ok(tree.files.some((f) => f.path === "main.cpp"));
            assert.match(ok(await run(root, home, ["status"])), /workspace team/);
            assert.equal(tokenCalls, 1);
            callback = undefined;
            assert.match(
                ok(await run(root, home, ["login", "--server", url], "", { PATH: home }, signIn)),
                /Signed in/,
            );
            assert.equal((await callback).status, 200);
            assert.equal(tokenCalls, 2);
        } finally {
            await new Promise((done) => host.close(done));
            assert.equal(await core.stop(), 0);
        }
    },
);

test("status, resolve and clean inspect local state without a server", async () => {
    const root = await scratch("resolve");
    try {
        await mkdir(join(root, ".fughetta/state/recovered"), { recursive: true });
        await writeFile(
            join(root, ".fughetta/project.json"),
            JSON.stringify({
                server: "http://127.0.0.1:1",
                workspace: "",
                project: "demo",
                worldline: "main",
            }),
        );
        await writeFile(join(root, ".fughetta/state/recovered/abc.file"), "local edit");
        await writeFile(
            join(root, ".fughetta/state/recovered/abc.file.json"),
            JSON.stringify({ path: "src/a.cpp" }),
        );
        await mkdir(join(root, ".fughetta/state/collisions/v9/src"), { recursive: true });
        await writeFile(join(root, ".fughetta/state/collisions/v9/src/b.cpp"), "remote copy");
        const resolved = ok(await run(root, root, ["resolve"]));
        assert.match(resolved, /recovered: src\/a\.cpp/);
        assert.match(resolved, /collisions: src\/b\.cpp at version v9/);
        assert.match(resolved, /run fug push/);
        const listed = JSON.parse(ok(await run(root, root, ["resolve", "--json"])));
        assert.deepEqual(
            listed.map((item) => [item.kind, item.path]),
            [
                ["recovered", "src/a.cpp"],
                ["collisions", "src/b.cpp"],
            ],
        );
        assert.match((await run(root, root, ["resolve", "extra"])).stderr, /takes no arguments/);
        const status = JSON.parse(ok(await run(root, root, ["status", "--json"])));
        assert.deepEqual(status.pending_recovery, listed);
        assert.equal(status.project, "demo");
        assert.equal(status.remote_error.code, "unauthenticated");
        assert.match(status.remote_error.message, /No token/);
        assert.equal(status.build_configurations, undefined);
        assert.ok(status.cache.total > 0);
        const offline = ok(
            await run(root, root, ["status"], "", { FUGHETTA_TOKEN: "offline-token" }),
        );
        assert.match(offline, /Remote status unavailable:/);
        assert.match(offline, /Pending recovery: 2 files/);
        assert.match(offline, /Local state:/);

        const stale = join(root, ".fughetta/state/reports/execution-stale");
        await mkdir(stale, { recursive: true });
        await writeFile(join(stale, "step-1.log"), "x".repeat(2048));
        const past = new Date(Date.now() - 11 * 60000);
        await utimes(join(stale, "step-1.log"), past, past);
        await utimes(stale, past, past);
        assert.match(
            ok(await run(root, root, ["clean"])),
            /Removed 2\.0 KiB of cached build logs and artifacts/,
        );
        await assert.rejects(stat(stale), /ENOENT/);
        const again = JSON.parse(ok(await run(root, root, ["clean", "--json"])));
        assert.equal(again.freed, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("language argument validation", async () => {
    const dir = await scratch("cli-language");
    try {
        assert.match(
            (await run(dir, dir, ["language", "bogus"])).stderr,
            /Unknown language action/,
        );
        assert.match(
            (await run(dir, dir, ["language", "definitions"])).stderr,
            /needs --path and --symbol/,
        );
        assert.match(
            (await run(dir, dir, ["language", "--line", "0"])).stderr,
            /--line must be a positive integer/,
        );
        assert.match(
            (await run(dir, dir, ["language", "symbols", "extra"])).stderr,
            /at most one action/,
        );
        assert.match(
            (await run(dir, dir, ["language", "--json", "--json"])).stderr,
            /not bound|no token/i,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("Worldline and d-mail render both modes and preserve refusal and local error codes", async () => {
    const root = await scratch("cli-modes");
    let refused = false;
    const host = createServer(async (req, res) => {
        let text = "";
        for await (const part of req) text += part;
        const input = text ? JSON.parse(text) : {};
        if (refused)
            return res
                .writeHead(409, { "content-type": "application/json" })
                .end(JSON.stringify({ code: "scope_locked", message: "Scope is locked" }));
        const value = req.url.includes("/d-mail")
            ? { messages: [{ body: "hello", recipient: "main" }], next: 1, more: false }
            : input.action === "inspect"
              ? { version: "v1" }
              : input.action === "promote"
                ? { promoted: true, version: "v2" }
                : { changes: [{ path: "main.cpp", kind: "modified" }] };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    });
    await new Promise((done) => host.listen(0, "127.0.0.1", done));
    try {
        await mkdir(join(root, ".fughetta"));
        await writeFile(
            join(root, ".fughetta/project.json"),
            JSON.stringify({
                server: `http://127.0.0.1:${host.address().port}`,
                workspace: "",
                project: "demo",
                worldline: "main",
            }),
        );
        const invoke = (args) => run(root, root, args, "", { FUGHETTA_TOKEN: "t" });
        for (const flag of [[], ["--json"], ["--text"]]) {
            const diff = ok(await invoke(["worldline", "diff", "feature", ...flag]));
            const promoted = ok(
                await invoke([
                    "worldline",
                    "promote",
                    "feature",
                    "--operation-id",
                    "publication",
                    ...flag,
                ]),
            );
            const page = ok(await invoke(["d-mail", "read", ...flag]));
            if (flag[0] === "--text") {
                assert.match(diff, /path: main.cpp/);
                assert.match(promoted, /promoted: true/);
                assert.match(page, /body: hello/);
            } else {
                assert.equal(JSON.parse(diff).changes[0].path, "main.cpp");
                assert.equal(JSON.parse(promoted).promoted, true);
                assert.equal(JSON.parse(page).messages[0].body, "hello");
            }
        }
        refused = true;
        const rejected = await invoke(["worldline", "diff", "feature"]);
        assert.equal(rejected.code, 1);
        assert.equal(JSON.parse(rejected.stderr).code, "scope_locked");
        await writeFile(join(root, "message.txt"), "hello");
        const draft = await invoke([
            "d-mail",
            "send",
            "--to",
            "feature",
            "--file",
            "message.txt",
            "--json",
        ]);
        assert.equal(JSON.parse(draft.stderr).code, "scope_locked");
        assert.match(JSON.parse(draft.stderr).message, /retained draft/);
        const missing = await invoke([
            "d-mail",
            "send",
            "--to",
            "feature",
            "--file",
            "absent.txt",
            "--json",
        ]);
        assert.equal(JSON.parse(missing.stderr).code, "missing_objects");
        assert.equal(
            JSON.parse((await invoke(["worldline", "diff", "feature", "--bad"])).stderr).code,
            "invalid_params",
        );
        assert.match(JSON.parse(ok(await invoke(["help", "--json"]))).usage, /fug worldline/);
    } finally {
        await new Promise((done) => host.close(done));
        await rm(root, { recursive: true, force: true });
    }
});
