// The mirror copies only verified snapshots, never replaces one, and does
// nothing while the bridge publishes no history.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { signSnapshot, buildIndex, fileText } from "../lib/format.mjs";
import { syncOnce } from "../sync.mjs";

const key = ethers.Wallet.createRandom(); // a throwaway test key
const intruder = ethers.Wallet.createRandom();
const quiet = () => {};

async function history(n, signer = key) {
  const out = [];
  let prev = null;
  for (let i = 1; i <= n; i++) {
    const s = await signSnapshot({ height: 1440 * i, previous: prev, attester: signer.address, assets: [{ escrowAtoms: String(i) }] }, signer);
    out.push(s);
    prev = { height: s.payload.height, hash: s.hash };
  }
  return out;
}

// A bridge as the mirror sees it: the index and the files, by path.
function bridge(files) {
  return async (url) => {
    const p = new URL(url).pathname.replace(/^\/bridge/, "");
    if (!(p in files)) return new Response('{"error":"not found"}', { status: 404 });
    const body = files[p];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  };
}
const serve = (snaps, index = buildIndex(snaps)) =>
  bridge({ "/api/por/history": fileText(index), ...Object.fromEntries(snaps.map((s) => [`/api/por/history/${s.payload.height}`, fileText(s)])) });

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-")), "snapshots");
const sync = (dir, fetchImpl, attester = key.address) => syncOnce({ source: "https://x/bridge", attester, dir, fetchImpl, log: quiet });

test("nothing happens while the bridge publishes no history", async () => {
  const dir = tmp();
  assert.equal((await sync(dir, bridge({}))).status, "no-history", "404");
  assert.equal((await sync(dir, bridge({ "/api/por/history": { generatedAt: "x", assets: [] } }))).status, "no-history", "the live report");
  assert.equal((await sync(dir, serve([]))).status, "no-history", "an empty index");
  assert.equal((await sync(dir, serve([]), "SET_ME")).status, "no-history", "no attester needed yet");
  assert.equal(fs.existsSync(dir), false);
});

test("an unreachable bridge is a warning, not a failure", async () => {
  const r = await sync(tmp(), async () => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal(r.status, "unreachable");
});

test("a history is refused until the attester is pinned", async () => {
  const r = await sync(tmp(), serve(await history(1)), "SET_ME_TO_THE_ATTESTATION_ADDRESS");
  assert.equal(r.status, "failed");
  assert.match(r.problems.join(), /ATTESTER is not set/);
});

test("verified snapshots are mirrored byte for byte, then only new ones", async () => {
  const dir = tmp();
  const h = await history(3);
  let r = await sync(dir, serve(h.slice(0, 2)));
  assert.deepEqual([r.status, r.added], ["ok", [1440, 2880]]);
  assert.equal(fs.readFileSync(path.join(dir, "2880.json"), "utf8"), fileText(h[1]));
  r = await sync(dir, serve(h));
  assert.deepEqual([r.status, r.added], ["ok", [4320]]);
  assert.equal(fs.readFileSync(path.join(dir, "index.json"), "utf8"), fileText(buildIndex(h)));
  r = await sync(dir, serve(h));
  assert.deepEqual([r.status, r.added], ["ok", []]);
});

test("a snapshot signed by anyone else is refused", async () => {
  const dir = tmp();
  const r = await sync(dir, serve(await history(1, intruder)));
  assert.equal(r.status, "failed");
  assert.match(r.problems.join(), /not by the expected attester/);
  assert.equal(fs.existsSync(path.join(dir, "1440.json")), false);
});

test("a rewritten snapshot is reported and the mirrored one kept", async () => {
  const dir = tmp();
  const h = await history(2);
  await sync(dir, serve(h));
  const p = structuredClone(h[1].payload);
  p.assets[0].escrowAtoms = "999";
  const rewritten = await signSnapshot(p, key);
  const r = await sync(dir, serve([h[0], rewritten]));
  assert.equal(r.status, "failed");
  assert.match(r.problems.join(), /2880: the bridge now lists hash/);
  assert.equal(fs.readFileSync(path.join(dir, "2880.json"), "utf8"), fileText(h[1]));
});

test("a snapshot that skips its predecessor, or lands in the past, is refused", async () => {
  const dir = tmp();
  const h = await history(3);
  await sync(dir, serve([h[0]]));
  // The bridge dropped 2880: 4320 links to a snapshot the mirror never saw.
  let r = await sync(dir, serve([h[0], h[2]]));
  assert.equal(r.status, "failed");
  assert.match(r.problems.join(), /4320 names 2880 as its predecessor, but the one before it is 1440/);
  // A snapshot inserted below what the mirror already holds.
  const dir2 = tmp();
  await sync(dir2, serve([h[0], h[1], h[2]]));
  const late = await signSnapshot({ height: 2000, previous: { height: 1440, hash: h[0].hash }, attester: key.address, assets: [] }, key);
  r = await sync(dir2, serve([h[0], late, h[1], h[2]]));
  assert.match(r.problems.join(), /2000: listed below 4320/);
});

test("a file that is not canonical, or not the height it is listed as, is refused", async () => {
  const [s] = await history(1);
  let r = await sync(tmp(), bridge({ "/api/por/history": fileText(buildIndex([s])), "/api/por/history/1440": JSON.stringify(s, null, 1) }));
  assert.match(r.problems.join(), /not in canonical form/);
  const index = buildIndex([s]);
  index.snapshots[0].hash = "0".repeat(64);
  r = await sync(tmp(), serve([s], index));
  assert.match(r.problems.join(), /the index says/);
});

test("a tampered mirror is never extended", async () => {
  const dir = tmp();
  const h = await history(2);
  await sync(dir, serve([h[0]]));
  const t = JSON.parse(fs.readFileSync(path.join(dir, "1440.json"), "utf8"));
  t.payload.assets[0].escrowAtoms = "7";
  fs.writeFileSync(path.join(dir, "1440.json"), fileText(t));
  const r = await sync(dir, serve(h));
  assert.equal(r.status, "failed");
  assert.match(r.problems.join(), /^mirror: /);
  assert.equal(fs.existsSync(path.join(dir, "2880.json")), false);
});
