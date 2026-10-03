// 位置迁移：一次编辑描述为 (pos 处删除 deleteLen 字节、插入 insertLen 字节)。
// 文档中任何“逻辑位置”（光标、选区端点、外部锚点）都按同一规则随编辑迁移。

export function mapPos(p, pos, deleteLen, insertLen) {
  if (p <= pos) return p;                          // 编辑点之前：不动
  if (p >= pos + deleteLen) return p + insertLen - deleteLen; // 删除区间之后：平移
  return pos;                                      // 落在被删区间内：收缩到编辑点
}

// 依次穿过一串编辑描述（undo/redo/批量编辑返回的 desc 列表）
export function mapThrough(p, descs) {
  for (const d of descs) p = mapPos(p, d.pos, d.deleteLen, d.insertLen);
  return p;
}
