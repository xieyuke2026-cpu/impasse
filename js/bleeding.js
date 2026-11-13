// 失血 debuff —— 纯函数模块，不依赖渲染器，可独立测试。
//
// 规则（Ryan 定）：
// - 假人和玩家都会失血；触发范围覆盖全身五个部位；
//   胸部触发概率最大，腹部其次。
// - 每次造成伤害的命中都 roll 一次；同一部位最多一处失血，
//   已失血的部位再次命中只刷新，不叠加。
// - 每处失血每秒给所在部位累积 0.1 严重度（假人：计入模块毁伤；
//   玩家：计入总失血量，达到阈值即倒地）。
// - 止血方式：包扎（玩家）/ 部位损毁 / 目标失能 / 靶子重置。

export const BLEED_PROBABILITY = {
  chest: 0.65,
  abdomen: 0.5,
  head: 0.3,
  leg: 0.3,
  arm: 0.25,
};

// 每处失血每秒累积的严重度。
export const BLEED_TICK_RATE = 0.1;

// 玩家总失血量达到此值即倒地（失血过多）。
export const COLLAPSE_THRESHOLD = 1.0;

// 命中造成的即时失血系数：bloodLoss += severity * IMMEDIATE_BLEED_FACTOR。
export const IMMEDIATE_BLEED_FACTOR = 0.2;

export function createBleedState() {
  return { bleeds: {} }; // zone -> { severity }
}

/**
 * 对一次命中 roll 失血。
 * @param {Object} state - createBleedState() 的返回值
 * @param {string} zone - head | chest | abdomen | arm | leg
 * @param {number} roll - 随机数 0..1（由调用方提供，保证可测试）
 * @returns {{triggered: boolean, refreshed: boolean}} refreshed = 该部位已有失血，本次只刷新
 */
export function rollBleed(state, zone, roll) {
  const p = BLEED_PROBABILITY[zone] ?? 0;
  if (roll >= p) return { triggered: false, refreshed: false };
  const refreshed = !!state.bleeds[zone];
  if (!refreshed) state.bleeds[zone] = { severity: 0 };
  return { triggered: true, refreshed };
}

/**
 * 推进一帧：每处失血累积严重度。
 * @returns {{added: Object, total: number}} added: zone -> 本帧新增严重度
 */
export function tickBleed(state, dt) {
  const added = {};
  let total = 0;
  for (const zone of Object.keys(state.bleeds)) {
    const a = BLEED_TICK_RATE * dt;
    state.bleeds[zone].severity += a;
    added[zone] = a;
    total += a;
  }
  return { added, total };
}

export function stopBleed(state, zone) {
  delete state.bleeds[zone];
}

export function clearBleeds(state) {
  state.bleeds = {};
}

export function bleedingZones(state) {
  return Object.keys(state.bleeds);
}

export function isBleeding(state) {
  return Object.keys(state.bleeds).length > 0;
}

// 当前总失血速率（严重度/秒），用于玩家 debuff 强度（红屏、晃动）。
export function bleedRate(state) {
  return Object.keys(state.bleeds).length * BLEED_TICK_RATE;
}

// 全部失血点累积的严重度总和（用于血泊大小等表现）。
export function totalSeverity(state) {
  let s = 0;
  for (const zone of Object.keys(state.bleeds)) s += state.bleeds[zone].severity;
  return s;
}
