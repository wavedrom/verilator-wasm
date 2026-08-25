// WASI preview1 shim over the in-memory VFS.
//
// node:wasi cannot serve this: it only accepts real-directory preopens, so an
// in-memory filesystem is impossible with it. Writing the shim ourselves also
// keeps the runtime dependency-free and gives one code path for node, browser,
// worker and VSCode webview.
//
// Scope is deliberately exactly the 24 imports the linked verilator.wasm
// declares — the import section is static, so this covers --lint-only and --cc
// as well as --json-only. Anything absent from that list is not implemented:
// path_rename, path_remove_directory, path_symlink, fd_pread/pwrite, fd_sync,
// clock_res_get and all sock_* are not imported by the module.

import {ERRNO, isVfsError, decodeText, encodeText} from './vfs.mjs';

const FILETYPE_CHARACTER_DEVICE = 2;

// oflags
const O_CREAT = 1;
const O_DIRECTORY = 2;
const O_EXCL = 4;
const O_TRUNC = 8;

// fst_flags for path_filestat_set_times
const FILESTAT_SET_ATIM = 1;
const FILESTAT_SET_ATIM_NOW = 2;
const FILESTAT_SET_MTIM = 4;
const FILESTAT_SET_MTIM_NOW = 8;

// whence
const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;

const RIGHTS_ALL = (1n << 64n) - 1n;

const FD_STDIN = 0;
const FD_STDOUT = 1;
const FD_STDERR = 2;
const FD_PREOPEN = 3;

const DIRENT_SIZE = 24;

// v3Global.vlExit() and v3fatal both call exit(), which is proc_exit under WASI
// and traps the instance. Carrying it as a private sentinel is what turns a
// fatal error into an exitCode instead of an uncaught throw.
const exitSentinel = code =>
  Object.assign(new Error('wasi proc_exit(' + code + ')'), {exitCode: code, isExitSentinel: true});

const isExitSentinel = err => Boolean(err && err.isExitSentinel);

const concat = chunks => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
};

const defaultRandom = target => {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    // getRandomValues caps at 65536 bytes per call.
    for (let offset = 0; offset < target.length; offset += 65536) {
      globalThis.crypto.getRandomValues(target.subarray(offset, Math.min(target.length, offset + 65536)));
    }
    return;
  }
  for (let i = 0; i < target.length; i++) {
    target[i] = Math.floor(Math.random() * 256);
  }
};

export const createWasi = ({
  vfs,
  mountNode,
  mountName = '/',
  args = [],
  env = {},
  onStdout = null,
  onStderr = null,
  now = () => Date.now(),
  random = defaultRandom
}) => {
  const mount = mountNode || vfs.root;

  const stdoutChunks = [];
  const stderrChunks = [];

  const fds = new Map([
    [FD_STDIN, {kind: 'stdin'}],
    [FD_STDOUT, {kind: 'stdout'}],
    [FD_STDERR, {kind: 'stderr'}],
    [FD_PREOPEN, {kind: 'dir', node: mount, preopen: mountName, offset: 0}]
  ]);
  let nextFd = FD_PREOPEN + 1;

  let memory = null;
  let exitCode = null;

  // memory.grow detaches the buffer, and the module can grow from 256 MB to
  // 2 GB mid-run — so never cache a view across calls.
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);

  const readString = (ptr, len) => decodeText(bytes().subarray(ptr, ptr + len));

  const getFd = fd => {
    const entry = fds.get(fd);
    if (entry === undefined) {
      throw Object.assign(new Error('bad fd ' + fd), {errno: ERRNO.EBADF, isVfsError: true});
    }
    return entry;
  };

  const getDirNode = fd => {
    const entry = getFd(fd);
    if (entry.kind !== 'dir') {
      throw Object.assign(new Error('fd ' + fd + ' is not a directory'),
        {errno: ERRNO.ENOTDIR, isVfsError: true});
    }
    return entry.node;
  };

  const readIovs = (ptr, count) => {
    const dv = view();
    const mem = bytes();
    const out = [];
    for (let i = 0; i < count; i++) {
      const base = dv.getUint32(ptr + i * 8, true);
      const len = dv.getUint32(ptr + i * 8 + 4, true);
      out.push(mem.subarray(base, base + len));
    }
    return out;
  };

  const writeStd = (kind, iovs, nwrittenPtr) => {
    let total = 0;
    for (const chunk of iovs) {
      if (chunk.length === 0) {
        continue;
      }
      const copy = chunk.slice();
      total += copy.length;
      if (kind === 'stdout') {
        stdoutChunks.push(copy);
        if (onStdout) {
          onStdout(decodeText(copy));
        }
      } else {
        stderrChunks.push(copy);
        if (onStderr) {
          onStderr(decodeText(copy));
        }
      }
    }
    view().setUint32(nwrittenPtr, total, true);
    return ERRNO.SUCCESS;
  };

  // Every import returns an errno and never throws, except proc_exit.
  const wrap = fn => (...callArgs) => {
    try {
      return fn(...callArgs);
    } catch (err) {
      if (isExitSentinel(err)) {
        throw err;
      }
      if (isVfsError(err)) {
        return err.errno;
      }
      if (err instanceof RangeError || err instanceof TypeError) {
        // Out-of-bounds pointer from the guest.
        return ERRNO.EFAULT;
      }
      throw err;
    }
  };

  const encodeStrings = list => {
    const encoded = list.map(s => encodeText(s + '\0'));
    return {encoded, bufSize: encoded.reduce((sum, b) => sum + b.length, 0)};
  };

  const putStrings = (list, ptrArrayPtr, bufPtr) => {
    const dv = view();
    const mem = bytes();
    let cursor = bufPtr;
    encodeStrings(list).encoded.forEach((entry, index) => {
      dv.setUint32(ptrArrayPtr + index * 4, cursor, true);
      mem.set(entry, cursor);
      cursor += entry.length;
    });
    return ERRNO.SUCCESS;
  };

  const putSizes = (list, countPtr, bufSizePtr) => {
    const {encoded, bufSize} = encodeStrings(list);
    const dv = view();
    dv.setUint32(countPtr, encoded.length, true);
    dv.setUint32(bufSizePtr, bufSize, true);
    return ERRNO.SUCCESS;
  };

  const envStrings = () => Object.entries(env).map(([key, value]) => key + '=' + value);

  const writeFilestat = (ptr, node) => {
    const dv = view();
    dv.setBigUint64(ptr, 0n, true);                    // dev
    dv.setBigUint64(ptr + 8, node.ino, true);          // ino
    dv.setUint8(ptr + 16, vfs.filetype(node));         // filetype
    dv.setBigUint64(ptr + 24, 1n, true);               // nlink
    dv.setBigUint64(ptr + 32, BigInt(node.type === 'file' ? node.size : 0), true);
    dv.setBigUint64(ptr + 40, node.atim, true);
    dv.setBigUint64(ptr + 48, node.mtim, true);
    dv.setBigUint64(ptr + 56, node.ctim, true);
  };

  const writeFdstat = (ptr, filetype, fdflags) => {
    const dv = view();
    dv.setUint8(ptr, filetype);
    dv.setUint16(ptr + 2, fdflags, true);
    dv.setBigUint64(ptr + 8, RIGHTS_ALL, true);
    dv.setBigUint64(ptr + 16, RIGHTS_ALL, true);
  };

  const importObject = {
    wasi_snapshot_preview1: {
      args_sizes_get: wrap((countPtr, bufSizePtr) => putSizes(args, countPtr, bufSizePtr)),

      args_get: wrap((ptrArrayPtr, bufPtr) => putStrings(args, ptrArrayPtr, bufPtr)),

      environ_sizes_get: wrap((countPtr, bufSizePtr) => putSizes(envStrings(), countPtr, bufSizePtr)),

      environ_get: wrap((ptrArrayPtr, bufPtr) => putStrings(envStrings(), ptrArrayPtr, bufPtr)),

      clock_time_get: wrap((id, precision, timePtr) => {
        view().setBigUint64(timePtr, BigInt(Math.round(now() * 1e6)), true);
        return ERRNO.SUCCESS;
      }),

      poll_oneoff: wrap(() => ERRNO.ENOSYS),

      sched_yield: wrap(() => ERRNO.SUCCESS),

      fd_fdstat_set_flags: wrap((fd, flags) => {
        getFd(fd).fdflags = flags;
        return ERRNO.SUCCESS;
      }),

      random_get: wrap((bufPtr, len) => {
        random(bytes().subarray(bufPtr, bufPtr + len));
        return ERRNO.SUCCESS;
      }),

      proc_exit: code => {
        throw exitSentinel(code);
      },

      fd_close: wrap(fd => {
        if (fd <= FD_PREOPEN) {
          return ERRNO.SUCCESS;
        }
        getFd(fd);
        fds.delete(fd);
        return ERRNO.SUCCESS;
      }),

      fd_fdstat_get: wrap((fd, statPtr) => {
        const entry = getFd(fd);
        if (entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr') {
          // Character device *with* seek rights, so isatty() reports false and
          // verilator emits no ANSI colour — matching a piped native run.
          writeFdstat(statPtr, FILETYPE_CHARACTER_DEVICE, 0);
          return ERRNO.SUCCESS;
        }
        writeFdstat(statPtr, vfs.filetype(entry.node), entry.fdflags || 0);
        return ERRNO.SUCCESS;
      }),

      fd_prestat_get: wrap((fd, prestatPtr) => {
        const entry = getFd(fd);
        if (entry.preopen === undefined) {
          return ERRNO.EBADF;
        }
        const dv = view();
        dv.setUint32(prestatPtr, 0, true); // preopentype: dir
        dv.setUint32(prestatPtr + 4, encodeText(entry.preopen).length, true);
        return ERRNO.SUCCESS;
      }),

      fd_prestat_dir_name: wrap((fd, pathPtr, pathLen) => {
        const entry = getFd(fd);
        if (entry.preopen === undefined) {
          return ERRNO.EBADF;
        }
        const name = encodeText(entry.preopen);
        if (name.length > pathLen) {
          return ERRNO.ENOTCAPABLE;
        }
        bytes().set(name, pathPtr);
        return ERRNO.SUCCESS;
      }),

      fd_write: wrap((fd, iovsPtr, iovsLen, nwrittenPtr) => {
        const entry = getFd(fd);
        const iovs = readIovs(iovsPtr, iovsLen);
        if (entry.kind === 'stdout' || entry.kind === 'stderr') {
          return writeStd(entry.kind, iovs, nwrittenPtr);
        }
        if (entry.kind !== 'file') {
          return ERRNO.EISDIR;
        }
        let written = 0;
        for (const chunk of iovs) {
          written += vfs.write(entry.node, entry.offset + written, chunk);
        }
        entry.offset += written;
        view().setUint32(nwrittenPtr, written, true);
        return ERRNO.SUCCESS;
      }),

      fd_read: wrap((fd, iovsPtr, iovsLen, nreadPtr) => {
        const entry = getFd(fd);
        if (entry.kind === 'stdin') {
          view().setUint32(nreadPtr, 0, true); // always EOF
          return ERRNO.SUCCESS;
        }
        if (entry.kind !== 'file') {
          return ERRNO.EISDIR;
        }
        let read = 0;
        for (const target of readIovs(iovsPtr, iovsLen)) {
          const chunk = vfs.read(entry.node, entry.offset + read, target.length);
          if (chunk.length === 0) {
            break;
          }
          target.set(chunk);
          read += chunk.length;
        }
        entry.offset += read;
        view().setUint32(nreadPtr, read, true);
        return ERRNO.SUCCESS;
      }),

      fd_seek: wrap((fd, offset, whence, newOffsetPtr) => {
        const entry = getFd(fd);
        if (entry.kind !== 'file') {
          return ERRNO.ESPIPE;
        }
        const delta = Number(offset);
        let next;
        switch (whence) {
          case WHENCE_SET: next = delta; break;
          case WHENCE_CUR: next = entry.offset + delta; break;
          case WHENCE_END: next = entry.node.size + delta; break;
          default: return ERRNO.EINVAL;
        }
        if (next < 0) {
          return ERRNO.EINVAL;
        }
        entry.offset = next;
        view().setBigUint64(newOffsetPtr, BigInt(next), true);
        return ERRNO.SUCCESS;
      }),

      fd_readdir: wrap((fd, bufPtr, bufLen, cookie, bufUsedPtr) => {
        const entries = vfs.readdir(getDirNode(fd));
        const dv = view();
        const mem = bytes();
        let used = 0;

        for (let index = Number(cookie); index < entries.length; index++) {
          const entry = entries[index];
          const name = encodeText(entry.name);
          if (used + DIRENT_SIZE > bufLen) {
            break;
          }
          dv.setBigUint64(bufPtr + used, BigInt(index + 1), true);       // d_next
          dv.setBigUint64(bufPtr + used + 8, entry.node.ino, true);      // d_ino
          dv.setUint32(bufPtr + used + 16, name.length, true);           // d_namlen
          dv.setUint8(bufPtr + used + 20, vfs.filetype(entry.node));     // d_type
          used += DIRENT_SIZE;
          // A truncated name is legal: libc retries with a larger buffer.
          const room = Math.min(name.length, bufLen - used);
          mem.set(name.subarray(0, room), bufPtr + used);
          used += room;
          if (room < name.length) {
            break;
          }
        }

        dv.setUint32(bufUsedPtr, used, true);
        return ERRNO.SUCCESS;
      }),

      path_open: wrap((dirFd, dirFlags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, openedFdPtr) => {
        const base = getDirNode(dirFd);
        const pathStr = readString(pathPtr, pathLen);

        const node = (oflags & O_CREAT)
          ? vfs.createFile(base, pathStr, {exclusive: Boolean(oflags & O_EXCL)})
          : vfs.lookup(base, pathStr);

        if ((oflags & O_DIRECTORY) && node.type !== 'dir') {
          return ERRNO.ENOTDIR;
        }
        if (node.type === 'file' && (oflags & O_TRUNC)) {
          vfs.truncate(node);
        }

        const fd = nextFd++;
        fds.set(fd, {
          kind: node.type === 'dir' ? 'dir' : 'file',
          node,
          offset: 0,
          fdflags
        });
        view().setUint32(openedFdPtr, fd, true);
        return ERRNO.SUCCESS;
      }),

      path_create_directory: wrap((dirFd, pathPtr, pathLen) => {
        vfs.mkdir(getDirNode(dirFd), readString(pathPtr, pathLen));
        return ERRNO.SUCCESS;
      }),

      path_unlink_file: wrap((dirFd, pathPtr, pathLen) => {
        vfs.unlink(getDirNode(dirFd), readString(pathPtr, pathLen));
        return ERRNO.SUCCESS;
      }),

      path_filestat_get: wrap((dirFd, flags, pathPtr, pathLen, statPtr) => {
        const node = vfs.lookup(getDirNode(dirFd), readString(pathPtr, pathLen));
        writeFilestat(statPtr, node);
        return ERRNO.SUCCESS;
      }),

      path_filestat_set_times: wrap((dirFd, flags, pathPtr, pathLen, atim, mtim, fstFlags) => {
        const node = vfs.lookup(getDirNode(dirFd), readString(pathPtr, pathLen));
        const nowValue = BigInt(Math.round(now() * 1e6));
        vfs.setTimes(
          node,
          (fstFlags & FILESTAT_SET_ATIM) ? atim : ((fstFlags & FILESTAT_SET_ATIM_NOW) ? nowValue : null),
          (fstFlags & FILESTAT_SET_MTIM) ? mtim : ((fstFlags & FILESTAT_SET_MTIM_NOW) ? nowValue : null)
        );
        return ERRNO.SUCCESS;
      }),

      // The VFS has no symlinks. realpath() degrades to the input path, which is
      // already the observed behaviour of the proven build: meta.json differs
      // from native only in its realpath strings.
      path_readlink: wrap(() => ERRNO.EINVAL)
    }
  };

  // Runs main() via _start. Returns the exit code; proc_exit is caught here, so
  // a v3fatal never surfaces as an uncaught throw.
  const start = instance => {
    memory = instance.exports.memory;
    if (!memory) {
      throw new Error('wasi: module exports no memory');
    }
    try {
      instance.exports._start();
      exitCode = 0;
    } catch (err) {
      if (isExitSentinel(err)) {
        exitCode = err.exitCode;
      } else {
        throw err;
      }
    }
    return exitCode;
  };

  return {
    importObject,
    start,
    stdout: () => decodeText(concat(stdoutChunks)),
    stderr: () => decodeText(concat(stderrChunks))
  };
};
