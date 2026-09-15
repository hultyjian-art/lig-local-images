/**
 * lig-local-images - 路径安全与类型校验
 *
 * 所有"相对路径 → 绝对路径"的解析都必须经过 resolveUnder，
 * 它对 .. / 绝对路径 / 编码变体天然免疫；写端点额外限定在 userImages 之下。
 */

import path from 'node:path';
import fs from 'node:fs';

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
  const baseWithSep = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  // abs 必须严格位于 baseAbs 之下（或等于 baseAbs 本身，用于列根）
  if (abs !== baseAbs && !abs.startsWith(baseWithSep)) {
    return { ok: false, code: 403, error: '路径越界' };
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
