// 界面辅助：十六进制解析与格式化。

/** 解析 "DE AD be ef" / "0xDE 0xAD" / "deadbeef" 形式的字节串；非法返回 null，空串返回空数组。 */
export function parseHex(text) {
  const clean = text.replace(/0x/gi, '').replace(/[\s_,.;:-]/g, '');
  if (clean === '') return new Uint8Array(0);
  if (!/^([0-9a-fA-F]{2})+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function hex2(b) { return b.toString(16).padStart(2, '0'); }
export function hexAddr(n) { return n.toString(16).padStart(8, '0'); }

/** 可打印 ASCII 原样返回（已转义 HTML），否则返回 '·'。 */
export function asciiChar(b) {
  if (b < 0x20 || b > 0x7e) return '·';
  const ch = String.fromCharCode(b);
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  return ch;
}
