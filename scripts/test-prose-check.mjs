#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Regression tests for the Vale rule packs in this repo.
//
// Adapted from agentnative-spec's scripts/test-prose-check.mjs at v0.4.0.
// The runner shape and assertion model are identical (spawn `vale` against
// each fixture, assert the expected rule fired at least once); the CASES
// array is site-specific — brand rules (universal, vendored) plus the two
// site-channel rules authored at U1 of the prose-check site plan.
//
// Spawns `vale` against each fixture under scripts/__fixtures__/prose-check/
// and asserts that the expected rule (e.g., brand.MarketingRegister,
// site.BannedFonts) fired at least once. Collateral rule firings are
// allowed; fixtures optimize for "this rule must catch its target", not
// "no other rule touches this fixture".
//
// Invoked manually by developers; not wired into pre-push (the orchestrator
// already runs Vale + LT once per push, running fixtures via the orchestrator
// would double the work).
//
// Exits 0 on all-pass, 1 on any case failure.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "__fixtures__/prose-check");

const CASES = [
  { name: "marketing-register", expect: /brand\.MarketingRegister/ },
  { name: "hedge-words", expect: /brand\.HedgeWords/ },
  { name: "filler-adjectives", expect: /brand\.FillerAdjectives/ },
  { name: "banned-fonts", expect: /site\.BannedFonts/ },
  { name: "banned-aesthetics", expect: /site\.BannedAesthetics/ },
];

let failed = 0;
for (const c of CASES) {
  const fixture = path.join(FIXTURES, c.name, "case.md");
  const res = spawnSync(
    "vale",
    ["--no-global", "--output=line", "--minAlertLevel=warning", fixture],
    { encoding: "utf8" },
  );
  const combined = (res.stdout ?? "") + (res.stderr ?? "");
  const ok = c.expect.test(combined);
  if (ok) {
    console.log(`  pass  ${c.name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${c.name}`);
    console.error(`        expected substring ${c.expect}`);
    console.error(`        vale exit=${res.status}`);
    console.error(`        output:\n${combined.split("\n").map((l) => `          ${l}`).join("\n")}`);
  }
}

if (failed > 0) {
  console.error(`\ntest-prose-check: ${failed}/${CASES.length} case(s) failed`);
  process.exit(1);
}
console.log(`\ntest-prose-check: ${CASES.length}/${CASES.length} OK`);
