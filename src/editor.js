// 编辑器控制器：在 PieceTable 之上提供
//   - 多步撤销 / 重做（段数组即不可变快照，撤销 = 换回旧段数组）；
//   - 光标与选区随编辑正确迁移（mapPosition）；
//   - 撤销分支：撤销后产生新编辑时清空重做栈；
//   - 连续输入的撤销合并（tag 相同的相邻编辑并入同一撤销单元）；
//   - 搜索结果与修订号绑定，过期结果禁止直接批量替换。

import { PieceTable } from './piece-table.js';

export const EMPTY = new Uint8Array(0);

/**
 * 把文档偏移 p 映射到一次编辑之后的位置。
 * 编辑：删除 [pos, pos+delLen)，插入 insLen 字节。
 * assoc: -1 偏向留在插入内容左侧，+1 偏向右侧；落在被删区间内的点收拢到插入内容末端。
 */
export function mapPosition(p, pos, delLen, insLen, assoc = 1) {
  if (p < pos) return p;
  if (p > pos + delLen) return p - delLen + insLen;
  if (p === pos && assoc < 0) return pos;
  return pos + insLen;
}

const UNDO_LIMIT = 1000;

export class HexEditor {
  /** @param {Uint8Array} bytes 初始内容（之后不得由外部修改） */
  constructor(bytes = new Uint8Array(0)) {
    this.doc = new PieceTable(bytes);
    this.revision = 0;          // 内容版本号：任何内容变化（含撤销/重做）都递增
    this.cursor = 0;            // 光标（选区的活动端）
    this.anchor = 0;            // 选区固定端；anchor === cursor 表示无选区
    this.insertMode = false;    // false=覆盖（替换），true=插入
    this.pendingNibble = null;  // 十六进制半字节输入状态 {off, high}
    this.undoStack = [];        // 元素：{pieces, length, cursor, anchor}
    this.redoStack = [];
    this.searchState = null;    // {rev, pattern:Uint8Array, positions:number[]}
    this._lastTag = null;       // 上一次编辑的合并标签
    this._listeners = new Set();
  }

  get length() { return this.doc.length; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) fn(); }

  /** 选区 [lo, hi)；无选区返回 null。 */
  selectionRange() {
    if (this.cursor === this.anchor) return null;
    return [Math.min(this.cursor, this.anchor), Math.max(this.cursor, this.anchor)];
  }

  _snapshot() {
    return { pieces: this.doc.pieces, length: this.doc.length, cursor: this.cursor, anchor: this.anchor };
  }

  _restore(s) {
    this.doc.pieces = s.pieces;
    this.doc.length = s.length;
    this.cursor = s.cursor;
    this.anchor = s.anchor;
  }

  /** 编辑前记录撤销点；tag 与上次相同则并入上一撤销单元（如一个字节的两个半字节）。 */
  _beforeEdit(tag) {
    if (tag == null || tag !== this._lastTag || this.undoStack.length === 0) {
      this.undoStack.push(this._snapshot());
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    }
    this._lastTag = tag ?? null;
    this.redoStack.length = 0; // 新编辑截断重做分支
  }

  /**
   * 单次编辑（插入/删除/替换的统一入口），产生一个新会自增修订号。
   * opts.cursor: 编辑后光标落点（省略则按 mapPosition 迁移现有光标与选区）；
   * opts.tag:    撤销合并标签。
   */
  splice(pos, delLen, ins = EMPTY, opts = {}) {
    this._beforeEdit(opts.tag);
    this.doc.splice(pos, delLen, ins);
    this.revision++;
    if (opts.cursor != null) {
      this.cursor = this.anchor = opts.cursor;
    } else {
      this.cursor = mapPosition(this.cursor, pos, delLen, ins.length, +1);
      this.anchor = mapPosition(this.anchor, pos, delLen, ins.length, -1);
    }
    this.pendingNibble = null;
    this._emit();
  }

  /** 多笔编辑合成一个撤销单元（如「全部替换」）。edits 按给定顺序依次应用。 */
  transaction(edits, opts = {}) {
    if (!edits.length) return;
    this._beforeEdit(opts.tag);
    for (const e of edits) {
      this.doc.splice(e.pos, e.delLen, e.ins);
      this.cursor = mapPosition(this.cursor, e.pos, e.delLen, e.ins.length, +1);
      this.anchor = mapPosition(this.anchor, e.pos, e.delLen, e.ins.length, -1);
    }
    this.revision++;
    if (opts.cursor != null) this.cursor = this.anchor = opts.cursor;
    this.pendingNibble = null;
    this._emit();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this.revision++;
    this._lastTag = null;
    this.pendingNibble = null;
    this._emit();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this.revision++;
    this._lastTag = null;
    this.pendingNibble = null;
    this._emit();
    return true;
  }

  // ---------- 光标 / 选区 ----------

  moveCursor(to, extend = false) {
    const clamped = Math.max(0, Math.min(to, this.length));
    this.cursor = clamped;
    if (!extend) this.anchor = clamped;
    this.pendingNibble = null;
    this._lastTag = null;
    this._emit();
  }

  select(start, end) {
    this.anchor = Math.max(0, Math.min(start, this.length));
    this.cursor = Math.max(0, Math.min(end, this.length));
    this.pendingNibble = null;
    this._lastTag = null;
    this._emit();
  }

  selectAll() { this.select(0, this.length); }

  // ---------- 高层编辑操作 ----------

  /** 输入一个十六进制半字节（0..15），自动处理覆盖/插入与半字节配对。 */
  typeHexDigit(d) {
    const cur = this.cursor;
    const sel = this.selectionRange();
    if (this.pendingNibble && this.pendingNibble.off === cur && !sel) {
      // 补全当前字节的低半字节；与首半字节同属一个撤销单元
      const b = (this.pendingNibble.high << 4) | d;
      if (this.doc.tryRewriteAddByteAt(cur, b)) {
        // 该字节刚由首半字节追加且未被快照/导出引用：就地改写，不产生新段
        this.revision++;
        this.pendingNibble = null;
        this.cursor = this.anchor = cur + 1;
        this._emit();
        return;
      }
      this.splice(cur, 1, Uint8Array.of(b), { tag: `nib:${cur}`, cursor: cur + 1 });
      return;
    }
    if (sel) {
      this.splice(sel[0], sel[1] - sel[0], Uint8Array.of(d << 4), { cursor: sel[0] });
      this.pendingNibble = { off: sel[0], high: d };
    } else if (this.insertMode || cur >= this.length) {
      this.splice(cur, 0, Uint8Array.of(d << 4), { tag: `nib:${cur}`, cursor: cur });
      this.pendingNibble = { off: cur, high: d };
    } else {
      const old = this.doc.byteAt(cur);
      this.splice(cur, 1, Uint8Array.of((d << 4) | (old & 0x0f)), { tag: `nib:${cur}`, cursor: cur });
      this.pendingNibble = { off: cur, high: d };
    }
  }

  /** 输入一个 ASCII 字节（可打印字符）。 */
  typeAsciiByte(byte) {
    const sel = this.selectionRange();
    if (sel) {
      this.splice(sel[0], sel[1] - sel[0], Uint8Array.of(byte), { cursor: sel[0] + 1, tag: 'ascii' });
    } else if (this.insertMode || this.cursor >= this.length) {
      this.splice(this.cursor, 0, Uint8Array.of(byte), { cursor: this.cursor + 1, tag: 'ascii' });
    } else {
      this.splice(this.cursor, 1, Uint8Array.of(byte), { cursor: this.cursor + 1, tag: 'ascii' });
    }
  }

  /** 删除选区；无选区时 backward=true 删光标前一字节，否则删光标处一字节。 */
  deleteSelectionOrByte(backward) {
    const sel = this.selectionRange();
    if (sel) {
      this.splice(sel[0], sel[1] - sel[0], EMPTY, { cursor: sel[0] });
    } else if (backward) {
      if (this.cursor > 0) this.splice(this.cursor - 1, 1, EMPTY, { cursor: this.cursor - 1 });
    } else {
      if (this.cursor < this.length) this.splice(this.cursor, 1, EMPTY, { cursor: this.cursor });
    }
  }

  // ---------- 搜索与替换 ----------

  /** 登记一次搜索的结果；rev 为搜索快照的修订号。 */
  setSearchResults(rev, pattern, positions) {
    this.searchState = rev == null ? null : { rev, pattern, positions };
    this._emit();
  }

  /** 搜索结果是否已过期（搜索之后文档发生过任何变化，包括撤销/重做）。 */
  get searchStale() {
    return !this.searchState || this.searchState.rev !== this.revision;
  }

  /**
   * 用当前（未过期）的搜索结果做批量替换，全部替换合并为一个撤销单元。
   * 过期结果直接抛错——调用方必须重新搜索。
   * @returns {number} 实际替换处数
   */
  replaceAllFromSearch(replacement) {
    if (this.searchStale) throw new Error('搜索结果已过期，请重新搜索后再替换');
    const { positions, pattern } = this.searchState;
    // 命中可能重叠（如 "aa" 在 "aaa" 中命中 0 和 1），替换按从左到右不重叠选取
    const picked = [];
    let lastEnd = -1;
    for (const p of positions) {
      if (p < lastEnd) continue;
      picked.push(p);
      lastEnd = p + pattern.length;
    }
    if (!picked.length) return 0;
    // 从后往前应用，前面的命中位置不受后面编辑影响
    const edits = [];
    for (let i = picked.length - 1; i >= 0; i--) {
      edits.push({ pos: picked[i], delLen: pattern.length, ins: replacement });
    }
    this.transaction(edits, { cursor: picked[0] + replacement.length });
    return picked.length;
  }
}
