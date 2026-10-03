// 小工具：十六进制解析/格式化（视图粘贴、搜索框、替换框共用）。

// 接受 "DE AD BE EF"、"deadbeef"、"de-ad" 等写法；非法或奇数位返回 null。
export function parseHexInput(s) {
  const t = s.replace(/[\s_,-]/g, '');
  if (t.length === 0 || t.length % 2 !== 0 || /[^0-9a-fA-F]/.test(t)) return null;
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
}
