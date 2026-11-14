// 射击记录：localStorage 持久化（impasse.records.v1）。
// 纯函数 + 可注入存储，存储不可用或数据损坏时回落空记录，游戏不受影响。
// v0.9 起两张地图（靶场/街区）共用同一份记录，不分地图统计。
// 记录内容：最高命中率（仅 ≥10 发的场次）、最多命中数、最快全清用时、
// 总场次、上次成绩；v0.12 起加团队死斗胜/负场（只计打完的比赛，中途
// 退出不计）。主页的记录面板只显示这里存下的真实数据，永不造假。

const STORAGE_KEY = 'impasse.records.v1';
export const MIN_SHOTS_FOR_ACCURACY = 10;

export function emptyRecords() {
  return {
    totalSessions: 0,
    bestAccuracy: null, // { accuracy, shots, hits }，仅统计 ≥10 发的场次
    mostHits: null, // number，单场最多命中数
    fastestClear: null, // number（秒），仅全清场次
    lastSession: null, // { shots, hits, accuracy, elapsedSec, cleared }
    tdmWins: 0, // 团队死斗胜场（只计打完的比赛）
    tdmLosses: 0, // 团队死斗负场（只计打完的比赛）
  };
}

function isNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isNonNegNumber(raw.shots) || !isNonNegNumber(raw.hits) || !isNonNegNumber(raw.elapsedSec)) return null;
  if (typeof raw.accuracy !== 'number' || !Number.isFinite(raw.accuracy) || raw.accuracy < 0 || raw.accuracy > 1) return null;
  return {
    shots: Math.floor(raw.shots),
    hits: Math.floor(raw.hits),
    accuracy: raw.accuracy,
    elapsedSec: raw.elapsedSec,
    cleared: raw.cleared === true,
  };
}

export function sanitizeRecords(raw) {
  const clean = emptyRecords();
  if (!raw || typeof raw !== 'object') return clean;
  if (Number.isInteger(raw.totalSessions) && raw.totalSessions >= 0) clean.totalSessions = raw.totalSessions;
  if (raw.bestAccuracy && typeof raw.bestAccuracy === 'object') {
    const b = raw.bestAccuracy;
    if (typeof b.accuracy === 'number' && Number.isFinite(b.accuracy) && b.accuracy >= 0 && b.accuracy <= 1 &&
        isNonNegNumber(b.shots) && isNonNegNumber(b.hits)) {
      clean.bestAccuracy = { accuracy: b.accuracy, shots: Math.floor(b.shots), hits: Math.floor(b.hits) };
    }
  }
  if (Number.isInteger(raw.mostHits) && raw.mostHits >= 0) clean.mostHits = raw.mostHits;
  if (isNonNegNumber(raw.fastestClear) && raw.fastestClear > 0) clean.fastestClear = raw.fastestClear;
  clean.lastSession = sanitizeSession(raw.lastSession);
  if (Number.isInteger(raw.tdmWins) && raw.tdmWins >= 0) clean.tdmWins = raw.tdmWins;
  if (Number.isInteger(raw.tdmLosses) && raw.tdmLosses >= 0) clean.tdmLosses = raw.tdmLosses;
  return clean;
}

function defaultStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch (e) { /* 存储不可用 */ }
  return null;
}

export function loadRecords(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return emptyRecords();
  try {
    const text = store.getItem(STORAGE_KEY);
    if (!text) return emptyRecords();
    return sanitizeRecords(JSON.parse(text));
  } catch (e) {
    return emptyRecords();
  }
}

export function saveRecords(records, storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch (e) { /* 忽略：无痕模式等场景下游戏照常运行 */ }
}

// 结算一场：计场次、刷新上次成绩，并按规则刷新三项最佳。返回新记录（不改原对象）。
// session: { shots, hits, elapsedSec, cleared }
export function applySession(records, session) {
  const shots = Math.max(0, Math.floor(session.shots) || 0);
  const hits = Math.max(0, Math.floor(session.hits) || 0);
  const elapsedSec = Math.max(0, session.elapsedSec || 0);
  const cleared = session.cleared === true;
  const accuracy = shots > 0 ? hits / shots : 0;
  const next = {
    totalSessions: (records.totalSessions || 0) + 1,
    bestAccuracy: records.bestAccuracy ? { ...records.bestAccuracy } : null,
    mostHits: records.mostHits,
    fastestClear: records.fastestClear,
    lastSession: { shots, hits, accuracy, elapsedSec, cleared },
    tdmWins: records.tdmWins || 0,
    tdmLosses: records.tdmLosses || 0,
  };
  if (shots >= MIN_SHOTS_FOR_ACCURACY) {
    if (!next.bestAccuracy || accuracy > next.bestAccuracy.accuracy) {
      next.bestAccuracy = { accuracy, shots, hits };
    }
  }
  if (next.mostHits === null || hits > next.mostHits) next.mostHits = hits;
  if (cleared && (next.fastestClear === null || elapsedSec < next.fastestClear)) {
    next.fastestClear = elapsedSec;
  }
  return next;
}

// 全清即时保存：只刷新最快全清用时，不计场次——场次在回主页结算时计，
// 避免同一场又记全清又记结算造成重复计数。
export function applyClear(records, elapsedSec) {
  const t = Math.max(0, elapsedSec || 0);
  if (records.fastestClear === null || t < records.fastestClear) {
    return { ...records, fastestClear: t };
  }
  return records;
}

// 团队死斗比赛结算：只计胜/负，不动射击记录。返回新记录（不改原对象）。
export function applyTdmMatch(records, won) {
  return {
    ...records,
    tdmWins: (records.tdmWins || 0) + (won ? 1 : 0),
    tdmLosses: (records.tdmLosses || 0) + (won ? 0 : 1),
  };
}

export function createRecordsStore(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  let current = loadRecords(store);
  return {
    get() { return current; },
    recordSession(session) {
      current = applySession(current, session);
      saveRecords(current, store);
      return current;
    },
    recordTdmMatch(won) {
      current = applyTdmMatch(current, won);
      saveRecords(current, store);
      return current;
    },
    recordClear(elapsedSec) {
      const next = applyClear(current, elapsedSec);
      if (next !== current) {
        current = next;
        saveRecords(current, store);
      }
      return current;
    },
  };
}
