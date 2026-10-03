// 片段表（Piece Table）编辑模型。
//
// 文档 = 原文件缓冲（只读，从不复制）+ 追加区（只增不减）上的一系列“范围引用”。
// 每次按键只做范围的切分/拼接，插入的字节追加到追加区，绝不整份复制文件。
//
// 撤销/重做：每条命令保存正向编辑与其逆操作（删除前读出的旧字节）。
// 连续输入（同一 coalesceKey）会合并成一条撤销记录。

const EMPTY = new Uint8Array(0);

// 片段对象与 pieces 数组按“纪律性不可变”处理：任何编辑都构建全新数组，
// 从不原地修改——这是快照语义的基础（10 万级片段下 Object.freeze 开销过大）。
const mkPiece = (orig, start, len) => ({ orig, start, len });
const descOf = (e) => ({ pos: e.pos, deleteLen: e.deleteLen, insertLen: e.insert.length });

function concat(a, b) {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

// ---------------------------------------------------------------------------
// 追加区：逻辑上是一段只增不减的字节序列，物理上由若干块组成（避免扩容拷贝）。
// ---------------------------------------------------------------------------
export class AppendStore {
  constructor() {
    this.chunks = [];   // Uint8Array[]
    this.starts = [];   // 每块在逻辑序列中的起始偏移
    this.length = 0;
    this._li = 0;       // 上次定位的块下标（顺序读缓存）
  }
  append(bytes) {
    if (bytes.length === 0) return this.length;
    const off = this.length;
    this.chunks.push(bytes);
    this.starts.push(off);
    this.length += bytes.length;
    return off;
  }
  _locate(off) {
    const s = this.starts;
    const i = this._li;
    if (i < s.length && s[i] <= off && (i + 1 === s.length || s[i + 1] > off)) return i;
    let lo = 0, hi = s.length - 1, ans = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (s[m] <= off) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    this._li = ans;
    return ans;
  }
  byteAt(off) {
    const i = this._locate(off);
    return this.chunks[i][off - this.starts[i]];
  }
  read(off, len) {
    const out = new Uint8Array(len);
    let done = 0;
    while (done < len) {
      const i = this._locate(off + done);
      const c = this.chunks[i];
      const from = off + done - this.starts[i];
      const n = Math.min(c.length - from, len - done);
      out.set(c.subarray(from, from + n), done);
      done += n;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 快照/文档共用的只读访问。snap 形状：{ pieces, orig, add, length, revision? }
// pieces 从不原地修改（每次编辑都构建新数组），追加区只增不减，因此快照永久有效。
// cache（可选）：{ pieces, idx, off }，顺序读取时避免每次都从头线性扫描。
// ---------------------------------------------------------------------------
function locateIn(pieces, pos, cache) {
  let i = 0, off = 0;
  if (cache && cache.pieces === pieces && cache.off <= pos && cache.idx < pieces.length) {
    i = cache.idx;
    off = cache.off;
  }
  while (i < pieces.length && pos >= off + pieces[i].len) {
    off += pieces[i].len;
    i++;
  }
  if (cache) { cache.pieces = pieces; cache.idx = i; cache.off = off; }
  return [i, off];
}

export function snapByteAt(snap, pos, cache) {
  if (pos < 0 || pos >= snap.length) throw new RangeError('offset out of range: ' + pos);
  const [i, off] = locateIn(snap.pieces, pos, cache);
  const p = snap.pieces[i];
  return p.orig ? snap.orig[p.start + pos - off] : snap.add.byteAt(p.start + pos - off);
}

export function snapRead(snap, pos, len, cache) {
  if (len < 0 || pos < 0 || pos + len > snap.length) {
    throw new RangeError(`read out of range: pos=${pos} len=${len} length=${snap.length}`);
  }
  const out = new Uint8Array(len);
  let [i, off] = locateIn(snap.pieces, pos, cache);
  let done = 0;
  for (; i < snap.pieces.length && done < len; i++) {
    const p = snap.pieces[i];
    const s = Math.max(pos - off, 0);
    const n = Math.min(p.len - s, len - done);
    if (n > 0) {
      if (p.orig) out.set(snap.orig.subarray(p.start + s, p.start + s + n), done);
      else out.set(snap.add.read(p.start + s, n), done);
      done += n;
    }
    off += p.len;
  }
  return out;
}

// 逐段遍历快照内容（导出用）。返回的是只读视图或新分配的小块，调用方不得修改。
export function* snapChunks(snap, maxChunk = 1 << 20) {
  for (const p of snap.pieces) {
    let done = 0;
    while (done < p.len) {
      const n = Math.min(maxChunk, p.len - done);
      if (p.orig) yield snap.orig.subarray(p.start + done, p.start + done + n);
      else yield snap.add.read(p.start + done, n);
      done += n;
    }
  }
}

// ---------------------------------------------------------------------------
// 连续输入合并：把“上一击 + 当前击”合并为一条撤销记录。
// e1/inv1：已合并的正向/逆向编辑；e2/inv2：本次击键。返回合并结果或 null。
// ---------------------------------------------------------------------------
function tryMerge(e1, inv1, e2, inv2) {
  // 1) 连续插入（插入模式下逐字节输入）
  if (e1.deleteLen === 0 && e2.deleteLen === 0 && e2.pos === e1.pos + e1.insert.length) {
    const ins = concat(e1.insert, e2.insert);
    return { fwd: { pos: e1.pos, deleteLen: 0, insert: ins },
             inv: { pos: e1.pos, deleteLen: ins.length, insert: EMPTY } };
  }
  // 2) 插入模式下补全最后一个插入的字节（十六进制半字节第二击）
  if (e1.deleteLen === 0 && e1.insert.length > 0 &&
      e2.deleteLen === 1 && e2.insert.length === 1 &&
      e2.pos === e1.pos + e1.insert.length - 1) {
    const fi = e1.insert.slice();
    fi[fi.length - 1] = e2.insert[0];
    return { fwd: { pos: e1.pos, deleteLen: 0, insert: fi },
             inv: { pos: e1.pos, deleteLen: fi.length, insert: EMPTY } };
  }
  // 3) 覆盖输入：等长替换，续写下一字节或改写末尾字节（半字节第二击）
  if (e1.deleteLen === e1.insert.length && e1.deleteLen > 0 &&
      e2.deleteLen === 1 && e2.insert.length === 1) {
    const end = e1.pos + e1.deleteLen;
    if (e2.pos === end) {
      return { fwd: { pos: e1.pos, deleteLen: e1.deleteLen + 1, insert: concat(e1.insert, e2.insert) },
               inv: { pos: e1.pos, deleteLen: e1.deleteLen + 1, insert: concat(inv1.insert, inv2.insert) } };
    }
    if (e2.pos === end - 1) {
      // 改写末尾字节（半字节第二击）：逆向仍恢复 inv1 保存的原始字节，不变
      const fi = e1.insert.slice(); fi[fi.length - 1] = e2.insert[0];
      return { fwd: { pos: e1.pos, deleteLen: e1.deleteLen, insert: fi },
               inv: inv1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
export class PieceTable {
  constructor(origBytes = EMPTY) {
    if (!(origBytes instanceof Uint8Array)) origBytes = Uint8Array.from(origBytes);
    this.orig = origBytes;              // 原文件：只读，永不复制
    this.add = new AppendStore();       // 追加区：只增不减
    this.pieces = origBytes.length ? [mkPiece(true, 0, origBytes.length)] : [];
    this.length = origBytes.length;
    this.revision = 0;                  // 每次应用（含撤销/重做）+1，搜索结果据此判过期
    this.undoStack = [];
    this.redoStack = [];
    this._rc = { pieces: null, idx: 0, off: 0 };  // 顺序读取定位缓存
  }

  byteAt(pos) { return snapByteAt(this, pos, this._rc); }
  read(pos, len) { return snapRead(this, pos, len, this._rc); }
  toBytes() { return snapRead(this, 0, this.length); }

  // 快照：浅拷贝。pieces 从不原地修改、追加区只增不减，之后任意编辑都不影响此快照。
  snapshot() {
    return { pieces: this.pieces, orig: this.orig, add: this.add,
             length: this.length, revision: this.revision };
  }

  // 单点编辑（可带 coalesceKey 合并连续输入）。返回编辑描述列表供位置迁移。
  edit(pos, deleteLen, insert = EMPTY, coalesceKey = null) {
    if (!(insert instanceof Uint8Array)) insert = Uint8Array.from(insert);
    const e2 = { pos, deleteLen, insert };
    const top = this.undoStack[this.undoStack.length - 1];
    if (coalesceKey !== null && top && top.key === coalesceKey && top.edits.length === 1) {
      const inv2 = { pos, deleteLen: insert.length, insert: snapRead(this, pos, deleteLen, this._rc) };
      const merged = tryMerge(top.edits[0], top.inv[0], e2, inv2);
      if (merged) {
        this._apply([e2]);               // 正向应用；逆操作并入已有撤销项
        top.edits = [merged.fwd];
        top.inv = [merged.inv];
        this.redoStack.length = 0;       // 新编辑切断重做分支
        return [descOf(e2)];
      }
    }
    const cmd = this._apply([e2]);
    cmd.key = coalesceKey;
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    return [descOf(e2)];
  }

  // 批量编辑：所有位置都相对于当前文档（同一坐标系），按 pos 升序、互不重叠。
  // 整批作为一条撤销记录（“全部替换”用它，单次扫描重建片段，O(片段数+编辑数)）。
  applyEdits(edits, coalesceKey = null) {
    const norm = edits.map(e => ({
      pos: e.pos, deleteLen: e.deleteLen,
      insert: e.insert instanceof Uint8Array ? e.insert : Uint8Array.from(e.insert),
    }));
    norm.sort((a, b) => a.pos - b.pos || a.deleteLen - b.deleteLen);
    if (norm.length === 0) return [];
    const cmd = this._apply(norm);
    cmd.key = coalesceKey;
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    return cmd.edits.map(descOf);
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this._apply(cmd.inv);
    this.redoStack.push(cmd);
    return cmd.inv.map(descOf);
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this._apply(cmd.edits);
    this.undoStack.push(cmd);
    return cmd.edits.map(descOf);
  }

  // 核心：单次扫描应用一组同坐标编辑，返回 { edits, inv }。
  // inv 的位置已换算到编辑后的坐标系，可直接再交给 _apply 实现撤销。
  _apply(edits) {
    let prevEnd = 0;
    for (const e of edits) {
      if (!(e.insert instanceof Uint8Array)) throw new TypeError('insert must be Uint8Array');
      if (e.pos < 0 || e.deleteLen < 0 || e.pos + e.deleteLen > this.length) {
        throw new RangeError(`edit out of range: pos=${e.pos} deleteLen=${e.deleteLen} length=${this.length}`);
      }
      if (e.deleteLen === 0 && e.insert.length === 0) throw new Error('empty edit');
      if (e.pos < prevEnd) throw new Error('edits overlap or unsorted');
      prevEnd = e.pos + e.deleteLen;
    }
    if (edits.length === 0) return { edits: [], inv: [], key: null };

    const addOffs = edits.map(e => this.add.append(e.insert));          // 新字节只追加，不搬移

    // 单次扫描：构建新片段的同时，顺带收集每处编辑被删除的字节（逆操作所需）。
    const newPieces = [];
    const removedSegs = edits.map(() => []);   // 每处编辑 → [[orig, start, len], ...]
    const push = (orig, start, len) => {   // 相邻同源同续的片段就地合并，控制片段数量
      if (len <= 0) return;
      const last = newPieces[newPieces.length - 1];
      if (last && last.orig === orig && last.start + last.len === start) {
        newPieces[newPieces.length - 1] = mkPiece(orig, last.start, last.len + len);
      } else {
        newPieces.push(mkPiece(orig, start, len));
      }
    };

    const oldPieces = this.pieces, oldLen = this.length;
    let pi = 0, pStart = 0, cur = 0;  // pStart: oldPieces[pi] 在文档中的起始偏移；cur: 已消费到的偏移
    const advance = (target) => {     // 复制 [cur, target) 的旧内容
      while (cur < target) {
        const p = oldPieces[pi];
        const take = Math.min(p.len - (cur - pStart), target - cur);
        push(p.orig, p.start + (cur - pStart), take);
        cur += take;
        if (cur === pStart + p.len) { pi++; pStart = cur; }
      }
    };
    const skip = (target, segs) => {  // 跳过 [cur, target)（被删除的内容），记录其来源区间
      while (cur < target) {
        const p = oldPieces[pi];
        const take = Math.min(p.len - (cur - pStart), target - cur);
        segs.push([p.orig, p.start + (cur - pStart), take]);
        cur += take;
        if (cur === pStart + p.len) { pi++; pStart = cur; }
      }
    };

    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      advance(e.pos);
      push(false, addOffs[i], e.insert.length);
      skip(e.pos + e.deleteLen, removedSegs[i]);
    }
    advance(oldLen);

    // 物化被删字节（orig 段做视图拷贝，add 段从追加区读出）
    const removed = removedSegs.map((segs) => {
      if (segs.length === 0) return EMPTY;
      const total = segs.reduce((n, s) => n + s[2], 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const [isOrig, start, len] of segs) {
        if (isOrig) out.set(this.orig.subarray(start, start + len), off);
        else out.set(this.add.read(start, len), off);
        off += len;
      }
      return out;
    });

    let delta = 0;
    const inv = edits.map((e, i) => {
      const ie = { pos: e.pos + delta, deleteLen: e.insert.length, insert: removed[i] };
      delta += e.insert.length - e.deleteLen;
      return ie;
    });

    this.pieces = newPieces;
    this.length = oldLen + delta;
    this.revision++;
    return { edits, inv, key: null };
  }
}
