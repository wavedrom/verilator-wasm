// Stage-3 packaging: both bundles must locate verilator.wasm beside themselves
// and produce the same output as the unbundled library. The .cjs case is the one
// worth guarding — CJS has no import.meta, so the wasm lookup is shimmed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

const distFile = name => new URL('../dist/' + name, import.meta.url);
const packed = existsSync(distFile('index.cjs')) && existsSync(distFile('index.mjs'));

const TOP = readFileSync(new URL('./fixtures/top.sv', import.meta.url), 'utf8');
const GOLDEN = readFileSync(new URL('./fixtures/Vtop.tree.json', import.meta.url));

const runOnce = async createVerilator => {
  const verilator = await createVerilator();
  return verilator.run({
    args: ['--json-only', '-O0', '--Mdir', 'out', 'top.sv'],
    files: {'top.sv': TOP}
  });
};

test('dist/index.cjs resolves the wasm and matches the golden', {skip: !packed && 'run stage 3 first'}, async () => {
  const {createVerilator} = require(distFile('index.cjs').pathname);
  const result = await runOnce(createVerilator);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(GOLDEN.equals(Buffer.from(result.filesBytes['out/Vtop.tree.json'])));
});

test('dist/index.mjs resolves the wasm and matches the golden', {skip: !packed && 'run stage 3 first'}, async () => {
  const {createVerilator} = await import(distFile('index.mjs'));
  const result = await runOnce(createVerilator);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(GOLDEN.equals(Buffer.from(result.filesBytes['out/Vtop.tree.json'])));
});
