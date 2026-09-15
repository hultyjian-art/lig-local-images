/**
 * lig-local-images - 外部根白名单存储（按用户隔离，原子写）
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOTS_FILE = 'lig-local-images.roots.json';

function rootsPath(userDirectories) {
  return path.join(userDirectories.root, ROOTS_FILE);
}

/** 读取外部根列表（不含内置 library） */
export function loadRoots(userDirectories) {
  try {
    const raw = fs.readFileSync(rootsPath(userDirectories), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(r => r && typeof r.id === 'string' && typeof r.path === 'string');
  } catch {
    return [];
  }
}

/** 原子写回 */
export function saveRoots(userDirectories, roots) {
  const target = rootsPath(userDirectories);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(roots, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

export function newRootId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
