// 虚拟化十六进制视图 + 编辑控制器。
// 每行 16 字节，只渲染可视窗口内的行；光标/选区以逻辑位置保存，
// 任何编辑（含撤销/重做/批量替换）后都通过 mapThrough 迁移。

import { mapThrough } from './mapping.js';
import { parseHexInput, bytesToHex } from './util.js';

const ROW_H = 20;      // 与 styles.css 中 .row 的高度一致
const OVERSCAN = 6;    // 可视区上下多渲染的行数
const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

const HEX = [];
for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, '0');
const ESC = { '<': '&lt;', '>': '&gt;', '&': '&amp;' };

export class HexView {
  constructor(container, hooks = {}) {
    this.container = container;
    this.hooks = hooks;          // { onChange, onCursor }
    this.doc = null;
    this.caret = 0;              // 光标（逻辑位置，0..length）
    this.anchor = 0;             // 选区锚点
    this.nibble = false;         // 已输入高位半字节，等待低位
    this.insertMode = false;     // 插入 / 覆盖
    this.asciiMode = false;      // 点击 ASCII 栏后进入字符输入
    this.typingKey = 0;          // 连续输入会话号（撤销合并用）
    this.hits = [];              // 搜索命中（升序），仅用于高亮
    this.hitLen = 0;
    this.curHit = -1;
    this._dragging = false;

    container.innerHTML = '';
    this.spacer = document.createElement('div');
    this.spacer.className = 'spacer';
    this.window = document.createElement('div');
    this.window.className = 'window';
    this.spacer.appendChild(this.window);
    container.appendChild(this.spacer);

    container.addEventListener('scroll', () => this.render());
    container.addEventListener('keydown', (e) => this._onKey(e));
    container.addEventListener('mousedown', (e) => this._onMouseDown(e));
    window.addEventListener('mousemove', (e) => this._onMouseMove(e));
    window.addEventListener('mouseup', () => { this._dragging = false; });
    window.addEventListener('resize', () => this.render());
  }

  attach(doc) {
    this.doc = doc;
    this.caret = this.anchor = 0;
    this.nibble = false;
    this._breakTyping();
    this.render();
  }

  setHits(positions, hitLen, curHit = -1) {
    this.hits = positions;
    this.hitLen = hitLen;
    this.curHit = curHit;
    this.render();
  }

  select(a, b) {
    const len = this.doc ? this.doc.length : 0;
    this.anchor = Math.max(0, Math.min(a, len));
    this.caret = Math.max(0, Math.min(b, len));
    this.nibble = false;
    this._breakTyping();
    this.render();
  }

  // 外部编辑（撤销/重做/全部替换）后：迁移光标与选区，再重绘。
  applyExternal(descs) {
    this.caret = mapThrough(this.caret, descs);
    this.anchor = mapThrough(this.anchor, descs);
    this.nibble = false;
    this._breakTyping();
    this.render();
  }

  undo() {
    const d = this.doc.undo();
    if (d) { this.applyExternal(d); this.hooks.onChange?.(); }
  }

  redo() {
    const d = this.doc.redo();
    if (d) { this.applyExternal(d); this.hooks.onChange?.(); }
  }

  _sel() {
    return this.anchor <= this.caret ? [this.anchor, this.caret] : [this.caret, this.anchor];
  }

  _breakTyping() { this.typingKey++; }

  _changed() { this.render(); this.hooks.onChange?.(); }

  scrollToPos(pos) {
    const row = pos >> 4;
    const st = this.container.scrollTop;
    const vh = this.container.clientHeight;
    if (row * ROW_H < st) this.container.scrollTop = row * ROW_H;
    else if ((row + 1) * ROW_H > st + vh) this.container.scrollTop = (row + 1) * ROW_H - vh;
  }

  // ---------------------------------------------------------------- 渲染
  render() {
    const doc = this.doc;
    if (!doc) return;
    const len = doc.length;
    const rows = Math.max(1, Math.ceil(len / 16));
    this.spacer.style.height = rows * ROW_H + 'px';

    const st = this.container.scrollTop;
    const vh = this.container.clientHeight || 400;
    const first = Math.max(0, Math.floor(st / ROW_H) - OVERSCAN);
    const last = Math.min(rows - 1, Math.ceil((st + vh) / ROW_H) + OVERSCAN);

    const startPos = first * 16;
    const count = Math.max(0, Math.min(len - startPos, (last - first + 1) * 16));
    const bytes = count ? doc.read(startPos, count) : EMPTY;

    const [selA, selB] = this._sel();
    const caretCell = len === 0 ? -1 : Math.min(this.caret, len - 1);
    const curHitPos = this.curHit >= 0 && this.curHit < this.hits.length ? this.hits[this.curHit] : -1;

    let html = '';
    for (let r = first; r <= last; r++) {
      const base = r * 16;
      let hex = '', asc = '';
      for (let c = 0; c < 16; c++) {
        const p = base + c;
        if (p < len) {
          const b = bytes[p - startPos];
          let cls = '';
          if (this._isHit(p)) cls += ' hit';
          if (curHitPos >= 0 && p >= curHitPos && p < curHitPos + this.hitLen) cls += ' cur';
          if (p >= selA && p < selB) cls += ' sel';
          if (p === caretCell) {
            cls += ' caret';
            if (this.caret === len) cls += ' atend';
            if (this.nibble) cls += ' nib';
          }
          hex += `<span class="byte${cls}" data-p="${p}">${HEX[b]}</span>`;
          const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·';
          asc += `<span class="ch${cls}" data-p="${p}">${ESC[ch] ?? ch}</span>`;
        } else {
          const cls = p === 0 && len === 0 ? 'byte empty caret' : 'byte empty';
          hex += `<span class="${cls}" data-p="${p}">  </span>`;
          asc += `<span class="ch empty" data-p="${p}"> </span>`;
        }
      }
      html += `<div class="row"><span class="off">${base.toString(16).padStart(8, '0')}</span>` +
              `<span class="hex">${hex}</span><span class="asc">${asc}</span></div>`;
    }
    this.window.style.transform = `translateY(${first * ROW_H}px)`;
    this.window.innerHTML = html;
    this.hooks.onCursor?.();
  }

  _isHit(p) {
    const h = this.hits, n = h.length, hl = this.hitLen;
    if (!n || !hl) return false;
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (h[m] <= p) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans >= 0 && p < h[ans] + hl;
  }

  // ---------------------------------------------------------------- 键盘
  _onKey(e) {
    const doc = this.doc;
    if (!doc) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const len = doc.length;
    const rowsVisible = Math.max(1, Math.floor((this.container.clientHeight || 400) / ROW_H));
    const move = (p, extend) => {
      p = Math.max(0, Math.min(p, len));
      if (extend) this.caret = p;
      else { this.caret = p; this.anchor = p; }
      this.nibble = false;
      this._breakTyping();
      this.scrollToPos(p);
      this._changed();
    };

    if (ctrl) {
      const lk = k.toLowerCase();
      if (lk === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (lk === 'y' || (lk === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
      else if (lk === 'a') {
        e.preventDefault();
        this.anchor = 0; this.caret = len;
        this.nibble = false; this._breakTyping(); this._changed();
      }
      else if (lk === 'c') { this._copy(); }
      else if (lk === 'v') { e.preventDefault(); this._paste(); }
      else if (k === 'Home') { e.preventDefault(); move(0, e.shiftKey); }
      else if (k === 'End') { e.preventDefault(); move(len, e.shiftKey); }
      return; // 其余组合键（Ctrl+S / Ctrl+F）交给应用层
    }

    switch (k) {
      case 'ArrowLeft':
        e.preventDefault();
        if (!e.shiftKey && this.anchor !== this.caret) move(Math.min(this.anchor, this.caret), false);
        else move(this.caret - 1, e.shiftKey);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (!e.shiftKey && this.anchor !== this.caret) move(Math.max(this.anchor, this.caret), false);
        else move(this.caret + 1, e.shiftKey);
        return;
      case 'ArrowUp': e.preventDefault(); move(this.caret - 16, e.shiftKey); return;
      case 'ArrowDown': e.preventDefault(); move(this.caret + 16, e.shiftKey); return;
      case 'Home': e.preventDefault(); move(this.caret - (this.caret % 16), e.shiftKey); return;
      case 'End': e.preventDefault(); move(Math.min(this.caret - (this.caret % 16) + 16, len), e.shiftKey); return;
      case 'PageUp': e.preventDefault(); move(this.caret - rowsVisible * 16, e.shiftKey); return;
      case 'PageDown': e.preventDefault(); move(this.caret + rowsVisible * 16, e.shiftKey); return;
      case 'Insert':
        e.preventDefault();
        this.insertMode = !this.insertMode;
        this._breakTyping();
        this._changed();
        return;
      case 'Delete': e.preventDefault(); this._delete(true); return;
      case 'Backspace': e.preventDefault(); this._delete(false); return;
      default: break;
    }

    if (k.length === 1) {
      if (!this.asciiMode && /^[0-9a-fA-F]$/.test(k)) {
        e.preventDefault();
        this._typeHex(parseInt(k, 16));
      } else if (this.asciiMode && k.charCodeAt(0) <= 0xff) {
        e.preventDefault();
        this._typeAscii(k.charCodeAt(0));
      }
    }
  }

  // ---------------------------------------------------------------- 编辑
  // 选区替换（删除+插入合并为一条撤销记录）
  _replaceRange(a, b, bytes) {
    const edits = a === b
      ? [{ pos: a, deleteLen: 0, insert: bytes }]
      : [{ pos: a, deleteLen: 0, insert: bytes }, { pos: a, deleteLen: b - a, insert: EMPTY }];
    return this.doc.applyEdits(edits, this.typingKey);
  }

  _typeHex(v) {
    const doc = this.doc, key = this.typingKey;
    const [a, b] = this._sel();
    if (a !== b) {                       // 有选区：替换为一个新字节，等第二半字节
      this._replaceRange(a, b, Uint8Array.of(v << 4));
      this.caret = this.anchor = a;
      this.nibble = true;
      this._changed();
      return;
    }
    const p = this.caret;
    if (!this.nibble) {
      if (this.insertMode || p === doc.length) {
        doc.edit(p, 0, Uint8Array.of(v << 4), key);
      } else {
        const ob = doc.byteAt(p);
        doc.edit(p, 1, Uint8Array.of((v << 4) | (ob & 0x0f)), key);
      }
      this.nibble = true;
    } else {
      const ob = doc.byteAt(p);
      doc.edit(p, 1, Uint8Array.of((ob & 0xf0) | v), key);
      this.nibble = false;
      this.caret = this.anchor = Math.min(p + 1, doc.length);
    }
    this._changed();
  }

  _typeAscii(code) {
    const doc = this.doc, key = this.typingKey;
    const [a, b] = this._sel();
    if (a !== b) {
      this._replaceRange(a, b, Uint8Array.of(code));
      this.caret = this.anchor = a + 1;
      this.nibble = false;
      this._changed();
      return;
    }
    const p = this.caret;
    if (this.insertMode || p === doc.length) doc.edit(p, 0, Uint8Array.of(code), key);
    else doc.edit(p, 1, Uint8Array.of(code), key);
    this.caret = this.anchor = p + 1;
    this.nibble = false;
    this._changed();
  }

  _delete(forward) {
    const doc = this.doc;
    const [a, b] = this._sel();
    if (a !== b) {
      doc.edit(a, b - a, EMPTY);
      this.caret = this.anchor = a;
    } else if (forward) {
      if (this.caret < doc.length) doc.edit(this.caret, 1, EMPTY);
    } else if (this.caret > 0) {
      doc.edit(this.caret - 1, 1, EMPTY);
      this.caret = this.anchor = this.caret - 1;
    }
    this.nibble = false;
    this._breakTyping();
    this._changed();
  }

  _copy() {
    const [a, b] = this._sel();
    if (a === b || !this.doc) return;
    const bytes = this.doc.read(a, Math.min(b - a, 4 << 20));
    navigator.clipboard?.writeText(bytesToHex(bytes)).catch(() => {});
  }

  async _paste() {
    let t = null;
    try { t = await navigator.clipboard.readText(); } catch { return; }
    if (!t) return;
    let bytes = parseHexInput(t);            // 形如 "DE AD BE EF" 按十六进制粘贴
    if (!bytes) bytes = encoder.encode(t);   // 否则按 UTF-8 文本
    if (!bytes.length) return;
    const [a, b] = this._sel();
    this._replaceRange(a, b, bytes);
    this.caret = this.anchor = a + bytes.length;
    this.nibble = false;
    this._breakTyping();
    this._changed();
  }

  // ---------------------------------------------------------------- 鼠标
  _posFromEvent(e, t) {
    let p = +t.dataset.p;
    const r = t.getBoundingClientRect();
    if (e.clientX > r.left + r.width / 2) p += 1;   // 点在字节右半 → 光标置于其后
    return Math.max(0, Math.min(p, this.doc.length));
  }

  _onMouseDown(e) {
    if (!this.doc) return;
    const t = e.target.closest('[data-p]');
    if (!t) return;
    e.preventDefault();
    this.container.focus();
    const p = this._posFromEvent(e, t);
    this.asciiMode = !!t.closest('.asc');
    if (e.shiftKey) this.caret = p;
    else { this.caret = p; this.anchor = p; }
    this.nibble = false;
    this._breakTyping();
    this._dragging = true;
    this._changed();
  }

  _onMouseMove(e) {
    if (!this._dragging || !this.doc) return;
    const t = e.target.closest?.('[data-p]');
    if (!t || !this.container.contains(t)) return;
    const p = this._posFromEvent(e, t);
    if (p !== this.caret) { this.caret = p; this._changed(); }
  }
}
