// 毁伤模型 —— 纯函数模块，不依赖渲染器，可独立测试。
//
// 设计原则（模块化毁伤，无血条）：
// - 目标按部位/模块划分，命中产生“结果 + 效果”，而不是扣血。
// - 跳弹只属于硬表面（钢板/墙体/地面），不属于无护甲人体。
//   人体软组织没有让弹头转向的硬度，弹头只会侵入；只有颅骨、
//   长骨这种又硬又圆的骨头在小角度擦过时才可能偏转。
//
// 入射角 incidenceDeg：弹道方向与命中面法线的夹角。
//   0° = 垂直命中，90° = 完全擦过。

export const ZONE_LABELS = {
  head: '头部',
  chest: '胸部',
  abdomen: '腹部',
  arm: '手臂',
  leg: '腿部',
};

export const OUTCOME_LABELS = {
  penetration: '贯穿',
  graze: '擦伤',
  deflection: '命中骨骼偏转',
};

// 各部位基础毁伤权重（1.0 = 毁灭性）
const ZONE_SEVERITY = {
  head: 1.0,
  chest: 0.8,
  abdomen: 0.55,
  arm: 0.3,
  leg: 0.3,
};

// 命中效果文案：部位 × 结果
function effectFor(zone, outcome) {
  if (outcome === 'graze') return '轻微擦伤';
  if (outcome === 'deflection') {
    return zone === 'head' ? '偏转，短暂晕眩' : '擦过骨骼，轻微影响';
  }
  switch (zone) {
    case 'head': return '失能';
    case 'chest': return '严重毁伤';
    case 'abdomen': return '毁伤';
    case 'arm': return '瞄准受扰';
    case 'leg': return '行动受限';
    default: return '毁伤';
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 评估一次对无护甲人体的命中。
 * @param {Object} hit
 * @param {string} hit.zone - head | chest | abdomen | arm | leg
 * @param {number} hit.incidenceDeg - 入射角（度），0 = 垂直
 * @param {number} hit.rangeM - 射击距离（米）
 * @param {number} [hit.energy=1] - 弹头剩余能量系数 0..1
 * @param {number} [hit.roll=0.5] - 随机 roll 0..1（由调用方提供，保证可测试/可复现）
 * @returns {{zone, zoneLabel, outcome, outcomeLabel, severity, effectLabel, detail, incapacitated}}
 */
export function evaluateHit({ zone, incidenceDeg = 0, rangeM = 10, energy = 1, roll = 0.5 }) {
  if (!ZONE_LABELS[zone]) zone = 'abdomen';
  const angle = clamp(incidenceDeg, 0, 90);
  const range = Math.max(0, rangeM);

  // 1) 骨骼偏转：头部/四肢有硬而圆的骨头，小角度擦过时小概率偏转。
  const boneZone = zone === 'head' || zone === 'arm' || zone === 'leg';
  if (boneZone && angle >= 55 && roll < 0.22) {
    return {
      zone,
      zoneLabel: ZONE_LABELS[zone],
      outcome: 'deflection',
      outcomeLabel: OUTCOME_LABELS.deflection,
      severity: 0.12,
      effectLabel: effectFor(zone, 'deflection'),
      detail: '弹头以小角度擦过骨骼，发生偏转，未能有效侵彻',
      incapacitated: false,
    };
  }

  // 2) 擦伤：入射角过大，弹头只擦过体表。
  if (angle >= 70) {
    return {
      zone,
      zoneLabel: ZONE_LABELS[zone],
      outcome: 'graze',
      outcomeLabel: OUTCOME_LABELS.graze,
      severity: 0.12,
      effectLabel: effectFor(zone, 'graze'),
      detail: '以小角度擦过体表，未能有效侵彻',
      incapacitated: false,
    };
  }

  // 3) 贯穿：能量传递随距离变化。
  // 近距离弹头速度高、干净穿过，能量释放反而有限；
  // 距离拉长后弹头失稳翻滚，能量释放更充分；极远距离能量衰减。
  const transfer = clamp(0.45 + range / 70, 0.45, 1);
  const energyFactor = clamp(energy * (1 - range / 160), 0.3, 1);
  const severity = clamp(ZONE_SEVERITY[zone] * transfer * energyFactor, 0.05, 1);
  const detail =
    range < 12 ? '高速贯穿，能量释放有限' :
    range < 35 ? '贯穿，能量部分释放' :
    '弹头翻滚，能量充分释放';

  return {
    zone,
    zoneLabel: ZONE_LABELS[zone],
    outcome: 'penetration',
    outcomeLabel: OUTCOME_LABELS.penetration,
    severity,
    effectLabel: effectFor(zone, 'penetration'),
    detail,
    // 头部贯穿即失能；其他部位靠模块累积毁伤判定。
    incapacitated: zone === 'head',
  };
}

/**
 * 评估一次对硬表面的命中是否跳弹。
 * 只对硬表面调用（钢板/墙体/地面/掩体），绝不对人体调用。
 * @param {Object} hit
 * @param {number} hit.incidenceDeg - 入射角（度），0 = 垂直
 * @param {number} [hit.hardness=1] - 表面硬度 0..1（钢 1.0，水泥 0.9，木箱 0.6）
 * @param {number} [hit.roll=0.5] - 随机 roll 0..1
 * @returns {{ricochet: boolean, probability: number}}
 */
export function evaluateRicochet({ incidenceDeg = 0, hardness = 1, roll = 0.5 }) {
  const angle = clamp(incidenceDeg, 0, 90);
  if (hardness < 0.5) return { ricochet: false, probability: 0 };
  // 入射角超过 55° 后开始可能跳弹，角度越小（越擦）概率越高。
  const probability = clamp((angle - 55) / 35, 0, 1) * clamp(hardness, 0, 1);
  return { ricochet: roll < probability, probability };
}
