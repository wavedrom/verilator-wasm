// Public API. JS owns the filesystem: files in, files out, no host FS access.

import {createVfs, decodeText} from './vfs.mjs';
import {createWasi} from './wasi.mjs';
import {vrootFilesBase64} from '../gen/vroot-data.mjs';

// The seed files live inside the mount, so they are reachable through the single
// preopen. Hidden behind a dot directory and filtered out of result.files.
const VROOT_DIR = '.verilator-root';

const isNode = () => Boolean(globalThis.process && globalThis.process.versions && globalThis.process.versions.node);

const fromBase64 = text => {
  if (isNode()) {
    return new Uint8Array(globalThis.Buffer.from(text, 'base64'));
  }
  const binary = globalThis.atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};

const readUrl = async url => {
  if (isNode() && String(url).startsWith('file:')) {
    const {readFile} = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('verilator-wasm: fetch ' + url + ' failed with ' + response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
};

const loadWasmBytes = async options => {
  if (options.wasmBinary) {
    return options.wasmBinary instanceof Uint8Array
      ? options.wasmBinary
      : new Uint8Array(options.wasmBinary);
  }

  // './verilator.wasm' is the packaged layout (dist/index.mjs beside the module);
  // '../dist/verilator.wasm' is the unbundled repo layout.
  const candidates = options.wasmUrl
    ? [options.wasmUrl]
    : [new URL('./verilator.wasm', import.meta.url), new URL('../dist/verilator.wasm', import.meta.url)];

  const failures = [];
  for (const candidate of candidates) {
    try {
      return await readUrl(candidate);
    } catch (err) {
      failures.push(String(candidate) + ': ' + err.message);
    }
  }
  throw new Error('verilator-wasm: could not load verilator.wasm\n  ' + failures.join('\n  '));
};

const seedVroot = (vfs, mount) => {
  for (const [name, base64] of Object.entries(vrootFilesBase64)) {
    vfs.writeFile(mount, VROOT_DIR + '/' + name, fromBase64(base64));
  }
};

export const createVerilator = async (options = {}) => {
  const wasmModule = options.wasmModule || await WebAssembly.compile(await loadWasmBytes(options));

  // Verilator's main() is not re-entrant: v3Global is global state and the run
  // ends in exit(). So the module is compiled once and every run() gets a fresh
  // instance.
  const run = async ({
    args = [],
    files = {},
    cwd = '/',
    env = {},
    onStdout = null,
    onStderr = null,
    now,
    random
  } = {}) => {
    const vfs = createVfs();
    const mount = vfs.mkdirp(vfs.root, cwd);

    seedVroot(vfs, mount);
    for (const [name, contents] of Object.entries(files)) {
      vfs.writeFile(mount, name, contents);
    }
    // Everything written so far is input; only what the run produces is dirty.
    vfs.markClean();

    const wasi = createWasi({
      vfs,
      mountNode: mount,
      mountName: '/',
      args: ['verilator', ...args],
      env: {
        // Must be set or the built-in std:: and lint-waiver lookups fail; the
        // native run needs it too.
        VERILATOR_ROOT: '/' + VROOT_DIR,
        ...env
      },
      onStdout,
      onStderr,
      ...(now ? {now} : {}),
      ...(random ? {random} : {})
    });

    const instance = await WebAssembly.instantiate(wasmModule, wasi.importObject);

    // The VFS lives in JS, so whatever was written before a trap is already
    // recoverable — including a v3fatal that never reached a clean exit.
    const harvest = () => {
      const raw = vfs.dirtyFiles(mount, {exclude: [VROOT_DIR]});
      const text = {};
      for (const [name, bytes] of Object.entries(raw)) {
        text[name] = decodeText(bytes);
      }
      return {filesBytes: raw, files: text};
    };

    let exitCode;
    try {
      exitCode = wasi.start(instance);
    } catch (err) {
      // A genuine trap — stack overflow on a deep AST is the expected one, and it
      // arrives as a trap rather than a diagnostic.
      throw Object.assign(err, {
        stdout: wasi.stdout(),
        stderr: wasi.stderr(),
        ...harvest()
      });
    }

    return {
      exitCode,
      stdout: wasi.stdout(),
      stderr: wasi.stderr(),
      ...harvest()
    };
  };

  return {run, module: wasmModule};
};

export default createVerilator;
