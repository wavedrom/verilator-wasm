#!/usr/bin/env node
// Thin CLI over the library: host files in, host files out. The library is the
// product; this is the fastest way to smoke-test it by hand.
//
//   verilator-wasm --json-only -O0 --Mdir out top.sv
//
// Every argument that resolves to an existing host file is seeded into the VFS,
// as is anything named with --vfs-add. Files the run produces are written back
// under the host cwd.

import {readFile, writeFile, mkdir, stat, readdir} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {createVerilator} from '../lib/index.mjs';

const USAGE = `
Usage: verilator-wasm [--vfs-add <path>]... <verilator arguments>

  --vfs-add <path>   seed an extra host file or directory into the VFS
                      (repeatable). A directory is walked recursively and
                      every file is seeded at multiple keys: its original
                      absolute path, its path relative to the --vfs-add
                      directory, its path relative to that directory's
                      parent, and every path suffix in between (so nested
                      -f/-F files that reference sources relative to their
                      own, possibly deeper, directory still resolve). Every
                      directory holding a seeded file is also passed to
                      verilator as "-y", so modules instantiated but not
                      explicitly listed in a source/-f file can still be
                      found by name.
  --vfs-help         this message

Anything else is passed straight to verilator. Example:
  verilator-wasm --json-only -O0 --Mdir out top.sv
`;

// Recursively collect every regular file under `dir`, as absolute host paths.
const walkFiles = async dir => {
  const out = [];
  const entries = await readdir(dir, {withFileTypes: true});
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
};

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

  for (const candidate of candidates) {
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

  // Every directory that ends up holding a seeded file, as an absolute path.
  // Passed to verilator as "-y" so its own module-name lookup (used when a
  // module is instantiated but not explicitly listed in a source/-f file)
  // can find it, mirroring what a real filesystem with -y would do.
  const moduleDirs = new Set();

  for (const candidate of extra) {
    const info = await stat(candidate);
    if (info.isDirectory()) {
      const dirAbs = path.resolve(candidate);
      const parentAbs = path.dirname(dirAbs);
      for (const hostPath of await walkFiles(candidate)) {
        const contents = await readFile(hostPath);
        const absKey = path.isAbsolute(hostPath) ? hostPath : path.resolve(hostPath);
        // Absolute key: for anything that references files under this
        // directory by full host path (e.g. an -F list built with
        // absolute paths).
        files[absKey] = contents;
        moduleDirs.add(path.dirname(absKey));
        // Relative-to-directory key: for arguments given relative to the
        // --vfs-add directory itself (e.g. "-F allll.F" when allll.F lives
        // at the top of the seeded directory).
        const relKey = path.relative(dirAbs, absKey);
        if (relKey && !relKey.startsWith('..')) {
          files[relKey] = contents;
        }
        // Relative-to-parent key: for references like "<dirname>/sub/file.v"
        // made relative to the seeded directory's own parent (e.g. an -f
        // file inside a "tmp/" dir that lists "tmp/rtl/foo.v").
        const parentRelKey = path.relative(parentAbs, absKey);
        if (parentRelKey && !parentRelKey.startsWith('..')) {
          files[parentRelKey] = contents;
        }
        // Suffix keys: nested -f/-F files can reference sources relative to
        // their own directory, which may be arbitrarily deep under the
        // seeded tree (not just the seeded dir or its parent). Seed every
        // path suffix (e.g. "a/b/c.sv" also as "b/c.sv" and "c.sv") so those
        // lookups still resolve. Only fill in suffixes that aren't already
        // claimed by a more specific/unique key, to avoid ambiguous
        // same-named files clobbering each other.
        const parts = parentRelKey.split(path.sep);
        for (let i = 1; i < parts.length; i++) {
          const suffixKey = parts.slice(i).join(path.sep);
          if (suffixKey && !(suffixKey in files)) {
            files[suffixKey] = contents;
          }
        }
      }
    } else {
      const key = path.isAbsolute(candidate) ? path.basename(candidate) : candidate;
      files[key] = await readFile(candidate);
    }
  }

  // Prepend a "-y" for every directory that holds a seeded file, so
  // verilator can resolve modules instantiated but not explicitly listed
  // in a source/-f file.
  const yArgs = [];
  for (const dir of moduleDirs) {
    yArgs.push('-y', dir);
  }

  const verilator = await createVerilator();
  const result = await verilator.run({
    args: [...yArgs, ...args],
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
