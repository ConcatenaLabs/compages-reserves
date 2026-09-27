#!/usr/bin/env node
// Copy new signed reserve snapshots from the bridge into snapshots/, after
// checking each one: signed by the pinned attester, canonical, the height
// and hash the index gives, and linked to the last snapshot already here.
// Nothing already here is ever replaced; a source that has rewritten a
// snapshot this mirror holds is reported, and the run fails.
//
//   SOURCE=https://sequentiatestnet.com/bridge ATTESTER=0x... node sync.mjs
//
// Exit status 0 when the mirror is up to date (including when the bridge
// publishes no history yet, or cannot be reached), 1 when something failed
// a check.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { verifySnapshot, verifyChain, checkLink, buildIndex, parseIndex, fileText } from "./lib/format.mjs";

const SNAPSHOT_FILE = /^(0|[1-9][0-9]*)\.json$/;

function readMirror(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => SNAPSHOT_FILE.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort((a, b) => a.payload.height - b.payload.height);
}

/**
 * One pass. Returns { status, added, problems }: status "no-history" (the
 * bridge publishes none yet), "unreachable", "ok" or "failed".
 */
export async function syncOnce({ source, attester, dir, fetchImpl = fetch, log = console.log }) {
  const base = source.replace(/\/+$/, "");
  const problems = [];
  const added = [];

  let res;
  try {
    res = await fetchImpl(`${base}/api/por/history`, { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    return { status: "unreachable", added, problems: [`${base}: ${e.message}`] };
  }
  if (res.status === 404) return { status: "no-history", added, problems };
  if (!res.ok) return { status: "unreachable", added, problems: [`${base}/api/por/history: HTTP ${res.status}`] };
  let index;
  try {
    index = parseIndex(await res.json());
  } catch {
    index = null;
  }
  // Anything that is not an index (a daemon without the history answers
  // this path with its live report) means there is no history to mirror.
  if (!index || index.snapshots.length === 0) return { status: "no-history", added, problems };

  if (!ethers.isAddress(attester ?? "") || /^0x0{40}$/i.test(attester)) {
    return { status: "failed", added, problems: ["ATTESTER is not set to the bridge's attestation address; nothing can be verified"] };
  }

  const have = readMirror(dir);
  const chain = verifyChain(have, { attester });
  if (!chain.ok) return { status: "failed", added, problems: chain.errors.map((e) => `mirror: ${e}`) };
  const byHeight = new Map(have.map((s) => [s.payload.height, s]));
  let head = have.at(-1) ?? null;

  for (const entry of [...index.snapshots].sort((a, b) => a.height - b.height)) {
    const mine = byHeight.get(entry.height);
    if (mine) {
      if (mine.hash !== entry.hash) {
        problems.push(`${entry.height}: the bridge now lists hash ${entry.hash}, but the snapshot it published was ${mine.hash}`);
      }
      continue;
    }
    if (head && entry.height < head.payload.height) {
      problems.push(`${entry.height}: listed below ${head.payload.height}, which this mirror already holds; history is only ever appended`);
      continue;
    }
    const r = await fetchImpl(`${base}/api/por/history/${entry.height}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) {
      problems.push(`${entry.height}: HTTP ${r.status}`);
      break;
    }
    const text = await r.text();
    let snap;
    try {
      snap = JSON.parse(text);
    } catch {
      problems.push(`${entry.height}: not JSON`);
      break;
    }
    const errs = [];
    const v = verifySnapshot(snap, { attester });
    errs.push(...v.errors);
    if (snap?.payload?.height !== entry.height) errs.push(`holds height ${snap?.payload?.height}`);
    if (v.hash && v.hash !== entry.hash) errs.push(`hashes to ${v.hash}, the index says ${entry.hash}`);
    if (v.hash) errs.push(...checkLink(head, snap));
    try {
      if (text !== fileText(snap)) errs.push("is not in canonical form");
    } catch (e) {
      errs.push(e.message);
    }
    if (errs.length) {
      problems.push(...errs.map((e) => `${entry.height}: ${e}`));
      break; // later snapshots would link to this one
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${entry.height}.json`), text, { flag: "wx" });
    byHeight.set(entry.height, snap);
    head = snap;
    added.push(entry.height);
    log(`mirrored ${entry.height} (sha256 ${v.hash})`);
  }

  if (added.length) {
    fs.writeFileSync(path.join(dir, "index.json"), fileText(buildIndex([...byHeight.values()])));
  }
  return { status: problems.length ? "failed" : "ok", added, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = await syncOnce({
    source: process.env.SOURCE ?? "https://sequentiatestnet.com/bridge",
    attester: process.env.ATTESTER,
    dir: path.join(here, "snapshots"),
  });
  for (const p of r.problems) console.log(`${r.status === "unreachable" ? "::warning::" : "::error::"}${p}`);
  if (r.status === "no-history") console.log("the bridge publishes no snapshot history yet; nothing to do");
  if (r.status === "unreachable") console.log("the bridge could not be reached; trying again next run");
  if (r.status === "ok") console.log(r.added.length ? `mirrored ${r.added.join(", ")}` : "up to date");
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `added=${r.added.join(" ")}\n`);
  process.exit(r.status === "failed" ? 1 : 0);
}
