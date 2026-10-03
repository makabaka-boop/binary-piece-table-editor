// 搜索 Worker：接收绑定修订号的搜索请求，返回命中位置。
// 消息协议：
//   入: {id, rev, pattern: Uint8Array, buffer: ArrayBuffer}  （buffer 为文档快照，已转移所有权）
//   出: {id, rev, positions: number[]}
// 同时兼容浏览器（self）与 Node worker_threads（便于测试）。

import { findAll } from './search-core.js';

let post;
let listen;
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  post = (msg) => self.postMessage(msg);
  listen = (fn) => { self.onmessage = (e) => fn(e.data); };
} else {
  const { parentPort } = await import('node:worker_threads');
  post = (msg) => parentPort.postMessage(msg);
  listen = (fn) => parentPort.on('message', fn);
}

listen((msg) => {
  const { id, rev, pattern, buffer } = msg;
  const positions = findAll(new Uint8Array(buffer), pattern);
  post({ id, rev, positions });
});
