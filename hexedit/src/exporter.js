// 导出：对“拍照时刻”的快照逐段生成文件内容，同时增量计算 SHA-256。
// 快照只引用冻结的片段与只增不减的追加区，因此导出期间的后续编辑
// 不会改变本次下载的内容与摘要。

import { snapChunks } from './piece-table.js';
import { Sha256 } from './sha256.js';

export async function exportSnapshot(snap, onProgress) {
  const sha = new Sha256();
  const parts = [];
  let done = 0;
  for (const chunk of snapChunks(snap, 1 << 20)) {
    sha.update(chunk);
    parts.push(chunk);
    done += chunk.length;
    if (onProgress) onProgress(done, snap.length);
    // 让出事件循环保持界面响应；这期间发生的编辑只产生新片段，与本快照无关。
    await new Promise((r) => setTimeout(r, 0));
  }
  return { parts, length: snap.length, revision: snap.revision, sha256: sha.digestHex() };
}
