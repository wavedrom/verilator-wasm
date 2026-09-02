// Milestone 5: the Milestone 4 test, fully in-memory, through the JS API.
//
// The golden Vtop.tree.json in test/fixtures/ was produced by native
// verilator_bin, so a pass here is wasm-vs-native byte parity, not
// wasm-vs-itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {createVerilator} from '../lib/index.mjs';

const fixture = name => new URL('./fixtures/' + name, import.meta.url);

const TOP = await readFile(fixture('top.sv'), 'utf8');
const GOLDEN = await readFile(fixture('Vtop.tree.json'));

const verilator = await createVerilator();

const jsonOnly = (files, extraArgs = []) => verilator.run({
  args: ['--json-only', '-O0', '--Mdir', 'out', ...extraArgs, 'top.sv'],
  files
});

test('--json-only -O0 matches the native golden byte for byte', async () => {
  const result = await jsonOnly({'top.sv': TOP});

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /V e r i l a t i o n {3}R e p o r t/);
  assert.deepEqual(
    Object.keys(result.files).sort(),
    ['out/Vtop.tree.json', 'out/Vtop.tree.meta.json']
  );
  assert.ok(
    GOLDEN.equals(Buffer.from(result.filesBytes['out/Vtop.tree.json'])),
    'out/Vtop.tree.json differs from the native reference'
  );
});

test('the seeded VERILATOR_ROOT files are not reported as outputs', async () => {
  const result = await jsonOnly({'top.sv': TOP});
  const leaked = Object.keys(result.files).filter(name => name.includes('verilator-root'));
  assert.deepEqual(leaked, []);
});

test('instance-per-run resets v3Global: two runs are identical', async () => {
  const first = await jsonOnly({'top.sv': TOP});
  const second = await jsonOnly({'top.sv': TOP});

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.ok(
    Buffer.from(first.filesBytes['out/Vtop.tree.json'])
      .equals(Buffer.from(second.filesBytes['out/Vtop.tree.json']))
  );
});

test('a syntax error exits non-zero with a diagnostic, not a throw', async () => {
  const result = await jsonOnly({'top.sv': 'module top;\n  this is not verilog\nendmodule\n'});

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /%Error/);
});

test('a missing input file is a diagnostic, not a throw', async () => {
  const result = await jsonOnly({});

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /top\.sv/);
});

test('-y library dirs exercise fd_readdir and path_create_directory', async () => {
  const result = await verilator.run({
    args: ['--json-only', '-O0', '--Mdir', 'out', '-y', 'lib', 'top.sv'],
    files: {
      'top.sv': 'module top(input logic a, output logic b);\n  sub u(.a(a), .b(b));\nendmodule\n',
      'lib/sub.sv': 'module sub(input logic a, output logic b);\n  always_comb b = ~a;\nendmodule\n'
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  // The library module was found through the -y directory, so the listing worked.
  assert.match(result.files['out/Vtop.tree.json'], /sub/);
});

// Verilator itself only creates the final --Mdir component: native
// verilator_bin fails the same way on a nested path with missing parents, so the
// shim must not paper over it.
test('nested --Mdir with missing parents fails, as it does natively', async () => {
  const result = await verilator.run({
    args: ['--json-only', '-O0', '--Mdir', 'build/nested/out', 'top.sv'],
    files: {'top.sv': TOP}
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Can't write file: build\/nested\/out/);
});

test('streaming callbacks see the same bytes as the captured strings', async () => {
  let streamed = '';
  const result = await verilator.run({
    args: ['--json-only', '-O0', '--Mdir', 'out', 'top.sv'],
    files: {'top.sv': TOP},
    onStdout: chunk => { streamed += chunk; }
  });

  assert.equal(streamed, result.stdout);
});

test('cwd is honoured as a mount', async () => {
  const result = await verilator.run({
    args: ['--json-only', '-O0', '--Mdir', 'out', 'top.sv'],
    files: {'top.sv': TOP},
    cwd: '/work'
  });

  assert.equal(result.exitCode, 0, result.stderr);
  // Keys stay relative to cwd, so they look the same as at the root.
  assert.ok(result.files['out/Vtop.tree.json']);
});
