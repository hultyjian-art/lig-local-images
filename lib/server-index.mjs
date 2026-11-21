/**
 * lig-local-images - 后端侧持久化图片索引（第103次，彻底版）
 *
 * 为什么放在后端：真机诊断(2026-11-21 22:02)证明，前端逐个 /tree 让后端 4 个目录吃掉 838MB 原生内存被 OOM 杀。
 * 前端侧所有优化（并发/串行/极简/本地索引）都无效——读大目录那一下的重活必须搬到后端，用低内存方式做。
 *
 * 设计四道保险：
 *  1. 低内存分批：一个目录用 readdir 流式读，一次只处理 BATCH 个文件就落盘，绝不在内存攒整目录。
 *  2. 保护线：每批前看 rss——过软线放慢、过硬线存进度后刹车返回，不硬撑到被系统杀。
 *  3. 断点续跑：lastKey + doneKeys 落盘，重启/刹车后接着建，已建的不重做。
 *  4. 防死循环 + 不静默：单目录失败超 MAX_FAILS 就记入 deferred（带文件夹名+原因），弹窗与日志专栏可见，
 *     先建别的；deferred 直到该目录索引成功或被删才消除。
 */
import fs from 'node:fs';
import path from 'node:path';

const INDEX_FILE = 'lig-local-images.index.json';
const BATCH = 40;                 // 每批处理文件数：小到单目录峰值内存可控
const SOFT_RSS_MB = 700;          // 软线：超过则每批之间多歇
const HARD_RSS_MB = 1100;         // 硬线：超过则刹车，本轮不再扫
const SOFT_SLEEP_MS = 1200;       // 软线时的批间等待
const NORMAL_SLEEP_MS = 60;       // 正常批间等待（仍让出事件循环）
const MAX_FAILS = 3;              // 单目录失败几次后转入 deferred
const MAX_FILES_PER_DIR = 4000;   // 单目录文件上限：超过只取前 N 个并记提示，防超大目录

function indexPath(userDirectories) {
  return path.join(userDirectories.root, INDEX_FILE);
}

function emptyState() {
  return { v: 1, dirs: {}, queue: [], lastKey: '', fails: {}, deferred: [], updatedAt: 0 };
}

export function loadIndex(userDirectories) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(userDirectories), 'utf8'));
    if (data && data.v === 1 && data.dirs && typeof data.dirs === 'object') {
      return { ...emptyState(), ...data };
    }
  } catch { /* 坏文件 → 重建，绝不覆盖用户图片 */ }
  return emptyState();
}

export function saveIndex(userDirectories, state) {
  try {
    state.updatedAt = Date.now();
    const target = indexPath(userDirectories);
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) { console.error('[lig-index] 索引落盘失败:', e); }
}

export function rssMb() {
  try { return Math.round((process.memoryUsage().rss || 0) / 1048576); } catch { return -1; }
}

/** 入队：根+子目录，去重。dirRel 为空表示根目录本身。 */
export function enqueueDirs(state, rootId, dirs) {
  for (const d of dirs || []) {
    const key = rootId + '::' + d;
    if (state.dirs[key] || state.queue.includes(key)) continue;
    if (!state.queue.includes(key)) state.queue.push(key);
  }
}

export function startScan(state, rootId) {
  const key = rootId + '::';
  if (!state.dirs[key] && !state.queue.includes(key)) state.queue.unshift(key);
}

/**
 * 驱动一步：处理队列里的一个目录的一批。
 * 返回 { action:'batch'|'dir-done'|'wait'|'brake'|'empty'|'deferred', ... }，
 * 前端据此决定多久后再 tick。所有分支都不抛异常给业务。
 */
export function tick(state, userDirectories, scanOneBatch) {
  const rss = rssMb();
  if (rss >= HARD_RSS_MB) {
    saveIndex(userDirectories, state);
    return { action: 'brake', rss, reason: 'rss>=hard', deferMs: 5000 };
  }
  if (!state.queue.length) return { action: 'empty', rss };
  const key = state.queue[0];
  const [rootId, ...rest] = key.split('::');
  const dirRel = rest.join('::');
  try {
    const r = scanOneBatch(rootId, dirRel, state.dirs[key] || null, BATCH);
    if (r.done) {
      state.dirs[key] = { ...r.record, indexedAt: Date.now() };
      delete state.fails[key];
      const di = state.deferred.findIndex(x => x.key === key);
      if (di >= 0) state.deferred.splice(di, 1);   // 索引成功 → 消除 deferred
      state.queue.shift();
      state.lastKey = key;
      enqueueDirs(state, rootId, r.record.subdirs);
      saveIndex(userDirectories, state);
      return { action: 'dir-done', rss, key, name: r.record.label || dirRel || '(根)', images: r.record.images?.length || 0 };
    }
    state.dirs[key] = r.record;
    saveIndex(userDirectories, state);
    return { action: 'batch', rss, key, deferMs: rss >= SOFT_RSS_MB ? SOFT_SLEEP_MS : NORMAL_SLEEP_MS };
  } catch (e) {
    const n = (state.fails[key] || 0) + 1;
    state.fails[key] = n;
    if (n >= MAX_FAILS) {
      const label = dirRel || '(根)';
      if (!state.deferred.some(x => x.key === key)) {
        state.deferred.push({ key, label, rootId, reason: String(e?.message || e).slice(0, 160), at: Date.now(), tries: n });
      }
      state.queue.shift();
      saveIndex(userDirectories, state);
      return { action: 'deferred', rss, key, label, reason: String(e?.message || e).slice(0, 160) };
    }
    saveIndex(userDirectories, state);
    return { action: 'batch', rss, key, deferMs: SOFT_SLEEP_MS, warn: String(e?.message || e).slice(0, 160) };
  }
}

/** 抽图读取：展平成 [{source,rootId,dirRel,label,images}] */
export function queryIndex(state, source) {
  const out = [];
  for (const [key, rec] of Object.entries(state.dirs || {})) {
    if (source && rec.source !== source) continue;
    out.push({ key, source: rec.source, rootId: rec.rootId, dirRel: rec.dirRel, label: rec.label || rec.dirRel, images: rec.images || [], indexedAt: rec.indexedAt || 0 });
  }
  return out;
}

/** 标脏：删掉该目录记录并重新入队 */
export function markDirty(state, rootId, dirRel) {
  const key = rootId + '::' + (dirRel || '');
  delete state.dirs[key];
  delete state.fails[key];
  const di = state.deferred.findIndex(x => x.key === key);
  if (di >= 0) state.deferred.splice(di, 1);
  if (!state.queue.includes(key)) state.queue.unshift(key);
}

/** 手动重试某个 deferred */
export function retryDeferred(state, key) {
  const di = state.deferred.findIndex(x => x.key === key);
  if (di >= 0) state.deferred.splice(di, 1);
  delete state.fails[key];
  if (!state.queue.includes(key)) state.queue.unshift(key);
}

/** 进度摘要 */
export function statusOf(state) {
  return {
    dirs: Object.keys(state.dirs || {}).length,
    images: Object.values(state.dirs || {}).reduce((n, r) => n + (r.images?.length || 0), 0),
    pending: (state.queue || []).length,
    lastKey: state.lastKey || '',
    deferred: (state.deferred || []).slice(),
    updatedAt: state.updatedAt || 0,
    rss: rssMb(),
  };
}
