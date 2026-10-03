// 片段表（Piece Table）编辑模型。
//
// 文档 = 段（piece）序列，每段是对两个只增不改的缓冲区之一的范围引用：
//   - ORIG：原始文件字节，加载后永不修改；
//   - ADD ：追加缓冲区，只往后追加新字节，已写入的字节永不修改。
//
// 段对象本身不可变；每次编辑用「拆分 + 重组 + 相邻合并」构造一个新的段数组，
// 因此旧段数组天然就是历史快照（撤销/重做、搜索修订、导出快照都直接引用它）。
// 任何按键级别的编辑都不会复制整份文件，代价是 O(段数) 的段表重组。

export const ORIG = 0;
export const ADD = 1;

const INITIAL_ADD_CAPACITY = 4096;

export class PieceTable {
  /** @param {Uint8Array} orig 原始文件内容（调用方不得再修改） */
  constructor(orig = new Uint8Array(0)) {
    this._orig = orig;
    this._add = new Uint8Array(INITIAL_ADD_CAPACITY);
    this._addLen = 0;
    this._freezeCount = 0; // >0 表示有导出快照在进行，禁止就地改写 ADD 字节
    this.pieces = orig.length ? [{ buf: ORIG, start: 0, len: orig.length }] : [];
    this.length = orig.length;
  }

  /** 段引用的源缓冲区。ADD 缓冲区扩容时会整体搬迁，但索引保持稳定，旧引用始终有效。 */
  sourceBuffer(which) {
    return which === ORIG ? this._orig : this._add;
  }

  /** 把字节追加到 ADD 缓冲区，返回起始索引。只追加，从不改写已有字节。 */
  _appendAdd(bytes) {
    const need = this._addLen + bytes.length;
    if (need > this._add.length) {
      let cap = this._add.length;
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this._add.subarray(0, this._addLen));
      this._add = next;
    }
    this._add.set(bytes, this._addLen);
    const start = this._addLen;
    this._addLen += bytes.length;
    return start;
  }

  /**
   * 统一编辑原语：删除 [pos, pos+delLen) 并在 pos 处插入 ins。
   * 插入 / 删除 / 替换都是它的特例。就地更新 this.pieces / this.length；
   * 调用方若需撤销，应在调用前保存旧 this.pieces 引用。
   */
  splice(pos, delLen, ins = new Uint8Array(0)) {
    pos = Math.max(0, Math.min(pos, this.length));
    delLen = Math.max(0, Math.min(delLen, this.length - pos));
    if (delLen === 0 && ins.length === 0) return;

    let insPiece = null;
    if (ins.length > 0) {
      insPiece = { buf: ADD, start: this._appendAdd(ins), len: ins.length };
    }

    const [head, rest] = splitPieces(this.pieces, pos);
    const [, tail] = splitPieces(rest, delLen); // rest 内偏移从 0 计，删 delLen 即弃掉头部

    const out = [];
    for (const p of head) pushPiece(out, p);
    if (insPiece) pushPiece(out, insPiece);
    for (const p of tail) pushPiece(out, p);

    this.pieces = out;
    this.length = this.length - delLen + ins.length;
  }

  /** @returns {number} 偏移 i 处的字节 */
  byteAt(i) {
    if (i < 0 || i >= this.length) throw new RangeError(`byteAt(${i})，长度 ${this.length}`);
    let off = 0;
    for (const p of this.pieces) {
      if (i < off + p.len) return this.sourceBuffer(p.buf)[p.start + (i - off)];
      off += p.len;
    }
    throw new RangeError(`byteAt(${i})`);
  }

  /** 复制 [start, end) 到新数组（越界自动截断）。 */
  copyRange(start, end) {
    start = Math.max(0, Math.min(start, this.length));
    end = Math.max(start, Math.min(end, this.length));
    const out = new Uint8Array(end - start);
    let off = 0;
    let written = 0;
    for (const p of this.pieces) {
      const pStart = off;
      const pEnd = off + p.len;
      const s = Math.max(start, pStart);
      const e = Math.min(end, pEnd);
      if (s < e) {
        const src = this.sourceBuffer(p.buf);
        out.set(src.subarray(p.start + (s - pStart), p.start + (e - pStart)), written);
        written += e - s;
      }
      off = pEnd;
      if (off >= end) break;
    }
    return out;
  }

  /** 当前文档的完整字节快照（一次性副本，非每键复制）。 */
  toBytes() {
    return this.copyRange(0, this.length);
  }

  /**
   * 就地改写文档偏移 docOff 处的字节（不改动段表），成功返回 true。
   * 仅当该字节是 ADD 缓冲区最后写入的字节（索引 addLen-1）且缓冲区未被
   * 导出冻结时才允许。安全性由调用方（编辑器）保证：该字节追加之后没有
   * 产生过引用它的撤销/重做快照——半字节补全场景满足此条件（补全与首半
   * 字节同属一个合并撤销单元，撤销点在该字节追加之前）。
   */
  tryRewriteAddByteAt(docOff, b) {
    if (this._freezeCount > 0) return false; // 导出进行中：已捕获的段可能引用该字节
    let off = 0;
    for (const p of this.pieces) {
      if (docOff < off + p.len) {
        if (p.buf !== ADD) return false;
        const idx = p.start + (docOff - off);
        if (idx !== this._addLen - 1) return false;
        this._add[idx] = b;
        return true;
      }
      off += p.len;
    }
    return false;
  }

  /** 导出快照期间冻结/解冻 ADD 缓冲区的就地改写。 */
  freeze() { this._freezeCount++; }
  unfreeze() { this._freezeCount = Math.max(0, this._freezeCount - 1); }

  /** 结构不变量校验，供测试与调试使用；违反时抛错。 */
  validate() {
    let total = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (!(p.len > 0)) throw new Error(`段 ${i} 长度非法: ${p.len}`);
      if (p.start < 0) throw new Error(`段 ${i} 起点非法: ${p.start}`);
      const cap = p.buf === ORIG ? this._orig.length : this._addLen;
      if (p.start + p.len > cap) throw new Error(`段 ${i} 越界: ${p.start}+${p.len} > ${cap}`);
      if (i > 0) {
        const q = this.pieces[i - 1];
        if (q.buf === p.buf && q.start + q.len === p.start) {
          throw new Error(`段 ${i - 1} 与 ${i} 本可合并`);
        }
      }
      total += p.len;
    }
    if (total !== this.length) throw new Error(`段长和 ${total} !== length ${this.length}`);
    return true;
  }
}

/**
 * 在文档偏移 pos 处把段列表一分为二，返回 [head, tail]。
 * 若 pos 落在某段内部，该段被拆成左右两段（新对象，原段不变）。
 */
export function splitPieces(pieces, pos) {
  const head = [];
  const tail = [];
  let off = 0;
  for (const p of pieces) {
    if (pos <= off) {
      tail.push(p);
    } else if (pos >= off + p.len) {
      head.push(p);
    } else {
      const leftLen = pos - off;
      head.push({ buf: p.buf, start: p.start, len: leftLen });
      tail.push({ buf: p.buf, start: p.start + leftLen, len: p.len - leftLen });
    }
    off += p.len;
  }
  return [head, tail];
}

/** 追加一段到输出列表，丢弃零长段并合并相邻同缓冲区且连续的段。 */
function pushPiece(out, p) {
  if (p.len === 0) return;
  const last = out[out.length - 1];
  if (last && last.buf === p.buf && last.start + last.len === p.start) {
    last.len += p.len;
  } else {
    out.push({ buf: p.buf, start: p.start, len: p.len });
  }
}
