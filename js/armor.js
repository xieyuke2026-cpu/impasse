// 防弹衣 / 头盔 —— 纯函数模块，不依赖渲染器，可独立测试。
//
// 规则（Ryan 定，v0.12 团队死斗）：
// - 防弹衣覆盖胸部 + 腹部，头盔覆盖头部；手臂 / 腿部无防护。
// - 有防护的部位命中时先打防具：防具吸收 70% 的毁伤，
//   自身耐久按 incoming 毁伤值扣除（毁伤 1.0 = 100 点耐久）。
// - 每发有 20% 概率击穿：击穿时造成全额毁伤，耐久扣双倍。
// - 耐久归零的防具被摧毁，不再提供防护；重生后重置为全新。
// - 防具挡在毁伤管线前面：调用方先调 applyGearHit 拿到调整后的
//   severity，再走 damage.js / bleeding.js 的原有流程——
//   这两个模块一字不改。

export const ARMOR_MAX = 100;
export const HELMET_MAX = 100;
export const ARMOR_ABSORB = 0.7; // 未击穿时吸收的毁伤比例
export const PENETRATION_CHANCE = 0.2; // 每发击穿概率

export const GEAR_LABELS = {
  armor: '防弹衣',
  helmet: '头盔',
};

// 部位 → 防具（null = 无防护）
export const GEAR_COVERAGE = {
  head: 'helmet',
  chest: 'armor',
  abdomen: 'armor',
  arm: null,
  leg: null,
};

export function createGearState() {
  return { armor: ARMOR_MAX, helmet: HELMET_MAX };
}

export function gearForZone(zone) {
  return GEAR_COVERAGE[zone] || null;
}

export function gearMax(piece) {
  return piece === 'helmet' ? HELMET_MAX : ARMOR_MAX;
}

/**
 * 一发命中先过防具。
 * @param {Object} gear - createGearState() 的返回值（会被原地修改耐久）
 * @param {string} zone - head | chest | abdomen | arm | leg
 * @param {number} severity - damage.js 评估出的毁伤 0..1
 * @param {number} roll - 随机数 0..1（击穿判定，由调用方提供，保证可测试）
 * @returns {{severity, penetrated, gearHit, destroyed, durabilityLoss, remaining}}
 *   severity: 过防具后的实际毁伤；penetrated: 是否击穿；
 *   gearHit: 命中的防具件（null = 该部位无防具或防具已毁）；
 *   destroyed: 本发摧毁的防具件（null = 未摧毁）；durabilityLoss: 本发扣除的耐久；
 *   remaining: 该防具件剩余耐久（无防具时为 null）。
 */
export function applyGearHit(gear, zone, severity, roll = 0.5) {
  const piece = gearForZone(zone);
  if (!piece || gear[piece] <= 0) {
    return {
      severity,
      penetrated: false,
      gearHit: null,
      destroyed: null,
      durabilityLoss: 0,
      remaining: piece ? gear[piece] : null,
    };
  }
  const penetrated = roll < PENETRATION_CHANCE;
  const loss = Math.round(severity * 100 * (penetrated ? 2 : 1));
  gear[piece] = Math.max(0, gear[piece] - loss);
  return {
    severity: penetrated ? severity : severity * (1 - ARMOR_ABSORB),
    penetrated,
    gearHit: piece,
    destroyed: gear[piece] <= 0 ? piece : null,
    durabilityLoss: loss,
    remaining: gear[piece],
  };
}

// HUD 用：两件防具的剩余比例与摧毁状态（只读快照）。
export function gearStatus(gear) {
  return {
    armor: Math.max(0, gear.armor / ARMOR_MAX),
    helmet: Math.max(0, gear.helmet / HELMET_MAX),
    armorDestroyed: gear.armor <= 0,
    helmetDestroyed: gear.helmet <= 0,
  };
}
