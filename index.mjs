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
 * - v1.0.5 破坏性操作再收紧：delete / rename / move 的目标必须至少两段，
 *   即必须位于 user/images 的**某个子目录内**。该目录根层由酒馆自身使用
 *   （实测有数十个以角色卡名命名的目录），绝不允许本插件直接操作。
 *   前端 services/galleryScope.ts 有同规则的第一层防线（双保险）。
 * - 每用户隔离：白名单存在该用户 data 目录下。
 * - v1.0.7 放宽 jpeg-js 解码内存上限（512MB → 4096MB），修复大图缩略图全部回退原图。
 * - v1.1.1 回退原图也带原因 + 文件名（redirectReasons / recent），用于定位
 *   "缩略图为什么没生成"：badPath / notImage / missing / tooSmall（原图本就更小，
 *   属正常）/ queueFull（队列积压）/ decodeFailed / noJimp。
 * - v1.1.0 新增缩略图格式统计：/ping 返回 thumb:{webp,jpeg,redirectedToOriginal,errors,recent}，
 *   /ping?reset=1 可清零，/diag 同样带 —— 用于确认 WebP 是否真的生效（长按保存图片拿到的是
 *   原图，不能用来判断缩略图格式）。未改动缩略图管道本身，故 THUMB_URL_VERSION 不变。
 * - v1.0.9 /thumb 支持 WebP 输出：按请求 Accept 协商（浏览器 <img> 自动带 image/webp），
 *   体积比 JPEG 小 39~46%、编码耗时持平（实测 49KB→30KB / 40ms→38ms）。编码器为
 *   vendored libwebp wasm（lib/webp/，281KB），本地 readFileSync + 手动实例化，
 *   零网络依赖，Luker 与原版 ST 行为一致；编码失败自动退回 JPEG。缓存键含格式，
 *   响应带 Vary: Accept。?webp=0 可强制 JPEG。
 * - v1.0.8 缩略图解码移入 worker 线程 + 队列上限 32：jimp 的同步解码会占满事件循环
 *   （实测单张 2.1 秒），导致 /roots /tree 被阻塞、前端 30 秒超时（signal is aborted
 *   without reason）。现在主线程不再被解码阻塞；队列积压时直接回退原图。
 * - v1.0.6 新增只读 /diag：把 user/images 与各注册根的路径归属、exists/stat/access/readdir
 *   各层结果、逐条 stat 样本全列出来，用于现场判定"目录有内容却显示为空"到底是
 *   路径错、权限被静默过滤、还是真的空。无副作用，不写盘。
 */

import fs from 'node:fs';
import path from 'node:path';

import { Worker } from 'node:worker_threads';
import { cleanRel, isImage, probeReadableDir, requireBelowImagesRoot, resolveUnder } from './lib/guard.mjs';
import { decodeThumb, loadJimp } from './lib/thumb-core.mjs';
import { loadRoots, newRootId, saveRoots } from './lib/store.mjs';

export const info = {
  id: 'lig-local-images',
  name: '本地图片图床后端',
  description: '任意目录只读图床 + user/images 嵌套文件夹管理（本地图片注入脚本配套插件）',
};

const API_VERSION = 1;
const LIBRARY_ROOT_ID = 'library';
/** 插件版本（唯一来源：/ping 与 /diag 都读它，避免两处不一致） */
const PLUGIN_VERSION = '1.1.1';

/**
 * 缩略图 URL 的版本号（第62次新增，跟随 WebP 协商一起发布）。
 *
 * 为什么需要它：/thumb 的响应带 `Cache-Control: public, max-age=86400`，浏览器会
 * 把旧响应缓存一整天。新增 WebP 协商后，同一个 URL 的新旧响应内容不同
 * （旧=jpeg、新=webp），而**旧缓存条目没有 Vary 头**，浏览器仍会按 URL 命中它 ——
 * 表现就是"重启后 webp 好像没生效"。
 * 递增此版本号即生成全新 URL，直接绕过所有旧缓存条目。
 *
 * ⚠️ 只在"缩略图管道语义变了、必须让客户端重新拉取"时递增，别当成普通构建号用。
 */
const THUMB_URL_VERSION = 2;

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
function scanDir(abs, urlFor, thumbFor) {
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
      images.push({ name: ent.name, size, mtime, url: urlFor(ent.name), thumb: thumbFor ? thumbFor(ent.name) : undefined });
    }
    scanned++;
  }
  dirs.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  images.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return { dirs, images, meta: { scanned, skipped } };
}

/** 错误短格式（带 errno code，便于一眼看出 EACCES / ENOENT） */
function fmtErr(e) {
  if (!e) return String(e);
  return e.code ? `${e.code}: ${e.message}` : String(e.message ?? e);
}

/**
 * 判断一个绝对路径处在哪种存储区，据此推断 Node 进程能否直接读。
 * 这是"目录有内容却显示为空"最决定性的线索：Android 分区存储下，
 * App 对无权限的目录 readdir 往往【静默返回空数组】而不是报 EACCES，
 * 于是"真的空"与"被系统过滤"在结果上一模一样。
 */
function describeStorageScope(abs) {
  if (!abs) return '未知（路径为空）';
  if (/^\/data\/(user|data)\/\d+\//.test(abs)) return 'App 私有内部存储 · 不受分区存储限制，必然可读';
  if (/\/Android\/data\/[^/]+\/files(\/|$)/.test(abs)) return 'App 专属外部存储 · 不受分区存储限制，必然可读';
  if (/^\/storage\/emulated\/\d+\//.test(abs)) return '公共外部存储 · 受 Android 分区存储限制，App 无权直读（readdir 通常返回空而不报错）';
  if (/^\/storage\//.test(abs)) return '外部挂载卷 · 受分区存储限制';
  if (/^[A-Za-z]:[\\/]/.test(abs)) return 'Windows 盘符路径 · 无 Android 限制';
  return '其它';
}

/** 把一个路径逐层探一遍（只读、无副作用；任何一步失败都记录而非抛出） */
function auditDir(abs, opts = {}) {
  const out = { abs: abs ?? null };
  if (!abs) {
    out.scope = describeStorageScope(null);
    out.note = '路径为空 —— 上游（req.user.directories.userImages）没取到值';
    return out;
  }
  out.scope = describeStorageScope(abs);
  try {
    out.exists = fs.existsSync(abs);
  } catch (e) {
    out.existsErr = fmtErr(e);
  }
  if (!out.exists) {
    out.note = '路径不存在';
    return out;
  }
  try {
    out.isDirectory = fs.statSync(abs).isDirectory();
  } catch (e) {
    out.statErr = fmtErr(e);
  }
  try {
    fs.accessSync(abs, fs.constants.R_OK | fs.constants.X_OK);
    out.access = 'ok';
  } catch (e) {
    out.access = 'denied';
    out.accessErr = fmtErr(e);
  }
  try {
    const raw = fs.readdirSync(abs);
    out.readdirCount = raw.length;
    out.readdirSample = raw.slice(0, opts.sampleLimit ?? 15);
    const limit = Math.min(raw.length, 20);
    let statOk = 0;
    let statFail = 0;
    let dirs = 0;
    let files = 0;
    let firstFail = null;
    for (let i = 0; i < limit; i++) {
      try {
        const st = fs.statSync(path.join(abs, raw[i]));
        statOk++;
        if (st.isDirectory()) dirs++;
        else files++;
      } catch (e) {
        statFail++;
        if (!firstFail) firstFail = `${raw[i]} → ${fmtErr(e)}`;
      }
    }
    out.statProbe = { tried: limit, statOk, statFail, dirs, files, firstFail };
    if (!raw.length) {
      out.note = /分区存储/.test(out.scope)
        ? 'readdir 返回 0 条。上方 scope 是"公共外部存储"→ 这是被分区存储【静默过滤】的典型表现（不报错、直接空），不是目录真的空。'
        : 'readdir 返回 0 条，且路径不在受限存储区 → 目录确实为空，或酒馆尚未在这个用户下写入过图片。';
    }
  } catch (e) {
    out.readdirErr = fmtErr(e);
    out.note = 'readdir 抛错 → 属于权限/路径问题，错误码见 readdirErr';
  }
  return out;
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
    // ?reset=1 清零缩略图统计 —— 方便"清缓存 → 浏览图库 → 再看计数"的自查流程
    if (/^(1|true|yes|on)$/i.test(String(req.query?.reset ?? ''))) resetThumbStats();
    res.json({ ok: true, name: info.name, version: PLUGIN_VERSION, api: API_VERSION, thumb: thumbStatsSnapshot() });
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

  // ============ 诊断（只读、无副作用） ============
  /**
   * v1.0.6: 现场诊断"目录里明明有内容，图库却显示为空"。
   * 输出路径归属（私有/专属外部/公共外部）、exists/stat/access/readdir 各层结果、
   * 前若干条的逐条 stat，并以 userImages 的父目录（user/）作对照：
   * 若 user/ 能列出 characters/chats/images 等，说明进程对数据区有读权限，
   * 那 images 的"空"就是它自身的问题；若连 user/ 也读不出，则是整体权限或路径错。
   */
  router.get('/diag', wrap(async (req, res) => {
    const images = userImages(req);
    res.json({
      thumb: thumbStatsSnapshot(),
      ok: true,
      version: PLUGIN_VERSION,
      api: API_VERSION,
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cwd: process.cwd(),
        pid: process.pid,
      },
      user: {
        name: req.user?.name ?? null,
        directories: req.user?.directories ?? null,
      },
      library: auditDir(images, { sampleLimit: 20 }),
      userDir: auditDir(images ? path.dirname(images) : null, { sampleLimit: 30 }),
      registeredRoots: loadRoots(req.user.directories).map(r => ({
        id: r.id,
        label: r.label,
        ...auditDir(r.path, { sampleLimit: 10 }),
      })),
    });
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
    const { dirs, images, meta } = scanDir(
      r.abs,
      name => serveUrl(rootRef.id, dirRel, name),
      name => serveThumbUrl(rootRef.id, dirRel, name),
    );
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

  // ============ 缩略图（v1.0.6） ============
  // 图库原先直出原图：实测一张 2134×3200 的 jpg 有 773KB，一页 50 张就近 40MB。
  // 这里按需缩放成小图（宽 240 约 25KB，降幅 96.8%），并做内存 LRU 缓存。
  // 关键：jimp 只是「尽力而为」——加载或缩放失败一律 302 回退到原图，
  // 保证图片始终能显示（不会因为缺依赖把功能弄坏）。
  const THUMB_WIDTH = { min: 64, max: 640, def: 320 };

  /** 缩略图内存缓存（Map 按插入序，超上限逐出最早的） */
  const thumbCache = new Map();
  const THUMB_CACHE_MAX = 300;

  /**
   * 缩略图格式统计（第63次新增，v1.1.0）。
   *
   * 解决什么问题：WebP 是按请求 Accept 协商输出的，用户在图库上"看起来一样"，
   * 无法判断 webp 到底有没有生效；而"长按保存图片"拿到的一般是原图（插入/下载走
   * httpUrl 原图，只有网格 <img src> 才指向 /thumb），更容易误判。
   * 这里把**实际编码结果**累计下来，通过 /ping 与 /diag 暴露出去。
   *
   * 自查流程：先访问 /ping?reset=1 清零 → 在图库浏览几页 → 再访问 /ping 看
   * thumb.webp / thumb.jpeg 的计数；webp>0 且 jpeg=0 即为完全生效。
   */
  const thumbStats = { webp: 0, jpeg: 0, redirected: 0, errors: 0, last: [], reasons: {} };

  function pushRecent(text) {
    thumbStats.last.push(text);
    if (thumbStats.last.length > 12) thumbStats.last.shift();
  }

  function noteThumb(mime, width, name) {
    if (mime === 'image/webp') thumbStats.webp++;
    else thumbStats.jpeg++;
    pushRecent(`${shortName(name)}→${mime === 'image/webp' ? 'webp' : 'jpeg'}@${width}`);
  }

  /**
   * 记录一次"回退原图"并带上原因 —— 这是排查"缩略图为什么没生成"的关键。
   * 原因取值：
   *   badPath        路径非法/越界
   *   notImage       扩展名不是图片
   *   missing        文件不存在或不是文件
   *   tooSmall       原图宽度 ≤ 请求宽度（本就不需要缩略图，属正常）
   *   queueFull      等待队列积压（超过 THUMB_QUEUE_MAX，主动放弃以免拖死）
   *   decodeFailed   解码/编码抛错（jimp 不可用、大图内存、文件损坏…）
   *   noJimp         jimp 加载失败
   */
  function noteRedirect(reason, name) {
    thumbStats.redirected++;
    thumbStats.reasons[reason] = (thumbStats.reasons[reason] || 0) + 1;
    pushRecent(`${shortName(name)}→${reason}`);
  }

  function shortName(n) {
    const b = String(n || '?');
    return b.length > 22 ? '…' + b.slice(-21) : b;
  }

  function thumbStatsSnapshot() {
    return {
      webp: thumbStats.webp,
      jpeg: thumbStats.jpeg,
      redirectedToOriginal: thumbStats.redirected,
      redirectReasons: { ...thumbStats.reasons },
      errors: thumbStats.errors,
      recent: thumbStats.last.slice(),
    };
  }

  function resetThumbStats() {
    thumbStats.webp = 0;
    thumbStats.jpeg = 0;
    thumbStats.redirected = 0;
    thumbStats.errors = 0;
    thumbStats.last.length = 0;
    thumbStats.reasons = {};
  }

  /**
   * ===== 第60次：缩略图解码移入 worker 线程 =====
   *
   * 背景（实测）：jimp 0.22 的解码/缩放/编码都是同步 CPU 操作，6.2MB 大图单张约 2.1 秒；
   * 期间整个 Node 事件循环被占满，/roots /tree 一并被卡住 2 秒。一页几十上百张图时会
   * 累计成数十秒阻塞，前端请求因此 30 秒超时（signal is aborted without reason）。
   *
   * 现方案：解码交给 1 个常驻 worker 串行处理，主线程只做缓存与文件发送；
   * 等待队列超过 THUMB_QUEUE_MAX 时直接 302 回退原图（宁可显原图，也不无限排队）。
   * worker 不可用（环境受限）时回退为主线程串行解码（保持可用，性能退回旧行为）。
   */
  const THUMB_QUEUE_MAX = 32;
  let thumbWorker = null;
  let workerBroken = false;
  let workerBusy = false;
  let taskSeq = 0;
  const pendingTasks = new Map(); // id -> { resolve, reject }
  const taskQueue = [];           // 待投递任务 { id, abs, width }
  let fallbackQueue = 0;          // 主线程回退路径的排队数

  function startThumbWorker() {
    if (thumbWorker || workerBroken) return thumbWorker;
    try {
      thumbWorker = new Worker(new URL('./lib/thumb-worker.mjs', import.meta.url));
      thumbWorker.on('message', (msg) => {
        const task = pendingTasks.get(msg?.id);
        workerBusy = false;
        if (task) {
          pendingTasks.delete(msg.id);
          if (msg.ok) {
            task.resolve(msg.buf ? { buf: Buffer.from(msg.buf), mime: msg.mime || 'image/jpeg' } : { reason: msg.reason || 'tooSmall' });
          }
          else task.reject(new Error(msg.error || 'worker 解码失败'));
        }
        drainThumbQueue();
      });
      thumbWorker.on('error', (e) => {
        workerBroken = true;
        thumbWorker = null;
        workerBusy = false;
        console.warn('[lig-local-images] 缩略图 worker 异常，改用主线程解码:', fmtErr(e));
        for (const [, task] of pendingTasks) task.reject(e);
        pendingTasks.clear();
        drainThumbQueue();
      });
      thumbWorker.on('exit', () => {
        thumbWorker = null;
        workerBusy = false;
        drainThumbQueue();
      });
    } catch (e) {
      workerBroken = true;
      console.warn('[lig-local-images] 缩略图 worker 不可用，改用主线程解码:', fmtErr(e));
    }
    return thumbWorker;
  }

  function drainThumbQueue() {
    if (workerBroken) return;
    const worker = startThumbWorker();
    if (!worker || workerBusy) return;
    const task = taskQueue.shift();
    if (!task) return;
    workerBusy = true;
    worker.postMessage(task);
  }

  /** 主线程回退路径（worker 不可用时）：串行解码，队列超限同样直接放弃 */
  let mainChain = Promise.resolve();
  async function decodeThumbOnMainThread(abs, width, format) {
    if (fallbackQueue >= THUMB_QUEUE_MAX) return { reason: 'queueFull' };
    fallbackQueue++;
    const run = mainChain.then(() => decodeThumb(abs, width, undefined, format), () => decodeThumb(abs, width, undefined, format));
    mainChain = run.then(() => {}, () => {});
    try {
      const r = await run;
      return r || { reason: 'tooSmall' };
    } finally {
      fallbackQueue--;
    }
  }

  /**
   * 生成缩略图（worker 优先，超队列直接放弃）
   * @param format 'jpeg' | 'webp'
   * @returns {{ buf: Buffer, mime: string } | null} —— null 表示"应回退原图"（原图已够小 / 队列积压 / 解码失败）
   */
  async function generateThumb(abs, width, format) {
    if (workerBroken) {
      try {
        return await decodeThumbOnMainThread(abs, width, format);
      } catch (e) {
        console.warn('[lig-local-images] 主线程生成缩略图失败，回退原图:', fmtErr(e));
        return { reason: 'decodeFailed' };
      }
    }
    if (taskQueue.length + (workerBusy ? 1 : 0) >= THUMB_QUEUE_MAX) return { reason: 'queueFull' };
    return new Promise((resolve) => {
      const id = ++taskSeq;
      pendingTasks.set(id, {
        resolve: (out) => resolve(out),
        reject: (e) => {
          console.warn('[lig-local-images] 生成缩略图失败，回退原图:', fmtErr(e));
          resolve({ reason: 'decodeFailed' });
        },
      });
      taskQueue.push({ id, abs, width, format });
      drainThumbQueue();
    });
  }

  /** 原图 URL（回退用）：直接复用 serveUrl，避免两处格式不一致 */
  function fileUrlFor(rootId, relPath) {
    const segs = String(relPath).split('/').filter(Boolean);
    const name = segs.pop() ?? '';
    return serveUrl(rootId, segs.join('/'), name);
  }

  router.get('/thumb', wrap(async (req, res) => {
    const rootRef = resolveRootBase(req, String(req.query?.root ?? ''));
    if (!rootRef) return res.status(404).json({ error: '根不存在' });
    const relPath = String(req.query?.path ?? '');
    const fallback = fileUrlFor(rootRef.id, relPath);
    const r = resolveUnder(rootRef.baseAbs, relPath);
    if (!r.ok) {
      noteRedirect('badPath', relPath);
      return res.redirect(302, fallback);
    }
    if (!isImage(r.abs)) {
      noteRedirect('notImage', relPath);
      return res.redirect(302, fallback);
    }
    try {
      if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isFile()) {
        noteRedirect('missing', relPath);
        return res.redirect(302, fallback);
      }
    } catch {
      noteRedirect('missing', relPath);
      return res.redirect(302, fallback);
    }

    const asked = Number(req.query?.w ?? THUMB_WIDTH.def);
    const width = Number.isFinite(asked)
      ? Math.min(THUMB_WIDTH.max, Math.max(THUMB_WIDTH.min, Math.round(asked)))
      : THUMB_WIDTH.def;

    // 第62次: 按客户端 Accept 协商缩略图格式（浏览器 <img> 会自动带上 image/webp）。
    // ?webp=0 可强制退回 JPEG，便于排查；无请求头（如 curl）默认 JPEG。
    const wantsWebp =
      !/^(0|false|no|off)$/i.test(String(req.query?.webp ?? '')) &&
      /image\/webp/i.test(String(req.headers?.accept ?? ''));
    const format = wantsWebp ? 'webp' : 'jpeg';

    // 缓存键必须带格式 —— 否则 webp 与 jpeg 会互相串
    const cacheKey = `${r.abs}|${width}|${format}`;
    const hit = thumbCache.get(cacheKey);
    if (hit) {
      res.type(hit.mime).set('Cache-Control', 'public, max-age=86400').set('Vary', 'Accept').send(hit.buf);
      return;
    }

    // jimp 不可用则直接回退原图（不阻塞、不报错）
    if (!(await loadJimp())) {
      noteRedirect('noJimp', relPath);
      return res.redirect(302, fallback);
    }

    try {
      const out = await generateThumb(r.abs, width, format);
      if (!out.buf) {
        noteRedirect(out.reason || 'unknown', relPath);
        return res.redirect(302, fallback);
      }
      if (thumbCache.size >= THUMB_CACHE_MAX) {
        thumbCache.delete(thumbCache.keys().next().value);
      }
      thumbCache.set(cacheKey, out);
      noteThumb(out.mime, width, relPath);
      // ⚠️ Vary: Accept 必须带上 —— 否则中间缓存可能把 webp 响应喂给不支持 webp 的客户端。
      // 响应格式以 out.mime 为准（webp 编码失败时会退回 jpeg）。
      res.type(out.mime).set('Cache-Control', 'public, max-age=86400').set('Vary', 'Accept').send(out.buf);
    } catch (e) {
      thumbStats.errors++;
      noteRedirect('decodeFailed', relPath);
      console.warn('[lig-local-images] 生成缩略图失败，回退原图:', fmtErr(e));
      res.redirect(302, fallback);
    }
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
    // v1.0.5: 破坏性操作不得作用于 user/images 根层（保护酒馆自身数据）
    for (const p of [from, to]) {
      const depth = requireBelowImagesRoot(p.cleaned);
      if (!depth.ok) return res.status(depth.code).json({ error: depth.error });
    }
    if (!fs.existsSync(from.abs)) return res.status(404).json({ error: '源不存在' });
    if (fs.existsSync(to.abs)) return res.status(409).json({ error: '目标已存在' });
    fs.mkdirSync(path.dirname(to.abs), { recursive: true });
    fs.renameSync(from.abs, to.abs);
    res.json({ ok: true, from: from.cleaned, to: to.cleaned });
  }));

  router.post('/delete', wrap(async (req, res) => {
    const p = resolveWritePath(req, String(req.body?.path ?? ''));
    if (!p.ok) return res.status(p.code).json({ error: p.error });
    // v1.0.5: 破坏性操作不得作用于 user/images 根层（保护酒馆自身数据）
    const depth = requireBelowImagesRoot(p.cleaned);
    if (!depth.ok) return res.status(depth.code).json({ error: depth.error });
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
    // v1.0.5: 破坏性操作不得作用于 user/images 根层（保护酒馆自身数据）
    for (const p of [from, to]) {
      const depth = requireBelowImagesRoot(p.cleaned);
      if (!depth.ok) return res.status(depth.code).json({ error: depth.error });
    }
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

/**
 * 缩略图 URL（v1.0.6）。
 * 一律走插件自己的 /thumb —— 内置 library 根不能用 serveUrl 的 /user/images 直接缩放，
 * 而 /thumb 两端都能统一处理。宽度固定传 320：网格单元约 96~140px，2x 屏也够清晰。
 */
function serveThumbUrl(rootId, dirRel, name, width = 320) {
  const rel = dirRel ? `${dirRel}/${name}` : name;
  return `/api/plugins/${info.id}/thumb?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(rel)}&w=${width}&v=${THUMB_URL_VERSION}`;
}

export async function exit() {
  // 无持久资源需要清理
}
