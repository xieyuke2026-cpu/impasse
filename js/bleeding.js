// 失血 debuff —— 纯函数模块，不依赖渲染器，可独立测试。
//
// 规则（Ryan 定）：
// - 假人和玩家都会失血；触发范围覆盖全身五个部位；
//   胸部触发概率最大，腹部其次。
// - 每次造成伤害的命中都 roll 一次；同一部位最多一处失血，
//   已失血的部位再次命中只刷新，不叠加。
// - 每处失血每秒累积严重度：假人 0.1/s（计入模块毁伤），
//   玩家 0.05/s（计入总失血量，达到阈值即倒地）——v0.5 起分开调，
//   玩家侧放缓是 Ryan 的要求（0.1/s 太快，游戏太难玩），假人手感不动。
// - 玩家 debuff 强度随总失血量渐变：刚开始几乎无影响，接近倒地时拉满。
// - 止血方式：包扎（玩家）/ 部位损毁 / 目标失能 / 靶子重置。

export const BLEED_PROBABILITY = {
  chest: 0.65,
  abdomen: 0.5,
  head: 0.3,
  leg: 0.3,
  arm: 0.25,
};

// 每处失血每秒累积的严重度（假人模块毁伤用，v0.4 既定手感，不动）。
export const BLEED_TICK_RATE = 0.1;

// 玩家每处失血每秒累积的总失血量（v0.5：0.1 → 0.05，放缓一半）。
export const PLAYER_BLEED_TICK_RATE = 0.05;

// 玩家总失血量达到此值即倒地（失血过多）。v0.5：1.0 → 1.5。
// 单处失血从一次 0.4 严重度命中起算约 28s 后倒地（原来约 9s），两处约 14s。
export const COLLAPSE_THRESHOLD = 1.5;

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
 * @param {number} rate - 每秒累积速率，默认 BLEED_TICK_RATE（假人）；
 *   玩家传 PLAYER_BLEED_TICK_RATE。
 * @returns {{added: Object, total: number}} added: zone -> 本帧新增严重度
 */
export function tickBleed(state, dt, rate = BLEED_TICK_RATE) {
  const added = {};
  let total = 0;
  for (const zone of Object.keys(state.bleeds)) {
    const a = rate * dt;
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

// 当前总失血速率（严重度/秒），按假人速率计（保留作调试/统计用）。
export function bleedRate(state) {
  return Object.keys(state.bleeds).length * BLEED_TICK_RATE;
}

// ---------- 玩家 debuff 渐变曲线（v0.5）：全部随总失血量线性拉满 ----------
// 失血程度 0..1：0 = 刚中弹几乎无感，1 = 倒地边缘拉满。
export function bleedFraction(bloodLoss) {
  return Math.min(1, Math.max(0, bloodLoss / COLLAPSE_THRESHOLD));
}

// 移速倍率：1 → 0.85（满额 -15%，与 v0.4 的满额一致，只是渐变到达）。
export function bleedSpeedFactor(fraction) {
  return 1 - 0.15 * fraction;
}

// 红屏不透明度：0 → 约 0.8（含脉冲），上限 0.85（与 v0.4 的满额一致）。
export function bleedVignetteOpacity(fraction, pulse) {
  if (fraction <= 0) return 0;
  return Math.min(0.85, 0.1 + fraction * 0.62 + pulse * 0.08 * fraction);
}

// 瞄准晃动幅度（弧度）：0 → 0.005（与 v0.4 的满额一致）。
export function bleedSwayAmplitude(fraction) {
  return 0.005 * fraction;
}

// 全部失血点累积的严重度总和（用于血泊大小等表现）。
export function totalSeverity(state) {
  let s = 0;
  for (const zone of Object.keys(state.bleeds)) s += state.bleeds[zone].severity;
  return s;
}
