// 测试：小数组参考实现与 PieceTable 对拍随机编辑历史，
// 并核对跨范围命中、撤销分支、位置迁移与导出快照。
// 运行：node test/run.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PieceTable, AppendStore, snapChunks } from '../src/piece-table.js';
import { mapPos, mapThrough } from '../src/mapping.js';
import { Sha256 } from '../src/sha256.js';
import { searchAll, naiveSearch } from '../src/search.js';
import { exportSnapshot } from '../src/exporter.js';

let passed = 0, failed = 0;
const asyncQueue = [];
function test(name, fn) {
  try { fn(); passed++; console.log('ok   -', name); }
  catch (e) { failed++; console.error('FAIL -', name); console.error(e); }
}
function testAsync(name, fn) { asyncQueue.push([name, fn]); }

// ---------------------------------------------------------------- 工具
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randBytes(rng, n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (rng() * 256) | 0;
  return b;
}
function concatParts(parts, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
const te = new TextEncoder();

// ---------------------------------------------------------------- 参考实现
// 独立的小数组模型：字节用普通数组 splice；每个字节带唯一令牌 id，
// 用令牌身份独立推导“位置迁移”的期望值，避免与被测实现同构。
class Ref {
  constructor(bytes) {
    this.bytes = [...bytes];
    this.tokens = this.bytes.map((_, i) => i);
    this.nextTok = this.bytes.length;
    this.undoS = [];
    this.redoS = [];
  }
  edit(pos, del, ins) {
    const removedB = this.bytes.splice(pos, del, ...ins);
    const newToks = ins.map(() => this.nextTok++);
    const removedT = this.tokens.splice(pos, del, ...newToks);
    this.undoS.push({ pos, del, ins: [...ins], removedB, removedT, newToks });
    this.redoS.length = 0;
  }
  // 与 PieceTable.applyEdits 相同的“同一坐标系批量”语义（从后往前应用）
  applyEdits(edits) {
    const sorted = [...edits].sort((a, b) => a.pos - b.pos || a.deleteLen - b.deleteLen);
    const batch = sorted.map((e) => ({ pos: e.pos, del: e.deleteLen, ins: [...e.insert] }));
    for (let i = batch.length - 1; i >= 0; i--) {
      const e = batch[i];
      e.removedB = this.bytes.splice(e.pos, e.del, ...e.ins);
      e.newToks = e.ins.map(() => this.nextTok++);
      e.removedT = this.tokens.splice(e.pos, e.del, ...e.newToks);
    }
    this.undoS.push({ batch });
    this.redoS.length = 0;
  }
  undo() {
    const c = this.undoS.pop();
    if (!c) return null;
    // 正向从右往左应用 ⇒ 撤销从左往右（逆序回滚应用序列）
    const list = c.batch ? c.batch : [c];
    for (const e of list) {
      this.bytes.splice(e.pos, e.ins.length, ...e.removedB);
      this.tokens.splice(e.pos, e.newToks.length, ...e.removedT);
    }
    this.redoS.push(c);
    return c;
  }
  redo() {
    const c = this.redoS.pop();
    if (!c) return null;
    // 重做复现正向应用顺序：从右往左
    const list = c.batch ? [...c.batch].reverse() : [c];
    for (const e of list) {
      this.bytes.splice(e.pos, e.del, ...e.ins);
      this.tokens.splice(e.pos, e.removedT.length, ...e.newToks);
    }
    this.undoS.push(c);
    return c;
  }
}

// 位置标记 = 左右相邻字节的令牌（'S'/'E' 为文档首尾哨兵，永不删除）。
// 与 mapPos 相同的“左重力”约定：位置恰好处于插入点时保持不动。
function markerFrom(tokens, p) {
  return { left: p > 0 ? tokens[p - 1] : 'S', right: p < tokens.length ? tokens[p] : 'E' };
}
function tokMarkerPos(tokens, m, fallbackPos) {
  if (m.left === 'S') return 0;
  const li = tokens.indexOf(m.left);
  if (li >= 0) return li + 1;
  if (m.right === 'E') return tokens.length;
  const ri = tokens.indexOf(m.right);
  if (ri >= 0) return ri;
  return fallbackPos;   // 两侧字节都被删除：收缩到编辑点
}

function expectSame(doc, ref, ctx) {
  assert.equal(doc.length, ref.bytes.length, `${ctx}: 长度不一致`);
  assert.deepEqual(doc.toBytes(), Uint8Array.from(ref.bytes), `${ctx}: 内容不一致`);
}

// ---------------------------------------------------------------- SHA-256
test('SHA-256 增量实现与标准向量 / Node crypto 一致', () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
     '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ];
  for (const [msg, want] of vectors) {
    const s = new Sha256();
    s.update(te.encode(msg));
    assert.equal(s.digestHex(), want, `向量 "${msg.slice(0, 20)}"`);
  }
  const rng = mulberry32(42);
  for (let t = 0; t < 20; t++) {           // 随机数据 + 随机分块喂入
    const data = randBytes(rng, (rng() * 5000) | 0);
    const s = new Sha256();
    let off = 0;
    while (off < data.length) {
      const n = 1 + ((rng() * 200) | 0);
      s.update(data.subarray(off, off + n));
      off += n;
    }
    assert.equal(s.digestHex(), createHash('sha256').update(data).digest('hex'), `len=${data.length}`);
  }
  for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {  // 填充边界
    const data = randBytes(rng, n);
    const s = new Sha256();
    s.update(data);
    assert.equal(s.digestHex(), createHash('sha256').update(data).digest('hex'), `边界 n=${n}`);
  }
});

// ---------------------------------------------------------------- AppendStore
test('AppendStore 跨块读取与随机访问', () => {
  const st = new AppendStore();
  const rng = mulberry32(7);
  const parts = [randBytes(rng, 5), randBytes(rng, 300), randBytes(rng, 1), randBytes(rng, 77)];
  for (const p of parts) st.append(p);
  const all = concatParts(parts, st.length);
  assert.equal(st.length, 383);
  for (let off = 0; off < all.length; off += 11) {
    for (const len of [1, 3, 100, 400]) {
      const n = Math.min(len, all.length - off);
      assert.deepEqual(st.read(off, n), all.subarray(off, off + n), `read(${off},${n})`);
    }
  }
  for (let i = 0; i < all.length; i++) assert.equal(st.byteAt(i), all[i], `byteAt(${i})`);
});

// ---------------------------------------------------------------- 位置迁移
test('位置迁移规则', () => {
  // 在 10 处删 5 插 3
  assert.equal(mapPos(5, 10, 5, 3), 5);
  assert.equal(mapPos(10, 10, 5, 3), 10);
  assert.equal(mapPos(12, 10, 5, 3), 10);   // 落入被删区间 → 编辑点
  assert.equal(mapPos(14, 10, 5, 3), 10);
  assert.equal(mapPos(15, 10, 5, 3), 13);   // 之后平移
  assert.equal(mapPos(20, 10, 5, 3), 18);
  assert.equal(mapThrough(20, [{ pos: 10, deleteLen: 5, insertLen: 3 }, { pos: 0, deleteLen: 0, insertLen: 2 }]), 20);
});

// ---------------------------------------------------------------- 基本编辑
test('基本插入/删除/替换 + 原文件不被复制或修改', () => {
  const orig = te.encode('hello world');
  const origCopy = orig.slice();
  const doc = new PieceTable(orig);
  assert.equal(doc.orig, orig, '原文件按引用持有，不复制');
  doc.edit(5, 0, te.encode(','));
  doc.edit(0, 5, te.encode('HELLO'));
  doc.edit(7, 1, te.encode('W'));
  assert.equal(new TextDecoder().decode(doc.toBytes()), 'HELLO, World');
  assert.deepEqual(orig, origCopy, '原文件内容未被修改');
  doc.undo();
  assert.equal(new TextDecoder().decode(doc.toBytes()), 'HELLO, world');
  doc.undo(); doc.undo();
  assert.equal(new TextDecoder().decode(doc.toBytes()), 'hello world');
  doc.redo(); doc.redo(); doc.redo();
  assert.equal(new TextDecoder().decode(doc.toBytes()), 'HELLO, World');
});

// ---------------------------------------------------------------- 随机对拍
test('随机编辑历史对拍（插入/删除/替换/撤销/重做 + 光标迁移）', () => {
  for (let seed = 1; seed <= 16; seed++) {
    const rng = mulberry32(seed);
    const init = randBytes(rng, 1 + ((rng() * 300) | 0));
    const doc = new PieceTable(init);
    const ref = new Ref(init);
    const mk = () => (rng() * (doc.length + 1)) | 0;
    let markers = [mk(), mk(), mk(), mk(), mk(), mk()];
    let tokMarkers = markers.map((p) => markerFrom(ref.tokens, p));

    for (let op = 0; op < 300; op++) {
      const r = rng();
      let descs = null;
      if (r < 0.32) {                                   // 插入
        const pos = (rng() * (doc.length + 1)) | 0;
        const ins = randBytes(rng, 1 + ((rng() * 8) | 0));
        descs = doc.edit(pos, 0, ins);
        ref.edit(pos, 0, [...ins]);
      } else if (r < 0.58 && doc.length > 0) {          // 删除
        const pos = (rng() * doc.length) | 0;
        const del = 1 + ((rng() * Math.min(8, doc.length - pos)) | 0);
        descs = doc.edit(pos, del, new Uint8Array(0));
        ref.edit(pos, del, []);
      } else if (r < 0.78 && doc.length > 0) {          // 替换
        const pos = (rng() * doc.length) | 0;
        const del = 1 + ((rng() * Math.min(6, doc.length - pos)) | 0);
        const ins = randBytes(rng, 1 + ((rng() * 6) | 0));
        descs = doc.edit(pos, del, ins);
        ref.edit(pos, del, [...ins]);
      } else if (r < 0.89) {                            // 撤销
        descs = doc.undo();
        const rc = ref.undo();
        assert.equal(descs === null, rc === null, `undo 可用性不一致 seed=${seed} op=${op}`);
      } else {                                          // 重做
        descs = doc.redo();
        const rc = ref.redo();
        assert.equal(descs === null, rc === null, `redo 可用性不一致 seed=${seed} op=${op}`);
      }

      const ctx = `seed=${seed} op=${op}`;
      if (descs) {
        assert.equal(descs.length, 1, '单条编辑应产生单个描述');
        markers = markers.map((m) => mapThrough(m, descs));
        // 令牌参考：解析新位置后重新锚定（两侧令牌可能已被删除）
        tokMarkers = tokMarkers.map((m) => {
          const p = tokMarkerPos(ref.tokens, m, descs[0].pos);
          return markerFrom(ref.tokens, p);
        });
      }
      expectSame(doc, ref, ctx);
      for (let k = 0; k < markers.length; k++) {
        const want = tokMarkerPos(ref.tokens, tokMarkers[k], 0);
        assert.equal(markers[k], want, `${ctx}: 标记 ${k} 迁移不一致`);
      }
    }
  }
});

// ---------------------------------------------------------------- 批量编辑
test('批量同坐标编辑（全部替换语义）对拍 + 单步撤销恢复', () => {
  for (let seed = 100; seed < 112; seed++) {
    const rng = mulberry32(seed);
    const doc = new PieceTable(randBytes(rng, 200 + ((rng() * 400) | 0)));
    const ref = new Ref(doc.toBytes());
    // 先做几笔单编辑，制造多片段结构
    for (let i = 0; i < 5; i++) {
      const pos = (rng() * (doc.length + 1)) | 0;
      const ins = randBytes(rng, 1 + ((rng() * 6) | 0));
      doc.edit(pos, 0, ins);
      ref.edit(pos, 0, [...ins]);
    }
    // 从内容里取子串当模式（保证有命中，且常跨片段）
    const bytes = doc.toBytes();
    const patLen = 1 + ((rng() * 4) | 0);
    const p0 = (rng() * (bytes.length - patLen)) | 0;
    const pat = bytes.slice(p0, p0 + patLen);
    // 过滤重叠命中（保留最左），与应用的“全部替换”一致
    const keep = [];
    let end = -1;
    for (const h of naiveSearch(bytes, pat)) {
      if (h >= end) { keep.push(h); end = h + patLen; }
    }
    assert.ok(keep.length > 0);
    const repl = randBytes(rng, (rng() * 5) | 0);   // 允许不等长替换
    const edits = keep.map((h) => ({ pos: h, deleteLen: patLen, insert: repl }));
    const descs = doc.applyEdits(edits);
    ref.applyEdits(edits);
    assert.equal(descs.length, keep.length);
    expectSame(doc, ref, `seed=${seed} 批量应用`);
    assert.equal(doc.undoStack.length, 6, '整批应为一条撤销记录');
    doc.undo(); ref.undo();
    expectSame(doc, ref, `seed=${seed} 批量撤销`);
    doc.redo(); ref.redo();
    expectSame(doc, ref, `seed=${seed} 批量重做`);
  }
});

// ---------------------------------------------------------------- 撤销分支
test('撤销分支：撤销后新编辑清空重做栈', () => {
  const doc = new PieceTable(Uint8Array.of(1, 2, 3));
  doc.edit(0, 0, Uint8Array.of(9));
  doc.edit(0, 0, Uint8Array.of(8));
  doc.undo();                                    // 撤销 8
  assert.equal(doc.redoStack.length, 1);
  doc.edit(0, 0, Uint8Array.of(7));              // 新分支
  assert.equal(doc.redoStack.length, 0, '新编辑必须清空重做栈');
  assert.deepEqual([...doc.toBytes()], [7, 9, 1, 2, 3]);
  doc.undo(); doc.undo();
  assert.deepEqual([...doc.toBytes()], [1, 2, 3]);
  assert.equal(doc.undo(), null, '空栈撤销应返回 null');
  // 撤销本身会压入重做栈：此时可以逐步重做回来
  doc.redo();
  assert.deepEqual([...doc.toBytes()], [9, 1, 2, 3]);
  doc.redo();
  assert.deepEqual([...doc.toBytes()], [7, 9, 1, 2, 3]);
  assert.equal(doc.redo(), null, '重做栈耗尽应返回 null');
});

// ---------------------------------------------------------------- 输入合并
test('连续输入合并为单个撤销步骤（覆盖与插入两种模式）', () => {
  // 覆盖模式：两个字节、每字节两击半字节 → 一条撤销记录
  const doc = new PieceTable(Uint8Array.of(1, 2, 3));
  doc.edit(0, 1, Uint8Array.of(0xa1), 7);   // 第 1 字节高半字节
  doc.edit(0, 1, Uint8Array.of(0xab), 7);   // 第 1 字节低半字节
  doc.edit(1, 1, Uint8Array.of(0xc2), 7);   // 第 2 字节高半字节
  doc.edit(1, 1, Uint8Array.of(0xcd), 7);   // 第 2 字节低半字节
  assert.deepEqual([...doc.toBytes()], [0xab, 0xcd, 3]);
  assert.equal(doc.undoStack.length, 1, '覆盖输入应合并为一条撤销记录');
  doc.undo();
  assert.deepEqual([...doc.toBytes()], [1, 2, 3]);
  doc.redo();
  assert.deepEqual([...doc.toBytes()], [0xab, 0xcd, 3]);

  // 插入模式：逐字节输入（含半字节补全）→ 一条撤销记录
  const doc2 = new PieceTable();
  doc2.edit(0, 0, Uint8Array.of(0x50), 3);  // 插入高半字节
  doc2.edit(0, 1, Uint8Array.of(0x5a), 3);  // 补全为 0x5a
  doc2.edit(1, 0, Uint8Array.of(0x60), 3);  // 插入第二字节高半字节
  doc2.edit(1, 1, Uint8Array.of(0x6b), 3);  // 补全为 0x6b
  assert.deepEqual([...doc2.toBytes()], [0x5a, 0x6b]);
  assert.equal(doc2.undoStack.length, 1, '插入输入应合并为一条撤销记录');
  doc2.undo();
  assert.equal(doc2.length, 0);
  doc2.redo();
  assert.deepEqual([...doc2.toBytes()], [0x5a, 0x6b]);

  // 会话号变化 → 不再合并
  const doc3 = new PieceTable();
  doc3.edit(0, 0, Uint8Array.of(1), 1);
  doc3.edit(1, 0, Uint8Array.of(2), 2);
  assert.equal(doc3.undoStack.length, 2);
});

// ---------------------------------------------------------------- 搜索
test('KMP 匹配器（含重叠命中与空模式）', () => {
  const doc = new PieceTable(te.encode('aaaa'));
  assert.deepEqual(searchAll(doc, te.encode('aa')), [0, 1, 2]);
  assert.deepEqual(searchAll(doc, te.encode('aaa')), [0, 1]);
  assert.deepEqual(searchAll(doc, te.encode('aaaaa')), []);
  assert.deepEqual(searchAll(doc, te.encode('')), []);
});

test('跨片段（跨范围）命中', () => {
  const doc = new PieceTable(te.encode('abcHEL'));
  doc.edit(6, 0, te.encode('LO_WOR'));     // abcHELLO_WOR
  doc.edit(0, 3, new Uint8Array(0));       // 删除 abc → HELLO_WOR
  doc.edit(9, 0, te.encode('LD!!!'));      // HELLO_WORLD!!!
  const bytes = doc.toBytes();
  assert.equal(new TextDecoder().decode(bytes), 'HELLO_WORLD!!!');
  assert.ok(doc.pieces.length >= 2, '应存在多个片段');
  // 这些模式横跨 原文件片段 / 追加区片段 的边界
  for (const pat of ['HELLO_WORLD', 'LLO_WOR', 'ORLD!', 'H', '!!!', 'LO_WORL', 'ELLO']) {
    const p = te.encode(pat);
    assert.deepEqual(searchAll(doc, p), naiveSearch(bytes, p), `模式 "${pat}"`);
  }
});

test('随机文档 + 随机编辑后的搜索对拍', () => {
  for (let seed = 300; seed < 320; seed++) {
    const rng = mulberry32(seed);
    const doc = new PieceTable(randBytes(rng, 60 + ((rng() * 120) | 0)));
    const flat = [...doc.toBytes()];
    for (let i = 0; i < 12; i++) {          // 随机编辑制造片段边界
      const pos = (rng() * (doc.length + 1)) | 0;
      const del = doc.length > pos ? (rng() * Math.min(5, doc.length - pos)) | 0 : 0;
      const ins = randBytes(rng, (rng() * 5) | 0);
      if (del === 0 && ins.length === 0) continue;
      doc.edit(pos, del, ins);
      flat.splice(pos, del, ...ins);
    }
    const bytes = Uint8Array.from(flat);
    assert.deepEqual(doc.toBytes(), bytes);
    for (let t = 0; t < 20; t++) {
      let pat;
      if (t % 2 === 0 && bytes.length > 4) {   // 一半取内容子串（必有命中）
        const l = 1 + ((rng() * 5) | 0);
        const p0 = (rng() * (bytes.length - l)) | 0;
        pat = bytes.slice(p0, p0 + l);
      } else {                                  // 一半完全随机
        pat = randBytes(rng, 1 + ((rng() * 4) | 0));
      }
      assert.deepEqual(searchAll(doc, pat), naiveSearch(bytes, pat),
        `seed=${seed} t=${t} pat=${[...pat]}`);
    }
  }
});

// ---------------------------------------------------------------- 导出快照
testAsync('导出快照不受后续编辑影响，摘要正确', async () => {
  const rng = mulberry32(999);
  const doc = new PieceTable(randBytes(rng, 5000));
  for (let i = 0; i < 20; i++) {
    const pos = (rng() * (doc.length + 1)) | 0;
    const del = doc.length > pos ? (rng() * Math.min(20, doc.length - pos)) | 0 : 0;
    const ins = randBytes(rng, (rng() * 20) | 0);
    if (del === 0 && ins.length === 0) continue;
    doc.edit(pos, del, ins);
  }
  const snap = doc.snapshot();
  const expected = doc.toBytes();
  const snapRevision = snap.revision;

  // 快照之后继续大量编辑（含撤销/重做）——不得影响快照
  for (let i = 0; i < 30; i++) {
    const r = rng();
    if (r < 0.6) {
      const pos = (rng() * (doc.length + 1)) | 0;
      const del = doc.length > pos ? (rng() * Math.min(10, doc.length - pos)) | 0 : 0;
      const ins = randBytes(rng, (rng() * 10) | 0);
      if (del === 0 && ins.length === 0) continue;
      doc.edit(pos, del, ins);
    } else if (r < 0.8) doc.undo();
    else doc.redo();
  }
  assert.notEqual(doc.revision, snapRevision, '编辑后修订号必须变化（搜索过期判定的基础）');

  // 各种分块大小遍历快照，内容必须等于拍照时的文档
  for (const maxChunk of [1, 7, 4096, 1 << 20]) {
    const parts = [];
    let total = 0;
    for (const c of snapChunks(snap, maxChunk)) { parts.push(c); total += c.length; }
    assert.equal(total, expected.length, `maxChunk=${maxChunk}`);
    assert.deepEqual(concatParts(parts, total), expected, `maxChunk=${maxChunk}`);
  }

  // 完整导出流程：内容 + 摘要 + 绑定的修订号
  const res = await exportSnapshot(snap);
  assert.equal(res.length, expected.length);
  assert.equal(res.revision, snapRevision);
  assert.equal(res.sha256, createHash('sha256').update(expected).digest('hex'), '导出摘要');
  assert.deepEqual(concatParts(res.parts, res.length), expected, '导出内容');
});

// ---------------------------------------------------------------- 参数校验
test('非法编辑被拒绝', () => {
  const doc = new PieceTable(Uint8Array.of(1, 2, 3));
  assert.throws(() => doc.edit(-1, 0, Uint8Array.of(1)), RangeError);
  assert.throws(() => doc.edit(4, 0, Uint8Array.of(1)), RangeError);
  assert.throws(() => doc.edit(2, 2, new Uint8Array(0)), RangeError);
  assert.throws(() => doc.edit(1, 0, new Uint8Array(0)), Error);          // 空编辑
  assert.throws(() => doc.applyEdits([                                     // 重叠
    { pos: 1, deleteLen: 2, insert: Uint8Array.of(9) },
    { pos: 2, deleteLen: 1, insert: Uint8Array.of(8) },
  ]), Error);
  assert.equal(doc.length, 3, '失败后文档不变');
  assert.equal(doc.revision, 0, '失败后修订号不变');
});

// ---------------------------------------------------------------- Worker 协议
testAsync('搜索 Worker：增量同步追加区 + 结果绑定修订号', async () => {
  // 用垫片模拟 Web Worker 环境，端到端驱动 src/search-worker.js
  const posted = [];
  const savedSelf = globalThis.self;
  globalThis.self = { onmessage: null, postMessage: (m) => posted.push(m) };
  try {
    await import('../src/search-worker.js');
    const doc = new PieceTable(te.encode('abc---abc---abc'));
    const send = (m) => globalThis.self.onmessage({ data: m });
    send({ type: 'init', docId: 1, orig: doc.orig.buffer.slice(0) });

    let synced = 0;
    const search = (id) => {
      const newChunks = doc.add.chunks.slice(synced)
        .map((c) => c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength));
      synced = doc.add.chunks.length;
      send({ type: 'search', docId: 1, id, revision: doc.revision, length: doc.length,
             pieces: doc.pieces.map((p) => [p.orig ? 1 : 0, p.start, p.len]),
             addChunks: newChunks, pattern: te.encode('abc') });
    };
    const collect = async () => {
      await new Promise((r) => setTimeout(r, 50));
      const hits = posted.filter((m) => m.type === 'hits').flatMap((m) => [...m.positions]);
      const done = posted.find((m) => m.type === 'done');
      posted.length = 0;
      return { hits, done };
    };

    let r = await (search(1), collect());
    assert.deepEqual(r.hits, [0, 6, 12]);
    assert.equal(r.done.revision, 0, '结果必须绑定产生它的修订号');

    doc.edit(7, 0, te.encode('abc'));          // → abc---aabcbc---abc
    r = await (search(2), collect());
    assert.deepEqual(r.hits, [0, 7, 15], '增量同步后结果应反映新内容');
    assert.equal(r.done.revision, 1);
    assert.equal(r.done.revision, doc.revision, '修订号一致 → 结果新鲜，可用于批量替换');
  } finally {
    globalThis.self = savedSelf;
  }
});

// ---------------------------------------------------------------- 运行
let asyncPassed = 0, asyncFailed = 0;
for (const [name, fn] of asyncQueue) {
  try { await fn(); asyncPassed++; console.log('ok   -', name); }
  catch (e) { asyncFailed++; console.error('FAIL -', name); console.error(e); }
}
const totalPass = passed + asyncPassed;
const totalFail = failed + asyncFailed;
console.log(`\n${totalPass} 通过, ${totalFail} 失败`);
process.exitCode = totalFail ? 1 : 0;
