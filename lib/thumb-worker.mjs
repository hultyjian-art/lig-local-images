/**
 * 缩略图解码 worker（第60次新增）
 *
 * 把 CPU 密集的 jimp 解码/缩放/编码移出主线程。
 * 实测（6.2MB 大图）：主线程解码 2.1 秒，期间 /roots /tree 全部被阻塞 2 秒 ——
 * 一页几十上百张图会累计成数十秒到数分钟的阻塞，前端请求因此超时
 * （signal is aborted without reason）。
 */

import { parentPort } from 'node:worker_threads';
import { decodeThumb } from './thumb-core.mjs';

parentPort?.on('message', async (msg) => {
  const { id, abs, width, quality, format } = msg || {};
  try {
    const out = await decodeThumb(abs, width, quality, format);
    if (!out) {
      // 原图本来就比目标宽度小（或解码后拿不到尺寸）—— 让主线程记下原因
      parentPort.postMessage({ id, ok: true, buf: null, reason: 'tooSmall' });
      return;
    }
    // 用 Transferable 转移字节，避免大 buffer 的结构化克隆开销
    const ab = out.buf.buffer.slice(out.buf.byteOffset, out.buf.byteOffset + out.buf.byteLength);
    parentPort.postMessage({ id, ok: true, buf: ab, mime: out.mime }, [ab]);
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
});
