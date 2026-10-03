// 搜索 Worker：在后台线程对文档做 KMP 流式扫描。
//
// 同步协议（主线程 → Worker）：
//   { type:'init',   docId, orig }                        原文件缓冲（每份文档克隆一次）
//   { type:'search', docId, id, revision, length, pieces, addChunks, pattern }
//     pieces    —— 当前片段表 [[isOrig, start, len], ...]（很小，每次全量发）
//     addChunks —— 只发送 Worker 尚未收到的追加区新块（增量同步）
//     revision  —— 本次搜索绑定的修订号，随 done 回传；主线程据此判过期
//
// 回包：{ type:'hits', id, positions:Uint32Array }（分批，可含重叠命中）
//       { type:'progress', id, scanned, total }
//       { type:'done', id, revision, truncated }

import { AppendStore } from './piece-table.js';
import { createMatcher, streamFromSnap } from './search.js';

const MAX_HITS = 200000;
const docs = new Map();   // docId -> { orig, add }
let generation = 0;       // 新搜索使旧搜索作废

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    docs.set(m.docId, { orig: new Uint8Array(m.orig), add: new AppendStore() });
  } else if (m.type === 'search') {
    generation++;
    run(m, generation);
  }
};

async function run(m, gen) {
  const d = docs.get(m.docId);
  if (!d) {
    self.postMessage({ type: 'done', id: m.id, revision: m.revision, truncated: false });
    return;
  }
  for (const c of m.addChunks) d.add.append(new Uint8Array(c));

  const snap = {
    pieces: m.pieces.map((p) => ({ orig: !!p[0], start: p[1], len: p[2] })),
    orig: d.orig,
    add: d.add,
    length: m.length,
  };
  const matcher = createMatcher(m.pattern);
  const stream = streamFromSnap(snap);

  let total = 0, truncated = false, i = 0, b;
  let batch = [];
  const flush = () => {
    if (batch.length === 0) return;
    const arr = Uint32Array.from(batch);
    self.postMessage({ type: 'hits', id: m.id, positions: arr }, [arr.buffer]);
    batch = [];
  };

  while ((b = stream.next()) >= 0) {
    const h = matcher.feed(b);
    if (h >= 0) {
      if (total >= MAX_HITS) { truncated = true; break; }
      batch.push(h);
      total++;
      if (batch.length >= 1024) flush();
    }
    i++;
    if ((i & 0xfffff) === 0) {   // 每 1M 字节：汇报进度、让出、检查是否被取代
      self.postMessage({ type: 'progress', id: m.id, scanned: i, total: m.length });
      if (gen !== generation) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  flush();
  self.postMessage({ type: 'done', id: m.id, revision: m.revision, truncated });
}
