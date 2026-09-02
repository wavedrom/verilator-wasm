#!/usr/bin/env node
'use strict';

// CI gate: catch tarball bloat before it ships. This is the mechanical half of
// plans/npm.md step 5 — `files[]` in package.json is the only guard against
// accidental inclusion (no .npmignore), so this asserts the *result* of that
// allowlist stays small instead of trusting the allowlist forever.
//
// Budget is generous around the current known-good size (~6.9 MB unpacked,
// dominated by dist/verilator.wasm at ~6.7 MB) so a real regression — e.g.
// `files[]` widened back to "gen/" instead of "gen/vroot-data.mjs" — trips
// it, without false-triggering on small legitimate growth.

const {execFileSync} = require('child_process');

const UNPACKED_BUDGET_BYTES = 10 * 1024 * 1024; // 10 MiB

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {encoding: 'utf8'});
const [pkg] = JSON.parse(raw);

console.log(`verilator-wasm@${pkg.version}: ${pkg.files.length} files, ` +
  `${pkg.unpackedSize} B unpacked (${(pkg.unpackedSize / 1024 / 1024).toFixed(2)} MiB)`);

if (pkg.unpackedSize > UNPACKED_BUDGET_BYTES) {
  console.error(
    `check-pack-size: unpacked size ${pkg.unpackedSize} B exceeds budget ` +
    `${UNPACKED_BUDGET_BYTES} B. Likely files[] in package.json widened back ` +
    'to a whole directory (gen/, lib/) instead of the specific runtime files ' +
    'the CLI/library actually import. Full file list:'
  );
  for (const f of pkg.files) {
    console.error(`  ${f.size.toString().padStart(10)}  ${f.path}`);
  }
  process.exit(1);
}
