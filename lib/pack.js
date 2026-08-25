'use strict';

// Stage 3 — JS packaging. esbuild the runtime into dist/ beside verilator.wasm.

const fs = require('fs/promises');
const path = require('path');

const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const ENTRY = path.join(__dirname, 'index.mjs');

// node:fs/promises is reached only through a dynamic import guarded by a node
// check; keeping it external stops it being pulled into the browser bundle.
const EXTERNAL = ['node:fs/promises'];

const exists = async p => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const pack = async (opts = {}) => {
  if (!(await exists(path.join(DIST_DIR, 'verilator.wasm')))) {
    throw new Error('pack: dist/verilator.wasm missing — run stage 2 first');
  }

  const targets = [
    {outfile: path.join(DIST_DIR, 'index.mjs'), format: 'esm', platform: 'neutral'},
    {
      outfile: path.join(DIST_DIR, 'index.cjs'),
      format: 'cjs',
      platform: 'node',
      // import.meta.url is how the runtime finds verilator.wasm next to itself.
      // CJS has no import.meta, so shim it from __filename or the .cjs bundle
      // would look for the module in the wrong place.
      define: {'import.meta.url': '__verilatorWasmModuleUrl'},
      banner: 'const __verilatorWasmModuleUrl = require("node:url").pathToFileURL(__filename).href;'
    }
  ];

  for (const target of targets) {
    await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      outfile: target.outfile,
      format: target.format,
      platform: target.platform,
      target: 'es2022',
      external: EXTERNAL,
      define: target.define,
      banner: target.banner ? {js: target.banner} : undefined,
      minify: Boolean(opts.minify),
      sourcemap: Boolean(opts.sourcemap),
      logLevel: 'warning'
    });
    if (opts.verbose) {
      console.log('  ' + path.relative(ROOT, target.outfile) + ' ' + (await fs.stat(target.outfile)).size + ' B');
    }
  }

  await fs.copyFile(path.join(__dirname, 'index.d.ts'), path.join(DIST_DIR, 'index.d.ts'));

  const sizes = await Promise.all(['index.mjs', 'index.cjs', 'index.d.ts', 'verilator.wasm']
    .map(async name => name + ' ' + (await fs.stat(path.join(DIST_DIR, name))).size + ' B'));
  console.log('pack: ' + sizes.join(', '));
};

module.exports = {pack, DIST_DIR};
