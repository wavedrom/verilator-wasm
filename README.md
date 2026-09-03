# verilator-wasm

[![npm](https://img.shields.io/npm/v/verilator-wasm.svg)](https://www.npmjs.com/package/verilator-wasm)
[![node](https://img.shields.io/node/v/verilator-wasm.svg)](https://www.npmjs.com/package/verilator-wasm)
[![downloads](https://img.shields.io/npm/dm/verilator-wasm.svg)](https://www.npmjs.com/package/verilator-wasm)
[![license](https://img.shields.io/npm/l/verilator-wasm.svg)](./NOTICE)

Verilator compiled to `wasm32-wasip1` and driven through an in-memory
filesystem. Runs in node, the browser, a worker, and a VSCode extension or
webview — no native toolchain, no Docker, no server round-trip.

Output is byte-identical to native `verilator_bin`: the `--json-only` AST that
this produces matches the golden reference in `test/fixtures/` exactly.

## Part of the `verilator` npm family

This package is the universal-reach counterpart to
[`verilator`](https://www.npmjs.com/package/verilator) (native prebuilt
binaries for linux-x64/darwin-x64/darwin-arm64,
[drom/npm-verilator](https://github.com/drom/npm-verilator)). That package's
`verilator` command uses this one automatically as a fallback whenever no
native binary is available — native Windows, an unsupported `os`/`cpu`, or a
sandboxed install that skipped the native `optionalDependency` — so most
users never need to depend on `verilator-wasm` directly.

Reach for this package directly instead of `verilator` when you already know
you want the wasm engine specifically: browser or VSCode-webview code (no
process to spawn at all), a sandboxed/serverless environment where spawning a
native binary isn't an option, or you want the in-memory-VFS `run()` API
rather than a CLI over a real filesystem. `verilator`'s shim is a thin
`spawnSync` over this package's own CLI (`bin/verilator-wasm.mjs`) for exactly
this reason — the two are not competing implementations, one wraps the other.

The trade-off either way is: no `--build`/`--hierarchical` (both shell out,
which WASI can't do), no compiling the emitted C++, and slower than native.
See **Supported** below for exactly what that leaves in scope.

## Install

```
npm i verilator-wasm
```

No native toolchain, no postinstall step, no platform-specific binary: one
6.4 MiB `verilator.wasm` plus the JS loader, the same artifact everywhere.

## Use

```js
import { createVerilator } from 'verilator-wasm';

const verilator = await createVerilator();       // compiles the module once

const result = await verilator.run({
  args: ['--json-only', '-O0', '--Mdir', 'out', 'top.sv'],
  files: { 'top.sv': 'module top; ... endmodule' }
});

result.exitCode    // 0 on success; a v3fatal arrives here, not as a throw
result.stdout      // string
result.stderr      // string — diagnostics live here
result.files       // { 'out/Vtop.tree.json': '...' } created or modified
result.filesBytes  // the same files, undecoded
```

`files` in, `files` out. The VFS is built fresh per `run()`, and each run gets a
new instance of the once-compiled module — Verilator's `main()` is not
re-entrant, since `v3Global` is global state and the run ends in `exit()`.

Optional `run()` arguments: `cwd` (default `/`), `env`, `onStdout` / `onStderr`
for streaming, and `now` / `random` for reproducible runs.

A CLI is included for hand testing; the library is the product:

```
npx verilator-wasm --json-only -O0 --Mdir out top.sv
```

Positional sources and anything named with `--vfs-add` are seeded into the VFS;
files the run produces are written back under the host cwd. `--vfs-add` takes a
file or a directory, and is repeatable:

```
npx verilator-wasm --vfs-add rtl --json-only -O0 -F rtl/files.F
```

A directory is walked recursively and every file is seeded under several keys —
its absolute host path, its path relative to the `--vfs-add` directory, its path
relative to that directory's parent, and every remaining path suffix — because
nested `-f`/`-F` lists resolve their entries relative to their own, possibly
deeper, directory. Every directory holding a seeded file is also passed as `-y`,
so modules that are instantiated but never listed in a source/`-f` file still
resolve by module name. Run `npx verilator-wasm --vfs-help` for the full text.

## Supported

The wasm module is a full compile of `verilator_bin` — all 166 translation
units on its native link line, not a stripped-down build for one mode. `main()`
pulls in the whole pass registry regardless of the mode flag, so nothing
mode-specific was left out at compile time.

`--json-only -O0` is verified byte-identical to native and pinned by a golden
fixture (`test/fixtures/Vtop.tree.json`) — that's the correctness bar this
repo holds itself to. `--lint-only`, `--cc`/`--sc`, `--xml-only`, and other
single-pass, single-process modes are compiled in and reachable through the
same `run()` — `--cc --protect-ids` is confirmed live (getentropy-backed
random identifiers differ run to run) — but don't yet have their own
byte-parity fixture. Anything that does not shell out or need a second
compiler is fair game; only what's actually been checked against native is
called done in [plans/wasm.md](plans/wasm.md).

Out of scope by construction, not just untested: `--build` and
`--hierarchical` (both need `V3Os::system()`, which wasi-libc declares but
traps rather than runs), compiling the emitted C++ (a second compiler, not on
the table), `verilator_coverage`/`verilator_gantt`/`verilator_profcfunc`
(separate binaries, never on this link line), and multi-threaded verilation
(the module imports `wasi_snapshot_preview1` only — no `pthread_create`).

## Versioning

`verilator-wasm` versions its own JS API (`createVerilator`, `run()`, the VFS
contract) under plain semver — it is deliberately *not* pinned to the upstream
Verilator release number the way [`verilator`](https://www.npmjs.com/package/verilator)
is, since that package is a repack of upstream binaries and this one carries an
API of its own.

The engine version is data, not the package version: the wasm in this release is
built from the fork rev pinned in [verilator.json](verilator.json) and reports
itself as `Verilator 5.051 devel rev v5.050-301-ge6cee9d54`. Every run prints it
with `--version` or in the verilation report.

## Build

Needs [wasi-sdk](bin/install-wasi-sdk.sh) 33 at `/opt/wasi-sdk` and
a sibling checkout of the Verilator fork pinned in [verilator.json](verilator.json).

```
node bin/build.js            # all three stages
node bin/build.js --help
npm test
```

Three stages, only the second of which is wasm:

| Stage | Driver | Product |
| --- | --- | --- |
| 1 | [lib/gen-host.js](lib/gen-host.js) | the fork's own autotools build; flex/bison/astgen output cached in `gen/` |
| 2 | [lib/run-clang-wasm.js](lib/run-clang-wasm.js) | 166 TUs → `dist/verilator.wasm` (6.4 MiB stripped, 1.22 MiB brotli) |
| 3 | [lib/pack.js](lib/pack.js) | `dist/index.mjs`, `dist/index.cjs`, `dist/index.d.ts` |

The runtime is dependency-free: [lib/vfs.mjs](lib/vfs.mjs) is the in-memory
filesystem and [lib/wasi.mjs](lib/wasi.mjs) is a WASI preview1 shim implementing
exactly the 24 imports the module declares. `node:wasi` is not used — it only
accepts real-directory preopens, so an in-memory filesystem is impossible with
it.

Design notes, measurements and milestones: [plans/wasm.md](plans/wasm.md). The
Verilator-side patches and their upstreaming: [plans/fork.md](plans/fork.md).
