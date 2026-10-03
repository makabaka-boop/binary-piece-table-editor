// 字节模式搜索：KMP 流式匹配。
// 以“拉取流”方式逐字节扫过片段序列，天然支持跨片段（跨范围）命中，
// 无需把文档拼成一整块内存。

export function buildKMP(pat) {
  const f = new Int32Array(pat.length);
  let k = 0;
  for (let i = 1; i < pat.length; i++) {
    while (k > 0 && pat[i] !== pat[k]) k = f[k - 1];
    if (pat[i] === pat[k]) k++;
    f[i] = k;
  }
  return f;
}

// 逐字节喂入；返回命中起始位置，未命中返回 -1。可发现重叠命中（如 'aa' in 'aaa'）。
export function createMatcher(pattern) {
  if (pattern.length === 0) return { feed: () => -1 };   // 空模式永不命中
  const f = buildKMP(pattern);
  let q = 0, i = 0;
  return {
    feed(b) {
      while (q > 0 && b !== pattern[q]) q = f[q - 1];
      if (b === pattern[q]) q++;
      const pos = i;
      i++;
      if (q === pattern.length) {
        q = f[q - 1];
        return pos - pattern.length + 1;
      }
      return -1;
    },
  };
}

// 把快照/文档变成字节流：next() 返回下一字节，结束返回 -1。
export function streamFromSnap(snap) {
  const ps = snap.pieces;
  let pi = 0, off = 0;
  return {
    next() {
      while (pi < ps.length) {
        const p = ps[pi];
        if (off < p.len) {
          const b = p.orig ? snap.orig[p.start + off] : snap.add.byteAt(p.start + off);
          off++;
          return b;
        }
        pi++;
        off = 0;
      }
      return -1;
    },
  };
}

// 便捷封装：返回全部命中位置（升序）。cap 限制最大命中数。
export function searchAll(snap, pattern, cap = Infinity) {
  const m = createMatcher(pattern);
  const s = streamFromSnap(snap);
  const out = [];
  let b;
  while ((b = s.next()) >= 0) {
    const h = m.feed(b);
    if (h >= 0) {
      out.push(h);
      if (out.length >= cap) break;
    }
  }
  return out;
}

// 朴素匹配，供测试对拍。
export function naiveSearch(bytes, pattern) {
  const out = [];
  if (pattern.length === 0) return out;
  outer: for (let i = 0; i + pattern.length <= bytes.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}
