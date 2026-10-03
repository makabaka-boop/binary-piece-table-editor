// 片段表单元测试 + 与朴素参考实现的随机对拍。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PieceTable, splitPieces } from '../src/piece-table.js';
import { HexEditor, EMPTY } from '../src/editor.js';
import { mulberry32, randomBytes, RefDoc } from './helpers.js';

test('空文档上的基本操作', () => {
  const doc = new PieceTable();
  assert.equal(doc.length, 0);
  doc.splice(0, 0, Uint8Array.of(1, 2, 3));
  assert.deepEqual([...doc.toBytes()], [1, 2, 3]);
  doc.splice(1, 0, Uint8Array.of(9));       // 1 9 2 3
  assert.deepEqual([...doc.toBytes()], [1, 9, 2, 3]);
  doc.splice(0, 2, Uint8Array.of(7));       // 7 2 3
  assert.deepEqual([...doc.toBytes()], [7, 2, 3]);
  doc.splice(0, 3);                          // 空
  assert.equal(doc.length, 0);
  assert.deepEqual([...doc.toBytes()], []);
  doc.validate();
});

test('splitPieces 边界', () => {
  const pieces = [{ buf: 0, start: 0, len: 10 }];
  const [h0, t0] = splitPieces(pieces, 0);
  assert.equal(h0.length, 0);
  assert.equal(t0[0].len, 10);
  const [h1, t1] = splitPieces(pieces, 4);
  assert.equal(h1[0].len, 4);
  assert.deepEqual([t1[0].start, t1[0].len], [4, 6]);
  const [h2, t2] = splitPieces(pieces, 10);
  assert.equal(h2[0].len, 10);
  assert.equal(t2.length, 0);
  // 原段对象未被修改
  assert.deepEqual(pieces[0], { buf: 0, start: 0, len: 10 });
});

test('删除后相邻同源段被合并', () => {
  const doc = new PieceTable(Uint8Array.of(1, 2, 3, 4, 5));
  doc.splice(2, 0, Uint8Array.of(8, 9)); // 1 2 [8 9] 3 4 5 → ORIG/ADD/ORIG 三段
  assert.equal(doc.pieces.length, 3);
  doc.splice(2, 2); // 删掉刚插入的 8 9 → 两段 ORIG 重新连续，合并回一段
  assert.deepEqual([...doc.toBytes()], [1, 2, 3, 4, 5]);
  assert.equal(doc.pieces.length, 1);
  doc.validate();
});

test('copyRange 跨段读取', () => {
  const doc = new PieceTable(Uint8Array.of(1, 2, 3, 4));
  doc.splice(2, 0, Uint8Array.of(8, 9)); // 1 2 | 8 9 | 3 4 → 至少 3 段
  assert.ok(doc.pieces.length >= 3);
  assert.deepEqual([...doc.copyRange(1, 5)], [2, 8, 9, 3]);
  assert.deepEqual([...doc.copyRange(0, 6)], [1, 2, 8, 9, 3, 4]);
  assert.deepEqual([...doc.copyRange(2, 4)], [8, 9]);
});

test('随机编辑历史对拍（插入/删除/替换/撤销/重做）', () => {
  for (const seed of [1, 7, 42, 1337, 20261003]) {
    const rng = mulberry32(seed);
    const init = randomBytes(rng, Math.floor(rng() * 200));
    const ed = new HexEditor(init);
    const ref = new RefDoc(init);

    for (let i = 0; i < 800; i++) {
      const roll = rng();
      if (roll < 0.30) { // 插入
        const pos = Math.floor(rng() * (ref.bytes.length + 1));
        const bytes = randomBytes(rng, Math.floor(rng() * 24));
        ed.splice(pos, 0, bytes, { cursor: pos + bytes.length });
        ref.splice(pos, 0, bytes);
      } else if (roll < 0.55) { // 删除
        if (!ref.bytes.length) continue;
        const pos = Math.floor(rng() * ref.bytes.length);
        const n = Math.floor(rng() * Math.min(24, ref.bytes.length - pos));
        ed.splice(pos, n, EMPTY, { cursor: pos });
        ref.splice(pos, n, []);
      } else if (roll < 0.75) { // 替换 = 删 + 插，同一撤销单元
        if (!ref.bytes.length) continue;
        const pos = Math.floor(rng() * ref.bytes.length);
        const n = Math.floor(rng() * Math.min(24, ref.bytes.length - pos));
        const bytes = randomBytes(rng, Math.floor(rng() * 24));
        ed.splice(pos, n, bytes, { cursor: pos + bytes.length });
        ref.splice(pos, n, bytes);
      } else if (roll < 0.88) { // 撤销
        assert.equal(ed.undo(), ref.undo());
      } else { // 重做
        assert.equal(ed.redo(), ref.redo());
      }

      assert.deepEqual([...ed.doc.toBytes()], ref.bytes, `seed=${seed} 第 ${i} 步内容不一致`);
      assert.equal(ed.length, ref.bytes.length);
      ed.doc.validate();

      // 随机点读 byteAt / copyRange
      for (let k = 0; k < 4 && ref.bytes.length; k++) {
        const idx = Math.floor(rng() * ref.bytes.length);
        assert.equal(ed.doc.byteAt(idx), ref.bytes[idx]);
        const end = Math.min(ref.bytes.length, idx + Math.floor(rng() * 30));
        assert.deepEqual([...ed.doc.copyRange(idx, end)], ref.bytes.slice(idx, end));
      }
    }
  }
});

test('撤销分支：撤销后新编辑截断重做栈', () => {
  const ed = new HexEditor(Uint8Array.of(65, 66, 67, 68)); // "ABCD"
  ed.splice(4, 0, Uint8Array.of(88));       // ABCDX
  ed.splice(4, 0, Uint8Array.of(89));       // ABCDXY
  ed.undo();                                 // ABCDX
  assert.deepEqual([...ed.doc.toBytes()], [65, 66, 67, 68, 88]);
  ed.splice(0, 0, Uint8Array.of(90));       // 分支：ZABCDX
  assert.equal(ed.canRedo, false, '新编辑后重做栈必须清空');
  assert.deepEqual([...ed.doc.toBytes()], [90, 65, 66, 67, 68, 88]);
  ed.undo();                                 // ABCDX
  ed.undo();                                 // ABCD
  assert.deepEqual([...ed.doc.toBytes()], [65, 66, 67, 68]);
  ed.redo();                                 // ABCDX
  ed.redo();                                 // ZABCDX（沿分支前进）
  assert.deepEqual([...ed.doc.toBytes()], [90, 65, 66, 67, 68, 88]);
  ed.doc.validate();
});

test('每键编辑不复制整份文件：段数有界且原缓冲区不被触动', () => {
  const orig = randomBytes(mulberry32(9), 1000);
  const origSnapshot = [...orig];
  const ed = new HexEditor(orig);
  ed.insertMode = true;
  // 模拟连续键入 500 个半字节（250 字节）
  for (let i = 0; i < 500; i++) ed.typeHexDigit(i % 16);
  assert.equal(ed.length, 1250);
  assert.ok(ed.doc.pieces.length <= 4, `连续键入应合并为少数几段，实际 ${ed.doc.pieces.length}`);
  assert.deepEqual([...orig], origSnapshot, '原始缓冲区不得被修改');
  ed.doc.validate();
});

test('文档中间连续键入：段数同样有界', () => {
  const ed = new HexEditor(randomBytes(mulberry32(11), 1000));
  ed.insertMode = true;
  ed.moveCursor(500); // 文档正中间
  for (let i = 0; i < 500; i++) ed.typeHexDigit(i % 16);
  assert.equal(ed.length, 1250);
  assert.ok(ed.doc.pieces.length <= 4, `中间键入段数应有界，实际 ${ed.doc.pieces.length}`);
  ed.doc.validate();
  // 覆盖模式在文档中间连续改写
  const ed2 = new HexEditor(randomBytes(mulberry32(13), 1000));
  ed2.moveCursor(400);
  for (let i = 0; i < 500; i++) ed2.typeHexDigit(i % 16);
  assert.equal(ed2.length, 1000);
  assert.ok(ed2.doc.pieces.length <= 4, `覆盖改写段数应有界，实际 ${ed2.doc.pieces.length}`);
  ed2.doc.validate();
});
