// 增量式 SHA-256：支持分块 update，最后 digest 取摘要。
// 用于导出时逐段计算哈希，避免为算摘要再复制一整份文件。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

export class SHA256 {
  constructor() {
    this._h = new Uint32Array(H0);
    this._block = new Uint8Array(64); // 未满一块的缓冲
    this._blockLen = 0;
    this._len = 0;                    // 已处理总字节数
    this._w = new Uint32Array(64);    // 消息调度工作区
  }

  /** @param {Uint8Array} data */
  update(data) {
    this._len += data.length;
    let off = 0;
    if (this._blockLen > 0) {
      const take = Math.min(64 - this._blockLen, data.length);
      this._block.set(data.subarray(0, take), this._blockLen);
      this._blockLen += take;
      off += take;
      if (this._blockLen === 64) {
        this._compress(this._block);
        this._blockLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this._compress(data.subarray(off, off + 64));
      off += 64;
    }
    if (off < data.length) {
      this._block.set(data.subarray(off), 0);
      this._blockLen = data.length - off;
    }
    return this;
  }

  _compress(block) {
    const w = this._w;
    for (let i = 0; i < 16; i++) {
      const j = i * 4;
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this._h;
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  /** @returns {Uint8Array} 32 字节摘要。可重复调用，不影响状态。 */
  digest() {
    // 在状态副本上收尾（填充），原实例可继续 update
    const clone = new SHA256();
    clone._h.set(this._h);
    clone._block.set(this._block);
    clone._blockLen = this._blockLen;
    clone._len = this._len;

    const bitLenHi = Math.floor(clone._len / 0x20000000); // len*8 的高 32 位
    const bitLenLo = (clone._len * 8) >>> 0;
    clone.update(new Uint8Array([0x80]));
    while (clone._blockLen !== 56) clone.update(new Uint8Array([0]));
    const lenBlock = new Uint8Array(8);
    new DataView(lenBlock.buffer).setUint32(0, bitLenHi, false);
    new DataView(lenBlock.buffer).setUint32(4, bitLenLo, false);
    clone.update(lenBlock);

    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) dv.setUint32(i * 4, clone._h[i], false);
    return out;
  }

  /** @returns {string} 64 位小写十六进制摘要 */
  hex() {
    return [...this.digest()].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
