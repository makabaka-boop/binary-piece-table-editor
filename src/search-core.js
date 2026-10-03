// 字节模式搜索核心（Boyer-Moore-Horspool）。纯函数，Worker 与测试共用。

/**
 * 在 hay 中查找 needle 的全部出现位置。
 * @param {Uint8Array} hay
 * @param {Uint8Array} needle
 * @param {{overlap?: boolean}} opts overlap=true 时允许重叠命中（步进 1），否则命中后跳过整个模式
 * @returns {number[]} 升序命中位置
 */
export function findAll(hay, needle, { overlap = true } = {}) {
  const n = hay.length;
  const m = needle.length;
  const out = [];
  if (m === 0 || m > n) return out;

  // 坏字符表：未出现的字符直接跳过整个模式长度
  const shift = new Int32Array(256).fill(m);
  for (let i = 0; i < m - 1; i++) shift[needle[i]] = m - 1 - i;

  const last = needle[m - 1];
  let i = 0;
  while (i <= n - m) {
    if (hay[i + m - 1] === last) {
      let j = m - 1;
      while (j > 0 && hay[i + j - 1] === needle[j - 1]) j--;
      if (j === 0) {
        out.push(i);
        i += overlap ? 1 : m;
        continue;
      }
    }
    i += shift[hay[i + m - 1]];
  }
  return out;
}
