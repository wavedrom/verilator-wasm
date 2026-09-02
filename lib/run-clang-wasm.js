'use strict';

// Stage 2 — the only wasm stage: compile all TUs (count pinned in
// verilator.json as expectedTuCount) to wasm32-wasip1 and link.
//
// The flag set below is not a starting point to tune; it is the set that was
// measured to produce a module whose --json-only output is byte-identical to
// native verilator_bin. Notes on every non-obvious entry are inline.
//
// -Os (compile and link) was measured against -O2: ~14% smaller stripped
// output (7.74 MB -> 6.68 MB) with identical --json-only golden output.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {exec} = require('./exec.js');
const {resolveTuSource} = require('./tu-list.js');
const {assertWasiOnly} = require('./wasm-inspect.js');

const ROOT = path.resolve(__dirname, '..');
const GEN_DIR = path.join(ROOT, 'gen');
const OBJ_DIR = path.join(ROOT, 'obj');
const DIST_DIR = path.join(ROOT, 'dist');

const wasiSdk = () => process.env.WASI_SDK || '/opt/wasi-sdk';

const TARGET = '--target=wasm32-wasip1';

// Harvested from Verilator's own native compile line, plus the wasm target.
const COMMON_FLAGS = [
  TARGET,
  // Verilator's autotools build sets this (configure.ac:510) and its non-Windows
  // path is genuinely exception-free: zero real throws, and every try/catch and
  // std::filesystem use sits behind #ifdef _MSC_VER. This also selects wasi-sdk's
  // default `noeh` libc++, which sidesteps the legacy-vs-standard wasm EH
  // mismatch entirely.
  '-fno-exceptions'
];

const COMPILE_FLAGS = [
  '-Os',
  '-DVERILATOR_INTERNAL_',
  '-faligned-new',
  '-Wno-shadow',
  '-Wno-unused-parameter',
  // Each must expand to a *string literal*; spawn() with no shell keeps the
  // inner quotes, which is what an earlier shell-based attempt lost.
  '-DDEFENV_SYSTEMC=""',
  '-DDEFENV_SYSTEMC_ARCH=""',
  '-DDEFENV_SYSTEMC_INCLUDE=""',
  '-DDEFENV_SYSTEMC_LIBDIR=""',
  '-DDEFENV_VERILATOR_ROOT=""',
  '-DDEFENV_VERILATOR_SOLVER=""'
  // Deliberately absent:
  //   -std=       — autotools passes none and relies on the compiler default
  //                 (gnu++17); configure.ac's -std=c++20 check is commented out.
  //   -DVL_IGNORE_UNKNOWN_ARCH — the fork has a real #elif defined(__wasm__) arm
  //                 for VL_CPU_RELAX(); the hatch would also mask the #error for
  //                 a genuinely unhandled architecture.
  //   -flto       — not needed for size, and it makes link errors unreadable.
  //   -pthread / -matomics / --shared-memory — wasm32-wasip1 has no shared memory.
];

const LINK_FLAGS = [
  // Measured, not theoretical: without an explicit stack size the link dies with
  // `RuntimeError: memory access out of bounds` on a *two-line* top.sv. 8 MB is
  // enough for that; it is still a guess for large designs.
  '-Wl,-z,stack-size=8388608',
  '-Wl,--initial-memory=268435456',
  // wasm32 cannot address 4 GiB. Cap at 2 GiB and rely on memory.grow.
  '-Wl,--max-memory=2147483648'
];

const includeFlags = forkRoot => [
  // gen/ first: its copies of config_*.h and verilated_config.h are the cached
  // stage-1 products and must win over anything left in the fork tree.
  '-I', GEN_DIR,
  '-I', path.join(forkRoot, 'src'),
  '-I', path.join(forkRoot, 'include')
];

// Bounded-concurrency map. Compiling every TU at -O2 is not a fast rebuild,
// and ccache only helps on the second pass.
const pool = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, runner));
  return results;
};

const exists = async p => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const compileAll = async (manifest, opts = {}) => {
  const forkRoot = opts.forkRoot;
  const jobs = opts.jobs || os.cpus().length;
  const clang = path.join(wasiSdk(), 'bin', 'clang++');

  if (!(await exists(clang))) {
    throw new Error('run-clang-wasm: ' + clang + ' not found; set WASI_SDK or run bin/install-wasi-sdk.sh');
  }

  await fs.mkdir(OBJ_DIR, {recursive: true});

  const useCcache = opts.ccache !== false && !process.env.CCACHE_DISABLE;
  const launcher = useCcache ? 'ccache' : clang;
  const prefixArgs = useCcache ? [clang] : [];

  const includes = includeFlags(forkRoot);
  let done = 0;

  await pool(manifest.tus, jobs, async name => {
    const source = await resolveTuSource(name, forkRoot, GEN_DIR);
    const object = path.join(OBJ_DIR, name + '.o');
    const args = [
      ...prefixArgs,
      ...COMMON_FLAGS,
      ...COMPILE_FLAGS,
      ...includes,
      '-MMD', '-MF', path.join(OBJ_DIR, name + '.d'),
      '-c', source,
      '-o', object
    ];
    await exec(launcher, args, {capture: !opts.verbose});
    done++;
    if (opts.verbose) {
      console.log('  [' + done + '/' + manifest.tus.length + '] ' + name);
    } else if (done % 20 === 0 || done === manifest.tus.length) {
      console.log('  compiled ' + done + '/' + manifest.tus.length);
    }
    return object;
  });

  return manifest.tus.map(name => path.join(OBJ_DIR, name + '.o'));
};

const sizeReport = async (files, opts = {}) => {
  const rows = [];
  for (const [label, file] of files) {
    if (!(await exists(file))) {
      continue;
    }
    const bytes = (await fs.stat(file)).size;
    rows.push({label, bytes, mib: (bytes / (1024 * 1024)).toFixed(2)});
  }
  if (opts.brotli) {
    const data = await fs.readFile(files[files.length - 1][1]);
    const compressed = await new Promise((resolve, reject) =>
      zlib.brotliCompress(data, {params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 11}},
        (err, out) => err ? reject(err) : resolve(out)));
    rows.push({label: 'brotli -q 11 (over the wire)', bytes: compressed.length,
      mib: (compressed.length / (1024 * 1024)).toFixed(2)});
  }
  for (const row of rows) {
    console.log('  ' + row.label.padEnd(34) + String(row.bytes).padStart(11) + '  ' + row.mib + ' MiB');
  }
  return rows;
};

const link = async (objects, opts = {}) => {
  const clang = path.join(wasiSdk(), 'bin', 'clang++');
  const strip = path.join(wasiSdk(), 'bin', 'llvm-strip');

  await fs.mkdir(DIST_DIR, {recursive: true});

  const raw = path.join(DIST_DIR, 'verilator.debug.wasm');
  const out = path.join(DIST_DIR, 'verilator.wasm');

  console.log('run-clang-wasm: linking ' + objects.length + ' objects');
  await exec(clang, [
    ...COMMON_FLAGS,
    '-Os',
    ...LINK_FLAGS,
    ...objects,
    '-o', raw
  ]);

  // llvm-strip removes DWARF, which is ~34% of the unstripped module. A
  // binaryen wasm-opt pass was measured to shave a further ~2% off, but that
  // is not worth the extra build dependency, so ship the stripped output
  // directly and keep the unstripped copy for debugging.
  await exec(strip, [raw, '-o', out]);

  // A wasm module can link clean and still refuse to instantiate, and a stray
  // import (pthread_create, say) means the single-threaded assumption broke.
  // Fail the build here rather than discover it at runtime.
  const imports = assertWasiOnly(await fs.readFile(out));
  console.log('run-clang-wasm: ' + imports.length + ' imports, all wasi_snapshot_preview1; exports memory + _start');

  await sizeReport([
    ['as linked (with DWARF)', raw],
    ['llvm-strip', out]
  ], opts);

  if (!opts.keepDebug) {
    await fs.rm(raw, {force: true});
  }

  return out;
};

const buildWasm = async (manifest, opts = {}) => {
  const objects = await compileAll(manifest, opts);
  return link(objects, opts);
};

module.exports = {compileAll, link, buildWasm, OBJ_DIR, DIST_DIR};
