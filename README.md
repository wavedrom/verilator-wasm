# verilator-wasm

Verilator compiled to `wasm32-wasip1` and driven through an in-memory
filesystem. Runs in node, the browser, a worker, and a VSCode extension or
webview — no native toolchain, no Docker, no server round-trip.

Output is byte-identical to native `verilator_bin`: the `--json-only` AST that
this produces matches the golden reference in `test/fixtures/` exactly.

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

## Supported

`--json-only` and `--lint-only` shaped work: anything that does not shell out.
Out of scope by construction: `--build` and `--hierarchical` (both need
`V3Os::system()`), compiling the emitted C++, `verilator_coverage`, and
multi-threaded verilation.

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
| 2 | [lib/run-clang-wasm.js](lib/run-clang-wasm.js) | 166 TUs → `dist/verilator.wasm` (6.4 MB stripped, 1.22 MB brotli) |
| 3 | [lib/pack.js](lib/pack.js) | `dist/index.mjs`, `dist/index.cjs`, `dist/index.d.ts` |

The runtime is dependency-free: [lib/vfs.mjs](lib/vfs.mjs) is the in-memory
filesystem and [lib/wasi.mjs](lib/wasi.mjs) is a WASI preview1 shim implementing
exactly the 24 imports the module declares. `node:wasi` is not used — it only
accepts real-directory preopens, so an in-memory filesystem is impossible with
it.

Design notes, measurements and milestones: [plans/wasm.md](plans/wasm.md). The
Verilator-side patches and their upstreaming: [plans/fork.md](plans/fork.md).
