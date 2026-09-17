/**
 * lig-local-images - 路径安全与类型校验
 *
 * 所有"相对路径 → 绝对路径"的解析都必须经过 resolveUnder，
 * 它对 .. / 绝对路径 / 编码变体天然免疫；写端点额外限定在 userImages 之下。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 支持的图片扩展名（对齐前端 constants.ts IMAGE_EXTENSIONS） */
export const IMAGE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif',
]);

/** 归一化逻辑相对路径：去掉 .. 段、反斜杠转斜杠、去首尾斜杠 */
export function cleanRel(rel) {
  if (typeof rel !== 'string') return '';
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .filter(seg => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/**
 * 将相对路径安全解析到某个基目录下。
 * @param {string} baseAbs 基目录绝对路径
 * @param {string} rel 相对路径（已清洗或将被清洗）
 * @returns {{ ok: true, abs: string } | { ok: false, code: number, error: string }}
 */
export function resolveUnder(baseAbs, rel) {
  const cleaned = cleanRel(rel);
  const abs = path.resolve(baseAbs, cleaned);
  // 第47次: baseAbs 先归一化——注册根常带尾斜杠(手机端手输 /storage/.../美化/),
  // path.resolve 会吃掉尾斜杠, 若不归一化 baseAbs 则 abs 永远 !== baseAbs 且
  // 不以 baseAbs+sep 开头, 误报"路径越界"
  const base = path.resolve(baseAbs);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  // abs 必须严格位于基目录之下（或等于基目录本身，用于列根）
  if (abs !== base && !abs.startsWith(baseWithSep)) {
    // 第47次: 附实际值(带引号暴露首尾空格/不可见字符), 远程排障用——仅回给
    // 已登录的本机前端, 无外部泄露面
    return { ok: false, code: 403, error: `路径越界 [base="${base}" abs="${abs}"]` };
  }
  return { ok: true, abs, cleaned };
}

/** 是否图片文件（按扩展名） */
export function isImage(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXT.has(name.slice(dot).toLowerCase());
}

/** 校验目录存在且可读，返回错误信息或 null */
export function probeReadableDir(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return '目标不是目录';
    fs.accessSync(abs, fs.constants.R_OK);
    return null;
  } catch (e) {
    return `目录不可读: ${e.message}`;
  }
}

/**
 * 破坏性操作的「非根层」闸门（v1.0.5，用户明确要求）。
 *
 * ⚠️ 为什么需要它：`user/images` 是**酒馆自己的目录**。除本脚本的图库子目录
 * （默认 `local_images`）外，实测该目录下还有数十个以角色卡名命名的目录
 * （`【成人美漫：开局社保黑丝旺达】`、`写卡`、`chatu8List` …），酒馆把角色卡等数据也放在这里。
 *
 * 本插件的图库目录恒为 `user/images` 的**某个子目录**（见 resolveWritePath 的说明），
 * 因此 delete / rename / move 的目标清洗后必须**至少两段**；只作用于根层（一段）的一律拒绝。
 * 这样即使前端出现 bug 或旧版本脚本，也无法误删 images 根层的东西。
 *
 * 前端 `src/本地图片展示/services/galleryScope.ts` 的 `assertInsideGalleryDir` 是同规则的
 * 第一层防线（双保险）；后端是最终底线。
 *
 * @param {string} cleaned cleanRel 之后的相对路径
 * @returns {{ ok: true } | { ok: false, code: number, error: string }}
 */
export function requireBelowImagesRoot(cleaned) {
  const segs = String(cleaned ?? '')
    .split('/')
    .filter(Boolean);
  if (segs.length < 2) {
    return {
      ok: false,
      code: 403,
      error: '拒绝对 user/images 根层直接操作（该层由酒馆自身使用，含角色卡等数据）',
    };
  }
  return { ok: true };
}
