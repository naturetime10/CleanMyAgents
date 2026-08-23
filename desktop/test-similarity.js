// node test-similarity.js — fails if the rubbish matcher stops discriminating.
import assert from "node:assert";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRubbishStore, cosine, embed } from "./similarity.js";

const file = join(tmpdir(), `rubbish-test-${process.pid}.json`);
const store = createRubbishStore(file);
store.add("bash curl -s https://api.example.com/usage | jq .total");

// near-duplicate (same call, different flag) must match
const hit = store.match("bash curl -sS https://api.example.com/usage | jq .total");
assert.ok(hit, "near-duplicate should match");

// an unrelated call must not
assert.equal(store.match("bash git status --short --branch"), null, "unrelated call matched");

// cosine sanity: self-similarity is 1
const v = embed("anything at all");
assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);

unlinkSync(file);
console.log(`ok — near-duplicate sim ${hit.sim.toFixed(3)}, unrelated below threshold`);
