/**
 * WebP 编码封装（第62次新增）—— 本地 wasm，零网络依赖
 *
 * 背景：网格缩略图原先一律输出 JPEG。实测同一张 320px 缩略图：
 *   B-15.jpg：jpeg q72 = 49KB / 40ms，webp q72 = 30KB / 38ms
 *   B-21.jpg：jpeg q72 = 37KB / 37ms，webp q72 = 20KB / 26ms
 * ⇒ webp 体积降 39~46%，耗时持平，是纯收益。
 *
 * 关键点（踩过的坑）：
 *   - `@jsquash/webp` 的 `encode.js` 默认用 `fetch()` 加载 `.wasm`，在 Node 的
 *     file:// 协议下必然失败（实测 "fetch failed"）。
 *   - 但它的 `utils.js` 明确支持手动实例化（注释原文 "allow manual instantiation
 *     of the Wasm Module"）：把 `WebAssembly.Module` 传进 init 即可，胶水源码
 *     不需要任何修改。
 *   ⇒ 本模块用 `readFileSync` + `WebAssembly.compile` 读出模块并注入。
 *
 * 为什么放在插件里而不是 import 宿主依赖：见同目录 webp/README.txt。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GLUE_URL = new URL('./webp/webp_enc.js', import.meta.url);
const WASM_PATH = fileURLToPath(new URL('./webp/webp_enc.wasm', import.meta.url));

/**
 * libwebp 的 WebPConfig 结构体字段（取自 @jsquash/webp 的 meta.js）。
 * 结构体必须整体填充，缺字段会导致 C 侧读到脏值。
 */
const WEBP_DEFAULT_OPTIONS = {
  quality: 75,
  target_size: 0,
  target_PSNR: 0,
  method: 4,
  sns_strength: 50,
  filter_strength: 60,
  filter_sharpness: 0,
  filter_type: 1,
  partitions: 0,
  segments: 4,
  pass: 1,
  show_compressed: 0,
  preprocessing: 0,
  autofilter: 0,
  partition_limit: 0,
  alpha_compression: 1,
  alpha_filtering: 1,
  alpha_quality: 100,
  lossless: 0,
  exact: 0,
  image_hint: 0,
  emulate_jpeg_size: 0,
  thread_level: 0,
  low_memory: 0,
  near_lossless: 100,
  use_delta_palette: 0,
  use_sharp_yuv: 0,
};

/** 已初始化的 emscripten 模块（进程内复用；wasm 实例化只需一次） */
let encoderPromise = null;

/** 加载并初始化编码器（首次约 2~10ms，之后复用同一实例） */
export function loadWebpEncoder() {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      const factory = (await import(GLUE_URL.href)).default;
      const wasmModule = await WebAssembly.compile(readFileSync(WASM_PATH));
      const mod = await factory({
        // 不自动执行任何 wasm 函数，交给 encode() 显式调用
        noInitialRun: true,
        // 手动实例化：绕开胶水内部基于 import.meta.url 的 fetch
        instantiateWasm: (imports, callback) => {
          const instance = new WebAssembly.Instance(wasmModule, imports);
          callback(instance);
          return instance.exports;
        },
      });
      return mod;
    })().catch((e) => {
      // 失败不缓存，允许下次重试（例如文件被临时占用）
      encoderPromise = null;
      throw e;
    });
  }
  return encoderPromise;
}

/**
 * 把 RGBA 像素编码为 WebP。
 *
 * @param {Uint8Array} rgba   RGBA 顺序、4 字节/像素的原始像素（jimp 的 bitmap.data 即此格式）
 * @param {number} width
 * @param {number} height
 * @param {number} quality    有损质量 0~100（与 jpeg 的 quality 语义不同，72 已足够）
 * @returns {Promise<Buffer>}
 */
export async function encodeWebp(rgba, width, height, quality = 72) {
  const mod = await loadWebpEncoder();
  if (typeof mod?.encode !== 'function') throw new Error('webp 编码器未正确初始化');
  // 复制一份传入：emscripten 侧会读 TypedArray 完整内容，且避免共享底层 buffer
  const bytes = new Uint8Array(rgba);
  const out = mod.encode(bytes, width, height, { ...WEBP_DEFAULT_OPTIONS, quality });
  if (!out || !out.length) throw new Error('libwebp 返回空结果');
  // ⚠️ out 是 wasm 堆上的视图，必须复制（下一次编码会覆盖同一块内存）
  return Buffer.from(out);
}
