'use strict';

// Stage 1 — host code generation. Native tools only, no wasm.
//
// Verilator's build is not just "compile the .cpp files": configure, bison,
// flex and astgen all run first. Rather than reimplement any of that, run the
// fork's own autotools build and cache its products in gen/, so a downstream
// consumer needs no python, flex, bison or autoconf.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {exec, execCapture} = require('./exec.js');
const {parseTuList} = require('./tu-list.js');

const ROOT = path.resolve(__dirname, '..');
const GEN_DIR = path.join(ROOT, 'gen');

// Generated sources and headers, copied flat into gen/.
// V3Lexer.yy.cpp / V3PreLex.yy.cpp are the post-flexfix files that actually get
// compiled; the *_pregen ones are intermediates, copied only so the #line
// directives inside them resolve for diagnostics.
const OBJ_OPT_GLOBS = [
  /^V3Ast__gen_.*\.h$/,
  /^V3Dfg__gen_.*\.h$/
];

const OBJ_OPT_FILES = [
  'V3Const__gen.cpp',
  'V3ParseBison.c',
  'V3ParseBison.h',
  'V3Lexer.yy.cpp',
  'V3Lexer_pregen.yy.cpp',
  'V3PreLex.yy.cpp',
  'V3PreLex_pregen.yy.cpp'
];

// configure products. None of these are in the fork's git, so caching them is
// what lets a consumer compile from a plain source checkout.
const CONFIG_FILES = [
  ['src/config_build.h', 'config_build.h'],
  ['src/config_package.h', 'config_package.h'],
  ['src/config_rev.h', 'config_rev.h'],
  ['include/verilated_config.h', 'verilated_config.h']
];

// The entire VFS seed set for --json-only: 11 KB, bisected by removal.
// VERILATOR_ROOT must point at their parent or the lookup fails.
const VROOT_FILES = [
  ['include/verilated_std.sv', 'verilated_std.sv'],
  ['include/verilated_std_waiver.vlt', 'verilated_std_waiver.vlt']
];

// config_rev.h is rewritten by every make (it holds `git describe` output), so
// it must not participate in the cache key or every build looks dirty.
const CACHE_KEY_EXCLUDE = new Set(['config_rev.h']);

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

const exists = async p => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const readConfig = async () => {
  const configPath = path.join(ROOT, 'verilator.json');
  if (!(await exists(configPath))) {
    throw new Error('gen-host: missing ' + configPath);
  }
  return JSON.parse(await fs.readFile(configPath, 'utf8'));
};

// Sibling checkout, not a submodule: the fork is an independently developed repo
// with its own upstream relationship. Clone it only if it is missing.
const resolveVerilator = async (opts = {}) => {
  const config = await readConfig();
  const forkRoot = path.resolve(ROOT, opts.verilator || config.path);

  if (!(await exists(path.join(forkRoot, 'src', 'Makefile_obj.in')))) {
    if (!config.url) {
      throw new Error('gen-host: no Verilator checkout at ' + forkRoot + ' and no url in verilator.json');
    }
    console.log('gen-host: cloning ' + config.url + ' -> ' + forkRoot);
    await exec('git', ['clone', config.url, forkRoot]);
    await exec('git', ['checkout', config.rev], {cwd: forkRoot});
  }

  const head = await execCapture('git', ['rev-parse', 'HEAD'], {cwd: forkRoot});
  const pinned = config.rev;
  const drifted = pinned && !head.startsWith(pinned) && !pinned.startsWith(head.slice(0, pinned.length));

  if (drifted) {
    const message =
      'gen-host: Verilator checkout is at ' + head.slice(0, 9) +
      ', verilator.json pins ' + pinned;
    if (!opts.allowDrift) {
      throw new Error(message + ' (pass --allow-drift to build anyway)');
    }
    console.warn(message + ' — continuing, --allow-drift given');
  }

  return {root: forkRoot, rev: head, pinned, drifted};
};

const buildNative = async (forkRoot, opts) => {
  const jobs = opts.jobs || os.cpus().length;

  if (!(await exists(path.join(forkRoot, 'configure')))) {
    console.log('gen-host: autoconf');
    await exec('autoconf', [], {cwd: forkRoot});
  }

  if (!(await exists(path.join(forkRoot, 'src', 'Makefile_obj')))) {
    console.log('gen-host: ./configure');
    await exec('./configure', [], {cwd: forkRoot});
  }

  if (opts.skipMake) {
    console.log('gen-host: skipping make (--skip-make)');
    return;
  }

  // Incremental. Also produces bin/verilator_bin, which the parity tests use as
  // the golden reference.
  console.log('gen-host: make -j' + jobs);
  await exec('make', ['-j' + jobs], {cwd: forkRoot});
};

const copyInto = async (srcPath, destName, files) => {
  const dest = path.join(GEN_DIR, destName);
  const data = await fs.readFile(srcPath);
  const previous = (await exists(dest)) ? await fs.readFile(dest) : null;
  if (previous === null || !previous.equals(data)) {
    await fs.writeFile(dest, data);
  }
  files[destName] = sha256(data);
};

const findExisting = async candidates => {
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const collectGenerated = async (forkRoot, files, minAstgenHeaders) => {
  const objOpt = path.join(forkRoot, 'src', 'obj_opt');
  if (!(await exists(objOpt))) {
    throw new Error('gen-host: ' + objOpt + ' missing — the native build did not run');
  }

  const generated = (await fs.readdir(objOpt)).filter(name => OBJ_OPT_GLOBS.some(re => re.test(name)));
  if (generated.length < minAstgenHeaders) {
    throw new Error('gen-host: only ' + generated.length + ' astgen headers in ' + objOpt + ', expected ' + minAstgenHeaders + '+');
  }

  for (const name of [...generated, ...OBJ_OPT_FILES]) {
    const srcPath = path.join(objOpt, name);
    if (!(await exists(srcPath))) {
      throw new Error('gen-host: missing stage-1 product ' + srcPath);
    }
    await copyInto(srcPath, name, files);
  }

  // flex's C++ header lives outside the wasi sysroot. Copying this one header is
  // how the wasm compile avoids -I/usr/include, which would expose host glibc
  // headers to a wasm target.
  const flexLexer = await findExisting([
    path.join(objOpt, 'FlexLexer.h'),
    '/usr/include/FlexLexer.h'
  ]);
  if (!flexLexer) {
    throw new Error('gen-host: FlexLexer.h not found in obj_opt/ or /usr/include');
  }
  await copyInto(flexLexer, 'FlexLexer.h', files);

  for (const [relative, destName] of [...CONFIG_FILES, ...VROOT_FILES]) {
    const srcPath = path.join(forkRoot, relative);
    if (!(await exists(srcPath))) {
      throw new Error('gen-host: missing ' + srcPath + ' — did ./configure run?');
    }
    await copyInto(srcPath, destName, files);
  }
};

// The runtime seeds these two files into every VFS, so they are inlined as
// base64 rather than fetched — 11 KB total.
const emitVrootData = async () => {
  const entries = await Promise.all(VROOT_FILES.map(async ([, destName]) => {
    const data = await fs.readFile(path.join(GEN_DIR, destName));
    return '  ' + JSON.stringify('include/' + destName) + ': ' +
      JSON.stringify(data.toString('base64'));
  }));

  const source = [
    '// Generated by lib/gen-host.js — do not edit.',
    '// The complete VFS seed set for verilator: bisected by removal, 11 KB.',
    'export const vrootFilesBase64 = {',
    entries.join(',\n'),
    '};',
    ''
  ].join('\n');

  await fs.writeFile(path.join(GEN_DIR, 'vroot-data.mjs'), source);
};

const genHost = async (opts = {}) => {
  const config = await readConfig();
  const fork = await resolveVerilator(opts);
  await buildNative(fork.root, opts);

  await fs.mkdir(GEN_DIR, {recursive: true});

  const files = {};
  await collectGenerated(fork.root, files, config.minAstgenHeaders);
  await emitVrootData();

  const tus = await parseTuList(fork.root);
  if (tus.length !== config.expectedTuCount) {
    throw new Error('gen-host: parsed ' + tus.length + ' TUs, expected ' + config.expectedTuCount);
  }

  const cacheKey = sha256(Buffer.from(JSON.stringify(
    Object.keys(files).sort()
      .filter(name => !CACHE_KEY_EXCLUDE.has(name))
      .map(name => [name, files[name]])
  )));

  const manifest = {
    verilatorRev: fork.rev,
    verilatorPinned: fork.pinned,
    verilatorDrifted: fork.drifted || false,
    tuCount: tus.length,
    tus,
    files,
    cacheKey
  };

  await fs.writeFile(path.join(GEN_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log('gen-host: ' + Object.keys(files).length + ' files in gen/, ' +
    tus.length + ' TUs, verilator ' + fork.rev.slice(0, 9));

  return {...manifest, forkRoot: fork.root};
};

const readManifest = async () => {
  const manifestPath = path.join(GEN_DIR, 'manifest.json');
  if (!(await exists(manifestPath))) {
    throw new Error('gen-host: ' + manifestPath + ' missing — run stage 1 first');
  }
  return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
};

module.exports = {genHost, resolveVerilator, readManifest, GEN_DIR, ROOT, VROOT_FILES};
