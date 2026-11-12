import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectDeliveries, beginDelivery, endDelivery } from "../build/retention.js";

const day = 86400000;
test("delivery retention expires history, protects active and recent files, and removes stale indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-retention-"));
    const now = Date.now(),
        old = new Date(now - 8 * day);
    try {
        const directory = async (name, active = false) => {
            const path = join(root, name);
            await mkdir(path);
            await writeFile(join(path, "file"), "contents");
            if (active) {
                await beginDelivery(path);
                await utimes(join(path, ".active"), old, old);
            }
            await utimes(join(path, "file"), old, old);
            await utimes(path, old, old);
            return path;
        };
        const expired = await directory("execution-old");
        const active = await directory("execution-active", true);
        const edited = await directory("execution-edited");
        await writeFile(join(edited, "file"), "recent edit");
        const unrelated = await directory("keep");
        await mkdir(join(root, "index"));
        const record = join(root, "index", "a".repeat(64) + ".json");
        await writeFile(record, JSON.stringify({ path: "execution-old/file" }));
        await collectDeliveries(root, { now, force: true });
        await assert.rejects(lstat(expired), { code: "ENOENT" });
        await assert.rejects(lstat(record), { code: "ENOENT" });
        assert.equal(await readFile(join(active, "file"), "utf8"), "contents");
        assert.equal(await readFile(join(edited, "file"), "utf8"), "recent edit");
        assert.equal(await readFile(join(unrelated, "file"), "utf8"), "contents");
        await endDelivery(active);
        await collectDeliveries(root, { now, budget: 0, force: true });
        assert.ok((await lstat(active)).isDirectory());
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("delivery size pressure removes eligible oldest directories without following links", async () => {
    const root = await mkdtemp(join(tmpdir(), "fug-retention-size-"));
    const now = Date.now();
    try {
        for (const [name, age] of [
            ["execution-older", 2 * day],
            ["execution-newer", day],
        ]) {
            const path = join(root, name);
            await mkdir(path);
            await writeFile(join(path, "file"), "1234");
            const then = new Date(now - age);
            await utimes(join(path, "file"), then, then);
            await utimes(path, then, then);
        }
        await collectDeliveries(root, { now, budget: 4, force: true });
        await assert.rejects(lstat(join(root, "execution-older")), { code: "ENOENT" });
        assert.equal(await readFile(join(root, "execution-newer/file"), "utf8"), "1234");
        const outside = join(root, "keep");
        await mkdir(outside);
        await writeFile(join(outside, "file"), "keep");
        if (process.platform !== "win32") {
            await symlink(outside, join(root, "execution-link"));
            await collectDeliveries(root, { now: now + 10 * day, budget: 0, force: true });
            assert.equal(await readFile(join(outside, "file"), "utf8"), "keep");
            assert.ok((await lstat(join(root, "execution-link"))).isSymbolicLink());
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
