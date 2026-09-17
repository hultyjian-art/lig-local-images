/**
 * lig-local-images - 本地图片图床后端插件
 *
 * 两大能力：
 * 1. 只读外部根图床：注册服务器可读范围内的任意目录，树形浏览 + 直插显示（免导入）。
 * 2. user/images 嵌套管理：为前端提供真嵌套的 mkdir / upload / rename / delete / move，
 *    弥补 Luker 内置 /api/images/* 端点 sanitize 掉 '/' 导致无法嵌套的限制（手机端尤其需要）。
 *
 * 安全模型：
 * - 读：只允许已注册根 + 内置 library 根；扩展名白名单；resolveUnder 防穿越。
 * - 写：只允许 user/images 之下；cleanRel 去掉 .. 段；拒绝覆盖已存在的目标。
 * - 每用户隔离：白名单存在该用户 data 目录下。
 */

import fs from 'node:fs';
import path from 'node:path';

import { cleanRel, isImage, probeReadableDir, resolveUnder } from './lib/guard.mjs';
import { loadRoots, newRootId, saveRoots } from './lib/store.mjs';

export const info = {
  id: 'lig-local-images',
  name: '本地图片图床后端',
  description: '任意目录只读图床 + user/images 嵌套文件夹管理（本地图片注入脚本配套插件）',
};

const API_VERSION = 1;
const LIBRARY_ROOT_ID = 'library';

/** 取当前用户的 user/images 绝对路径 (Luker 的 DATA_ROOT 可能是相对路径, 必须 resolve) */
function userImages(req) {
  const p = req.user?.directories?.userImages ?? null;
  return p ? path.resolve(p) : null;
}

/** 统一错误包装 */
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error('[lig-local-images] 请求失败:', req.path, e);
      if (!res.headersSent) {
        res.status(500).json({ error: e?.message ?? String(e) });
      }
    }
  };
}

/** 单层扫描目录（懒加载友好）；meta 供前端区分"真空目录"与"条目读不了" */
function scanDir(abs, urlFor) {
  const dirs = [];
  const images = [];
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  let scanned = 0;
  let skipped = 0;
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    // 第49次: Android /storage 的 FUSE 挂载不填 d_type, Dirent.isDirectory()/isFile()
    // 双双返回 false, 图片既不进 dirs 也不进 images → 列表恒空。类型判定一律以
    // statSync 为准 (FUSE 下可靠); Dirent 仅做快速路径。
    const full = path.join(abs, ent.name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    if (!isDir && !isFile) {
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        // 第50次: statSync 也失败(Android 分区存储权限的典型信号)→ 计数上报,
        // 前端据此显示"条目读不了"而非误导性的"该目录为空"
        skipped++;
        continue;
      }
    }
    if (isDir) {
      dirs.push(ent.name);
    } else if (isFile && isImage(ent.name)) {
      let size = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = Math.floor(st.mtimeMs);
      } catch { /* 忽略单个文件的元数据失败 */ }
      images.push({ name: ent.name, size, mtime, url: urlFor(ent.name) });
    }
    scanned++;
  }
  dirs.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  images.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return { dirs, images, meta: { scanned, skipped } };
}

/** 解析 root 参数 → { baseAbs, id }；library 指向 user/images */
function resolveRootBase(req, rootId) {
  const images = userImages(req);
  if (!images) return null;
  if (!rootId || rootId === LIBRARY_ROOT_ID) {
    return { id: LIBRARY_ROOT_ID, baseAbs: images };
  }
  const root = loadRoots(req.user.directories).find(r => r.id === rootId);
  if (!root) return null;
  // 第47次: 注册时按原样存储, 手机端用户常带尾斜杠(如 /storage/emulated/0/AA/美化/),
  // 而 resolveUnder 里 path.resolve 会吃掉尾斜杠导致 baseAbs 与 abs 永不相等,
  // 误报"路径越界"。解析根时统一 path.resolve 归一化(去尾斜杠/解相对段)。
  return { id: root.id, baseAbs: path.resolve(root.path) };
}

/** 确保写路径位于 user/images 之下，返回 { ok, abs, cleaned } */
function resolveWritePath(req, rel) {
  const images = userImages(req);
  if (!images) return { ok: false, code: 500, error: '无法定位用户 images 目录' };
  const cleaned = cleanRel(rel);
  if (!cleaned) return { ok: false, code: 400, error: '路径不能为空' };
  const abs = path.resolve(images, cleaned);
  const baseWithSep = images.endsWith(path.sep) ? images : images + path.sep;
  if (!abs.startsWith(baseWithSep)) {
    return { ok: false, code: 403, error: '禁止写入 user/images 之外' };
  }
  return { ok: true, abs, cleaned };
}

/** 递归删除（仅限已通过 resolveWritePath 校验的路径） */
function removeRecursive(abs) {
  fs.rmSync(abs, { recursive: true, force: true });
}

export async function init(router) {
  // ⚠️ 所有路由注册必须在第一个 await 之前完成
  // 说明: Luker server-main.js 已全局挂载 bodyParser.json({limit:'500mb'})，
  // 插件无需也不能再 require express（插件目录下没有 express 依赖）。

  // ============ 探测 ============
  router.get('/ping', wrap(async (req, res) => {
    res.json({ ok: true, name: info.name, version: '1.0.4', api: API_VERSION });
  }));

  // ============ 只读图床：根管理 ============
  router.get('/roots', wrap(async (req, res) => {
    const images = userImages(req);
    const roots = [{ id: LIBRARY_ROOT_ID, label: '图库(user/images)', path: images ?? '', builtin: true }];
    for (const r of loadRoots(req.user.directories)) {
      roots.push({ id: r.id, label: r.label || r.path, path: r.path, addedAt: r.addedAt, builtin: false });
    }
    res.json({ roots });
  }));

  router.post('/roots/register', wrap(async (req, res) => {
    const absPath = String(req.body?.path ?? '').trim();
    if (!absPath) return res.status(400).json({ error: '路径不能为空' });
    if (!path.isAbsolute(absPath)) return res.status(400).json({ error: '必须是绝对路径' });
    const err = probeReadableDir(absPath);
    if (err) return res.status(400).json({ error: err });
    const roots = loadRoots(req.user.directories);
    // 第47次: 归一化后入库+比对——白名单里可能存着历史带尾斜杠的脏 path,
    // 命中复用时顺手回写归一化(自愈), 新注册也直接存归一化值, 从源头杜绝脏数据
    const normalized = path.resolve(absPath);
    const existing = roots.find(r => path.resolve(r.path) === normalized);
    if (existing) {
      if (existing.path !== normalized) {
        existing.path = normalized;
        saveRoots(req.user.directories, roots);
      }
      return res.json({ root: existing, imageCount: countImages(normalized) });
    }
    const root = {
      id: newRootId(),
      label: String(req.body?.label ?? '').trim() || path.basename(normalized),
      path: normalized,
      addedAt: Date.now(),
    };
    roots.push(root);
    saveRoots(req.user.directories, roots);
    res.json({ root, imageCount: countImages(normalized) });
  }));

  router.post('/roots/remove', wrap(async (req, res) => {
    const id = String(req.body?.id ?? '');
    if (!id || id === LIBRARY_ROOT_ID) return res.status(400).json({ error: '内置图库根不可移除' });
    const roots = loadRoots(req.user.directories);
    const next = roots.filter(r => r.id !== id);
    if (next.length === roots.length) return res.status(404).json({ error: '根不存在' });
    saveRoots(req.user.directories, next);
    res.json({ ok: true });
  }));

  // ============ 只读图床：浏览与供图 ============
  router.get('/tree', wrap(async (req, res) => {
    const rootRef = resolveRootBase(req, String(req.query?.root ?? ''));
    if (!rootRef) return res.status(404).json({ error: '根不存在' });
    const dirRel = cleanRel(String(req.query?.dir ?? ''));
    const r = resolveUnder(rootRef.baseAbs, dirRel);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    const err = probeReadableDir(r.abs);
    if (err) return res.status(404).json({ error: err });
    const { dirs, images, meta } = scanDir(r.abs, name => serveUrl(rootRef.id, dirRel, name));
    res.json({ dirs, images, meta });
  }));

  router.get('/file', wrap(async (req, res) => {
    const rootRef = resolveRootBase(req, String(req.query?.root ?? ''));
    if (!rootRef) return res.status(404).json({ error: '根不存在' });
    const r = resolveUnder(rootRef.baseAbs, String(req.query?.path ?? ''));
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    if (!isImage(r.abs)) return res.status(403).json({ error: '仅允许图片文件' });
    if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isFile()) return res.status(404).json({ error: '文件不存在' });
    res.sendFile(r.abs);
  }));

  // ============ user/images 嵌套管理 ============
  router.post('/mkdir', wrap(async (req, res) => {
    const p = resolveWritePath(req, String(req.body?.path ?? ''));
    if (!p.ok) return res.status(p.code).json({ error: p.error });
    fs.mkdirSync(p.abs, { recursive: true });
    res.json({ ok: true, path: p.cleaned });
  }));

  router.post('/upload', wrap(async (req, res) => {
    const dir = resolveWritePath(req, String(req.body?.path ?? ''));
    if (!dir.ok) return res.status(dir.code).json({ error: dir.error });
    const filename = cleanRel(String(req.body?.filename ?? ''));
    if (!filename || filename.includes('/')) return res.status(400).json({ error: '非法文件名' });
    if (!isImage(filename)) return res.status(403).json({ error: '仅允许图片文件' });
    const b64 = String(req.body?.base64 ?? '');
    if (!b64) return res.status(400).json({ error: '缺少图片数据' });
    const abs = path.join(dir.abs, filename);
    if (fs.existsSync(abs)) return res.status(409).json({ error: '目标文件已存在' });
    fs.mkdirSync(dir.abs, { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
    const st = fs.statSync(abs);
    res.json({ ok: true, path: `${dir.cleaned}/${filename}`, size: st.size });
  }));

  router.post('/rename', wrap(async (req, res) => {
    const from = resolveWritePath(req, String(req.body?.from ?? ''));
    if (!from.ok) return res.status(from.code).json({ error: from.error });
    const to = resolveWritePath(req, String(req.body?.to ?? ''));
    if (!to.ok) return res.status(to.code).json({ error: to.error });
    if (!fs.existsSync(from.abs)) return res.status(404).json({ error: '源不存在' });
    if (fs.existsSync(to.abs)) return res.status(409).json({ error: '目标已存在' });
    fs.mkdirSync(path.dirname(to.abs), { recursive: true });
    fs.renameSync(from.abs, to.abs);
    res.json({ ok: true, from: from.cleaned, to: to.cleaned });
  }));

  router.post('/delete', wrap(async (req, res) => {
    const p = resolveWritePath(req, String(req.body?.path ?? ''));
    if (!p.ok) return res.status(p.code).json({ error: p.error });
    if (!fs.existsSync(p.abs)) return res.status(404).json({ error: '目标不存在' });
    removeRecursive(p.abs);
    res.json({ ok: true, path: p.cleaned });
  }));

  router.post('/move', wrap(async (req, res) => {
    // 跨目录移动（文件或整个目录）；to 是完整目标路径（含新名）
    const from = resolveWritePath(req, String(req.body?.from ?? ''));
    if (!from.ok) return res.status(from.code).json({ error: from.error });
    const to = resolveWritePath(req, String(req.body?.to ?? ''));
    if (!to.ok) return res.status(to.code).json({ error: to.error });
    if (!fs.existsSync(from.abs)) return res.status(404).json({ error: '源不存在' });
    if (fs.existsSync(to.abs)) return res.status(409).json({ error: '目标已存在' });
    if (to.abs.startsWith(from.abs + path.sep)) return res.status(400).json({ error: '不能移动到自身内部' });
    fs.mkdirSync(path.dirname(to.abs), { recursive: true });
    fs.renameSync(from.abs, to.abs);
    res.json({ ok: true, from: from.cleaned, to: to.cleaned });
  }));

  // ============ 只读图床：按文件夹名在已注册根内搜索 ============
  // 用途: 图库对话框「选择文件夹」注册——浏览器 FSA 拿不到绝对路径, 只能拿到
  // 文件夹名; 由服务器在"已注册根"范围内限深搜索同名文件夹供用户点选注册。
  // 明确不做全盘扫描 (性能与隐私): 深度≤6、单根条目上限 2 万、总超时 8 秒、
  // 结果上限 50; 精确同名优先, 无精确命中时退回子串匹配。
  router.get('/folders', wrap(async (req, res) => {
    const name = String(req.query?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name 不能为空' });
    const lower = name.toLowerCase();
    const MAX_DEPTH = 6;
    const ROOT_SCAN_LIMIT = 20000;
    const TOTAL_LIMIT = 50;
    const deadline = Date.now() + 8000;

    const images = userImages(req);
    /** 全部可搜索根: 内置 library + 外置注册根, 按注册先后排序 */
    const roots = [];
    if (images) roots.push({ id: LIBRARY_ROOT_ID, label: '图库(user/images)', baseAbs: images, addedAt: 0 });
    for (const r of loadRoots(req.user.directories)) {
      roots.push({ id: r.id, label: r.label || r.path, baseAbs: path.resolve(r.path), addedAt: r.addedAt ?? 0 });
    }
    roots.sort((a, b) => a.addedAt - b.addedAt);

    const exact = [];
    const partial = [];
    let truncated = false;
    const pushHit = (arr, root, rel, abs, dirName) => {
      if (arr.length >= TOTAL_LIMIT) { truncated = true; return; }
      arr.push({ rootId: root.id, rootLabel: root.label, rel, abs, name: dirName });
    };

    for (const root of roots) {
      if (exact.length >= TOTAL_LIMIT || Date.now() > deadline) { truncated = true; break; }
      let scanned = 0;
      /** 广度优先: 浅层命中优先返回 */
      const queue = [{ abs: root.baseAbs, rel: '', depth: 0 }];
      while (queue.length && scanned < ROOT_SCAN_LIMIT) {
        const { abs, rel, depth } = queue.shift();
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          // 第49次: FUSE 下 isDirectory() 可能恒 false, statSync 兜底
          if (ent.name.startsWith('.')) continue;
          if (!ent.isDirectory()) {
            if (ent.isFile()) continue;
            try { if (!fs.statSync(path.join(abs, ent.name)).isDirectory()) continue; } catch { continue; }
          }
          scanned++;
          if (scanned >= ROOT_SCAN_LIMIT) { truncated = true; break; }
          const childRel = rel ? `${rel}/${ent.name}` : ent.name;
          const childAbs = path.join(abs, ent.name);
          const nameLower = ent.name.toLowerCase();
          if (nameLower === lower) pushHit(exact, root, childRel, childAbs, ent.name);
          else if (nameLower.includes(lower)) pushHit(partial, root, childRel, childAbs, ent.name);
          if (depth + 1 < MAX_DEPTH) queue.push({ abs: childAbs, rel: childRel, depth: depth + 1 });
          if (exact.length >= TOTAL_LIMIT) break;
        }
        if (Date.now() > deadline) { truncated = true; break; }
      }
    }
    const folders = exact.length ? exact : partial;
    res.json({ folders, truncated });
  }));
}

/** 统计目录（含子目录一层）内图片数量，用于注册反馈 */
function countImages(absDir) {
  let count = 0;
  // 第49次: 同 scanDir, 类型判定 statSync 兜底 (Android FUSE d_type 不可靠)
  const isDirEnt = (ent, full) => {
    if (ent.isDirectory()) return true;
    if (ent.isFile()) return false;
    try { return fs.statSync(full).isDirectory(); } catch { return false; }
  };
  const isFileEnt = (ent, full) => {
    if (ent.isFile()) return true;
    if (ent.isDirectory()) return false;
    try { return fs.statSync(full).isFile(); } catch { return false; }
  };
  try {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const full = path.join(absDir, ent.name);
      if (isFileEnt(ent, full) && isImage(ent.name)) count++;
      else if (isDirEnt(ent, full)) {
        try {
          for (const sub of fs.readdirSync(full)) {
            if (isImage(sub)) count++;
          }
        } catch { /* 子目录不可读则跳过 */ }
      }
    }
  } catch { /* 不可读返回 0 */ }
  return count;
}

/**
 * 浏览结果的图片 URL：
 * - library 根 → Luker 静态路由 /user/images/<rel>（天然支持嵌套与中文）
 * - 外部根 → 插件 /file 端点
 */
function serveUrl(rootId, dirRel, name) {
  const rel = dirRel ? `${dirRel}/${name}` : name;
  if (rootId === LIBRARY_ROOT_ID) {
    return `/user/images/${rel.split('/').map(encodeURIComponent).join('/')}`;
  }
  return `/api/plugins/${info.id}/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(rel)}`;
}

export async function exit() {
  // 无持久资源需要清理
}
