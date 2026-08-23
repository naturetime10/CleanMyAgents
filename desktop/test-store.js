// node test-store.js — fails if per-session storage stops round-tripping.
import assert from "node:assert";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./store.js";

const dir = join(tmpdir(), `store-test-${process.pid}`);
const store = createSessionStore(dir);

store.append("thread-1", { type: "activity", n: 1 });
store.append("thread-1", { type: "review", n: 2 });
store.append("../evil", { n: 3 }); // path characters must not escape the dir

assert.deepEqual(store.read("thread-1").map((e) => e.n), [1, 2]);
assert.equal(store.read("nope"), null);
assert.ok(store.list().some((s) => s.id === "thread-1"));
assert.ok(store.list().every((s) => !s.id.includes("/")), "unsafe id leaked into a filename");

rmSync(dir, { recursive: true });
console.log("ok — per-session store round-trips, ids sanitised");
