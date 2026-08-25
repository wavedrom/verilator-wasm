#!/usr/bin/env node
'use strict';

// Three-stage build driver. Only stage 2 is wasm.
//
//   1  host code generation — the fork's own autotools build, cached into gen/
//   2  wasm compile + link   — 165 TUs -> dist/verilator.wasm
//   3  JS packaging          — esbuild the library into dist/

const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const {parseArgs} = require('util');

const {genHost, readManifest, resolveVerilator} = require('../lib/gen-host.js');
const {buildWasm} = require('../lib/run-clang-wasm.js');
const {pack} = require('../lib/pack.js');

const ROOT = path.resolve(__dirname, '..');

const USAGE = `
Usage: node bin/build.js [options]

  --stage <list>      stages to run, e.g. "1", "2,3" (default: 1,2,3)
  --jobs <n>          parallel compile jobs (default: ${os.cpus().length})
  --verilator <path>  Verilator checkout (default: verilator.json "path")
  --allow-drift       build even if the checkout is not at the pinned rev
  --skip-make         reuse an existing native build, do not run make
  --no-ccache         bypass ccache for stage 2
  --keep-debug        keep dist/verilator.debug.wasm (unstripped, with DWARF)
  --brotli            also report the brotli -q 11 size
  --clean             remove obj/ and dist/ first
  --verbose           per-TU output
  --help
`;

const parseStages = value => {
  if (!value) {
    return [1, 2, 3];
  }
  const stages = value.split(',').map(s => Number(s.trim()));
  for (const stage of stages) {
    if (![1, 2, 3].includes(stage)) {
      throw new Error('build: unknown stage "' + stage + '"');
    }
  }
  return stages;
};

const build = async () => {
  const {values} = parseArgs({
    options: {
      stage: {type: 'string'},
      jobs: {type: 'string'},
      verilator: {type: 'string'},
      'allow-drift': {type: 'boolean'},
      'skip-make': {type: 'boolean'},
      ccache: {type: 'boolean', default: true},
      'keep-debug': {type: 'boolean'},
      brotli: {type: 'boolean'},
      clean: {type: 'boolean'},
      verbose: {type: 'boolean'},
      help: {type: 'boolean'}
    },
    allowNegative: true
  });

  if (values.help) {
    console.log(USAGE.trim());
    return;
  }

  const stages = parseStages(values.stage);
  const opts = {
    jobs: values.jobs ? Number(values.jobs) : os.cpus().length,
    verilator: values.verilator,
    allowDrift: values['allow-drift'],
    skipMake: values['skip-make'],
    ccache: values.ccache,
    keepDebug: values['keep-debug'],
    brotli: values.brotli,
    verbose: values.verbose
  };

  if (values.clean) {
    for (const dir of ['obj', 'dist']) {
      await fs.rm(path.join(ROOT, dir), {recursive: true, force: true});
    }
    console.log('build: cleaned obj/ dist/');
  }

  const timings = [];
  const stamp = async (label, fn) => {
    const t0 = Date.now();
    const result = await fn();
    timings.push([label, (Date.now() - t0) / 1000]);
    return result;
  };

  let manifest = null;

  if (stages.includes(1)) {
    manifest = await stamp('stage 1 (host codegen)', () => genHost(opts));
    opts.forkRoot = manifest.forkRoot;
  }

  if (stages.includes(2) || stages.includes(3)) {
    if (!manifest) {
      manifest = await readManifest();
      opts.forkRoot = (await resolveVerilator(opts)).root;
    }
  }

  if (stages.includes(2)) {
    await stamp('stage 2 (wasm compile + link)', () => buildWasm(manifest, opts));
  }

  if (stages.includes(3)) {
    await stamp('stage 3 (js packaging)', () => pack(opts));
  }

  console.log('');
  for (const [label, seconds] of timings) {
    console.log('  ' + label.padEnd(30) + seconds.toFixed(1) + ' s');
  }
};

build().catch(err => {
  console.error(String(err.message || err));
  process.exit(1);
});
