// 测试辅助：确定性随机数、朴素参考实现（小数组），用于与片段表对拍。

/** mulberry32：可复现的伪随机数发生器 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(rng, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

/** 朴素全量扫描查找（含重叠），作为 findAll 的参考实现 */
export function refFindAll(hay, needle, overlap = true) {
  const out = [];
  const n = hay.length;
  const m = needle.length;
  if (m === 0 || m > n) return out;
  for (let i = 0; i <= n - m;) {
    let ok = true;
    for (let j = 0; j < m; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) { out.push(i); i += overlap ? 1 : m; }
    else i++;
  }
  return out;
}

/**
 * 参考文档模型：直接在一个普通数组上 splice，并维护与 HexEditor 相同语义的
 * 撤销/重做栈（编辑即整体快照——参考实现追求显而易见地正确，不追求效率）。
 */
export class RefDoc {
  constructor(bytes) {
    this.bytes = [...bytes];
    this.undoStack = [];
    this.redoStack = [];
  }
  splice(pos, delLen, ins) {
    this.undoStack.push([...this.bytes]);
    this.redoStack = [];
    this.bytes.splice(pos, delLen, ...ins);
  }
  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push([...this.bytes]);
    this.bytes = this.undoStack.pop();
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push([...this.bytes]);
    this.bytes = this.redoStack.pop();
    return true;
  }
}
