// 导出与摘要测试：SHA-256 正确性、导出快照与并发编辑隔离。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SHA256 } from '../src/sha256.js';
import { exportSnapshot } from '../src/exporter.js';
import { HexEditor } from '../src/editor.js';
import { mulberry32, randomBytes } from './helpers.js';

const sha256Node = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('SHA-256 标准测试向量', () => {
  assert.equal(
    new SHA256().hex(),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    new SHA256().update(new TextEncoder().encode('abc')).hex(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    new SHA256().update(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).hex(),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('SHA-256 随机分块与 Node crypto 对拍', () => {
  const rng = mulberry32(31337);
  for (let round = 0; round < 50; round++) {
    const data = randomBytes(rng, Math.floor(rng() * 5000));
    const h = new SHA256();
    let off = 0;
    while (off < data.length) {
      const n = Math.min(data.length - off, 1 + Math.floor(rng() * 200));
      h.update(data.subarray(off, off + n));
      off += n;
    }
    assert.equal(h.hex(), sha256Node(data), `round=${round} len=${data.length}`);
  }
});

test('导出：内容分段生成，摘要与整份哈希一致', async () => {
  const rng = mulberry32(99);
  const ed = new HexEditor(randomBytes(rng, 5000));
  // 制造多段：中间插入、头部替换、尾部删除
  ed.splice(1000, 500, randomBytes(rng, 800));
  ed.splice(0, 100, randomBytes(rng, 50));
  ed.splice(ed.length - 300, 300);
  ed.doc.validate();
  assert.ok(ed.doc.pieces.length >= 3);

  const expected = ed.doc.toBytes();
  const result = await exportSnapshot(ed.doc, { yieldThresholdBytes: 64 }); // 小段让点，走多轮
  assert.equal(result.length, expected.length);
  assert.equal(result.digest, sha256Node(expected));
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), expected);
});

test('导出期间的后续编辑不改变该份导出（快照语义）', async () => {
  const rng = mulberry32(1234);
  const ed = new HexEditor(randomBytes(rng, 2000));
  ed.splice(500, 100, randomBytes(rng, 300)); // 多段文档
  ed.splice(0, 0, randomBytes(rng, 77));

  const expected = ed.doc.toBytes();          // 导出开始时的内容
  const expectedDigest = sha256Node(expected);

  let interleaved = false;
  const result = await exportSnapshot(ed.doc, {
    yieldThresholdBytes: 1, // 每段之后都让点，确保编辑插在导出中途
    onYield: () => {
      if (interleaved) return;
      interleaved = true;
      // 导出进行中大肆修改文档：插入、删除、替换、撤销
      ed.splice(0, 0, randomBytes(rng, 999));
      ed.splice(10, 50, randomBytes(rng, 20));
      ed.splice(ed.length - 100, 100);
      ed.undo();
    },
  });

  assert.ok(interleaved, '测试必须真的在导出中途编辑过');
  assert.notEqual(ed.length, expected.length, '文档确实已被改乱');
  assert.equal(result.length, expected.length, '导出长度必须等于导出开始时的快照');
  assert.equal(result.digest, expectedDigest, '导出摘要必须对应快照而非当前文档');
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), expected);
});

test('空文档导出', async () => {
  const ed = new HexEditor();
  const result = await exportSnapshot(ed.doc);
  assert.equal(result.length, 0);
  assert.equal(result.digest, sha256Node(new Uint8Array(0)));
  assert.equal((await result.blob.arrayBuffer()).byteLength, 0);
});

test('导出期间键入半字节：就地改写被冻结，快照不受污染', async () => {
  const ed = new HexEditor(new Uint8Array(100));
  ed.insertMode = true;
  ed.moveCursor(50);
  ed.typeHexDigit(0xa); // 首半字节：插入 0xa0，进入待补全状态
  const expected = ed.doc.toBytes(); // 此刻启动导出，快照含半字节 0xa0
  const expectedDigest = sha256Node(expected);

  const result = await exportSnapshot(ed.doc, {
    yieldThresholdBytes: 1,
    onYield: () => {
      ed.typeHexDigit(0xb); // 补全为 0xab —— 若就地改写未被冻结，将污染导出快照
    },
  });

  assert.equal(ed.doc.byteAt(50), 0xab, '当前文档确实已补全');
  assert.equal(result.digest, expectedDigest, '导出摘要必须对应导出开始时的快照');
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), expected);
});

test('撤销到历史状态后导出的是该状态', async () => {
  const ed = new HexEditor(new TextEncoder().encode('version-1'));
  const v1 = ed.doc.toBytes();
  ed.splice(9, 1, new TextEncoder().encode('2')); // version-2
  ed.splice(9, 1, new TextEncoder().encode('3')); // version-3
  ed.undo();
  ed.undo(); // 回到 version-1
  const result = await exportSnapshot(ed.doc);
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), v1);
  assert.equal(result.digest, sha256Node(v1));
});
