// fd_readdir must fill the buffer completely (truncated last entry) so
// wasi-libc keeps reading; stopping short ends the directory early.
// Verilator caches directory listings for its module / include lookup, so
// a truncated listing shows up as "Cannot find file containing module".

import test from 'node:test';
import assert from 'node:assert/strict';

import {createVerilator} from '../lib/index.mjs';

const verilator = await createVerilator();

test('module lookup in a directory with 1500 files (-y)', async () => {
  const N = 1500;
  const name = i => 'm' + String(i).padStart(4, '0') + '_with_a_fairly_long_name';
  const files = {};
  let top = 'module top;\n';
  for (let i = 0; i < N; i++) {
    files['lib/' + name(i) + '.sv'] = 'module ' + name(i) + '; endmodule\n';
    top += '  ' + name(i) + ' u' + i + '();\n';
  }
  files['top.sv'] = top + 'endmodule\n';

  const result = await verilator.run({
    args: ['--json-only', '-O0', '--Mdir', 'out', '-y', 'lib', 'top.sv'],
    files
  });
  assert.equal(result.exitCode, 0, result.stderr.slice(0, 500));
});

test('result.files decodes lazily and stays enumerable', async () => {
  const result = await verilator.run({
    args: ['--json-only', '-O0', '--Mdir', 'out', 'top.sv'],
    files: {'top.sv': 'module top; endmodule\n'}
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const keys = Object.keys(result.files).sort();
  assert.deepEqual(keys, ['out/Vtop.tree.json', 'out/Vtop.tree.meta.json']);
  const desc = Object.getOwnPropertyDescriptor(result.files, 'out/Vtop.tree.json');
  assert.equal(typeof desc.get, 'function');
  assert.equal(result.files['out/Vtop.tree.json'],
    Buffer.from(result.filesBytes['out/Vtop.tree.json']).toString('utf8'));
});
