// In-memory filesystem backing the WASI shim.
//
// JS owns the filesystem: there is no host FS access anywhere in the runtime, so
// one code path serves node, worker, browser and VSCode webview alike.

export const FILETYPE_UNKNOWN = 0;
export const FILETYPE_DIRECTORY = 3;
export const FILETYPE_REGULAR_FILE = 4;

// WASI preview1 errno subset we actually produce.
export const ERRNO = {
  SUCCESS: 0,
  EACCES: 2,
  EBADF: 8,
  EEXIST: 20,
  EFAULT: 21,
  EINVAL: 28,
  EISDIR: 31,
  ENOENT: 44,
  ENOSYS: 52,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
  ENOTCAPABLE: 76,
  EPERM: 63,
  ESPIPE: 70
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const decodeText = bytes => decoder.decode(bytes);
export const encodeText = text => encoder.encode(text);

export const vfsError = (errno, message) =>
  Object.assign(new Error(message || 'vfs errno ' + errno), {errno, isVfsError: true});

export const isVfsError = err => Boolean(err && err.isVfsError);

const nowNs = () => BigInt(Date.now()) * 1000000n;

const splitPath = pathStr => pathStr.split('/').filter(part => part.length > 0);

export const createVfs = () => {
  let nextIno = 1n;

  const makeDir = (parent, name) => ({
    type: 'dir',
    ino: nextIno++,
    name,
    parent,
    entries: new Map(),
    atim: nowNs(),
    mtim: nowNs(),
    ctim: nowNs()
  });

  const makeFile = (parent, name) => ({
    type: 'file',
    ino: nextIno++,
    name,
    parent,
    data: new Uint8Array(0),
    size: 0,
    atim: nowNs(),
    mtim: nowNs(),
    ctim: nowNs()
  });

  const root = makeDir(null, '');

  // Files created or modified since the last markClean(). The seeded inputs are
  // cleaned after setup, so this set is exactly what a run produced.
  const dirty = new Set();

  // Absolute path of a node, for reporting files back out.
  const pathOf = (node, base = root) => {
    const parts = [];
    for (let cursor = node; cursor && cursor !== base; cursor = cursor.parent) {
      parts.unshift(cursor.name);
    }
    return parts.join('/');
  };

  // Resolve `pathStr` relative to `base`. '.' and '..' are handled here; the VFS
  // has no symlinks, so there is no loop to guard against.
  const lookup = (base, pathStr) => {
    let node = pathStr.startsWith('/') ? root : base;
    for (const part of splitPath(pathStr)) {
      if (part === '.') {
        continue;
      }
      if (part === '..') {
        node = node.parent || root;
        continue;
      }
      if (node.type !== 'dir') {
        throw vfsError(ERRNO.ENOTDIR, 'not a directory: ' + pathStr);
      }
      const next = node.entries.get(part);
      if (next === undefined) {
        throw vfsError(ERRNO.ENOENT, 'no such file or directory: ' + pathStr);
      }
      node = next;
    }
    return node;
  };

  // Resolve everything but the last component, for create/unlink/mkdir.
  const resolveParent = (base, pathStr) => {
    const parts = splitPath(pathStr);
    if (parts.length === 0) {
      throw vfsError(ERRNO.EINVAL, 'empty path');
    }
    const name = parts[parts.length - 1];
    const dirPath = (pathStr.startsWith('/') ? '/' : '') + parts.slice(0, -1).join('/');
    const dir = lookup(base, dirPath || '.');
    if (dir.type !== 'dir') {
      throw vfsError(ERRNO.ENOTDIR, 'not a directory: ' + dirPath);
    }
    if (name === '.' || name === '..') {
      throw vfsError(ERRNO.EINVAL, 'invalid final component: ' + pathStr);
    }
    return {dir, name};
  };

  const mkdir = (base, pathStr) => {
    const {dir, name} = resolveParent(base, pathStr);
    if (dir.entries.has(name)) {
      throw vfsError(ERRNO.EEXIST, 'exists: ' + pathStr);
    }
    const node = makeDir(dir, name);
    dir.entries.set(name, node);
    dir.mtim = nowNs();
    return node;
  };

  const mkdirp = (base, pathStr) => {
    let node = pathStr.startsWith('/') ? root : base;
    for (const part of splitPath(pathStr)) {
      if (part === '.') {
        continue;
      }
      if (part === '..') {
        node = node.parent || root;
        continue;
      }
      const existing = node.entries.get(part);
      if (existing === undefined) {
        const created = makeDir(node, part);
        node.entries.set(part, created);
        node = created;
      } else if (existing.type === 'dir') {
        node = existing;
      } else {
        throw vfsError(ERRNO.ENOTDIR, 'not a directory: ' + pathStr);
      }
    }
    return node;
  };

  const createFile = (base, pathStr, {exclusive = false} = {}) => {
    const {dir, name} = resolveParent(base, pathStr);
    const existing = dir.entries.get(name);
    if (existing !== undefined) {
      if (exclusive) {
        throw vfsError(ERRNO.EEXIST, 'exists: ' + pathStr);
      }
      if (existing.type !== 'file') {
        throw vfsError(ERRNO.EISDIR, 'is a directory: ' + pathStr);
      }
      return existing;
    }
    const node = makeFile(dir, name);
    dir.entries.set(name, node);
    dir.mtim = nowNs();
    dirty.add(node);
    return node;
  };

  const unlink = (base, pathStr) => {
    const {dir, name} = resolveParent(base, pathStr);
    const node = dir.entries.get(name);
    if (node === undefined) {
      throw vfsError(ERRNO.ENOENT, 'no such file: ' + pathStr);
    }
    if (node.type === 'dir' && node.entries.size > 0) {
      throw vfsError(ERRNO.ENOTEMPTY, 'not empty: ' + pathStr);
    }
    dir.entries.delete(name);
    dir.mtim = nowNs();
    dirty.delete(node);
  };

  const truncate = node => {
    node.data = new Uint8Array(0);
    node.size = 0;
    node.mtim = nowNs();
    dirty.add(node);
  };

  const write = (node, offset, bytes) => {
    const end = offset + bytes.length;
    if (end > node.data.length) {
      // Grow geometrically; verilator writes JSON in many small chunks.
      const capacity = Math.max(end, node.data.length * 2, 1024);
      const grown = new Uint8Array(capacity);
      grown.set(node.data.subarray(0, node.size));
      node.data = grown;
    }
    node.data.set(bytes, offset);
    node.size = Math.max(node.size, end);
    node.mtim = nowNs();
    dirty.add(node);
    return bytes.length;
  };

  const read = (node, offset, length) => {
    if (offset >= node.size) {
      return new Uint8Array(0);
    }
    return node.data.subarray(offset, Math.min(node.size, offset + length));
  };

  const setTimes = (node, atim, mtim) => {
    if (atim !== null) {
      node.atim = atim;
    }
    if (mtim !== null) {
      node.mtim = mtim;
    }
  };

  const filetype = node => {
    if (node.type === 'dir') {
      return FILETYPE_DIRECTORY;
    }
    if (node.type === 'file') {
      return FILETYPE_REGULAR_FILE;
    }
    return FILETYPE_UNKNOWN;
  };

  const readdir = node => {
    if (node.type !== 'dir') {
      throw vfsError(ERRNO.ENOTDIR, 'not a directory');
    }
    // '.' and '..' must be present: opendir/readdir and
    // std::filesystem::directory_iterator both go through fd_readdir, and both
    // verilator call sites swallow errors, so a wrong listing would produce
    // wrong-but-plausible output rather than a diagnostic.
    const entries = [
      {name: '.', node},
      {name: '..', node: node.parent || node}
    ];
    for (const [name, child] of node.entries) {
      entries.push({name, node: child});
    }
    return entries;
  };

  // --- host-side conveniences (setup and result harvesting) ---

  const writeFile = (base, pathStr, contents) => {
    const parts = splitPath(pathStr);
    if (parts.length > 1) {
      mkdirp(base, parts.slice(0, -1).join('/'));
    }
    const node = createFile(base, pathStr);
    const bytes = typeof contents === 'string' ? encodeText(contents) : new Uint8Array(contents);
    node.data = bytes;
    node.size = bytes.length;
    node.mtim = nowNs();
    dirty.add(node);
    return node;
  };

  const readFile = (base, pathStr) => {
    const node = lookup(base, pathStr);
    if (node.type !== 'file') {
      throw vfsError(ERRNO.EISDIR, 'is a directory: ' + pathStr);
    }
    return node.data.subarray(0, node.size);
  };

  const markClean = () => dirty.clear();

  // Files created or modified since markClean(), keyed relative to `base`.
  const dirtyFiles = (base = root, {exclude = []} = {}) => {
    const out = {};
    for (const node of dirty) {
      if (node.type !== 'file') {
        continue;
      }
      const key = pathOf(node, base);
      if (key === '' || exclude.some(prefix => key === prefix || key.startsWith(prefix + '/'))) {
        continue;
      }
      out[key] = node.data.subarray(0, node.size);
    }
    return out;
  };

  return {
    root,
    pathOf,
    lookup,
    resolveParent,
    mkdir,
    mkdirp,
    createFile,
    unlink,
    truncate,
    write,
    read,
    setTimes,
    filetype,
    readdir,
    writeFile,
    readFile,
    markClean,
    dirtyFiles
  };
};
