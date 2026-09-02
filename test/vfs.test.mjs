import test from 'node:test';
import assert from 'node:assert/strict';

import {createVfs, decodeText, encodeText, ERRNO, isVfsError} from '../lib/vfs.mjs';

const errnoOf = fn => {
  try {
    fn();
  } catch (err) {
    assert.ok(isVfsError(err), 'expected a vfs error, got ' + err);
    return err.errno;
  }
  return ERRNO.SUCCESS;
};

test('writeFile creates parents, readFile round-trips', () => {
  const vfs = createVfs();
  vfs.writeFile(vfs.root, 'a/b/c.txt', 'hello');
  assert.equal(decodeText(vfs.readFile(vfs.root, 'a/b/c.txt')), 'hello');
  assert.equal(vfs.lookup(vfs.root, 'a/b').type, 'dir');
});

test('lookup resolves . and .. and reports the right errno', () => {
  const vfs = createVfs();
  vfs.writeFile(vfs.root, 'dir/file.txt', 'x');
  const dir = vfs.lookup(vfs.root, 'dir');

  assert.equal(vfs.lookup(dir, './file.txt').name, 'file.txt');
  assert.equal(vfs.lookup(dir, '../dir/file.txt').name, 'file.txt');
  assert.equal(errnoOf(() => vfs.lookup(vfs.root, 'nope')), ERRNO.ENOENT);
  assert.equal(errnoOf(() => vfs.lookup(vfs.root, 'dir/file.txt/deeper')), ERRNO.ENOTDIR);
});

test('mkdir refuses to clobber, mkdirp is idempotent', () => {
  const vfs = createVfs();
  vfs.mkdir(vfs.root, 'out');
  assert.equal(errnoOf(() => vfs.mkdir(vfs.root, 'out')), ERRNO.EEXIST);
  assert.equal(vfs.mkdirp(vfs.root, 'out/deep/deeper'), vfs.lookup(vfs.root, 'out/deep/deeper'));
});

test('createFile honours O_EXCL semantics', () => {
  const vfs = createVfs();
  vfs.createFile(vfs.root, 'f');
  assert.equal(errnoOf(() => vfs.createFile(vfs.root, 'f', {exclusive: true})), ERRNO.EEXIST);
});

test('write grows the file, read clamps to size', () => {
  const vfs = createVfs();
  const node = vfs.createFile(vfs.root, 'f');
  vfs.write(node, 0, encodeText('abc'));
  vfs.write(node, 3, encodeText('def'));
  assert.equal(node.size, 6);
  assert.equal(decodeText(vfs.read(node, 0, 100)), 'abcdef');
  assert.equal(decodeText(vfs.read(node, 4, 100)), 'ef');
  assert.equal(vfs.read(node, 6, 100).length, 0);

  vfs.truncate(node);
  assert.equal(node.size, 0);
});

test('readdir lists . and .. first', () => {
  const vfs = createVfs();
  vfs.writeFile(vfs.root, 'd/one', '1');
  vfs.writeFile(vfs.root, 'd/two', '2');
  const names = vfs.readdir(vfs.lookup(vfs.root, 'd')).map(entry => entry.name);
  assert.deepEqual(names, ['.', '..', 'one', 'two']);
});

test('unlink refuses a non-empty directory', () => {
  const vfs = createVfs();
  vfs.writeFile(vfs.root, 'd/one', '1');
  assert.equal(errnoOf(() => vfs.unlink(vfs.root, 'd')), ERRNO.ENOTEMPTY);
  vfs.unlink(vfs.root, 'd/one');
  vfs.unlink(vfs.root, 'd');
  assert.equal(errnoOf(() => vfs.lookup(vfs.root, 'd')), ERRNO.ENOENT);
});

test('dirtyFiles reports only post-markClean writes, keyed to the mount', () => {
  const vfs = createVfs();
  const mount = vfs.mkdirp(vfs.root, 'work');
  vfs.writeFile(mount, 'input.sv', 'in');
  vfs.writeFile(mount, '.verilator-root/include/seed.sv', 'seed');
  vfs.markClean();

  vfs.writeFile(mount, 'out/result.json', 'out');
  vfs.writeFile(mount, '.verilator-root/include/late.sv', 'late');

  const files = vfs.dirtyFiles(mount, {exclude: ['.verilator-root']});
  assert.deepEqual(Object.keys(files), ['out/result.json']);
  assert.equal(decodeText(files['out/result.json']), 'out');
});
