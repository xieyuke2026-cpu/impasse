// 机器人 AI：9 名机器人（蓝队 4 名队友 + 红队 5 名敌人），只在团队死斗中出现。
// 士兵 GLB + 骨骼动画（Walk/Run/Shoot/Death/RecieveHit），路径点寻路（BFS），
// 感知（距离 + 视野角 + 视线遮挡，错峰检测）→ 交战（横移 + 短点射 + 反应延迟）
// → 受伤反应 → 死亡/重生。机器人与玩家走同一套毁伤/失血/防具管线
// （damage.js / bleeding.js / armor.js），只是没有血条：部位模块毁伤累积，
// 头/胸模块损毁即阵亡。
//
// 队伍识别：蓝队用蓝色士兵模型，红队用绿色士兵模型染红（只染制服/头盔
// 材质，皮肤与面部不动），另加双肩队色臂章 + 脚下队色光环——30m 外也能
// 一眼认出敌我。没有悬浮标记（Ryan 不要）。

import * as THREE from 'three';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';
import { evaluateHit, ZONE_LABELS } from './damage.js?v=0.12';
import {
  createBleedState,
  rollBleed,
  tickBleed,
  stopBleed,
  clearBleeds,
  bleedingZones,
  BLEED_TICK_RATE,
} from './bleeding.js?v=0.12';
import { createGearState, applyGearHit, GEAR_LABELS } from './armor.js?v=0.12';

// 士兵模型部位判定带：与 targets.js 的 ZONE_BANDS / SOLDIER_OFFSET 完全一致，
// 两边改一边必须同步（同一模型、同一 Idle 姿态）。
const ZONE_BANDS = { headY: 1.48, chestY: 1.05, abdomenY: 0.62, armX: 0.27, armY0: 0.6, armY1: 1.45 };
const SOLDIER_OFFSET = new THREE.Vector3(-0.048, 0, 0.165);

export const BOT_NAMES = {
  blue: ['猎鹰', '山猫', '磐石', '疾风'],
  red: ['毒蛇', '秃鹫', '铁锤', '幽灵', '豺狼'],
};
const TEAM_COLORS = { blue: 0x3a7bff, red: 0xff4a3a };
const TEAM_LABELS = { blue: '蓝队', red: '红队' };
// 红队制服染色：只染 Main（制服）/ DarkGreen（深绿部件）/ Helmet（头盔），
// Skin（皮肤）/ Face（面部）/ Black（黑色部件）保持原色。
const RED_TINT = { Main: 0x8a2f22, DarkGreen: 0x6e241b, Helmet: 0x7c2820 };

const BOT_EYE = 1.55;
const BOT_CHEST = 1.2;
const PERCEPT_INTERVAL = 0.2; // 感知节流：每名机器人每 0.2s 检测一次，错峰
const SIGHT_RANGE = 48;
const SIGHT_HALF_FOV = 0.96; // 视野半角约 55°
const BOT_DAMAGE_SCALE = 0.85; // 机器人单发毁伤略低于玩家步枪
const RESPAWN_TIME = 3;

// ---------- 路径点图 ----------
// 沿街道/广场/巷道/房门口手放，边由“距离 + 净空检测”自动生成：
// 两点 ≤16m 且连线采样点都不压进障碍物碰撞体（0.55m 余量）才连边。
// 改地图几何或加道具后，用 __impasseDebug.tdm.checkWaypoints() 复核。
const WAYPOINTS = [
  // 主街（南北向，x≈0；(0,13) 避开停在 x≈2.8 的汽车，(-3,13) 一侧也有道具）
  [0, 40], [0, 32], [3, 24], [0, 13], [0, 0], [-3.5, -13], [-3.5, -24], [0, -32], [0, -40],
  // 西街（南北向，绕开停在路边的出租车与轿车）
  [-28, 36], [-28, 26], [-24, 14], [-24, 0], [-28, -13], [-24, -20], [-28, -26], [-28, -36],
  // 东街（南北向，绕开 SUV 与卡车；(25,36) 避开东南角伸进街面的 7m 建筑）
  [25, 36], [28, 26], [24, 14], [24, 0], [28.5, -1], [28.5, -8], [28, -13], [24, -20], [28, -26], [28, -36],
  // 横街（(±13,0) 原址各压着一只 1.04m 路障，分别挪到 z=+2.5/-2.5 的空位）
  [-13, 26], [13, 26], [-13, -26], [13, -26], [-13, 2.5], [13, -2.5],
  // 广场
  [-13, -13], [13, 13],
  // 房门口（R1/R2/R3/R4/R5 门外 2m）
  [-13, -34], [-34, -13], [13, -34], [34, 13], [-13, 34],
  // 工业角
  [30, -29], [39, -27],
];
const EDGE_MAX_DIST = 16;
const EDGE_CLEAR_MARGIN = 0.55;

// minTop：只把高于该值的障碍物算作阻挡。转向探针用默认 0.2（锥桶/
// 木箱也要绕开）；路径图连边用 1.4（只有墙体/房间/汽车/集装箱才真正
// 截断路线，矮道具靠转向探针临场绕开——否则街上每只锥桶都会打断连边，
// 图会碎成十几块，机器人只能在出生点附近打转）。
// ignorePoles：连边时忽略细杆（路灯杆 r=0.25）：杆子再高也只有一根，
// 机器人临场一步就能绕开，不该截断整条路线。
function pointBlocked(colliders, x, z, margin, minTop = 0.2, ignorePoles = false) {
  for (const c of colliders) {
    const top = c.top ?? 99;
    if (top <= minTop) continue;
    if (ignorePoles && c.type === 'circle' && c.r <= 0.35) continue;
    if (c.type === 'aabb') {
      if (x >= c.minX - margin && x <= c.maxX + margin && z >= c.minZ - margin && z <= c.maxZ + margin) return true;
    } else if (c.type === 'circle') {
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = c.r + margin;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
  }
  return false;
}

function segmentClear(colliders, ax, az, bx, bz, margin, minTop = 0.2, ignorePoles = false) {
  const dist = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(dist / 0.5));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (pointBlocked(colliders, ax + (bx - ax) * t, az + (bz - az) * t, margin, minTop, ignorePoles)) return false;
  }
  return true;
}

function buildGraph(colliders) {
  const nodes = WAYPOINTS.map(([x, z]) => ({ x, z }));
  const adj = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
      if (d > EDGE_MAX_DIST) continue;
      // 连边只看高大障碍物（墙/车/集装箱），矮道具与细灯杆临场绕开。
      if (!segmentClear(colliders, nodes[i].x, nodes[i].z, nodes[j].x, nodes[j].z, EDGE_CLEAR_MARGIN, 1.4, true)) continue;
      adj[i].push(j);
      adj[j].push(i);
    }
  }
  return { nodes, adj };
}

function bfsPath(adj, from, to) {
  if (from === to) return [from];
  const prev = new Array(adj.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nb of adj[cur]) {
      if (prev[nb] !== -1) continue;
      prev[nb] = cur;
      if (nb === to) {
        const path = [to];
        let p = to;
        while (p !== from) {
          p = prev[p];
          path.push(p);
        }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

function nearestNode(nodes, x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = Math.hypot(nodes[i].x - x, nodes[i].z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// 机器人开火命中率：距离越远越低，目标/自身移动再打折。
function hitChance(dist, targetSpeed, shooterMoving) {
  let p;
  if (dist <= 8) p = 0.6;
  else if (dist <= 15) p = 0.6 - (dist - 8) * 0.026; // 15m 处约 0.42
  else if (dist <= 25) p = 0.42 - (dist - 15) * 0.014; // 25m 处约 0.28
  else if (dist <= 40) p = 0.28 - (dist - 25) * 0.008; // 40m 处约 0.16
  else p = 0.1;
  if (targetSpeed > 3) p *= 0.75;
  else if (targetSpeed > 1) p *= 0.9;
  if (shooterMoving) p *= 0.85;
  return Math.min(0.7, Math.max(0.05, p));
}

function rollZone() {
  const r = Math.random();
  if (r < 0.38) return 'chest';
  if (r < 0.62) return 'abdomen';
  if (r < 0.75) return 'head';
  if (r < 0.88) return 'arm';
  return 'leg';
}

export function createBotManager({
  parent,
  soldierBlue = null,
  soldierRed = null,
  animations = null,
  colliders = [],
  occluders = [],
  callbacks = {},
}) {
  const {
    onPlayerHit = () => {},
    onKill = () => {},
    spawnTracer = () => {},
    playDistantShot = () => {},
  } = callbacks;

  const graph = buildGraph(colliders);
  const bots = [];
  const hitMeshes = [];
  const botColliders = [];
  const raycaster = new THREE.Raycaster();
  let combatEnabled = true;

  // ---------- 队伍出生点 ----------
  const SPAWNS = {
    blue: [[-3, 41], [3, 41], [-3, 38], [3, 38]],
    red: [[-3, -41], [3, -41], [-3, -38], [3, -38], [0, -42]],
  };

  const patchGeo = new THREE.BoxGeometry(0.1, 0.07, 0.03);
  const ringGeo = new THREE.CircleGeometry(0.45, 24);
  const gunBodyGeo = new THREE.BoxGeometry(0.06, 0.09, 0.55);
  const gunBarrelGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.25, 8);
  const gunMagGeo = new THREE.BoxGeometry(0.05, 0.12, 0.08);
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.6, metalness: 0.5 });

  function makeBot(team, index) {
    const name = BOT_NAMES[team][index];
    const group = new THREE.Group();
    const model = team === 'blue' ? soldierBlue : soldierRed;
    const disposables = [];
    let mixer = null;
    const actions = {};
    const botMeshes = [];
    const baseColors = [];

    if (model) {
      const clone = skClone(model);
      clone.position.copy(SOLDIER_OFFSET);
      group.add(clone);
      clone.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.frustumCulled = false;
        o.material = o.material.clone();
        disposables.push(o.material);
        // 红队染色：只染制服类材质
        if (team === 'red' && RED_TINT[o.material.name] !== undefined) {
          o.material.color.setHex(RED_TINT[o.material.name]);
        }
        o.material.emissive = new THREE.Color(0xff4030);
        o.material.emissiveIntensity = 0;
        baseColors.push({ mat: o.material, color: o.material.color.clone() });
        o.userData.surface = { kind: 'bot', hardness: 0.15 };
        o.userData.flashT = 0;
        hitMeshes.push(o);
        botMeshes.push(o);
      });
      // 动画：clip 存在才建 mixer，否则冻结姿态 + 程序化摆动
      const clips = animations && animations.get(team === 'blue' ? 'soldier-blue' : 'soldier');
      if (clips && clips.length > 0) {
        try {
          mixer = new THREE.AnimationMixer(clone);
          for (const [key, clipName] of [['idle', 'Idle'], ['walk', 'Walk'], ['run', 'Run'], ['shoot', 'Shoot_OneHanded'], ['death', 'Death'], ['hit', 'RecieveHit']]) {
            const clip = THREE.AnimationClip.findByName(clips, clipName);
            if (clip) actions[key] = mixer.clipAction(clip);
          }
          if (actions.death) {
            actions.death.setLoop(THREE.LoopOnce, 1);
            actions.death.clampWhenFinished = true;
          }
          if (actions.hit) {
            actions.hit.setLoop(THREE.LoopOnce, 1);
            actions.hit.clampWhenFinished = true;
          }
          if (actions.idle) actions.idle.play();
        } catch (e) {
          mixer = null;
        }
      }
    } else {
      // 程序化回退：方块人（与 targets.js 的程序化假人同尺寸风格）
      const baseMat = new THREE.MeshStandardMaterial({ color: team === 'blue' ? 0x3a5a8a : 0x8a4a3a, roughness: 0.85 });
      disposables.push(baseMat);
      const part = (w, h, d, px, py, zone) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), baseMat);
        m.castShadow = true;
        m.position.set(px, py, 0);
        m.userData.surface = { kind: 'bot', hardness: 0.15 };
        m.userData.zone = zone;
        m.userData.flashT = 0;
        m.material.emissive = new THREE.Color(0xff4030);
        m.material.emissiveIntensity = 0;
        group.add(m);
        hitMeshes.push(m);
        botMeshes.push(m);
        return m;
      };
      part(0.13, 0.8, 0.13, -0.11, 0.4, 'leg');
      part(0.13, 0.8, 0.13, 0.11, 0.4, 'leg');
      part(0.34, 0.35, 0.2, 0, 0.98, 'abdomen');
      part(0.4, 0.45, 0.22, 0, 1.42, 'chest');
      part(0.1, 0.62, 0.1, -0.27, 1.32, 'arm');
      part(0.1, 0.62, 0.1, 0.27, 1.32, 'arm');
      part(0.24, 0.26, 0.24, 0, 1.82, 'head');
    }

    // 队色臂章（双肩）+ 脚下光环 + 手持步枪（装饰）
    const patchMat = new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team] });
    disposables.push(patchMat);
    for (const sx of [-1, 1]) {
      const patch = new THREE.Mesh(patchGeo, patchMat);
      patch.position.set(sx * 0.23, 1.44, 0.02);
      group.add(patch);
    }
    const ringMat = new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team], transparent: true, opacity: 0.4, depthWrite: false });
    disposables.push(ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);
    const gunBody = new THREE.Mesh(gunBodyGeo, gunMat);
    gunBody.position.set(0.18, 1.28, 0.32);
    group.add(gunBody);
    const gunBarrel = new THREE.Mesh(gunBarrelGeo, gunMat);
    gunBarrel.rotation.x = Math.PI / 2;
    gunBarrel.position.set(0.18, 1.3, 0.68);
    group.add(gunBarrel);
    const gunMag = new THREE.Mesh(gunMagGeo, gunMat);
    gunMag.position.set(0.18, 1.2, 0.3);
    group.add(gunMag);

    parent.add(group);
    const collider = { type: 'circle', x: 0, z: 0, r: 0.4, top: 1.95 };
    botColliders.push(collider);

    const bot = {
      id: `${team}-${index}`,
      team,
      name,
      group,
      meshes: botMeshes,
      baseColors,
      mixer,
      actions,
      currentAction: mixer && actions.idle ? 'idle' : null,
      collider,
      disposables,
      isSoldier: !!model,
      alive: true,
      state: 'patrol', // patrol | engage | dead
      yaw: 0,
      speed: 0,
      integrity: { head: 1, chest: 1, abdomen: 1, arm: 1, leg: 1 },
      destroyed: new Set(),
      gear: createGearState(),
      bleed: createBleedState(),
      lastAttacker: null,
      lastAttackerT: -99,
      // 寻路
      path: [],
      pathIdx: 0,
      idleT: 0,
      stuckT: 0,
      lastPos: new THREE.Vector3(),
      stuckCheckT: 0,
      // 感知与交战
      perceptT: Math.random() * PERCEPT_INTERVAL,
      target: null, // { kind: 'player' } | { kind: 'bot', bot } | null
      targetLostT: 0,
      lastKnown: new THREE.Vector3(),
      lastKnownT: -99,
      reactionT: 0,
      burstLeft: 0,
      shotT: 0,
      pauseT: 0,
      magLeft: 30,
      reloadT: 0,
      strafeDir: 1,
      strafeT: 0,
      strafeAnchor: new THREE.Vector3(),
      hitT: 0,
      deathT: 0,
      respawnT: 0,
      bobT: Math.random() * 10,
      fallT: 0,
    };
    for (const m of botMeshes) m.userData.bot = bot;
    bots.push(bot);
    return bot;
  }

  function resetBot(bot, spawnPoint) {
    bot.integrity = { head: 1, chest: 1, abdomen: 1, arm: 1, leg: 1 };
    bot.destroyed.clear();
    bot.gear = createGearState();
    clearBleeds(bot.bleed);
    bot.lastAttacker = null;
    bot.lastAttackerT = -99;
    bot.alive = true;
    bot.state = 'patrol';
    bot.target = null;
    bot.targetLostT = 0;
    bot.reactionT = 0;
    bot.burstLeft = 0;
    bot.shotT = 0;
    bot.pauseT = 0;
    bot.magLeft = 30;
    bot.reloadT = 0;
    bot.hitT = 0;
    bot.deathT = 0;
    bot.fallT = 0;
    bot.group.visible = true;
    bot.group.rotation.x = 0;
    bot.group.rotation.y = 0;
    bot.group.position.set(spawnPoint[0], 0, spawnPoint[1]);
    bot.yaw = spawnPoint[1] > 0 ? Math.PI : 0; // 南侧出生面向北（-Z），北侧面向南
    bot.group.rotation.y = bot.yaw;
    bot.collider.x = spawnPoint[0];
    bot.collider.z = spawnPoint[1];
    bot.collider.r = 0.4;
    bot.collider.top = 1.95;
    for (const { mat, color } of bot.baseColors) mat.color.copy(color);
    for (const m of bot.meshes) {
      m.material.emissiveIntensity = 0;
      m.userData.flashT = 0;
    }
    if (bot.mixer) {
      for (const a of Object.values(bot.actions)) a.stop();
      if (bot.actions.idle) {
        bot.actions.idle.reset().play();
        bot.currentAction = 'idle';
      }
    }
    // 开局即选一个远处目标点散开，避免出生点扎堆
    pickDestination(bot, true);
  }

  function pickDestination(bot, far = false) {
    const from = nearestNode(graph.nodes, bot.group.position.x, bot.group.position.z);
    // 候选点必须 BFS 可达才采用（图若有断块，不可达的候选只会让机器人
    // 走到最近节点就停下、反复重选、原地打转）。12 次都不可达时退到
    // 一个直连邻居，机器人至少一直在移动。
    for (let tries = 0; tries < 12; tries++) {
      const cand = Math.floor(Math.random() * graph.nodes.length);
      if (cand === from) continue;
      const d = Math.hypot(graph.nodes[cand].x - bot.group.position.x, graph.nodes[cand].z - bot.group.position.z);
      if (far && d <= 25) continue;
      const path = bfsPath(graph.adj, from, cand);
      if (path && path.length > 1) {
        bot.path = path;
        // 路径首节点就是脚下的最近节点：跳过它，直接朝下一节点走。
        // 否则机器人会先走向脚下这点——若玩家正好站在该点（出生点
        // [0,40] 与玩家出生点重合），排斥圈会把它挡在到达半径之外，
        // 永远到不了、永远不推进，整场卡在出生点。
        bot.pathIdx = 1;
        return;
      }
    }
    const neighbors = graph.adj[from];
    if (neighbors.length > 0) {
      bot.path = [from, neighbors[Math.floor(Math.random() * neighbors.length)]];
      bot.pathIdx = 1;
    } else {
      bot.path = [from];
      bot.pathIdx = 0;
    }
  }

  function playAction(bot, name) {
    if (!bot.mixer || !bot.actions[name] || bot.currentAction === name) return;
    const prev = bot.currentAction && bot.actions[bot.currentAction];
    const next = bot.actions[name];
    if (prev && prev !== next) {
      next.reset().setEffectiveWeight(1).play();
      next.crossFadeFrom(prev, 0.15, false);
    } else {
      next.reset().play();
    }
    bot.currentAction = name;
  }

  function destroyZone(bot, zone) {
    bot.destroyed.add(zone);
    stopBleed(bot.bleed, zone);
    if (bot.isSoldier) {
      const k = Math.pow(0.72, bot.destroyed.size);
      for (const { mat, color } of bot.baseColors) mat.color.copy(color).multiplyScalar(k);
    } else {
      for (const m of bot.meshes) {
        if (m.userData.zone === zone) m.material.color.setHex(0x3a3f30);
      }
    }
  }

  function killBot(bot, killer) {
    if (!bot.alive) return;
    bot.alive = false;
    bot.state = 'dead';
    bot.deathT = 0;
    bot.respawnT = RESPAWN_TIME;
    bot.target = null;
    bot.burstLeft = 0;
    bot.collider.r = 0.01;
    bot.collider.top = 0; // 倒地不挡人
    clearBleeds(bot.bleed);
    if (bot.mixer && bot.actions.death) {
      playAction(bot, 'death');
    }
    onKill({
      killer: killer || null,
      victim: { team: bot.team, name: bot.name, isPlayer: false },
    });
  }

  // 机器人受到一次命中（来自玩家射线或机器人开火）：防具 → 模块毁伤 → 失血 → 死亡。
  // evalResult: damage.js 的评估结果；damageScale: 武器毁伤倍率；attacker: 攻击者描述。
  // 返回 { log, killed, zoneLabel }。
  function applyHit(bot, evalResult, damageScale, attacker) {
    const zone = evalResult.zone;
    for (const m of bot.meshes) {
      m.userData.flashT = 0.18;
      m.material.emissiveIntensity = 1;
    }
    if (!bot.alive) {
      return { log: `命中${evalResult.zoneLabel}（目标已倒地）`, killed: false, zoneLabel: evalResult.zoneLabel };
    }
    bot.hitT = 0.3;
    bot.lastAttacker = attacker || null;
    bot.lastAttackerT = performance.now() / 1000;
    const gearRes = applyGearHit(bot.gear, zone, evalResult.severity * damageScale, Math.random());
    bot.integrity[zone] -= gearRes.severity;
    let log = `命中 ${TEAM_LABELS[bot.team]}·${bot.name} ${evalResult.zoneLabel} · ${evalResult.outcomeLabel}`;
    if (gearRes.gearHit) {
      if (gearRes.penetrated) log += ` · 击穿${GEAR_LABELS[gearRes.gearHit]}！`;
      else log += ` · ${GEAR_LABELS[gearRes.gearHit]}吸收了大部分伤害`;
      if (gearRes.destroyed) log += ` · ${GEAR_LABELS[gearRes.destroyed]}被摧毁！`;
    }
    let killed = false;
    if (bot.integrity[zone] <= 0 && !bot.destroyed.has(zone)) {
      destroyZone(bot, zone);
      if (zone === 'head' || zone === 'chest') {
        killed = true;
        log += ' —— 目标倒地！';
      } else {
        log += ` —— ${evalResult.zoneLabel}模块损毁`;
      }
    } else if (evalResult.incapacitated) {
      destroyZone(bot, zone);
      killed = true;
      log += ' —— 目标倒地！';
    } else if (!bot.destroyed.has(zone)) {
      const bleedRoll = rollBleed(bot.bleed, zone, Math.random());
      if (bleedRoll.triggered && !bleedRoll.refreshed) log += ` —— ${evalResult.zoneLabel}失血！`;
    }
    // 受伤即转火：正在巡逻的机器人立刻注意到攻击者方向
    if (bot.state === 'patrol' && attacker) {
      bot.lastKnownT = performance.now() / 1000;
      if (attacker.pos) bot.lastKnown.copy(attacker.pos);
    }
    if (killed) killBot(bot, attacker);
    return { log, killed, zoneLabel: evalResult.zoneLabel };
  }

  // 玩家射线命中机器人：与 applyHit 相同，但攻击者是玩家（带位置，供转火用）。
  function applyPlayerHit(bot, evalResult, damageScale, playerPos) {
    return applyHit(bot, evalResult, damageScale, { team: 'blue', name: '你', isPlayer: true, pos: playerPos });
  }

  // 命中点 → 部位（与 targets.js 同一判定带；程序化回退用 mesh 自带 zone）。
  const _local = new THREE.Vector3();
  function zoneAtPoint(bot, point) {
    if (!bot.isSoldier) return null;
    _local.copy(point);
    bot.group.worldToLocal(_local);
    const y = _local.y;
    const ax = Math.abs(_local.x);
    if (y >= ZONE_BANDS.headY) return 'head';
    if (ax > ZONE_BANDS.armX && y >= ZONE_BANDS.armY0 && y < ZONE_BANDS.armY1) return 'arm';
    if (y >= ZONE_BANDS.chestY) return 'chest';
    if (y >= ZONE_BANDS.abdomenY) return 'abdomen';
    return 'leg';
  }

  // ---------- 感知 ----------
  const _eye = new THREE.Vector3();
  const _chest = new THREE.Vector3();
  const _toTarget = new THREE.Vector3();
  function hasLineOfSight(fromPos, toPos) {
    _eye.copy(fromPos);
    _eye.y += BOT_EYE;
    _chest.copy(toPos);
    _chest.y += BOT_CHEST;
    _toTarget.subVectors(_chest, _eye);
    const dist = _toTarget.length();
    _toTarget.normalize();
    raycaster.set(_eye, _toTarget);
    raycaster.far = dist - 0.5;
    const hits = raycaster.intersectObjects(occluders, false);
    return hits.length === 0;
  }

  function perceive(bot, now, player) {
    // 候选：玩家 + 敌方机器人
    let best = null;
    let bestDist = Infinity;
    const consider = (kind, obj, pos) => {
      const dx = pos.x - bot.group.position.x;
      const dz = pos.z - bot.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SIGHT_RANGE || dist >= bestDist) return;
      // 视野角：正前方 110°；刚受过伤（3s 内）或极近（8m 内）则 360°
      const recentDamage = now - bot.lastAttackerT < 3;
      if (!recentDamage && dist > 8) {
        const fx = Math.sin(bot.yaw);
        const fz = Math.cos(bot.yaw);
        const cosA = (dx * fx + dz * fz) / Math.max(0.001, dist);
        if (Math.acos(Math.min(1, Math.max(-1, cosA))) > SIGHT_HALF_FOV) return;
      }
      if (!hasLineOfSight(bot.group.position, pos)) return;
      best = { kind, obj, dist };
      bestDist = dist;
    };
    // 玩家是蓝队：只有红队机器人把玩家当目标（蓝队队友不打自己人）。
    if (player.alive && bot.team === 'red') consider('player', null, player.pos);
    for (const other of bots) {
      if (other === bot || !other.alive || other.team === bot.team) continue;
      consider('bot', other, other.group.position);
    }
    if (best) {
      const newTarget = best.kind === 'player' ? { kind: 'player' } : { kind: 'bot', bot: best.obj };
      const changed = !bot.target || bot.target.kind !== newTarget.kind ||
        (newTarget.kind === 'bot' && bot.target.bot !== newTarget.bot);
      if (changed) {
        bot.target = newTarget;
        bot.reactionT = 0.5 + Math.random() * 0.4;
        bot.strafeAnchor.copy(bot.group.position);
        bot.strafeT = 0;
      }
      bot.targetLostT = 0;
      bot.lastKnown.copy(best.kind === 'player' ? player.pos : best.obj.group.position);
      bot.lastKnownT = now;
      if (bot.state !== 'engage') bot.state = 'engage';
    } else if (bot.target) {
      bot.targetLostT += PERCEPT_INTERVAL;
      if (bot.targetLostT > 2.5) {
        bot.target = null;
        bot.state = 'patrol';
        bot.burstLeft = 0;
        pickDestination(bot);
      }
    }
  }

  // ---------- 开火 ----------
  const _muzzle = new THREE.Vector3();
  const _shotEnd = new THREE.Vector3();
  const _perp = new THREE.Vector3();
  function botShoot(bot, now, player) {
    if (!bot.target) return;
    let targetPos;
    let targetSpeed = 0;
    let isPlayer = false;
    if (bot.target.kind === 'player') {
      if (!player.alive) return;
      targetPos = player.pos;
      targetSpeed = player.speed || 0;
      isPlayer = true;
    } else {
      const tb = bot.target.bot;
      if (!tb.alive) return;
      targetPos = tb.group.position;
      targetSpeed = tb.speed;
    }
    const dx = targetPos.x - bot.group.position.x;
    const dz = targetPos.z - bot.group.position.z;
    const dist = Math.hypot(dx, dz);
    // 枪口：机器人前方 0.7m、高 1.4m 处
    _muzzle.set(
      bot.group.position.x + Math.sin(bot.yaw) * 0.7,
      BOT_CHEST + 0.2,
      bot.group.position.z + Math.cos(bot.yaw) * 0.7
    );
    const moving = bot.speed > 0.5;
    const hit = Math.random() < hitChance(dist, targetSpeed, moving);
    _perp.set(-dz / Math.max(0.001, dist), 0, dx / Math.max(0.001, dist));
    if (hit) {
      _shotEnd.set(
        targetPos.x + (Math.random() - 0.5) * 0.3,
        BOT_CHEST + (Math.random() - 0.5) * 0.5,
        targetPos.z + (Math.random() - 0.5) * 0.3
      );
    } else {
      const miss = 0.6 + Math.random() * 1.2;
      const side = Math.random() < 0.5 ? -1 : 1;
      _shotEnd.set(
        targetPos.x + _perp.x * miss * side + (Math.random() - 0.5) * 0.4,
        BOT_CHEST + (Math.random() - 0.5) * 1.2,
        targetPos.z + _perp.z * miss * side + (Math.random() - 0.5) * 0.4
      );
    }
    spawnTracer(_muzzle.clone(), _shotEnd.clone(), bot.team === 'red' ? 0xff7a6a : 0x7aa8ff);
    playDistantShot(dist);
    if (!hit) return;
    const zone = rollZone();
    const evalResult = evaluateHit({
      zone,
      incidenceDeg: Math.random() * 30,
      rangeM: dist,
      energy: Math.max(0.3, 1 - dist * 0.012),
      roll: Math.random(),
    });
    const attacker = { team: bot.team, name: bot.name, isPlayer: false, pos: bot.group.position };
    if (isPlayer) {
      onPlayerHit({
        zone,
        severity: evalResult.severity * BOT_DAMAGE_SCALE,
        outcomeLabel: evalResult.outcomeLabel,
        distance: dist,
        attacker,
      });
    } else {
      const tb = bot.target.bot;
      applyHit(tb, evalResult, BOT_DAMAGE_SCALE, attacker);
    }
  }

  // ---------- 移动 ----------
  const _moveDir = new THREE.Vector3();
  function moveToward(bot, tx, tz, speed, dt) {
    const dx = tx - bot.group.position.x;
    const dz = tz - bot.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) return true;
    // 前方探障：1m 外被挡则左右试探，选通的那边绕行
    const stepX = (dx / dist) * 1.0;
    const stepZ = (dz / dist) * 1.0;
    let mx = dx / dist;
    let mz = dz / dist;
    if (pointBlocked(colliders, bot.group.position.x + stepX, bot.group.position.z + stepZ, 0.4)) {
      const leftX = -mz;
      const leftZ = mx;
      const leftClear = !pointBlocked(colliders, bot.group.position.x + leftX, bot.group.position.z + leftZ, 0.4);
      const rightClear = !pointBlocked(colliders, bot.group.position.x - leftX, bot.group.position.z - leftZ, 0.4);
      const s = leftClear && !rightClear ? 1 : !leftClear && rightClear ? -1 : bot.strafeDir;
      mx = (dx / dist + leftX * s * 0.9);
      mz = (dz / dist + leftZ * s * 0.9);
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml;
      mz /= ml;
    }
    bot.group.position.x += mx * speed * dt;
    bot.group.position.z += mz * speed * dt;
    bot.group.position.x = THREE.MathUtils.clamp(bot.group.position.x, -43, 43);
    bot.group.position.z = THREE.MathUtils.clamp(bot.group.position.z, -43, 43);
    // 朝向：平滑转向移动方向
    const targetYaw = Math.atan2(mx, mz);
    let dy = targetYaw - bot.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    bot.yaw += THREE.MathUtils.clamp(dy, -3.5 * dt, 3.5 * dt);
    bot.group.rotation.y = bot.yaw;
    // 到达半径 1.0m：必须大于玩家排斥半径（0.9m），否则玩家站在路径点
    // 上时机器人会被排斥圈挡在到达半径之外、永远到不了。
    return dist < 1.0;
  }

  function faceToward(bot, tx, tz, dt) {
    const dx = tx - bot.group.position.x;
    const dz = tz - bot.group.position.z;
    if (Math.hypot(dx, dz) < 0.01) return;
    const targetYaw = Math.atan2(dx, dz);
    let dy = targetYaw - bot.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    bot.yaw += THREE.MathUtils.clamp(dy, -4.5 * dt, 4.5 * dt);
    bot.group.rotation.y = bot.yaw;
  }

  // ---------- 主更新 ----------
  function update(dt, now, player, mods) {
    // mods: { blue: {bleedFactor, speedFactor}, red: {...} } 背水一战增益
    for (const bot of bots) {
      // 命中闪红衰减
      for (const m of bot.meshes) {
        if (m.userData.flashT > 0) {
          m.userData.flashT -= dt;
          m.material.emissiveIntensity = Math.max(0, m.userData.flashT / 0.18);
        }
      }
      if (bot.mixer) bot.mixer.update(dt);

      if (!bot.alive) {
        bot.deathT += dt;
        bot.respawnT -= dt;
        if (!bot.mixer && bot.fallT < 1) {
          // 无动画回退：倒地动画（与假人一致）
          bot.fallT = Math.min(1, bot.fallT + dt / 0.6);
          const e = 1 - Math.pow(1 - bot.fallT, 3);
          bot.group.rotation.x = -1.52 * e;
        }
        if (bot.deathT > 1.2) bot.group.visible = false;
        if (bot.respawnT <= 0) {
          const spawns = SPAWNS[bot.team];
          const sp = spawns[Math.floor(Math.random() * spawns.length)];
          resetBot(bot, [sp[0] + (Math.random() - 0.5) * 1.5, sp[1] + (Math.random() - 0.5) * 1.5]);
        }
        continue;
      }

      const mod = (mods && mods[bot.team]) || { bleedFactor: 1, speedFactor: 1 };

      // 失血滴答：累积到模块毁伤，头/胸模块毁伤致死（记最近攻击者）
      const tick = tickBleed(bot.bleed, dt, BLEED_TICK_RATE * mod.bleedFactor);
      let bledOut = false;
      for (const zone of Object.keys(tick.added)) {
        bot.integrity[zone] -= tick.added[zone];
        if (bot.integrity[zone] <= 0 && !bot.destroyed.has(zone)) {
          destroyZone(bot, zone);
          if (zone === 'head' || zone === 'chest') bledOut = true;
        }
      }
      if (bledOut) {
        const recent = now - bot.lastAttackerT < 10 ? bot.lastAttacker : null;
        killBot(bot, recent);
        continue;
      }
      if (bot.hitT > 0) bot.hitT -= dt;

      // 感知（错峰）与交战决策
      bot.perceptT += dt;
      if (combatEnabled && bot.perceptT >= PERCEPT_INTERVAL) {
        bot.perceptT = Math.random() * 0.05;
        perceive(bot, now, player);
      }
      if (!combatEnabled && bot.state === 'engage') {
        bot.state = 'patrol';
        bot.target = null;
        bot.burstLeft = 0;
      }

      const patrolSpeed = 2.4 * mod.speedFactor;
      const engageSpeed = 3.2 * mod.speedFactor;
      let moving = false;
      let running = false;

      if (bot.state === 'engage' && bot.target && combatEnabled) {
        // 目标位置
        let tx, tz, tDist;
        if (bot.target.kind === 'player') {
          tx = player.pos.x;
          tz = player.pos.z;
        } else {
          tx = bot.target.bot.group.position.x;
          tz = bot.target.bot.group.position.z;
        }
        tDist = Math.hypot(tx - bot.group.position.x, tz - bot.group.position.z);
        faceToward(bot, tx, tz, dt);

        // 反应延迟过后才开火
        if (bot.reactionT > 0) bot.reactionT -= dt;
        // 换弹
        if (bot.reloadT > 0) {
          bot.reloadT -= dt;
          if (bot.reloadT <= 0) bot.magLeft = 30;
        } else if (bot.reactionT <= 0) {
          if (bot.burstLeft > 0) {
            bot.shotT -= dt;
            if (bot.shotT <= 0) {
              botShoot(bot, now, player);
              bot.magLeft -= 1;
              bot.burstLeft -= 1;
              bot.shotT = 0.11;
              if (bot.magLeft <= 0) {
                bot.reloadT = 1.8;
                bot.burstLeft = 0;
              } else if (bot.burstLeft <= 0) {
                bot.pauseT = 0.45 + Math.random() * 0.4;
              }
            }
          } else if (bot.pauseT > 0) {
            bot.pauseT -= dt;
          } else {
            bot.burstLeft = 3 + Math.floor(Math.random() * 3);
            bot.shotT = 0;
          }
        }

        // 走位：太远则向目标靠近（沿路径点），否则绕锚点横移
        if (tDist > 35) {
          const destNode = nearestNode(graph.nodes, tx, tz);
          const fromNode = nearestNode(graph.nodes, bot.group.position.x, bot.group.position.z);
          if (fromNode !== destNode) {
            const path = bfsPath(graph.adj, fromNode, destNode);
            if (path && path.length > 1) {
              const wp = graph.nodes[path[1]];
              moveToward(bot, wp.x, wp.z, engageSpeed, dt);
              moving = true;
              running = true;
            }
          } else {
            moveToward(bot, tx, tz, engageSpeed, dt);
            moving = true;
            running = true;
          }
        } else {
          bot.strafeT += dt;
          if (bot.strafeT > 1.2 + Math.random() * 0.8) {
            bot.strafeT = 0;
            bot.strafeDir *= -1;
          }
          // 横移目标：锚点 ± 垂直方向 1.5m，探障后取可行点
          const fx = Math.sin(bot.yaw);
          const fz = Math.cos(bot.yaw);
          const px = -fz * bot.strafeDir * 1.5;
          const pz = fx * bot.strafeDir * 1.5;
          const sx = bot.strafeAnchor.x + px;
          const sz = bot.strafeAnchor.z + pz;
          if (!pointBlocked(colliders, sx, sz, 0.4)) {
            moveToward(bot, sx, sz, engageSpeed * 0.7, dt);
            moving = true;
          }
          // 锚点漂移：跟随目标慢慢前移，避免原地横移一整场
          bot.strafeAnchor.x += (bot.group.position.x - bot.strafeAnchor.x) * Math.min(1, dt * 0.3);
          bot.strafeAnchor.z += (bot.group.position.z - bot.strafeAnchor.z) * Math.min(1, dt * 0.3);
        }
      } else {
        // 巡逻：沿路径点移动，到达后随机选下一个
        if (bot.idleT > 0) {
          bot.idleT -= dt;
        } else if (bot.pathIdx < bot.path.length) {
          const wp = graph.nodes[bot.path[bot.pathIdx]];
          if (moveToward(bot, wp.x, wp.z, patrolSpeed, dt)) {
            bot.pathIdx += 1;
            if (bot.pathIdx >= bot.path.length) {
              bot.idleT = 1 + Math.random() * 2;
              pickDestination(bot);
            }
          }
          moving = true;
        } else {
          pickDestination(bot);
        }
        // 受伤后往最后已知位置看一眼（转火意识）
        if (bot.lastKnownT > 0 && now - bot.lastAttackerT < 3 && bot.state === 'patrol') {
          faceToward(bot, bot.lastKnown.x, bot.lastKnown.z, dt);
        }
      }

      // 卡住检测：2s 内移动不足 0.3m → 换目标点
      bot.stuckCheckT += dt;
      if (bot.stuckCheckT > 2) {
        bot.stuckCheckT = 0;
        const moved = Math.hypot(bot.group.position.x - bot.lastPos.x, bot.group.position.z - bot.lastPos.z);
        if (moving && moved < 0.3) {
          bot.stuckT += 1;
          pickDestination(bot);
          bot.strafeDir *= -1;
        } else {
          bot.stuckT = 0;
        }
        bot.lastPos.copy(bot.group.position);
      }

      // 机器人之间分离：避免重叠穿模
      for (const other of bots) {
        if (other === bot || !other.alive) continue;
        const dx = bot.group.position.x - other.group.position.x;
        const dz = bot.group.position.z - other.group.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.8 && d > 0.001) {
          const push = (0.8 - d) * 0.5;
          bot.group.position.x += (dx / d) * push;
          bot.group.position.z += (dz / d) * push;
        }
      }

      // 与玩家保持距离：机器人不许站进玩家身体里（出生点路径点 [0,40]
      // 与玩家出生点重合，巡逻机器人会直接走到玩家脸上、挡住整个视野）。
      // 玩家不主动让位，所以全额推出；0.9m 仍在到达半径（1.0m）之内，
      // 机器人路过玩家脚下的路径点时不会被卡住。
      if (player.alive) {
        const dx = bot.group.position.x - player.pos.x;
        const dz = bot.group.position.z - player.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.9) {
          if (d > 0.001) {
            bot.group.position.x = player.pos.x + (dx / d) * 0.9;
            bot.group.position.z = player.pos.z + (dz / d) * 0.9;
          } else {
            bot.group.position.x = player.pos.x + 0.9;
          }
        }
      }

      bot.speed = moving ? (running ? engageSpeed : patrolSpeed) : 0;
      bot.collider.x = bot.group.position.x;
      bot.collider.z = bot.group.position.z;

      // 动画选择：受击 > 开火 > 移动（走/跑）> 待机；无动画时程序化摆动
      if (bot.mixer) {
        if (bot.hitT > 0 && bot.actions.hit) playAction(bot, 'hit');
        else if (bot.burstLeft > 0 && bot.actions.shoot) playAction(bot, 'shoot');
        else if (moving && running && bot.actions.run) playAction(bot, 'run');
        else if (moving && bot.actions.walk) playAction(bot, 'walk');
        else if (bot.actions.idle) playAction(bot, 'idle');
      } else if (moving) {
        bot.bobT += dt * 6;
        bot.group.position.y = Math.abs(Math.sin(bot.bobT)) * 0.03;
      } else {
        bot.group.position.y = 0;
      }
    }
  }

  function spawnAll() {
    // 幂等：再来一局时先清掉上一场的机器人，否则人数会翻倍。
    dispose();
    for (let i = 0; i < BOT_NAMES.blue.length; i++) {
      const bot = makeBot('blue', i);
      resetBot(bot, SPAWNS.blue[i]);
    }
    for (let i = 0; i < BOT_NAMES.red.length; i++) {
      const bot = makeBot('red', i);
      resetBot(bot, SPAWNS.red[i]);
    }
  }

  function dispose() {
    for (const bot of bots) {
      if (bot.mixer) {
        for (const a of Object.values(bot.actions)) a.stop();
      }
      parent.remove(bot.group);
      for (const d of bot.disposables) {
        if (d && d.dispose) d.dispose();
      }
    }
    bots.length = 0;
    hitMeshes.length = 0;
    botColliders.length = 0;
  }

  function setCombatEnabled(v) {
    combatEnabled = v;
  }

  // 调试用：路径点净空与连通性检查（改地图后必跑）。
  function checkWaypoints() {
    const badNodes = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      if (pointBlocked(colliders, graph.nodes[i].x, graph.nodes[i].z, EDGE_CLEAR_MARGIN)) {
        badNodes.push({ index: i, x: graph.nodes[i].x, z: graph.nodes[i].z });
      }
    }
    const isolated = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      if (graph.adj[i].length === 0) isolated.push(i);
    }
    // 连通分量（BFS）
    const seen = new Set();
    const components = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      if (seen.has(i)) continue;
      const comp = [];
      const queue = [i];
      seen.add(i);
      while (queue.length > 0) {
        const cur = queue.shift();
        comp.push(cur);
        for (const nb of graph.adj[cur]) {
          if (!seen.has(nb)) {
            seen.add(nb);
            queue.push(nb);
          }
        }
      }
      components.push(comp);
    }
    return {
      nodeCount: graph.nodes.length,
      edgeCount: graph.adj.reduce((n, a) => n + a.length, 0) / 2,
      badNodes,
      isolated,
      components: components.map((c) => c.length),
    };
  }

  return {
    bots,
    hitMeshes,
    botColliders,
    graph,
    update,
    spawnAll,
    dispose,
    setCombatEnabled,
    applyPlayerHit,
    zoneAtPoint,
    checkWaypoints,
    getBots() {
      return bots.map((b) => ({
        id: b.id,
        team: b.team,
        name: b.name,
        x: +b.group.position.x.toFixed(1),
        z: +b.group.position.z.toFixed(1),
        state: b.state,
        alive: b.alive,
        integrity: { ...b.integrity },
        gear: { ...b.gear },
        bleeding: bleedingZones(b.bleed),
        hasTarget: !!b.target,
      }));
    },
  };
}
