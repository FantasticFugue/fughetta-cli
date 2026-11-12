import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mail } from "../build/mail.js";
import { scratch } from "./service.mjs";

test("d-mail retains a retryable draft before sending and saves paged reads locally", async () => {
    const root = await scratch("mail-client");
    const file = join(root, "message.txt");
    await writeFile(file, "Review the ABI.\n世界");
    let first = true,
        calls = 0;
    const server = createServer(async (req, res) => {
        ++calls;
        if (req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const input = JSON.parse(body);
            assert.equal(input.worldline, "branch-a");
            assert.equal(input.recipient, "branch-b");
            assert.equal(input.operation_id, "retry-one");
            const draft = JSON.parse(
                await readFile(join(root, ".fughetta/state/d-mail/retry-one.json"), "utf8"),
            );
            assert.equal(draft.body, input.body);
            if (first) {
                first = false;
                req.socket.destroy();
                return;
            }
            res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ replayed: true, messages: [{ id: 1, body: input.body }] }),
            );
        } else {
            const url = new URL(req.url, "http://local");
            assert.equal(url.searchParams.get("recipient"), "branch-b");
            assert.equal(url.searchParams.get("after"), "1");
            res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                    messages: [{ id: 2, body: "Acknowledged" }],
                    next: 2,
                    more: false,
                }),
            );
        }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const core = {
        server: `http://127.0.0.1:${server.address().port}`,
        workspace: "",
        token: "secret",
    };
    const binding = { server: core.server, workspace: "", project: "app", worldline: "branch-a" };
    try {
        const args = ["send", "--to", "branch-b", "--file", file, "--operation-id", "retry-one"];
        await assert.rejects(
            mail(core, binding, root, args),
            /retained draft.*--operation-id retry-one/,
        );
        assert.equal((await mail(core, binding, root, args)).replayed, true);
        await writeFile(file, "changed");
        await assert.rejects(mail(core, binding, root, args), /already names another d-mail/);
        const output = join(root, "inbox.json");
        await mail(core, binding, root, [
            "read",
            "--to",
            "branch-b",
            "--after",
            "1",
            "--output",
            output,
        ]);
        assert.equal(JSON.parse(await readFile(output, "utf8")).messages[0].body, "Acknowledged");
        assert.equal(calls, 3);
    } finally {
        await new Promise((done) => server.close(done));
        await rm(root, { recursive: true, force: true });
    }
});
