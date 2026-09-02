# AGENTS.md

Verilator compiled to wasm32-wasip1 + in-memory FS. See README.md for usage/design.

## Layout

- `lib/` runtime + build drivers (source of truth, hand-written JS)
- `bin/build.js` 3-stage build CLI; `bin/verilator-wasm.mjs` CLI entry
- `gen/` cached host-build output (flex/bison/astgen), stage 1 product
- `obj/` stage 2 `.o`/`.d` compile cache
- `dist/` stage 3 output: `index.mjs`/`index.cjs`/`index.d.ts`/`verilator.wasm` — never hand-edit
- `test/` node:test, golden JSON in `test/fixtures/`
- `plans/wasm.md` design notes; `plans/fork.md` Verilator fork patches/upstreaming
- `verilator.json` pins sibling Verilator checkout (path/url/branch/rev)

## Build

Requires wasi-sdk 33 at `/opt/wasi-sdk` (`bin/install-wasi-sdk.sh`) and sibling
checkout of the fork pinned in `verilator.json`.

```
node bin/build.js                 # all 3 stages
node bin/build.js --stage 2,3      # skip host regen, reuse gen/
node bin/build.js --stage 3        # repack JS only
node bin/build.js --clean          # wipe obj/ + dist/ first
node bin/build.js --help
```

Stages: 1 host codegen (autotools, fills `gen/`) → 2 wasm compile/link (166 TUs,
`obj/` → `dist/verilator.wasm`) → 3 JS packaging (esbuild → `dist/`).

## Test

```
npm test        # node --test test/*.test.mjs
```

`test/dist.test.mjs` needs stage 3 output present, else it self-skips.
Correctness bar: `--json-only` AST output must byte-match `test/fixtures/Vtop.tree.json`.

## Debugging notes

- `V3Global`/verilator `main()` is not re-entrant per process — each `run()`
  must get a fresh module instance (see lib/exec.js).
- WASI shim is hand-rolled in `lib/wasi.mjs` (24 imports only); `node:wasi` not
  usable (needs real-dir preopens, incompatible with in-memory FS `lib/vfs.mjs`).
- Only `--json-only`/`--lint-only`-shaped work is in scope; `--build`,
  `--hierarchical`, coverage, and multi-threaded verilation are out (need
  `V3Os::system()` or native compile).
- Build failures usually trace to: wasi-sdk path/version, missing/mismatched
  sibling Verilator checkout rev (`--allow-drift` to bypass), or stale `gen/`/`obj/`
  (use `--clean` or narrow `--stage`).
