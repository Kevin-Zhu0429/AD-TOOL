/**
 * 表单草稿:开广告的两个页面在浏览器本地存一份,切页面 / 刷新 / 关标签页都不丢。
 *
 * 只存在本机 localStorage 里,不上传服务器 —— 和广告优化页解析批量表一个口径。
 * 按「页面 + 站点」分开存,切站点是另一份草稿,互不覆盖。
 */

const PREFIX = 'adtool.draft.';
const VERSION = 1;

export function draftKey(page, market) {
  return `${PREFIX}v${VERSION}.${page}.${String(market ?? '').toUpperCase()}`;
}

export function readDraft(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;                                   // 存的内容坏了就当没有草稿
  }
}

export function writeDraft(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;                                  // 隐私模式 / 配额满了都别把页面搞崩
  }
}

export function dropDraft(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 同上,删不掉也无所谓 */
  }
}

/**
 * 存过的任务 + 当前版本的默认任务合并。
 * 老草稿缺的新字段用默认值补上,类型对不上的一律以默认值为准,
 * 这样以后加字段不会让别人存着的草稿把页面打崩。
 */
export function mergeTask(base, saved) {
  if (!saved || typeof saved !== 'object') return null;
  const out = { ...base };
  for (const k of Object.keys(base)) {
    const b = base[k];
    const v = saved[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(b)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (b && typeof b === 'object') {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...b, ...v };
    } else if (typeof v !== 'object') {
      out[k] = v;
    }
  }
  if (typeof saved.id === 'string' && saved.id) out.id = saved.id;
  return out;
}

/**
 * 只有一个任务、而且一个字都没改过 = 干净的空表单,没必要存草稿。
 * (不存的话下次进来也就不会显示「草稿已恢复」)
 */
export function isPristine(tasks, makeTask) {
  if (!Array.isArray(tasks) || tasks.length !== 1) return false;
  const a = JSON.stringify({ ...tasks[0], id: '' });
  const b = JSON.stringify({ ...makeTask(), id: '' });
  return a === b;
}

/** 草稿里的 id 都是 t3 / m12 这种,恢复之后编号要接着往下发,免得撞 id */
export function nextSeq(tasks, prefix) {
  let max = 0;
  for (const t of tasks || []) {
    const m = String(t?.id ?? '').match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/**
 * 读草稿并整理成 { tasks, activeId }。
 * 读不到、或者读出来是空的,就返回 null,让页面自己开一个新任务。
 */
export function restoreTasks(key, makeTask, prefix) {
  const saved = readDraft(key);
  const list = Array.isArray(saved?.tasks) ? saved.tasks : [];
  const seen = new Set();
  const tasks = [];
  for (const raw of list) {
    const t = mergeTask(makeTask(), raw);
    if (!t || seen.has(t.id)) continue;            // 同 id 的重复行直接丢掉
    seen.add(t.id);
    tasks.push(t);
  }
  if (!tasks.length) return null;
  const activeId = tasks.some((t) => t.id === saved?.activeId) ? saved.activeId : tasks[0].id;
  return { tasks, activeId, seq: nextSeq(tasks, prefix) };
}
