// 团队死斗计分与背水一战 —— 纯函数模块，不依赖渲染器，可独立测试。
//
// 规则（Ryan 定，v0.12）：
// - 击杀 1 人 = 1 分，先到 30 分的队伍获胜。
// - 当一方率先达到 20 分时，另一方（落后方）触发一次性的“背水一战”：
//   失血效果降低 5%（相对值：失血速率 ×0.95），移速增加 5%（×1.05）。
// - 背水一战在触发方（落后方）拿到 5 次击杀后结束；整场只触发一次。
// - 比赛结束（一方到 30 分）后不再计分。

export const WIN_SCORE = 30;
export const BUFF_TRIGGER_SCORE = 20;
export const BUFF_KILLS_TO_END = 5;
export const BUFF_BLEED_FACTOR = 0.95; // 失血速率倍率（相对 -5%）
export const BUFF_SPEED_FACTOR = 1.05; // 移速倍率（+5%）

export function createMatch() {
  return {
    scores: { blue: 0, red: 0 },
    buff: null, // { team, killsSince }，生效中的背水一战
    buffUsed: false, // 整场只触发一次
    winner: null, // 'blue' | 'red' | null
    kills: 0,
  };
}

function otherTeam(team) {
  return team === 'blue' ? 'red' : 'blue';
}

/**
 * 记录一次击杀，返回本发击杀触发的事件列表（按发生顺序）。
 * 事件：{ type: 'score', team, scores } / { type: 'buffTriggered', team } /
 *      { type: 'buffEnded', team } / { type: 'win', team, scores }
 * 比赛已结束时返回空数组，不再计分。
 */
export function recordKill(match, killerTeam) {
  const events = [];
  if (match.winner) return events;
  if (killerTeam !== 'blue' && killerTeam !== 'red') return events;

  match.scores[killerTeam] += 1;
  match.kills += 1;
  events.push({ type: 'score', team: killerTeam, scores: { ...match.scores } });

  // 背水一战触发：一方率先达到 20 分、且对方不足 20 分时，落后方获得增益。
  if (!match.buffUsed && !match.buff) {
    const other = otherTeam(killerTeam);
    if (match.scores[killerTeam] >= BUFF_TRIGGER_SCORE && match.scores[other] < BUFF_TRIGGER_SCORE) {
      match.buff = { team: other, killsSince: 0 };
      match.buffUsed = true;
      events.push({ type: 'buffTriggered', team: other });
    }
  }

  // 背水一战进度：增益方拿到 5 次击杀后结束。
  if (match.buff && killerTeam === match.buff.team) {
    match.buff.killsSince += 1;
    if (match.buff.killsSince >= BUFF_KILLS_TO_END) {
      events.push({ type: 'buffEnded', team: match.buff.team });
      match.buff = null;
    }
  }

  if (match.scores[killerTeam] >= WIN_SCORE) {
    match.winner = killerTeam;
    events.push({ type: 'win', team: killerTeam, scores: { ...match.scores } });
  }
  return events;
}

// 某队伍当前的增益倍率（失血速率 / 移速），无增益时均为 1。
export function buffModifiers(match, team) {
  const active = !!(match.buff && match.buff.team === team);
  return {
    active,
    bleedFactor: active ? BUFF_BLEED_FACTOR : 1,
    speedFactor: active ? BUFF_SPEED_FACTOR : 1,
  };
}
