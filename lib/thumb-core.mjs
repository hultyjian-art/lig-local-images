/**
 * 缩略图解码核心（第60次新增）
 *
 * 主线程与 worker 线程共用同一份实现：
 * - 主线程：直接调用（worker 不可用时的回退路径）
 * - worker：thumb-worker.mjs 调用（正常路径，避免阻塞事件循环）
 *
 * 为什么需要 worker：jimp 0.22 的解码/缩放/编码都是**同步 CPU 操作**，
 * 实测 6.2MB / 大尺寸 jpg 单张解码约 2.1 秒，期间整个 Node 事件循环被占满，
 * /roots /tree 等端点全部被卡住 → 前端 30 秒超时 abort
 * （用户现象："退出图库重进后什么都不显示，报 signal is aborted without reason"）。
 */

import { encodeWebp } from './webp-encode.mjs';

let jimpHandle = null; // null=未加载, false=不可用

/**
 * 放宽 jpeg-js 解码器的内存上限。
 * jimp 0.x 的 jpeg 解码器 = jpeg-js.decode 裸函数（不传 opts），默认 maxMemoryUsageInMB=512；
 * 大图（数千万像素）解码足迹可达 700MB+，会报 "maxMemoryUsageInMB limit exceeded"。
 * 覆盖 Jimp.decoders['image/jpeg']（jimp 0.22 静态可变 map，运行时查找即生效）。
 */
async function raiseJpegMemoryLimit(Jimp) {
  try {
    if (!Jimp || typeof Jimp !== 'function' || !Jimp.decoders) return;
    const mod = await import('jpeg-js');
    const jpegJs = mod.default || mod;
    if (typeof jpegJs?.decode !== 'function') return;
    const current = Jimp.decoders['image/jpeg'];
    if (current && current.__ligPatched) return;
    const patched = (data) => jpegJs.decode(data, { maxMemoryUsageInMB: 4096 });
    patched.__ligPatched = true;
    Jimp.decoders['image/jpeg'] = patched;
  } catch (e) {
    /* 保持默认上限；解码失败由调用方回退原图 */
  }
}

export async function loadJimp() {
  if (jimpHandle !== null) return jimpHandle;
  try {
    const m = await import('jimp');
    jimpHandle = m.Jimp || m.default || m;
    await raiseJpegMemoryLimit(jimpHandle);
  } catch {
    jimpHandle = false;
  }
  return jimpHandle;
}

/**
 * 把图片解码 → 缩放 → 编码为缩略图。
 *
 * @param format 'jpeg' | 'webp'（第62次新增；webp 体积比 jpeg 小 39~46%，耗时持平）
 * @returns {{ buf: Buffer, mime: string } | null}
 *   返回 null 表示「原图已够小，调用方应回退原图」（避免放大糊图）；
 *   mime 是**实际**编码出的格式 —— webp 编码失败时会退回 jpeg，调用方必须按它设响应头。
 */
export async function decodeThumb(abs, width, quality = 72, format = 'jpeg') {
  const Jimp = await loadJimp();
  if (!Jimp) throw new Error('jimp 不可用');
  const img = await Jimp.read(abs);
  const w0 = img.bitmap?.width ?? 0;
  const h0 = img.bitmap?.height ?? 0;
  if (!w0 || !h0) throw new Error('无法解码图片尺寸');
  if (w0 <= width) return null;
  img.resize(width, Math.max(1, Math.round((h0 * width) / w0)));

  if (format === 'webp') {
    try {
      const w = img.bitmap?.width ?? 0;
      const h = img.bitmap?.height ?? 0;
      const buf = await encodeWebp(img.bitmap.data, w, h, quality);
      return { buf, mime: 'image/webp' };
    } catch (e) {
      // 只警告一次，避免每张缩略图刷一行日志
      if (!webpWarned) {
        webpWarned = true;
        console.warn('[lig-local-images] webp 编码失败，本次起改用 jpeg:', String(e?.message ?? e));
      }
    }
  }

  img.quality(quality);
  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
  return { buf, mime: 'image/jpeg' };
}

/** webp 失败只提示一次 */
let webpWarned = false;
