#!/usr/bin/env node
// Thin CLI over the library: host files in, host files out. The library is the
// product; this is the fastest way to smoke-test it by hand.
//
//   verilator-wasm --json-only -O0 --Mdir out top.sv
//
// Every argument that resolves to an existing host file is seeded into the VFS,
// as is anything named with --vfs-add. Files the run produces are written back
// under the host cwd.

import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {createVerilator} from '../lib/index.mjs';

const USAGE = `
Usage: verilator-wasm [--vfs-add <path>]... <verilator arguments>

  --vfs-add <path>   seed an extra host file into the VFS (repeatable)
  --vfs-help         this message

Anything else is passed straight to verilator. Example:
  verilator-wasm --json-only -O0 --Mdir out top.sv
`;

const main = async () => {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes('--vfs-help')) {
    process.stdout.write(USAGE.trimStart());
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const args = [];
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vfs-add') {
      extra.push(argv[++i]);
    } else {
      args.push(argv[i]);
    }
  }

  const isHostFile = async value => {
    if (typeof value !== 'string' || value.startsWith('-')) {
      return false;
    }
    try {
      return (await stat(value)).isFile();
    } catch {
      return false;
    }
  };

  const candidates = [];
  for (const value of args) {
    if (await isHostFile(value)) {
      candidates.push(value);
    }
  }

  const files = {};
  for (const candidate of [...candidates, ...extra]) {
    // Keys are relative to the VFS mount, so a host-absolute path is normalised.
    const key = path.isAbsolute(candidate) ? path.basename(candidate) : candidate;
    files[key] = await readFile(candidate);
    if (key !== candidate) {
      // Rewrite the argument so verilator looks the file up where it landed.
      const index = args.indexOf(candidate);
      if (index !== -1) {
        args[index] = key;
      }
    }
  }

  const verilator = await createVerilator();
  const result = await verilator.run({
    args,
    files,
    onStdout: chunk => process.stdout.write(chunk),
    onStderr: chunk => process.stderr.write(chunk)
  });

  for (const [name, bytes] of Object.entries(result.filesBytes)) {
    const target = path.resolve(process.cwd(), name);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, bytes);
  }

  process.exit(result.exitCode);
};

main().catch(err => {
  process.stderr.write('verilator-wasm: ' + (err.stack || err.message) + '\n');
  process.exit(1);
});
