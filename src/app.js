// 界面层：虚拟滚动十六进制表格 + 键鼠交互 + Worker 搜索 + 快照导出。
// 所有编辑语义都在 editor.js / piece-table.js 中，这里只做展示与事件接线。

import { HexEditor } from './editor.js';
import { findAll } from './search-core.js';
import { exportSnapshot } from './exporter.js';
import { parseHex, hex2, hexAddr, asciiChar } from './util.js';

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MiB 上限
const BYTES_PER_ROW = 16;
const ROW_H = 20;
const OVERSCAN = 6;

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const spacer = $('spacer');
const rowsEl = $('rows');
const statusEl = $('status');
const fileInfoEl = $('fileInfo');
const searchInput = $('searchInput');
const searchInfoEl = $('searchInfo');
const replaceInput = $('replaceInput');
const replaceAllBtn = $('replaceAllBtn');
const digestEl = $('digest');

let editor = newEditor(new Uint8Array(0));
let fileName = 'untitled.bin';
let asciiInputMode = false;   // Tab 切换：十六进制半字节输入 / ASCII 字符输入
let needsScrollToCursor = false;
let dragging = false;

function newEditor(bytes) {
  const ed = new HexEditor(bytes);
  ed.subscribe(() => { needsScrollToCursor = true; scheduleRender(); });
  return ed;
}

// ---------- 虚拟滚动渲染 ----------

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

function render() {
  const total = editor.length;
  const rowCount = Math.max(1, Math.ceil(total / BYTES_PER_ROW));
  spacer.style.height = `${rowCount * ROW_H}px`;

  const viewH = viewport.clientHeight;
  const firstRow = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - OVERSCAN);
  const lastRow = Math.min(rowCount, Math.ceil((viewport.scrollTop + viewH) / ROW_H) + OVERSCAN);
  rowsEl.style.transform = `translateY(${firstRow * ROW_H}px)`;

  const sel = editor.selectionRange();
  const st = editor.searchState;
  const hitSet = st && !editor.searchStale && st.positions.length <= 200000
    ? new Set(st.positions) : null;
  const curMatch = currentMatch();

  let html = '';
  for (let r = firstRow; r < lastRow; r++) {
    const off = r * BYTES_PER_ROW;
    const n = Math.max(0, Math.min(BYTES_PER_ROW, total - off));
    const bytes = n > 0 ? editor.doc.copyRange(off, off + n) : null;
    let cells = '';
    let ascii = '';
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      const o = off + i;
      if (i < n) {
        let cls = 'cell';
        if (sel && o >= sel[0] && o < sel[1]) cls += ' sel';
        if (o === editor.cursor) cls += ' cur';
        if (editor.pendingNibble && editor.pendingNibble.off === o) cls += ' pend';
        if (hitSet && hitSet.has(o)) cls += ' hit';
        if (curMatch && o >= curMatch[0] && o < curMatch[1]) cls += ' curmatch';
        const b = bytes[i];
        cells += `<span class="${cls}" data-off="${o}">${hex2(b)}</span>`;
        ascii += `<span class="a${cls.includes('sel') ? ' sel' : ''}" data-off="${o}">${asciiChar(b)}</span>`;
      } else if (o === editor.cursor) {
        cells += '<span class="cell cur vcur">&nbsp;</span>'; // 末尾光标占位
        ascii += ' ';
      } else {
        cells += '<span class="cell empty"></span>';
        ascii += ' ';
      }
      if (i === 7) cells += '<span class="gap"></span>';
    }
    html += `<div class="row"><span class="addr">${hexAddr(off)}</span>${cells}<span class="ascii">${ascii}</span></div>`;
  }
  rowsEl.innerHTML = html;

  if (needsScrollToCursor) {
    needsScrollToCursor = false;
    const cursorRow = Math.floor(editor.cursor / BYTES_PER_ROW);
    const top = viewport.scrollTop;
    const bottom = top + viewH;
    const y = cursorRow * ROW_H;
    if (y < top || y + ROW_H > bottom) {
      viewport.scrollTop = Math.max(0, y - viewH / 2);
    }
  }
  renderStatus();
}

function renderStatus() {
  const sel = editor.selectionRange();
  const st = editor.searchState;
  const parts = [
    `偏移 0x${hexAddr(editor.cursor)}`,
    sel ? `选区 ${sel[1] - sel[0]} 字节` : '无选区',
    `长度 ${editor.length.toLocaleString()} 字节`,
    `段数 ${editor.doc.pieces.length}`,
    `修订 ${editor.revision}`,
    editor.insertMode ? '插入' : '覆盖',
    asciiInputMode ? 'ASCII 输入' : 'HEX 输入',
  ];
  statusEl.textContent = parts.join(' · ');
  $('undoBtn').disabled = !editor.canUndo;
  $('redoBtn').disabled = !editor.canRedo;
  $('modeBtn').textContent = editor.insertMode ? '插入' : '覆盖';

  if (st) {
    const stale = editor.searchStale;
    searchInfoEl.innerHTML = stale
      ? `<span class="stale">${st.positions.length} 个匹配（已过期，需重新搜索）</span>`
      : `${st.positions.length} 个匹配`;
    replaceAllBtn.disabled = stale || st.positions.length === 0;
  } else {
    searchInfoEl.textContent = '';
    replaceAllBtn.disabled = true;
  }
}

// ---------- 鼠标 ----------

function offsetFromEvent(e) {
  const t = e.target.closest('[data-off]');
  return t ? Number(t.dataset.off) : null;
}

rowsEl.addEventListener('mousedown', (e) => {
  const off = offsetFromEvent(e);
  if (off == null) return;
  e.preventDefault();
  viewport.focus();
  if (e.shiftKey) editor.moveCursor(off, true);
  else { editor.moveCursor(off); dragging = true; }
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const off = offsetFromEvent(e);
  if (off != null) editor.moveCursor(off, true);
});
window.addEventListener('mouseup', () => { dragging = false; });

// ---------- 键盘 ----------

viewport.addEventListener('keydown', (e) => {
  const key = e.key;
  if (e.ctrlKey || e.metaKey) {
    const k = key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); }
    else if (k === 'y') { e.preventDefault(); editor.redo(); }
    else if (k === 'a') { e.preventDefault(); editor.selectAll(); }
    else if (k === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
    return;
  }
  const rowsVisible = Math.max(1, Math.floor(viewport.clientHeight / ROW_H));
  const move = (delta) => { e.preventDefault(); editor.moveCursor(editor.cursor + delta, e.shiftKey); };
  switch (key) {
    case 'ArrowLeft': move(-1); return;
    case 'ArrowRight': move(1); return;
    case 'ArrowUp': move(-BYTES_PER_ROW); return;
    case 'ArrowDown': move(BYTES_PER_ROW); return;
    case 'PageUp': move(-BYTES_PER_ROW * rowsVisible); return;
    case 'PageDown': move(BYTES_PER_ROW * rowsVisible); return;
    case 'Home': e.preventDefault(); editor.moveCursor(editor.cursor - (editor.cursor % BYTES_PER_ROW), e.shiftKey); return;
    case 'End': e.preventDefault(); {
      const rowStart = editor.cursor - (editor.cursor % BYTES_PER_ROW);
      editor.moveCursor(Math.min(rowStart + BYTES_PER_ROW, editor.length), e.shiftKey);
      return;
    }
    case 'Insert': e.preventDefault(); editor.insertMode = !editor.insertMode; renderStatus(); return;
    case 'Backspace': e.preventDefault(); editor.deleteSelectionOrByte(true); return;
    case 'Delete': e.preventDefault(); editor.deleteSelectionOrByte(false); return;
    case 'Tab': e.preventDefault(); asciiInputMode = !asciiInputMode; renderStatus(); return;
    case 'Escape': editor.moveCursor(editor.cursor); return; // 收起选区
  }
  if (key.length === 1) {
    if (!asciiInputMode && /^[0-9a-fA-F]$/.test(key)) {
      e.preventDefault();
      editor.typeHexDigit(parseInt(key, 16));
    } else if (asciiInputMode && key >= ' ' && key <= '~') {
      e.preventDefault();
      editor.typeAsciiByte(key.charCodeAt(0));
    }
  }
});

// ---------- 搜索（Worker，结果绑定修订号） ----------

let worker = null;
try {
  worker = new Worker('src/search-worker.js', { type: 'module' });
  worker.onmessage = (e) => handleSearchResult(e.data);
  worker.onerror = () => { worker = null; }; // 回退到主线程同步搜索
} catch {
  worker = null;
}

let searchSeq = 0;
let pendingJump = 0; // 搜索完成后要执行的跳转方向（0 不跳）

function currentPattern() {
  const p = parseHex(searchInput.value);
  searchInput.classList.toggle('invalid', p === null);
  return p && p.length ? p : null;
}

function runSearch(jumpAfter = 0) {
  const pattern = currentPattern();
  if (!pattern) { editor.setSearchResults(null); pendingJump = 0; return; }
  pendingJump = jumpAfter;
  const rev = editor.revision;
  const bytes = editor.doc.toBytes(); // 一次性快照副本，转移给 Worker
  const id = ++searchSeq;
  if (worker) {
    worker.postMessage({ id, rev, pattern, buffer: bytes.buffer }, [bytes.buffer]);
  } else {
    handleSearchResult({ id, rev, pattern, positions: findAll(bytes, pattern) });
  }
}

function handleSearchResult(msg) {
  if (msg.id !== searchSeq) return; // 已被更新的搜索取代
  editor.setSearchResults(msg.rev, msg.pattern, msg.positions);
  if (pendingJump) { const d = pendingJump; pendingJump = 0; jumpToMatch(d); }
}

/** 当前应高亮的匹配区间 [start, end)，无则 null。 */
function currentMatch() {
  const st = editor.searchState;
  if (!st || editor.searchStale) return null;
  const sel = editor.selectionRange();
  if (sel && sel[1] - sel[0] === st.pattern.length && st.positions.includes(sel[0])) return sel;
  return null;
}

function jumpToMatch(dir) {
  const st = editor.searchState;
  if (!st || !st.positions.length) return;
  if (editor.searchStale) { runSearch(dir); return; } // 过期则重新搜索后再跳
  const pos = st.positions;
  const len = st.pattern.length;
  const sel = editor.selectionRange();
  const from = sel ? sel[0] : editor.cursor;
  let idx;
  if (dir > 0) {
    idx = pos.findIndex((p) => p > from); // 第一个在当前匹配之后的命中
    if (idx === -1) idx = 0;              // 回绕到开头
  } else {
    idx = pos.length - 1;
    while (idx >= 0 && pos[idx] >= from) idx--;
    if (idx < 0) idx = pos.length - 1;    // 回绕到末尾
  }
  editor.select(pos[idx], pos[idx] + len);
}

let searchDebounce = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(0), 250);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); }
});
$('findNextBtn').onclick = () => runSearchIfNeededThen(1);
$('findPrevBtn').onclick = () => runSearchIfNeededThen(-1);
function runSearchIfNeededThen(dir) {
  if (!editor.searchState || editor.searchStale) runSearch(dir);
  else jumpToMatch(dir);
}

replaceAllBtn.onclick = () => {
  const replacement = parseHex(replaceInput.value);
  if (replacement === null) { replaceInput.classList.add('invalid'); return; }
  replaceInput.classList.remove('invalid');
  if (editor.searchStale) return; // 按钮此时本应禁用，双保险
  const n = editor.replaceAllFromSearch(replacement);
  digestEl.textContent = `已替换 ${n} 处（搜索结果已过期，需重新搜索）`;
};

// ---------- 文件打开 / 新建 ----------

$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    alert(`文件 ${(file.size / 1048576).toFixed(1)} MiB，超过 8 MiB 上限`);
    return;
  }
  const buf = await file.arrayBuffer();
  loadDocument(new Uint8Array(buf), file.name);
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) { alert('文件超过 8 MiB 上限'); return; }
  loadDocument(new Uint8Array(await file.arrayBuffer()), file.name);
});

$('newBtn').onclick = () => loadDocument(new Uint8Array(0), 'untitled.bin');

function loadDocument(bytes, name) {
  editor = newEditor(bytes);
  fileName = name;
  searchSeq++; // 作废旧文档的搜索
  editor.setSearchResults(null);
  digestEl.textContent = '';
  fileInfoEl.textContent = `${name} · ${bytes.length.toLocaleString()} 字节`;
  viewport.scrollTop = 0;
  render();
}

// ---------- 撤销 / 重做 / 模式 ----------

$('undoBtn').onclick = () => editor.undo();
$('redoBtn').onclick = () => editor.redo();
$('modeBtn').onclick = () => { editor.insertMode = !editor.insertMode; renderStatus(); };

// ---------- 导出（快照 + 流式摘要） ----------

$('exportBtn').onclick = async () => {
  const btn = $('exportBtn');
  btn.disabled = true;
  digestEl.textContent = '导出中…';
  try {
    const result = await exportSnapshot(editor.doc, {
      revision: editor.revision,
      onProgress: (done, total) => {
        digestEl.textContent = `导出中 ${total ? Math.round((done / total) * 100) : 100}%`;
      },
    });
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    digestEl.textContent =
      `SHA-256 ${result.digest}（${result.length.toLocaleString()} 字节，修订 ${result.revision} 的快照）`;
  } finally {
    btn.disabled = false;
  }
};

// ---------- 启动 ----------

viewport.addEventListener('scroll', scheduleRender);
window.addEventListener('resize', scheduleRender);
render();
viewport.focus();
