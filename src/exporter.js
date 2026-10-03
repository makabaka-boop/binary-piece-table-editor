// 快照式导出：从当前段列表逐段生成文件内容并流式计算 SHA-256。
//
// 导出开始时捕获段数组引用（段对象不可变，后续编辑只会换出新的段数组），
// 因此导出进行中发生的任何编辑都不会影响本次导出的字节与摘要。
// Blob 的各部分直接引用底层缓冲区的视图，整份导出零整拷贝。

import { SHA256 } from './sha256.js';

/**
 * @param {PieceTable} doc
 * @param {object} opts
 * @param {number} [opts.yieldThresholdBytes] 每处理多少字节让出一次事件循环（默认 4 MiB）
 * @param {() => (void|Promise<void>)} [opts.onYield] 让点时回调（测试用它注入并发编辑）
 * @param {(done:number, total:number) => void} [opts.onProgress]
 * @param {number} [opts.revision] 仅用于展示/日志的修订号标签
 * @returns {Promise<{blob: Blob, digest: string, length: number, revision?: number}>}
 */
export async function exportSnapshot(doc, opts = {}) {
  const {
    yieldThresholdBytes = 4 * 1024 * 1024,
    onYield = () => new Promise((r) => setTimeout(r, 0)),
    onProgress,
    revision,
  } = opts;

  // 关键：捕获此刻的段列表与长度 —— 这就是导出的不可变快照
  const pieces = doc.pieces;
  const total = doc.length;

  // 冻结 ADD 缓冲区的就地改写：本导出引用的段可能覆盖最近追加的字节，
  // 导出期间该优化必须暂停（编辑器会回退为普通 splice，追加新字节）。
  doc.freeze();

  const hash = new SHA256();
  const parts = [];
  let done = 0;
  let sinceYield = 0;

  try {
    for (const p of pieces) {
      const view = doc.sourceBuffer(p.buf).subarray(p.start, p.start + p.len);
      hash.update(view);
      parts.push(view);
      done += p.len;
      sinceYield += p.len;
      onProgress?.(done, total);
      if (sinceYield >= yieldThresholdBytes) {
        sinceYield = 0;
        await onYield(); // 让出事件循环；期间发生的编辑与本次导出无关
      }
    }
  } finally {
    doc.unfreeze();
  }

  return { blob: new Blob(parts), digest: hash.hex(), length: total, revision };
}
