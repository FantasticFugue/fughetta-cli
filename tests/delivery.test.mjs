import { Proxy } from "../build/proxy.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localReports, localExports, reportSchema } from "../build/delivery.js";

const response = (steps) => {
    const structuredContent = {
        ok: false,
        results: [
            {
                configuration: "../../untrusted",
                ok: false,
                steps,
                diagnostics: [{ message: "type mismatch", path: "src/main.cpp", line: 3 }],
                tests: { failed: 1 },
            },
        ],
    };
    return {
        isError: true,
        structuredContent,
        content: [
            { type: "text", text: JSON.stringify(structuredContent) },
            { type: "text", text: "Keep this note" },
        ],
    };
};

test("large execution logs are saved with bounded summaries and matching MCP representations", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-delivery-"));
    try {
        const output = "编译器输出\n".repeat(2000);
        const result = response([
            { name: "../compile", output, truncated: true, exit_code: 1 },
            { name: "test", output: "small", truncated: false },
        ]);
        await localReports(root, result);
        const [first, second] = result.structuredContent.results[0].steps;
        assert.equal(await readFile(first.output_file, "utf8"), output);
        assert.equal(first.output_bytes, Buffer.byteLength(output));
        assert.ok(first.output.length <= 512);
        assert.equal(first.output_shortened, true);
        assert.equal(first.truncated, true);
        assert.equal(await readFile(second.output_file, "utf8"), "small");
        assert.equal(second.output_shortened, false);
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
        assert.equal(result.content[1].text, "Keep this note");
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.results[0].diagnostics[0].line, 3);
        assert.ok(first.output_file.startsWith(join(root, ".fughetta/state/reports/execution-")));
        if (process.platform !== "win32")
            assert.equal((await stat(first.output_file)).mode & 0o777, 0o600);
        const next = response([{ output }]);
        await localReports(root, next);
        assert.notEqual(next.structuredContent.results[0].steps[0].output_file, first.output_file);
        assert.equal(await readFile(first.output_file, "utf8"), output);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("small execution logs stay inline without creating state", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-delivery-"));
    try {
        const result = response([{ output: "build failed", exit_code: 1 }]);
        const before = structuredClone(result);
        await localReports(root, result);
        assert.deepEqual(result, before);
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("failed local report storage preserves the remote result and full log", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-delivery-"));
    try {
        await mkdir(join(root, ".fughetta/state"), { recursive: true });
        await writeFile(join(root, ".fughetta/state/reports"), "occupied");
        const result = response([{ output: "x".repeat(10000), exit_code: 1 }]);
        const before = structuredClone(result);
        await localReports(root, result);
        assert.deepEqual(result.structuredContent, before.structuredContent);
        assert.deepEqual(result.content.slice(0, 2), before.content);
        assert.match(JSON.parse(result.content[2].text).delivery_error, /EEXIST|ENOTDIR/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("many step logs share a bounded inline output budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-delivery-"));
    try {
        const result = response(Array.from({ length: 30 }, () => ({ output: "x".repeat(1000) })));
        await localReports(root, result);
        const steps = result.structuredContent.results[0].steps;
        assert.equal(steps.at(-1).output.length, 512);
        assert.equal(steps[0].output.length, 0);
        assert.ok(steps.reduce((size, step) => size + step.output.length, 0) <= 4096);
        for (const step of steps) assert.equal((await readFile(step.output_file)).length, 1000);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("execution output schemas describe local report references, including referenced steps", () => {
    const step = {
        type: "object",
        additionalProperties: false,
        required: ["output", "truncated"],
        properties: { output: { type: "string" }, truncated: { type: "boolean" } },
    };
    const input = {
        $defs: { step },
        properties: { steps: { type: "array", items: { $ref: "#/$defs/step" } } },
    };
    const result = reportSchema(input);
    assert.equal(result.$defs.step.properties.output_file.type, "string");
    assert.equal(result.$defs.step.properties.output_bytes.type, "integer");
    assert.deepEqual(result.$defs.step.required, ["output", "truncated"]);
    assert.equal(step.properties.output_file, undefined);
    assert.deepEqual(result.properties, input.properties);
});

for (const failure of ["none", "digest", "path"])
    test(`artifact downloads verify bytes and preserve completed results: ${failure}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "fug-artifacts-"));
        const data = Buffer.alloc((4 << 20) + 17, 0x61);
        const digest = createHash("sha256").update(data).digest("hex");
        const requested = [];
        const server = createServer((req, res) => {
            const url = new URL(req.url, "http://localhost");
            requested.push(url.pathname);
            const offset = Number(url.searchParams.get("offset")),
                length = Number(url.searchParams.get("length"));
            const bytes = data.subarray(offset, offset + length);
            if (failure === "digest") bytes.fill(0x62);
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    digest,
                    offset,
                    total: data.length,
                    data_base64: bytes.toString("base64"),
                }),
            );
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const result = response([]);
            result.structuredContent.results[0].exports = [
                {
                    name: "app",
                    path: failure === "path" ? "../escape" : "bin/app",
                    digest,
                    size: data.length,
                    executable: true,
                    delivery_error: "",
                    local_path: "/untrusted/path",
                },
            ];
            result.content[0].text = JSON.stringify(result.structuredContent);
            await localExports(
                {
                    server: `http://127.0.0.1:${server.address().port}`,
                    workspace: "",
                    token: "test",
                },
                "project",
                root,
                result,
            );
            const file = result.structuredContent.results[0].exports[0];
            assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
            assert.equal(result.structuredContent.results[0].diagnostics[0].line, 3);
            if (failure === "none") {
                assert.equal(file.delivery_error, "");
                assert.equal(
                    createHash("sha256")
                        .update(await readFile(file.local_path))
                        .digest("hex"),
                    digest,
                );
                assert.equal(requested.length, 2);
                assert.ok(
                    requested.every(
                        (path) => path === `/api/v1/projects/project/exports/${digest}`,
                    ),
                );
                if (process.platform !== "win32")
                    assert.equal((await stat(file.local_path)).mode & 0o777, 0o700);
            } else {
                assert.equal(file.local_path, undefined);
                assert.match(
                    file.delivery_error,
                    failure === "digest" ? /digest mismatch/ : /Unsupported export path/,
                );
                if (failure === "path") assert.equal(requested.length, 0);
            }
        } finally {
            await new Promise((resolve) => server.close(resolve));
            await rm(root, { recursive: true, force: true });
        }
    });

test("truncated remote logs preserve the complete inline tail in a separate local report", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-log-tail-"));
    const head = Buffer.from("first bytes only");
    const digest = createHash("sha256").update(head).digest("hex");
    const server = createServer((req, res) => {
        res.end(
            JSON.stringify({
                digest,
                offset: 0,
                total: head.length,
                data_base64: head.toString("base64"),
            }),
        );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const tail = "later diagnostic\n".repeat(1000) + "fatal: final error";
        const result = response([
            {
                output: tail,
                truncated: true,
                log_truncated: true,
                exit_code: 1,
                log: {
                    name: "step-0.log",
                    path: "0.log",
                    digest,
                    size: head.length,
                    executable: false,
                    delivery_error: "",
                },
            },
        ]);
        const core = {
            server: `http://127.0.0.1:${server.address().port}`,
            workspace: "",
            token: "",
        };
        await localExports(core, "app", root, result);
        assert.equal(result.structuredContent.results[0].steps[0].output_file, undefined);
        await localReports(root, result);
        const step = result.structuredContent.results[0].steps[0];
        assert.equal(await readFile(step.output_file, "utf8"), tail);
        assert.deepEqual(await readFile(step.log.local_path), head);
        assert.notEqual(step.output_file, step.log.local_path);
        assert.equal(step.output_bytes, Buffer.byteLength(tail));
        assert.ok(step.output.endsWith("fatal: final error"));
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test("download budgets restart for each selected configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-config-budgets-"));
    const data = Buffer.from("ready");
    const digest = createHash("sha256").update(data).digest("hex");
    let requests = 0;
    const server = createServer((req, res) => {
        requests++;
        if (requests <= 2) {
            res.statusCode = 503;
            res.end("unavailable");
            return;
        }
        res.end(
            JSON.stringify({
                digest,
                offset: 0,
                total: data.length,
                data_base64: data.toString("base64"),
            }),
        );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const file = (size) => ({
            name: "app",
            path: "app",
            digest,
            size,
            executable: false,
            delivery_error: "",
        });
        const result = response([]);
        result.structuredContent.results = [
            { exports: [file(1073741824)], steps: [{ log: file(64 << 20) }] },
            { exports: [file(data.length)], steps: [{ log: file(data.length) }] },
        ];
        await localExports(
            { server: `http://127.0.0.1:${server.address().port}`, workspace: "", token: "" },
            "app",
            root,
            result,
        );
        const second = result.structuredContent.results[1];
        assert.equal(requests, 3);
        for (const delivered of [second.exports[0], second.steps[0].log]) {
            assert.equal(delivered.delivery_error, "");
            assert.deepEqual(await readFile(delivered.local_path), data);
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test("verified local artifacts are reused without replacing user changes or crossing projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-export-reuse-"));
    const data = Buffer.from("unchanged artifact");
    const digest = createHash("sha256").update(data).digest("hex");
    let requests = 0;
    const server = createServer((req, res) => {
        requests++;
        res.end(
            JSON.stringify({
                digest,
                offset: 0,
                total: data.length,
                data_base64: data.toString("base64"),
            }),
        );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const core = {
            server: `http://127.0.0.1:${server.address().port}`,
            workspace: "",
            token: "",
        };
        const download = async (project = "app") => {
            const result = response([]);
            result.structuredContent.results[0].exports = [
                {
                    name: "app",
                    path: "app",
                    digest,
                    size: data.length,
                    executable: false,
                    delivery_error: "",
                },
            ];
            await localExports(core, project, root, result);
            const file = result.structuredContent.results[0].exports[0];
            assert.equal(file.delivery_error, "");
            return file.local_path;
        };
        const first = await download();
        assert.equal(await download(), first);
        assert.equal(requests, 1);
        await writeFile(first, "user modified artifact");
        const next = await download();
        assert.notEqual(next, first);
        assert.equal(await readFile(first, "utf8"), "user modified artifact");
        assert.deepEqual(await readFile(next), data);
        assert.equal(requests, 2);
        assert.equal(await download(), next);
        assert.equal(requests, 2);
        await rm(next);
        const recovered = await download();
        assert.notEqual(recovered, next);
        assert.equal(requests, 3);
        assert.notEqual(await download("other"), recovered);
        assert.equal(requests, 4);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test("MCP proxy returns verified local artifacts with synchronized source binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-export-proxy-"));
    const data = Buffer.from("ready to run");
    const digest = createHash("sha256").update(data).digest("hex");
    let builds = 0,
        downloads = 0;
    const server = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, "Bearer secret");
        res.setHeader("content-type", "application/json");
        if (req.url === "/w/team/mcp") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const request = JSON.parse(body);
            assert.equal(request.params.arguments.project, "app");
            assert.equal(request.params.arguments.worldline, "branch");
            assert.equal(request.params.arguments.version, "submitted");
            builds++;
            const structuredContent = {
                ok: true,
                results: [
                    {
                        configuration: "native",
                        exports: [
                            {
                                name: "binary",
                                path: "app",
                                digest,
                                size: data.length,
                                executable: false,
                            },
                        ],
                        steps: [
                            {
                                output: "run",
                                truncated: true,
                                log_truncated: false,
                                log: {
                                    name: "step-0.log",
                                    path: "0.log",
                                    digest,
                                    size: data.length,
                                    executable: false,
                                },
                            },
                        ],
                        diagnostics: [],
                    },
                ],
            };
            res.end(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        structuredContent,
                        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
                    },
                }),
            );
        } else {
            assert.ok(req.url.startsWith(`/w/team/api/v1/projects/app/exports/${digest}?`));
            downloads++;
            res.end(
                JSON.stringify({
                    digest,
                    offset: 0,
                    total: data.length,
                    data_base64: data.toString("base64"),
                }),
            );
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const replies = [];
        const core = {
            server: `http://127.0.0.1:${server.address().port}`,
            workspace: "team",
            token: "secret",
        };
        const proxy = new Proxy(
            core,
            { ...core, project: "app", worldline: "branch" },
            root,
            (value) => replies.push(value),
            () => {},
            async () => ({
                version: "submitted",
                created: 0,
                written: 0,
                removed: 0,
                skipped: [],
                kept: [],
            }),
        );
        await proxy.line(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 12,
                method: "tools/call",
                params: { name: "build" },
            }),
        );
        assert.equal(replies.length, 1);
        assert.equal(replies[0].id, 12);
        const result = replies[0].result;
        const file = result.structuredContent.results[0].exports[0];
        assert.deepEqual(await readFile(file.local_path), data);
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
        assert.equal(JSON.parse(result.content[1].text).synchronization.version, "submitted");
        assert.equal(builds, 1);
        assert.equal(downloads, 2);
        const step = result.structuredContent.results[0].steps[0];
        assert.deepEqual(await readFile(step.output_file), data);
        assert.equal(step.output_bytes, data.length);
        assert.equal(step.truncated, true);
        assert.equal(step.log_truncated, false);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test("server delivery errors preserve results without attempting a download", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-unavailable-export-"));
    try {
        const result = response([{ output: "completed", exit_code: 0 }]);
        result.structuredContent.results[0].exports = [
            {
                name: "app",
                path: "app",
                digest: "a".repeat(64),
                size: 4,
                executable: false,
                delivery_error: "worker connection lost",
                local_path: "/untrusted",
            },
        ];
        result.content[0].text = JSON.stringify(result.structuredContent);
        await localExports(
            { server: "http://127.0.0.1:1", workspace: "", token: "" },
            "app",
            root,
            result,
        );
        const file = result.structuredContent.results[0].exports[0];
        assert.equal(file.delivery_error, "worker connection lost");
        assert.equal(file.local_path, undefined);
        assert.equal(result.structuredContent.results[0].steps[0].exit_code, 0);
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
