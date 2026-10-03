// 应用层：文件载入、工具栏、搜索客户端（修订绑定/过期判定）、全部替换、导出。

import { PieceTable } from './piece-table.js';
import { exportSnapshot } from './exporter.js';
import { HexView } from './hexview.js';
import { parseHexInput } from './util.js';

const $ = (id) => document.getElementById(id);
const MAX_SIZE = 8 * 1024 * 1024;   // 8 MB 上限
const encoder = new TextEncoder();

let doc = new PieceTable();
let fileName = '未命名.bin';

const view = new HexView($('hexview'), { onChange: updateStatus, onCursor: updateStatus });

// ---------------------------------------------------------------- 搜索
const worker = new Worker('./src/search-worker.js', { type: 'module' });
let docId = 0;          // 每载入一份文档 +1，Worker 端按 docId 保存镜像
let syncedChunks = 0;   // 已同步给 Worker 的追加区块数（增量同步）
let reqId = 0;
let pendingId = null;   // 进行中的搜索 id
// 命中结果绑定产生它的修订号；之后任何编辑都使它过期，不能直接用于批量替换。
let hits = { searched: false, positions: [], revision: -1, patternLen: 0, done: true, truncated: false };
let curHit = -1;

worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.id !== pendingId) return;             // 已被取代的搜索：忽略
  if (m.type === 'hits') {
    hits.positions.push(...m.positions);
    view.setHits(hits.positions, hits.patternLen, curHit);
    updateHitsInfo();
  } else if (m.type === 'progress') {
    $('hitsInfo').textContent = `搜索中 ${(m.scanned / Math.max(1, m.total) * 100).toFixed(0)}%…`;
  } else if (m.type === 'done') {
    pendingId = null;
    hits.done = true;
    hits.truncated = m.truncated;
    view.setHits(hits.positions, hits.patternLen, curHit);
    updateHitsInfo();
  }
};

function parsePattern() {
  const raw = $('searchInput').value;
  if ($('searchMode').value === 'hex') {
    const b = parseHexInput(raw);
    if (!b) throw new Error('十六进制格式无效（需偶数位，如 "DE AD BE EF"）');
    return b;
  }
  const b = encoder.encode(raw);
  if (!b.length) throw new Error('请输入搜索内容');
  return b;
}

function startSearch() {
  let pattern;
  try { pattern = parsePattern(); }
  catch (e) { $('hitsInfo').textContent = e.message; return; }

  const id = ++reqId;
  pendingId = id;
  const newChunks = doc.add.chunks
    .slice(syncedChunks)
    .map((c) => c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength));
  syncedChunks = doc.add.chunks.length;

  hits = { searched: true, positions: [], revision: doc.revision, patternLen: pattern.length, done: false, truncated: false };
  curHit = -1;
  view.setHits([], 0);
  worker.postMessage({
    type: 'search', docId, id,
    revision: doc.revision,                    // 绑定修订号
    length: doc.length,
    pieces: doc.pieces.map((p) => [p.orig ? 1 : 0, p.start, p.len]),
    addChunks: newChunks,
    pattern,
  }, newChunks);
  updateHitsInfo();
}

function hitsStale() {
  return hits.searched && hits.revision !== doc.revision;
}

function updateHitsInfo() {
  const el = $('hitsInfo');
  if (!hits.searched) { el.textContent = ''; el.classList.remove('stale'); $('btnReplaceAll').disabled = true; return; }
  const stale = hitsStale();
  el.classList.toggle('stale', stale && hits.done);
  if (!hits.done) { $('btnReplaceAll').disabled = true; return; }
  const n = hits.positions.length;
  el.textContent = n === 0
    ? (stale ? '结果已过期 — 请重新搜索' : '无命中')
    : `${curHit >= 0 ? curHit + 1 + '/' : ''}${n} 个命中` +
      `${hits.truncated ? '（已达上限）' : ''}` +
      `${stale ? ' — 已过期，需重新搜索' : ''}`;
  // 过期结果不能直接用于批量替换
  $('btnReplaceAll').disabled = stale || n === 0;
}

function jumpToHit(delta) {
  const n = hits.positions.length;
  if (!n) return;
  curHit = ((curHit + delta) % n + n) % n;
  const p = hits.positions[curHit];
  view.select(p, p + hits.patternLen);
  view.setHits(hits.positions, hits.patternLen, curHit);
  view.scrollToPos(p);
  updateHitsInfo();
}

// ---------------------------------------------------------------- 文档载入
function loadDoc(bytes, name) {
  doc = new PieceTable(bytes);
  fileName = name;
  pendingId = null;
  docId += 1;
  syncedChunks = 0;
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  worker.postMessage({ type: 'init', docId, orig: copy });   // 克隆一份给 Worker
  hits = { searched: false, positions: [], revision: -1, patternLen: 0, done: true, truncated: false };
  curHit = -1;
  view.attach(doc);
  view.setHits([], 0);
  updateStatus();
  $('hexview').focus();
}

function makeDemo() {
  const n = 512 * 1024;
  const b = new Uint8Array(n);
  let s = 0x2f6e2b1;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    b[i] = (s >>> 16) & 0xff;
  }
  const txt = encoder.encode('The quick brown fox jumps over the lazy dog. 0123456789\n');
  for (let off = 1024; off + txt.length <= n; off += 4096) b.set(txt, off);
  return b;
}

// ---------------------------------------------------------------- 导出
async function doExport() {
  const snap = doc.snapshot();   // 拍照：之后的编辑不影响本次下载
  const btn = $('btnExport');
  btn.disabled = true;
  try {
    const res = await exportSnapshot(snap, (done, total) => {
      $('exportInfo').textContent =
        `导出中 ${(done / Math.max(1, total) * 100).toFixed(0)}%（r${snap.revision} 快照，后续编辑不影响本次导出）`;
    });
    const blob = new Blob(res.parts, { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName.replace(/\.[^.]+$/, '') + '.edited.bin';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    $('exportInfo').textContent =
      `已导出 ${res.length.toLocaleString()} 字节（r${res.revision} 快照） SHA-256: ${res.sha256}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- 状态栏
function updateStatus() {
  $('stFile').textContent = fileName;
  $('stLen').textContent = `长度 ${doc.length.toLocaleString()} 字节`;
  $('stCaret').textContent = `光标 0x${view.caret.toString(16).padStart(8, '0')}`;
  const [a, b] = [Math.min(view.anchor, view.caret), Math.max(view.anchor, view.caret)];
  $('stSel').textContent = a === b ? '' : `选区 ${b - a} 字节`;
  $('stMode').textContent = `${view.insertMode ? '插入' : '覆盖'} · ${view.asciiMode ? 'ASCII' : 'HEX'}`;
  $('stRev').textContent = `修订 r${doc.revision}`;
  $('btnUndo').disabled = doc.undoStack.length === 0;
  $('btnRedo').disabled = doc.redoStack.length === 0;
  updateHitsInfo();   // 编辑会改变修订号 → 旧命中立即显示为过期
}

// ---------------------------------------------------------------- 事件
$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > MAX_SIZE) { alert(`文件 ${f.size.toLocaleString()} 字节，超过 8 MB 限制`); return; }
  loadDoc(new Uint8Array(await f.arrayBuffer()), f.name);
});
$('btnNew').addEventListener('click', () => loadDoc(new Uint8Array(0), '未命名.bin'));
$('btnDemo').addEventListener('click', () => loadDoc(makeDemo(), 'demo.bin'));
$('btnUndo').addEventListener('click', () => view.undo());
$('btnRedo').addEventListener('click', () => view.redo());
$('btnExport').addEventListener('click', doExport);
$('btnSearch').addEventListener('click', startSearch);
$('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') startSearch(); });
$('btnPrev').addEventListener('click', () => jumpToHit(-1));
$('btnNext').addEventListener('click', () => jumpToHit(1));

$('btnReplaceAll').addEventListener('click', () => {
  // 双重保险：过期结果绝不用于批量替换
  if (!hits.done || hitsStale() || hits.positions.length === 0) return;
  let repl;
  if ($('searchMode').value === 'hex') {
    repl = parseHexInput($('replaceInput').value);
    if (!repl) { $('hitsInfo').textContent = '替换内容不是有效的十六进制'; return; }
  } else {
    repl = encoder.encode($('replaceInput').value);
  }
  // KMP 可能给出重叠命中，批量替换前过滤（保留最左）
  const keep = [];
  let end = -1;
  for (const h of hits.positions) {
    if (h >= end) { keep.push(h); end = h + hits.patternLen; }
  }
  const edits = keep.map((h) => ({ pos: h, deleteLen: hits.patternLen, insert: repl }));
  const descs = doc.applyEdits(edits);   // 整批一条撤销记录
  view.applyExternal(descs);
  updateStatus();
  startSearch();                          // 修订已变，自动重新搜索
});

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const lk = e.key.toLowerCase();
  if (lk === 's') { e.preventDefault(); doExport(); }
  else if (lk === 'f') { e.preventDefault(); $('searchInput').focus(); $('searchInput').select(); }
});

loadDoc(new Uint8Array(0), '未命名.bin');
