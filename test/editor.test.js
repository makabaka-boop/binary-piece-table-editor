// 编辑器层测试：光标/选区迁移、撤销合并、搜索过期与批量替换。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HexEditor, mapPosition, EMPTY } from '../src/editor.js';

const bytes = (...xs) => Uint8Array.from(xs);

test('mapPosition：插入/删除前后的位置迁移', () => {
  // 在 5 处插入 3 字节
  assert.equal(mapPosition(4, 5, 0, 3), 4, '插入点之前不动');
  assert.equal(mapPosition(5, 5, 0, 3, -1), 5, '插入点处（左亲和）留在左侧');
  assert.equal(mapPosition(5, 5, 0, 3, +1), 8, '插入点处（右亲和）移到插入内容之后');
  assert.equal(mapPosition(9, 5, 0, 3), 12, '插入点之后平移');
  // 删除 [3, 7)
  assert.equal(mapPosition(2, 3, 4, 0), 2, '删除区间之前不动');
  assert.equal(mapPosition(5, 3, 4, 0), 3, '被删区间内收拢到删除点');
  assert.equal(mapPosition(7, 3, 4, 0), 3, '删除区间末端收拢到删除点');
  assert.equal(mapPosition(10, 3, 4, 0), 6, '删除区间之后前移');
  // 替换 [2,4) → 5 字节
  assert.equal(mapPosition(3, 2, 2, 5), 7, '被替换区间内收拢到插入内容末端');
  assert.equal(mapPosition(8, 2, 2, 5), 11, '替换区间之后平移');
});

test('光标与选区随编辑迁移', () => {
  const ed = new HexEditor(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
  ed.select(2, 5); // 选区 [2,5)

  ed.splice(0, 0, bytes(100, 101, 102)); // 在选区前插入
  assert.deepEqual([ed.anchor, ed.cursor], [5, 8], '前方插入：选区整体平移');

  ed.undo();
  ed.splice(2, 0, bytes(100)); // 在选区起点插入（anchor 左亲和，cursor 右移）
  assert.deepEqual([ed.anchor, ed.cursor], [2, 6], '选区边界处的插入：选区包住新内容');

  ed.undo();
  ed.splice(3, 2, EMPTY); // 删除选区中间一段
  assert.deepEqual([ed.anchor, ed.cursor], [2, 3], '选区内删除：两端收拢');

  ed.undo();
  ed.splice(8, 2, EMPTY); // 选区之后删除
  assert.deepEqual([ed.anchor, ed.cursor], [2, 5], '后方删除：选区不动');
});

test('撤销/重做恢复当时的光标与选区', () => {
  const ed = new HexEditor(bytes(1, 2, 3, 4, 5));
  ed.select(1, 4);
  ed.deleteSelectionOrByte(false); // 删除 [1,4) → 剩 1,5，光标在 1
  assert.deepEqual([...ed.doc.toBytes()], [1, 5]);
  assert.equal(ed.cursor, 1);
  ed.undo();
  assert.deepEqual([...ed.doc.toBytes()], [1, 2, 3, 4, 5]);
  assert.deepEqual([ed.anchor, ed.cursor], [1, 4], '撤销后选区恢复原样');
  ed.redo();
  assert.deepEqual([...ed.doc.toBytes()], [1, 5]);
});

test('半字节输入：两次击键合成一个撤销单元', () => {
  const ed = new HexEditor(bytes(0xab, 0xcd));
  ed.typeHexDigit(0x0); // 覆盖高半字节：0x0b
  assert.equal(ed.doc.byteAt(0), 0x0b);
  assert.equal(ed.cursor, 0, '高半字节输入后光标不动');
  ed.typeHexDigit(0x7); // 补全低半字节：0x07，光标前进
  assert.equal(ed.doc.byteAt(0), 0x07);
  assert.equal(ed.cursor, 1);
  assert.equal(ed.undoStack.length, 1, '一个完整字节只产生一个撤销单元');
  ed.undo();
  assert.equal(ed.doc.byteAt(0), 0xab, '一次撤销恢复整个字节');
});

test('半字节输入：末尾就地改写路径的撤销与重做', () => {
  // 插入模式在文档末尾键入：补全走 tryRewriteLastAddByte 就地改写
  const ed = new HexEditor(bytes(1, 2));
  ed.insertMode = true;
  ed.moveCursor(2);
  ed.typeHexDigit(0x4);
  ed.typeHexDigit(0x1); // 0x41 = 'A'
  assert.deepEqual([...ed.doc.toBytes()], [1, 2, 0x41]);
  assert.equal(ed.undoStack.length, 1, '两次击键仍是一个撤销单元');
  ed.undo();
  assert.deepEqual([...ed.doc.toBytes()], [1, 2]);
  ed.redo();
  assert.deepEqual([...ed.doc.toBytes()], [1, 2, 0x41], '重做应恢复补全后的完整字节');

  // 覆盖模式改写文档最后一个字节：同样走就地改写
  const ed2 = new HexEditor(bytes(0x00, 0x00));
  ed2.moveCursor(1);
  ed2.typeHexDigit(0xa);
  ed2.typeHexDigit(0xb);
  assert.deepEqual([...ed2.doc.toBytes()], [0, 0xab]);
  ed2.undo();
  assert.deepEqual([...ed2.doc.toBytes()], [0, 0]);
  ed2.redo();
  assert.deepEqual([...ed2.doc.toBytes()], [0, 0xab]);
});

test('插入模式与覆盖模式', () => {
  const ed = new HexEditor(bytes(1, 2, 3));
  ed.insertMode = false;
  ed.moveCursor(1);
  ed.typeHexDigit(0xf);
  ed.typeHexDigit(0xf);
  assert.deepEqual([...ed.doc.toBytes()], [1, 0xff, 3], '覆盖模式替换字节');
  ed.insertMode = true;
  ed.moveCursor(1);
  ed.typeHexDigit(0x0);
  ed.typeHexDigit(0x0);
  assert.deepEqual([...ed.doc.toBytes()], [1, 0, 0xff, 3], '插入模式插入字节');
});

test('搜索结果绑定修订：编辑后过期，过期禁止批量替换', () => {
  const ed = new HexEditor(bytes(0xaa, 0xbb, 0xaa, 0xbb, 0xaa));
  const pattern = bytes(0xaa);
  ed.setSearchResults(ed.revision, pattern, [0, 2, 4]);
  assert.equal(ed.searchStale, false);

  ed.splice(0, 0, bytes(0x00)); // 任意编辑
  assert.equal(ed.searchStale, true, '编辑后搜索结果必须过期');
  assert.throws(() => ed.replaceAllFromSearch(bytes(0x01)), /已过期/);

  ed.undo();
  assert.equal(ed.searchStale, true, '撤销同样使结果过期（修订号不复用）');
});

test('批量替换：单撤销单元、位置正确、不重叠', () => {
  const ed = new HexEditor(bytes(0xaa, 0xbb, 0xaa, 0xbb, 0xaa));
  ed.setSearchResults(ed.revision, bytes(0xaa), [0, 2, 4]);
  const n = ed.replaceAllFromSearch(bytes(0x01, 0x02));
  assert.equal(n, 3);
  assert.deepEqual([...ed.doc.toBytes()], [1, 2, 0xbb, 1, 2, 0xbb, 1, 2]);
  assert.equal(ed.undoStack.length, 1, '全部替换应为一个撤销单元');
  ed.undo();
  assert.deepEqual([...ed.doc.toBytes()], [0xaa, 0xbb, 0xaa, 0xbb, 0xaa]);
});

test('批量替换：重叠命中按从左到右不重叠选取', () => {
  const ed = new HexEditor(bytes(0xaa, 0xaa, 0xaa)); // "aa" 命中 [0,1]（重叠）
  ed.setSearchResults(ed.revision, bytes(0xaa, 0xaa), [0, 1]);
  const n = ed.replaceAllFromSearch(bytes(0xbb));
  assert.equal(n, 1, '重叠命中只替换第一处');
  assert.deepEqual([...ed.doc.toBytes()], [0xbb, 0xaa]);
});

test('替换后旧搜索结果自动过期', () => {
  const ed = new HexEditor(bytes(0xaa, 0xaa));
  ed.setSearchResults(ed.revision, bytes(0xaa), [0, 1]);
  ed.replaceAllFromSearch(bytes(0xbb));
  assert.equal(ed.searchStale, true);
  assert.throws(() => ed.replaceAllFromSearch(bytes(0xcc)), /已过期/);
});

test('transaction 把多笔编辑合成一个撤销单元并迁移光标', () => {
  const ed = new HexEditor(bytes(1, 2, 3, 4, 5, 6));
  ed.moveCursor(5);
  ed.transaction([
    { pos: 4, delLen: 2, ins: bytes(9) },   // 1 2 3 4 9
    { pos: 0, delLen: 1, ins: bytes(7, 8) }, // 7 8 2 3 4 9
  ]);
  assert.deepEqual([...ed.doc.toBytes()], [7, 8, 2, 3, 4, 9]);
  assert.equal(ed.undoStack.length, 1);
  ed.undo();
  assert.deepEqual([...ed.doc.toBytes()], [1, 2, 3, 4, 5, 6]);
});
