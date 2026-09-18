本目录是 WebP 编码器（libwebp via WASM）的 vendored 副本。

来源：@jsquash/webp v1.5.0 —— https://github.com/jamsinclair/jSquash
文件：codec/enc/webp_enc.js（emscripten 胶水，原样复制，未做任何修改）
      codec/enc/webp_enc.wasm（libwebp 编码器，标量版，281KB）

为什么 vendor 进插件而不是依赖宿主的 node_modules：
  1. 宿主（Luker / 原版 SillyTavern）虽然当前都装了 @jsquash/webp，
     但版本与存在性都不受本插件控制，升级宿主可能改变行为；
  2. 插件直接 reads 自带 wasm + 手动实例化，不依赖任何第三方解析路径，
     因此在 Luker 与原版 ST 上行为完全一致；
  3. 全程零网络：@jsquash/webp 的 encode.js 默认用 fetch() 加载 wasm，
     在 Node 里（file:// 协议）会失败 —— 本插件改用
     `WebAssembly.compile(readFileSync(...))` + `instantiateWasm` 手动实例化
     （该能力由 @jsquash 的 utils.js 明确提供："allow manual instantiation"）。

为什么不带 SIMD 版（webp_enc_simd.wasm，345KB）：
  实测 320px 缩略图编码，标量版 26~38ms、SIMD 版 17~30ms —— 差距仅为
  十几毫秒，且编码发生在 worker 线程里，不值得为此多带 345KB。

许可证：Apache-2.0（见 LICENSE-jsquash.txt）。libwebp 本身为 BSD 许可。
