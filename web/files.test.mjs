// Tests for the files taken from a drop, folders included:
//
//   node --test web/files.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byName, droppedFiles } from './js/files.js';

const file = (name) => ({ name, type: 'image/jpeg' });
const fileEntry = (name) => ({ isFile: true, isDirectory: false, file: (resolve) => setTimeout(() => resolve(file(name))) });
// A folder whose reader gives its entries two at a time, as browsers give them in batches.
const folder = (...children) => ({
  isFile: false,
  isDirectory: true,
  createReader: () => {
    let at = 0;
    return {
      readEntries: (resolve) =>
        setTimeout(() => {
          resolve(children.slice(at, at + 2));
          at += 2;
        }),
    };
  },
});
const drop = (files, entries) => ({ files, items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })) });

test('files dropped without a folder are taken as they are', async () => {
  const files = [file('b.jpg'), file('a.jpg')];
  assert.deepEqual(await droppedFiles(drop(files, [fileEntry('b.jpg'), fileEntry('a.jpg')])), files);
  assert.deepEqual(await droppedFiles({ files }), files);
  assert.deepEqual(await droppedFiles(null), []);
});

test("a folder's files, in its folders too and however many batches they come in, in the order of their names", async () => {
  const entries = [
    folder(fileEntry('IMG_10.jpg'), fileEntry('IMG_2.jpg'), folder(fileEntry('IMG_1.jpg')), fileEntry('img_3.jpg')),
    fileEntry('IMG_11.jpg'),
  ];
  const names = (await droppedFiles(drop([], entries))).map((found) => found.name);
  assert.deepEqual(names, ['IMG_1.jpg', 'IMG_2.jpg', 'img_3.jpg', 'IMG_10.jpg', 'IMG_11.jpg']);
});

test('names are ordered by their numbers, whatever their case', () => {
  const sorted = ['b10.png', 'B9.png', 'a.png'].map((name) => ({ name })).sort(byName);
  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ['a.png', 'B9.png', 'b10.png'],
  );
});
