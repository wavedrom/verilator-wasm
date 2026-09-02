// Guards on the build products themselves. A module can link clean and still be
// wrong: the EH-flavour failure presented exactly that way, and a stray import
// would mean the single-threaded assumption had broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {inspectWasm, assertWasiOnly} = require('../lib/wasm-inspect.js');
const {parseTuList} = require('../lib/tu-list.js');

const repoFile = name => new URL('../' + name, import.meta.url);

const config = JSON.parse(readFileSync(repoFile('verilator.json'), 'utf8'));
const EXPECTED_COUNT = config.expectedTuCount;

const manifestPath = repoFile('gen/manifest.json');
const wasmPath = repoFile('dist/verilator.wasm');

// The 24 imports the proven build declares. Growth here is a design change, not
// an accident: the shim in lib/wasi.mjs implements exactly this set.
const EXPECTED_IMPORTS = [
  'args_get', 'args_sizes_get', 'clock_time_get', 'environ_get', 'environ_sizes_get',
  'fd_close', 'fd_fdstat_get', 'fd_fdstat_set_flags', 'fd_prestat_dir_name',
  'fd_prestat_get', 'fd_read', 'fd_readdir', 'fd_seek', 'fd_write',
  'path_create_directory', 'path_filestat_get', 'path_filestat_set_times',
  'path_open', 'path_readlink', 'path_unlink_file', 'poll_oneoff', 'proc_exit',
  'random_get', 'sched_yield'
].map(name => 'wasi_snapshot_preview1.' + name);

test('the TU list is exactly the native link line', async () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.tus.length, EXPECTED_COUNT);

  // Re-derive from the fork when it is checked out beside this repo: the manifest
  // must not drift from Makefile_obj.in. Resolved the same way the build driver
  // resolves it (relative to repo root, per verilator.json's "path"), not a
  // hardcoded guess — that guess goes stale the moment the pinned checkout moves.
  const forkRoot = new URL(config.path + '/', repoFile('.'));
  if (existsSync(new URL('src/Makefile_obj.in', forkRoot))) {
    assert.deepEqual(await parseTuList(forkRoot.pathname), manifest.tus);
  }
});

test('verilator.wasm imports only WASI and exports only memory + _start', () => {
  const imports = assertWasiOnly(readFileSync(wasmPath));
  assert.deepEqual(imports, EXPECTED_IMPORTS);
});

test('verilator.wasm carries no DWARF and instantiates', async () => {
  const bytes = readFileSync(wasmPath);
  // llvm-strip ran, so the custom debug sections are gone.
  assert.ok(!bytes.includes(Buffer.from('.debug_info')), 'DWARF still present in the shipped module');

  const module = await WebAssembly.compile(bytes);
  const {imports} = inspectWasm(bytes);
  const stubs = Object.fromEntries(imports.map(entry => [entry.name, () => 0]));
  stubs.proc_exit = () => { throw new Error('exit'); };
  // Instantiating is the real gate — linking clean proves nothing.
  const instance = await WebAssembly.instantiate(module, {wasi_snapshot_preview1: stubs});
  assert.equal(typeof instance.exports._start, 'function');
});
