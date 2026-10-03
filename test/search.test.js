// 搜索测试：findAll 正确性、跨段命中、Worker 消息往返。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { findAll } from '../src/search-core.js';
import { HexEditor } from '../src/editor.js';
import { mulberry32, randomBytes, refFindAll } from './helpers.js';

const ascii = (s) => new TextEncoder().encode(s);

test('findAll 基本行为与重叠语义', () => {
  assert.deepEqual(findAll(ascii('aaaa'), ascii('aa')), [0, 1, 2], '允许重叠');
  assert.deepEqual(findAll(ascii('aaaa'), ascii('aa'), { overlap: false }), [0, 2], '不重叠');
  assert.deepEqual(findAll(ascii('abc'), ascii('')), [], '空模式无命中');
  assert.deepEqual(findAll(ascii('ab'), ascii('abcd')), [], '模式长于文本无命中');
  assert.deepEqual(findAll(new Uint8Array(0), ascii('a')), [], '空文档无命中');
  assert.deepEqual(findAll(ascii('abcabc'), ascii('abc')), [0, 3]);
});

test('findAll 与朴素实现对拍（随机数据）', () => {
  const rng = mulberry32(555);
  for (let round = 0; round < 200; round++) {
    const n = Math.floor(rng() * 300);
    // 小字节表制造大量命中与重叠
    const hay = randomBytes(rng, n).map((b) => b % 4);
    const m = 1 + Math.floor(rng() * 5);
    const needle = randomBytes(rng, m).map((b) => b % 4);
    assert.deepEqual(findAll(hay, needle), refFindAll(hay, needle), `round=${round}`);
    assert.deepEqual(
      findAll(hay, needle, { overlap: false }),
      refFindAll(hay, needle, false),
      `round=${round} no-overlap`,
    );
  }
});

test('跨段命中：模式横跨 ORIG/ADD 段边界', () => {
  // 通过编辑构造多段文档： 'hello ' + 中间插入 'beautiful ' + 'world!'
  const ed = new HexEditor(ascii('hello world!'));
  ed.splice(6, 0, ascii('beautiful ')); // → ORIG / ADD / ORIG 三段
  assert.ok(ed.doc.pieces.length >= 3, `应至少有三段，实际 ${ed.doc.pieces.length}`);
  const doc = ed.doc.toBytes();
  assert.equal(new TextDecoder().decode(doc), 'hello beautiful world!');

  // 分别横跨 ORIG→ADD、ADD→ORIG、以及贯穿全部三段
  assert.deepEqual(findAll(doc, ascii('o bea')), [4]);
  assert.deepEqual(findAll(doc, ascii('ful wor')), [12]);
  assert.deepEqual(findAll(doc, ascii('hello beautiful world!')), [0]);
  assert.deepEqual(findAll(doc, ascii('lo')), [3]);
});

test('随机编辑后的文档搜索与参考实现一致（跨范围命中）', () => {
  const rng = mulberry32(777);
  for (let round = 0; round < 30; round++) {
    const ed = new HexEditor(randomBytes(rng, 20 + Math.floor(rng() * 60)).map((b) => b % 3));
    for (let i = 0; i < 20; i++) {
      const pos = Math.floor(rng() * (ed.length + 1));
      const ins = randomBytes(rng, Math.floor(rng() * 8)).map((b) => b % 3);
      const del = Math.floor(rng() * Math.min(8, ed.length - pos));
      ed.splice(pos, del, ins);
    }
    const doc = ed.doc.toBytes();
    // 从文档中截取一段作为模式（保证至少一个命中，且常跨段）
    const start = Math.floor(rng() * doc.length);
    const len = 1 + Math.floor(rng() * Math.min(6, doc.length - start));
    const needle = doc.slice(start, start + len);
    assert.deepEqual(findAll(doc, needle), refFindAll(doc, needle), `round=${round}`);
  }
});

test('搜索 Worker 消息往返（结果绑定修订号）', async () => {
  const worker = new Worker(new URL('../src/search-worker.js', import.meta.url));
  try {
    const ed = new HexEditor(ascii('hello world, hello worker'));
    const rev = ed.revision;
    const snapshot = ed.doc.toBytes();
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage(
        { id: 1, rev, pattern: ascii('hello'), buffer: snapshot.buffer },
        [snapshot.buffer],
      );
    });
    assert.equal(result.id, 1);
    assert.equal(result.rev, rev, '返回的修订号必须与请求一致');
    assert.deepEqual(result.positions, [0, 13]);

    // 模拟“搜索期间继续编辑”：主线程据此把旧结果标为过期
    ed.setSearchResults(result.rev, ascii('hello'), result.positions);
    ed.splice(0, 0, ascii('>> '));
    assert.equal(ed.searchStale, true);
    assert.throws(() => ed.replaceAllFromSearch(ascii('hi')), /已过期/);
  } finally {
    await worker.terminate();
  }
});
