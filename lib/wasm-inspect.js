'use strict';

// Minimal WebAssembly binary reader: import and export sections only.
// Used as a build gate — a module that imports anything besides
// wasi_snapshot_preview1 (a stray pthread_create, say) must fail the build
// rather than surface as a runtime instantiation error.

const MAGIC = 0x6d736100; // '\0asm'

const SECTION_IMPORT = 2;
const SECTION_EXPORT = 7;

const KIND = ['func', 'table', 'memory', 'global'];

const reader = buf => {
  let pos = 0;
  const self = {
    get pos () { return pos; },
    get eof () { return pos >= buf.length; },
    u8: () => buf[pos++],
    uleb: () => {
      let result = 0, shift = 0;
      for (;;) {
        const byte = buf[pos++];
        result += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if ((byte & 0x80) === 0) {
          return result;
        }
      }
    },
    name: () => {
      const len = self.uleb();
      const str = buf.toString('utf8', pos, pos + len);
      pos += len;
      return str;
    },
    skip: n => { pos += n; }
  };
  return self;
};

// limits: flags byte, then min, then max when flags & 1
const skipLimits = r => {
  const flags = r.u8();
  r.uleb();
  if (flags & 0x01) {
    r.uleb();
  }
};

const skipImportDesc = (r, kind) => {
  switch (kind) {
    case 0: r.uleb(); break;                 // func: typeidx
    case 1: r.u8(); skipLimits(r); break;    // table: reftype + limits
    case 2: skipLimits(r); break;            // memory: limits
    case 3: r.u8(); r.u8(); break;           // global: valtype + mutability
    default: throw new Error('wasm-inspect: unknown import kind ' + kind);
  }
};

const inspectWasm = buf => {
  if (buf.length < 8 || buf.readUInt32LE(0) !== MAGIC) {
    throw new Error('wasm-inspect: not a WebAssembly module');
  }

  const r = reader(buf);
  r.skip(8); // magic + version

  const imports = [];
  const exports = [];

  while (!r.eof) {
    const id = r.u8();
    const size = r.uleb();
    const end = r.pos + size;

    if (id === SECTION_IMPORT) {
      const count = r.uleb();
      for (let i = 0; i < count; i++) {
        const module = r.name();
        const name = r.name();
        const kind = r.u8();
        skipImportDesc(r, kind);
        imports.push({module, name, kind: KIND[kind]});
      }
    } else if (id === SECTION_EXPORT) {
      const count = r.uleb();
      for (let i = 0; i < count; i++) {
        const name = r.name();
        const kind = r.u8();
        r.uleb(); // index
        exports.push({name, kind: KIND[kind]});
      }
    }

    r.skip(end - r.pos);
  }

  return {imports, exports};
};

// Build gate. Throws with the offending entries listed.
const assertWasiOnly = (buf, expectedExports = ['memory', '_start']) => {
  const {imports, exports} = inspectWasm(buf);

  const foreign = imports.filter(i => i.module !== 'wasi_snapshot_preview1');
  if (foreign.length > 0) {
    throw new Error(
      'wasm-inspect: unexpected non-WASI imports: ' +
      foreign.map(i => i.module + '.' + i.name).join(', ')
    );
  }

  const names = exports.map(e => e.name).sort();
  const wanted = [...expectedExports].sort();
  if (names.join(',') !== wanted.join(',')) {
    throw new Error(
      'wasm-inspect: exports are [' + names.join(', ') +
      '], expected [' + wanted.join(', ') + ']'
    );
  }

  return imports.map(i => i.module + '.' + i.name).sort();
};

module.exports = {inspectWasm, assertWasiOnly};
