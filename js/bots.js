// 机器人 AI：9 名机器人（蓝队 4 名队友 + 红队 5 名敌人），只在团队死斗中出现。
// 士兵 GLB + 骨骼动画（Walk/Run/Shoot/Death/RecieveHit），路径点寻路（BFS），
// 感知（距离 + 视野角 + 视线遮挡，错峰检测）→ 交战（横移 + 短点射 + 反应延迟）
// → 受伤反应 → 死亡/重生。机器人与玩家走同一套毁伤/失血/防具管线
// （damage.js / bleeding.js / armor.js），只是没有血条：部位模块毁伤累积，
// 头/胸模块损毁即阵亡。
//
// v0.14 战术层（Ryan 定方向：更聪明，不改数值——命中率/反应延迟/毁伤
// 一字不动，只改走位决策）：掩体探头循环（藏身→探头短点射→缩回）、
// 小队包抄（2 打 1 时一人牵制一人绕侧）、残血撤退 + 掩体后包扎、
// 目标失联后迂回搜寻、目标分配（不全队集火一人）、换弹先找掩体、
// 同队散开队形。全部走同一套移动/动画系统（缓动速度/交叉淡化/侧倾），
// 不新增硬切。
//
// 队伍识别：蓝队用蓝色士兵模型，红队用绿色士兵模型染红（只染制服/头盔
// 材质，皮肤与面部不动），另加双肩队色臂章 + 脚下队色光环——30m 外也能
// 一眼认出敌我。没有悬浮标记（Ryan 不要）。

import * as THREE from 'three';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';
import { evaluateHit, ZONE_LABELS } from './damage.js?v=0.14';
import {
  createBleedState,
  rollBleed,
  tickBleed,
  stopBleed,
  clearBleeds,
  bleedingZones,
  BLEED_TICK_RATE,
} from './bleeding.js?v=0.14';
import { createGearState, applyGearHit, GEAR_LABELS } from './armor.js?v=0.14';

// 士兵模型部位判定带：与 targets.js 的 ZONE_BANDS / SOLDIER_OFFSET 完全一致，
// 两边改一边必须同步（同一模型、同一 Idle 姿态）。
const ZONE_BANDS = { headY: 1.48, chestY: 1.05, abdomenY: 0.62, armX: 0.27, armY0: 0.6, armY1: 1.45 };
const SOLDIER_OFFSET = new THREE.Vector3(-0.048, 0, 0.165);
// 士兵 clip 的自然移动速度（实测 GLB 动画数据：脚掌 Z 向跨度 / clip 时长；
// clip 本身无根运动，Bone 根节点位移恒定）：Walk 1.09m/1.25s，Run 1.33m/0.88s。
// 播放速率 = 地面速度 / 自然速度，脚掌不再相对地面滑行。
const WALK_NATURAL_SPEED = 0.87;
const RUN_NATURAL_SPEED = 1.51;

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
const BOT_BANDAGE_TIME = 2.5; // 机器人包扎读条（秒），与玩家同一时长
const RETREAT_INTEGRITY = 0.35; // 完整度跌破此值触发撤退（边沿触发，见 retreatNeeded）
const FIRE_FRESHNESS = 0.6; // 目标失联超此时长不许开火（防隔墙射击；感知每 0.2s 刷新）

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

// 从某节点出发的 BFS 可达集合（包抄目的地筛选：一次 BFS 供全部候选点复用）。
function reachableSet(adj, from) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nb of adj[cur]) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  return seen;
}

// ---------- 掩体点 ----------
// 开局从碰撞体预计算一次：每个“够高够宽”的障碍物（矮墙/木箱/路障/
// 沙袋/汽车/垃圾箱/花坛/房间墙体）四周生成站位点，机器人交战/撤退时
// 就近选用。点位本身不保证有效——是否真能挡住某个敌人的视线，由
// 决策时用现有 LOS 射线现测（findCover），不预计算（敌人位置每帧在变）。
// reservedBy：同一掩体点只许一名机器人占用，避免全队挤一个木箱后。
const COVER_MIN_TOP = 0.9;
const COVER_STANDOFF = 0.95; // 站位点离障碍物表面的距离（机器人半径 0.4 + 余量）
function buildCoverPoints(colliders, graph) {
  const points = [];
  let id = 0;
  const tryAdd = (x, z, cx, cz, top) => {
    if (Math.abs(x) > 43 || Math.abs(z) > 43) return;
    if (pointBlocked(colliders, x, z, 0.4)) return;
    // 可达性：离某个路径点 ≤4m，或与最近路径点之间无高大障碍物——
    // 否则点在房间深处/墙后，机器人走不过去还会被卡住检测反复折腾。
    const nn = nearestNode(graph.nodes, x, z);
    const nd = Math.hypot(graph.nodes[nn].x - x, graph.nodes[nn].z - z);
    if (nd > 4 && !segmentClear(colliders, graph.nodes[nn].x, graph.nodes[nn].z, x, z, 0.4, 1.4, true)) return;
    points.push({ id: id++, x, z, cx, cz, top, reservedBy: null });
  };
  for (const c of colliders) {
    const top = c.top ?? 99;
    if (top < COVER_MIN_TOP) continue;
    if (c.type === 'aabb') {
      const w = c.maxX - c.minX;
      const d = c.maxZ - c.minZ;
      if (Math.min(w, d) < 0.4) continue;
      const cx = (c.minX + c.maxX) / 2;
      const cz = (c.minZ + c.maxZ) / 2;
      // 每面沿边长每 ~2.5m 一个点
      const nx = Math.max(1, Math.round(w / 2.5));
      const nz = Math.max(1, Math.round(d / 2.5));
      for (let i = 0; i < nx; i++) {
        const x = c.minX + ((i + 0.5) / nx) * w;
        tryAdd(x, c.minZ - COVER_STANDOFF, cx, cz, top);
        tryAdd(x, c.maxZ + COVER_STANDOFF, cx, cz, top);
      }
      for (let i = 0; i < nz; i++) {
        const z = c.minZ + ((i + 0.5) / nz) * d;
        tryAdd(c.minX - COVER_STANDOFF, z, cx, cz, top);
        tryAdd(c.maxX + COVER_STANDOFF, z, cx, cz, top);
      }
    } else if (c.type === 'circle') {
      if (c.r < 0.4) continue;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        tryAdd(c.x + Math.cos(a) * (c.r + COVER_STANDOFF), c.z + Math.sin(a) * (c.r + COVER_STANDOFF), c.x, c.z, top);
      }
    }
  }
  return points;
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
  const coverPoints = buildCoverPoints(colliders, graph);
  const bots = [];
  const hitMeshes = [];
  const botColliders = [];
  const raycaster = new THREE.Raycaster();
  let combatEnabled = true;
  let coordT = 0; // 小队角色分配节流计时（1s 一次）

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
    let soldierClone = null; // 骨骼模型克隆体（绑枪到右手骨骼用）
    const actions = {};
    const botMeshes = [];
    const baseColors = [];

    if (model) {
      const clone = skClone(model);
      soldierClone = clone;
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
    // 手持步枪（装饰）：绑到右手骨骼 FistR 上，随手臂摆动/举枪一起动。
    // v0.12 把枪固定在躯干前方，播走/跑动画时手臂甩动而枪悬空不动，
    // 像一块浮在胸前的板子，是“诡异感”的来源之一。程序化方块人没有
    // 骨骼，退回躯干固定位。枪身局部 +Z 为枪口方向，贴着拳头握把处。
    const gunGroup = new THREE.Group();
    const gunBody = new THREE.Mesh(gunBodyGeo, gunMat);
    gunBody.position.set(0, 0, 0.1);
    gunBody.frustumCulled = false;
    gunGroup.add(gunBody);
    const gunBarrel = new THREE.Mesh(gunBarrelGeo, gunMat);
    gunBarrel.rotation.x = Math.PI / 2;
    gunBarrel.position.set(0, 0.01, 0.47);
    gunBarrel.frustumCulled = false;
    gunGroup.add(gunBarrel);
    const gunMag = new THREE.Mesh(gunMagGeo, gunMat);
    gunMag.position.set(0, -0.09, 0.08);
    gunMag.frustumCulled = false;
    gunGroup.add(gunMag);
    const fist = soldierClone ? soldierClone.getObjectByName('FistR') : null;
    if (fist) {
      // 拳头骨骼局部坐标：枪身沿前臂方向握持（视觉迭代后定，见截图验证）
      gunGroup.position.set(0, -0.03, 0.02);
      gunGroup.rotation.set(Math.PI / 2, 0, 0);
      fist.add(gunGroup);
    } else {
      gunGroup.position.set(0.18, 1.28, 0.32);
      group.add(gunGroup);
    }

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
      speed: 0, // 当前地面速度（缓动后的值，动画重定时用它）
      moveSpeed: 0, // 缓动后的移动速度：起步/刹车有加速度，不再瞬间满速
      yawVel: 0, // 当前角速度（rad/s）：转身有加速/减速过程
      roll: 0, // 当前身体侧倾（rad）：转身/横移时程序化内倾，软化 clip 僵直
      strafing: false, // 本帧是否在横移（侧倾方向用）
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
      // 战术状态（v0.14）：掩体/包抄/撤退/包扎，见 update 里的决策分支。
      // state 扩展：patrol | engage | retreat | bandage | dead；包抄/搜寻
      // 是 engage 内的子模式（role / hunting），不另开状态。
      role: null, // 'pin' 牵制 | 'flank' 包抄 | null
      flankDest: null, // {x, z} 包抄目的地
      flankTargetKey: null,
      flankArrived: false,
      flankAnchor: null, // {x, z} 指派包抄时目标的位置；目标跑远即过期重评
      cover: null, // { point, phase: 'hidden'|'peek', phaseT, peekSide, peekPos, staleT, fired }
      coverDecideT: 0,
      hunting: false, // 目标失联后向最后已知位置迂回搜寻中
      retreatDest: null, // {x, z, point} 撤退目的地（point 为占用的掩体点或 null）
      retreatThreat: null, // 撤退时面对的威胁位置（包扎时朝向用）
      bandageT: 0,
      bandageInterrupts: 0,
      bandageSeq: 0,
      hitSeq: 0, // 累计受击次数（包扎打断检测用）
      prevMinI: 1, // 上一帧的最低部位完整度（撤退边沿触发用）
      lastRetreatDestroyed: 0, // 上次撤退时已损毁的模块数（新损毁触发用）
      retreatCooldownUntil: 0,
      reloadMove: null, // 换弹前先跑到的掩体点（占用中）
      alertCover: null, // 巡逻受袭后先去的掩体点（占用中）
    };
    for (const m of botMeshes) m.userData.bot = bot;
    bots.push(bot);
    return bot;
  }

  function resetBot(bot, spawnPoint) {
    releaseTactical(bot); // 先释放上一条命占用的掩体点，再复位字段
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
    bot.role = null;
    bot.flankDest = null;
    bot.flankTargetKey = null;
    bot.flankArrived = false;
    bot.flankAnchor = null;
    bot.cover = null;
    bot.coverDecideT = 0;
    bot.hunting = false;
    bot.retreatDest = null;
    bot.retreatThreat = null;
    bot.bandageT = 0;
    bot.bandageInterrupts = 0;
    bot.bandageSeq = 0;
    bot.hitSeq = 0;
    bot.prevMinI = 1;
    bot.lastRetreatDestroyed = 0;
    bot.retreatCooldownUntil = 0;
    bot.reloadMove = null;
    bot.alertCover = null;
    bot.group.visible = true;
    bot.group.rotation.x = 0;
    bot.group.rotation.y = 0;
    bot.group.rotation.z = 0;
    bot.moveSpeed = 0;
    bot.yawVel = 0;
    bot.roll = 0;
    bot.strafing = false;
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

  // 动作切换一律交叉淡化，永不硬切：待机/走/跑之间 0.25s（腿的相位
  // 错开时靠淡化抹平，不抽帧）；受击/开火/倒地 0.12s（反应要跟手，但
  // 仍有淡化，不闪一下）。Ryan 说的“生硬”一半来自这里。
  const LOCO_ACTIONS = new Set(['idle', 'walk', 'run']);
  function playAction(bot, name) {
    if (!bot.mixer || !bot.actions[name] || bot.currentAction === name) return;
    const prev = bot.currentAction && bot.actions[bot.currentAction];
    const next = bot.actions[name];
    if (prev && prev !== next) {
      const dur = LOCO_ACTIONS.has(bot.currentAction) && LOCO_ACTIONS.has(name) ? 0.25 : 0.12;
      next.reset().setEffectiveWeight(1).play();
      next.crossFadeFrom(prev, dur, false);
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
    releaseTactical(bot); // 倒地即释放掩体占用，队友可以接手这个点
    bot.alive = false;
    bot.state = 'dead';
    bot.deathT = 0;
    bot.respawnT = RESPAWN_TIME;
    bot.target = null;
    bot.burstLeft = 0;
    bot.collider.r = 0.01;
    bot.collider.top = 0; // 倒地不挡人
    bot.moveSpeed = 0;
    bot.yawVel = 0;
    bot.roll = 0;
    bot.strafing = false;
    bot.group.rotation.z = 0; // 倒地时身体回正，不带着侧倾躺下
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
    bot.hitT = 0.45; // 受击 clip 0.62s：0.3s 切走会把反应动作拦腰截断，看着抽搐
    bot.hitSeq += 1; // 包扎打断检测：包扎期间 hitSeq 变化即被打断
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
    // 受伤即转火：正在巡逻的机器人立刻注意到攻击者方向，并就近找掩体
    // （v0.14：挨打不再站着发呆——先缩到掩体后再感知还击）。
    if (bot.state === 'patrol' && attacker) {
      bot.lastKnownT = performance.now() / 1000;
      if (attacker.pos) {
        bot.lastKnown.copy(attacker.pos);
        if (!bot.alertCover) {
          const p = findCover(bot, attacker.pos, 12, 'hide');
          if (p) {
            p.reservedBy = bot.id;
            bot.alertCover = p;
          }
        }
      }
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

  // ---------- 战术辅助（v0.14） ----------
  const _losFrom = new THREE.Vector3();
  const _losTo = new THREE.Vector3();
  // 两点之间视线是否被挡（复用 hasLineOfSight 的射线；太近时不存在掩体）。
  function losBlocked(fx, fz, tx, tz) {
    if (Math.hypot(tx - fx, tz - fz) < 1) return false;
    _losFrom.set(fx, 0, fz);
    _losTo.set(tx, 0, tz);
    return !hasLineOfSight(_losFrom, _losTo);
  }

  function releasePoint(p, bot) {
    if (p && p.reservedBy === bot.id) p.reservedBy = null;
  }
  function releaseCover(bot) {
    if (bot.cover) {
      releasePoint(bot.cover.point, bot);
      bot.cover = null;
    }
  }
  // 释放一条命占用的全部战术资源（死亡/重生/撤退时调用，防占用泄漏）。
  function releaseTactical(bot) {
    releaseCover(bot);
    if (bot.alertCover) {
      releasePoint(bot.alertCover, bot);
      bot.alertCover = null;
    }
    if (bot.reloadMove) {
      releasePoint(bot.reloadMove, bot);
      bot.reloadMove = null;
    }
    if (bot.retreatDest && bot.retreatDest.point) releasePoint(bot.retreatDest.point, bot);
    bot.retreatDest = null;
    bot.retreatThreat = null;
    bot.role = null;
    bot.flankDest = null;
    bot.flankTargetKey = null;
    bot.flankArrived = false;
    bot.flankAnchor = null;
  }

  // 探头位：从掩体点向“掩体→敌人”连线的垂直方向偏移，探出去必须能
  // 看见敌人（否则探头白搭）。两侧都试，返回第一个可行的位置与方向。
  function pickPeek(cv, tx, tz) {
    const px = cv.point.x;
    const pz = cv.point.z;
    const dx = tx - px;
    const dz = tz - pz;
    const d = Math.hypot(dx, dz) || 1;
    const perpX = -dz / d;
    const perpZ = dx / d;
    const sides = cv.peekSide >= 0 ? [1, -1] : [-1, 1];
    for (const side of sides) {
      // 1.6/2.2m 探不出长墙的墙角时再试 3.0m（仍需空地 + 通视验证）
      for (const off of [1.6, 2.2, 3.0]) {
        const x = px + perpX * side * off;
        const z = pz + perpZ * side * off;
        if (Math.abs(x) > 43 || Math.abs(z) > 43) continue;
        if (pointBlocked(colliders, x, z, 0.4)) continue;
        if (losBlocked(x, z, tx, tz)) continue;
        return { pos: new THREE.Vector3(x, 0, z), side };
      }
    }
    return null;
  }
  function peekSideWorks(p, threatPos) {
    return !!pickPeek({ point: p, peekSide: 1 }, threatPos.x, threatPos.z);
  }

  // 找掩体：离机器人最近的候选点中，挑一个“敌人看不见它”的点。
  // mode 'fight' 还要求至少一侧能探头开火；'hide' 只要求藏得住（撤退/
  // 包扎/换弹用）。验证次数封顶 8 次，决策节流 0.5s，不增加逐帧射线。
  // trace（可选，调试用）：记录候选点在各道关卡的淘汰数。
  function findCover(bot, threatPos, maxDist, mode, trace) {
    const bx = bot.group.position.x;
    const bz = bot.group.position.z;
    const cands = [];
    for (const p of coverPoints) {
      if (p.reservedBy && p.reservedBy !== bot.id) continue;
      const d = Math.hypot(p.x - bx, p.z - bz);
      if (d > maxDist) continue;
      cands.push({ p, d });
    }
    if (trace) trace.cands = cands.length;
    // 高掩体（墙/围栏/车辆，top ≥ 1.4m）优先：站姿胸线射线只有它们
    // 挡得住；矮箱子/路障的点排在后面，避免 8 个名额全耗在注定无效
    // 的矮掩体上。同类内仍按距离排序（就近找掩体）。
    cands.sort((a, b) => ((b.p.top >= 1.4) - (a.p.top >= 1.4)) || (a.d - b.d));
    let checked = 0;
    for (const { p } of cands) {
      if (checked >= 12) break;
      // 可达：与机器人之间无高大障碍物（矮道具靠 moveToward 临场绕开）
      if (!segmentClear(colliders, bx, bz, p.x, p.z, 0.4, 1.4, true)) {
        if (trace) trace.segFail++;
        continue;
      }
      checked++;
      if (!losBlocked(threatPos.x, threatPos.z, p.x, p.z)) {
        if (trace) trace.losFail++;
        continue;
      }
      if (mode === 'fight' && !peekSideWorks(p, threatPos)) {
        if (trace) trace.peekFail++;
        continue;
      }
      if (trace) trace.checked = checked;
      return p;
    }
    if (trace) trace.checked = checked;
    return null;
  }

  // 掩体决策（节流调用）：已有掩体先验证是否仍有效（敌人绕过来/战线
  // 转移就放弃），没有则就近找一个。太远（>35m）先靠近，不找掩体。
  // 包抄途中的机器人不找掩体——先到位，掩体到位后再说。
  function decideCover(bot, tx, tz, tDist) {
    if (bot.role === 'flank' && bot.flankDest && !bot.flankArrived) {
      releaseCover(bot);
      return;
    }
    if (bot.cover) {
      const cv = bot.cover;
      const dThreat = Math.hypot(cv.point.x - tx, cv.point.z - tz);
      const dBot = Math.hypot(cv.point.x - bot.group.position.x, cv.point.z - bot.group.position.z);
      if (dThreat > 35 || dBot > 18) {
        releaseCover(bot);
      } else if (cv.phase === 'hidden' && !losBlocked(tx, tz, cv.point.x, cv.point.z)) {
        releaseCover(bot); // 敌人已经能看见掩体点，这个点废了
      } else {
        return; // 掩体仍有效，保持
      }
    }
    if (tDist > 35) return;
    const p = findCover(bot, { x: tx, z: tz }, 14, 'fight');
    if (p) {
      p.reservedBy = bot.id;
      bot.cover = {
        point: p,
        phase: 'hidden',
        phaseT: 0.3 + Math.random() * 0.4,
        peekSide: Math.random() < 0.5 ? -1 : 1,
        peekPos: null,
        staleT: 0,
        fired: false,
      };
    }
  }

  // 当前威胁的实时位置：目标 > 最后已知位置 > 无。
  function threatPosOf(bot, player) {
    if (bot.target) {
      if (bot.target.kind === 'player') return player.alive ? player.pos : null;
      if (bot.target.bot.alive) return bot.target.bot.group.position;
    }
    if (bot.lastKnownT > 0) return bot.lastKnown;
    return null;
  }

  // 撤退触发（边沿触发，不用水平触发——完整度只降不升，水平触发会让
  // 残血机器人包扎完 8 秒又撤退，整场反复横跳）：
  // - 2 处以上失血（包扎能修好，修好后需重新挨打才再触发）；
  // - 最低完整度本帧跌破 35%（prevMinI 是上一帧的值）；
  // - 完整度已 <20% 且正在挨打（3s 内受过伤）；
  // - 新损毁一个模块且正在挨打（5s 内受过伤）。
  function retreatNeeded(bot, now, minI) {
    const bleeds = bleedingZones(bot.bleed).length;
    if (bleeds >= 2) return true;
    if (bot.prevMinI >= RETREAT_INTEGRITY && minI < RETREAT_INTEGRITY) return true;
    if (minI < 0.2 && now - bot.lastAttackerT < 3) return true;
    if (bot.destroyed.size > bot.lastRetreatDestroyed && now - bot.lastAttackerT < 5) return true;
    return false;
  }

  function startRetreat(bot, now, player) {
    releaseTactical(bot);
    bot.lastRetreatDestroyed = bot.destroyed.size;
    const threat = threatPosOf(bot, player);
    bot.retreatThreat = threat ? new THREE.Vector3(threat.x, 0, threat.z) : null;
    let dest = null;
    if (threat) dest = findCover(bot, threat, 20, 'hide');
    if (dest) {
      dest.reservedBy = bot.id;
      bot.retreatDest = { x: dest.x, z: dest.z, point: dest };
    } else {
      // 无可用掩体：退向己方半场——离威胁远、离出生侧近的路径点。
      const homeZ = bot.team === 'blue' ? 40 : -40;
      let bestNode = null;
      let bestScore = -Infinity;
      for (const n of graph.nodes) {
        const dBot = Math.hypot(n.x - bot.group.position.x, n.z - bot.group.position.z);
        if (dBot < 3) continue;
        const dHome = Math.hypot(n.x, n.z - homeZ);
        const dThreat = threat ? Math.hypot(n.x - threat.x, n.z - threat.z) : 0;
        const score = dThreat - dHome * 0.5 - dBot * 0.2;
        if (score > bestScore) {
          bestScore = score;
          bestNode = n;
        }
      }
      bot.retreatDest = bestNode ? { x: bestNode.x, z: bestNode.z, point: null } : null;
    }
    bot.state = 'retreat';
    bot.burstLeft = 0;
  }

  function endRetreat(bot, now, cooldown) {
    if (bot.retreatDest && bot.retreatDest.point) releasePoint(bot.retreatDest.point, bot);
    bot.retreatDest = null;
    bot.retreatThreat = null;
    bot.retreatCooldownUntil = now + cooldown;
    bot.bandageT = 0;
    if (bot.target && bot.target.kind === 'bot' && !bot.target.bot.alive) bot.target = null;
    bot.state = bot.target ? 'engage' : 'patrol';
    if (bot.state === 'patrol') pickDestination(bot);
    else bot.coverDecideT = 0; // 重返交战立刻找掩体
  }

  // 包抄目的地：与牵制者-目标连线的夹角 >60°、离目标 10~35m、且 BFS
  // 可达的路径点/掩体点；角度越大、离自己越近越好。
  function findFlankDest(bot, tPos, pinPos) {
    const ax = pinPos.x - tPos.x;
    const az = pinPos.z - tPos.z;
    const aLen = Math.hypot(ax, az) || 1;
    const from = nearestNode(graph.nodes, bot.group.position.x, bot.group.position.z);
    const reach = reachableSet(graph.adj, from);
    let best = null;
    const considerDest = (x, z) => {
      const dx = x - tPos.x;
      const dz = z - tPos.z;
      const d = Math.hypot(dx, dz);
      if (d < 10 || d > 35) return;
      const cosA = (ax * dx + az * dz) / (aLen * d);
      const angle = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
      if (angle < Math.PI / 3) return;
      if (!reach.has(nearestNode(graph.nodes, x, z))) return;
      const dBot = Math.hypot(x - bot.group.position.x, z - bot.group.position.z);
      if (dBot > 30) return; // 太远的包抄位没有意义：到位前战斗早结束了
      // 夹角优先，但路程惩罚要够重：36m 外的 173° 不如 15m 外的 90°。
      const score = angle - dBot * 0.07;
      if (!best || score > best.score) best = { x, z, angle, score };
    };
    for (const n of graph.nodes) considerDest(n.x, n.z);
    for (const p of coverPoints) {
      if (p.reservedBy && p.reservedBy !== bot.id) continue;
      considerDest(p.x, p.z);
    }
    return best;
  }

  // 小队角色分配（1s 一次）：同一目标有 2 名以上队友在打时，最近的牵制
  // （pin，正面施压），再挑一名包抄（flank，绕侧）；每目标最多一名包抄。
  // 目标死亡/更换、包抄者阵亡时重新评估；角色只影响走位，不改数值。
  function coordinateRoles(player) {
    const keyOf = (b) => (b.target.kind === 'player' ? 'player' : 'bot:' + b.target.bot.id);
    const livePosOf = (b) => {
      if (b.target.kind === 'player') return player.alive ? player.pos : null;
      return b.target.bot.alive ? b.target.bot.group.position : null;
    };
    for (const team of ['blue', 'red']) {
      const engagers = bots.filter((b) => b.alive && b.team === team && b.state === 'engage' && b.target);
      const groups = new Map();
      for (const b of engagers) {
        const k = keyOf(b);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(b);
      }
      // 目标已换的包抄者卸任（新目标重新评估）；目标跑远（>12m）则
      // 包抄目的地过期，同样卸任重评——否则包抄者永远追不上战线。
      for (const b of engagers) {
        if (b.role === 'flank' && b.flankTargetKey !== keyOf(b)) {
          b.role = null;
          b.flankDest = null;
          b.flankArrived = false;
          b.flankAnchor = null;
        } else if (b.role === 'flank' && b.flankAnchor) {
          const tp = livePosOf(b);
          if (tp && Math.hypot(tp.x - b.flankAnchor.x, tp.z - b.flankAnchor.z) > 12) {
            b.role = null;
            b.flankDest = null;
            b.flankArrived = false;
            b.flankAnchor = null;
          }
        }
      }
      for (const [key, group] of groups) {
        if (group.length < 2) continue;
        const tPos = livePosOf(group[0]);
        if (!tPos) continue;
        // 角色粘性：已有的牵制/包抄不轻易换人。按“最近者当牵制”每秒重
        // 选会换位震荡——包抄者跑近目标就变成最近者、被改任牵制丢掉目
        // 的地，两人反复换位谁也到不了位（实测）。只在空缺时补选。
        let pin = group.find((b) => b.role === 'pin');
        if (!pin) {
          group.sort(
            (a, b) =>
              Math.hypot(a.group.position.x - tPos.x, a.group.position.z - tPos.z) -
              Math.hypot(b.group.position.x - tPos.x, b.group.position.z - tPos.z)
          );
          pin = group[0];
          if (pin.role === 'flank') {
            pin.flankDest = null;
            pin.flankArrived = false;
            pin.flankAnchor = null;
          }
          pin.role = 'pin';
        }
        let flanker = group.find((b) => b !== pin && b.role === 'flank' && b.flankTargetKey === key);
        if (!flanker) {
          let bestBot = null;
          let bestDest = null;
          for (const b of group) {
            if (b === pin) continue;
            if (b.flankArrived) continue; // 刚包抄到位，先打仗，不立刻再派
            const dest = findFlankDest(b, tPos, pin.group.position);
            if (dest && (!bestDest || dest.score > bestDest.score)) {
              bestBot = b;
              bestDest = dest;
            }
          }
          if (bestBot) {
            flanker = bestBot;
            flanker.role = 'flank';
            flanker.flankTargetKey = key;
            flanker.flankDest = { x: bestDest.x, z: bestDest.z };
            flanker.flankArrived = false;
            flanker.flankAnchor = { x: tPos.x, z: tPos.z };
            releaseCover(flanker); // 包抄先动身，掩体到位后再找
          }
        }
        for (const b of group) {
          if (b !== pin && b !== flanker && b.role !== null) {
            b.role = null;
            b.flankDest = null;
            b.flankArrived = false;
            b.flankAnchor = null;
          }
        }
      }
      for (const b of engagers) {
        if (b.role === 'pin') {
          const g = groups.get(keyOf(b));
          if (!g || g.length < 2) b.role = null;
        }
      }
    }
  }

  // 沿路径点向目标推进（交战接近/迂回搜寻/包抄/撤退共用）：先 BFS 到
  // 目标最近节点，同一节点内直接走。faceMove=false 时脸留在敌人身上。
  function routeViaWaypoints(bot, tx, tz, speed, dt, faceMove = true) {
    const destNode = nearestNode(graph.nodes, tx, tz);
    const fromNode = nearestNode(graph.nodes, bot.group.position.x, bot.group.position.z);
    if (fromNode !== destNode) {
      const path = bfsPath(graph.adj, fromNode, destNode);
      if (path && path.length > 1) {
        const wp = graph.nodes[path[1]];
        moveToward(bot, wp.x, wp.z, easeSpeed(bot, speed, dt), dt, faceMove);
        return false;
      }
    }
    return moveToward(bot, tx, tz, easeSpeed(bot, speed, dt), dt, faceMove);
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
    // 候选：玩家 + 敌方机器人（全部过一遍，供目标分配挑选）。
    const candidates = [];
    const consider = (kind, obj, pos) => {
      const dx = pos.x - bot.group.position.x;
      const dz = pos.z - bot.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SIGHT_RANGE) return;
      // 视野角：正前方 110°；刚受过伤（3s 内）或极近（8m 内）则 360°
      const recentDamage = now - bot.lastAttackerT < 3;
      if (!recentDamage && dist > 8) {
        const fx = Math.sin(bot.yaw);
        const fz = Math.cos(bot.yaw);
        const cosA = (dx * fx + dz * fz) / Math.max(0.001, dist);
        if (Math.acos(Math.min(1, Math.max(-1, cosA))) > SIGHT_HALF_FOV) return;
      }
      if (!hasLineOfSight(bot.group.position, pos)) return;
      candidates.push({ kind, obj, dist, key: kind === 'player' ? 'player' : 'bot:' + obj.id });
    };
    // 玩家是蓝队：只有红队机器人把玩家当目标（蓝队队友不打自己人）。
    if (player.alive && bot.team === 'red') consider('player', null, player.pos);
    for (const other of bots) {
      if (other === bot || !other.alive || other.team === bot.team) continue;
      consider('bot', other, other.group.position);
    }
    if (candidates.length > 0) {
      // 目标分配（v0.14）：优先选没有队友在打的敌人，避免全队集火
      // 一个人、放着其他敌人不管；实在都有人打了就选最近的。
      const engagedKeys = new Set();
      for (const other of bots) {
        if (other === bot || !other.alive || other.team !== bot.team || !other.target) continue;
        engagedKeys.add(other.target.kind === 'player' ? 'player' : 'bot:' + other.target.bot.id);
      }
      candidates.sort((a, b) => a.dist - b.dist);
      const best = candidates.find((c) => !engagedKeys.has(c.key)) || candidates[0];
      const newTarget = best.kind === 'player' ? { kind: 'player' } : { kind: 'bot', bot: best.obj };
      const changed = !bot.target || bot.target.kind !== newTarget.kind ||
        (newTarget.kind === 'bot' && bot.target.bot !== newTarget.bot);
      if (changed) {
        bot.target = newTarget;
        bot.reactionT = 0.5 + Math.random() * 0.4;
        bot.strafeAnchor.copy(bot.group.position);
        bot.strafeT = 0;
        // 换目标了：旧掩体是冲旧目标找的，下一决策 tick 重新评估
        if (bot.cover) bot.coverDecideT = 0.2;
      }
      bot.targetLostT = 0;
      bot.hunting = false;
      bot.lastKnown.copy(best.kind === 'player' ? player.pos : best.obj.group.position);
      bot.lastKnownT = now;
      // 有活目标就不再需要受袭掩体（交战掩体决策接手）
      if (bot.alertCover) {
        releasePoint(bot.alertCover, bot);
        bot.alertCover = null;
      }
      // 只从巡逻转入交战：撤退/包扎中的机器人不被感知拽回战场
      if (bot.state === 'patrol') bot.state = 'engage';
    } else if (bot.target) {
      // 藏身掩体后时目标短暂不可见是正常的：冻结丢失计时（探头周期内
      // 不丢目标）；但藏超过 6s 目标早走了，放弃掩体重新感知。
      if (bot.cover && bot.cover.phase === 'hidden') {
        bot.targetLostT = Math.min(bot.targetLostT, 0.5);
        bot.cover.staleT += PERCEPT_INTERVAL;
        if (bot.cover.staleT > 6) releaseCover(bot);
      } else {
        bot.targetLostT += PERCEPT_INTERVAL;
        if (bot.cover) bot.cover.staleT = 0;
      }
      if (bot.targetLostT > 2.5 && bot.state === 'engage') {
        bot.target = null;
        bot.state = 'patrol';
        bot.burstLeft = 0;
        bot.hunting = false;
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
  // 速度缓动：起步加速度 5 m/s²（0 → 3m/s 约 0.6s），刹车 8 m/s²。
  // 机器人不再瞬间满速/瞬间定住，腿的摆动速率（重定时用 bot.speed）
  // 跟着速度一起起落，走→跑是加速过程不是换挡。
  function easeSpeed(bot, target, dt) {
    const rate = target > bot.moveSpeed ? 5 : 8;
    bot.moveSpeed += THREE.MathUtils.clamp(target - bot.moveSpeed, -rate * dt, rate * dt);
    return bot.moveSpeed;
  }

  // 二阶转向：角速度向“剩余角度 × 6”加速/减速（上限 maxRate），转身
  // 起步有加速、到位有减速，不再以恒定满速起停。bot.yawVel 同时驱动
  // 身体侧倾。没有转向指令的帧由主更新里的衰减把角速度归零。
  function turnToward(bot, targetYaw, dt, maxRate) {
    let dy = targetYaw - bot.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const desired = THREE.MathUtils.clamp(dy * 6, -maxRate, maxRate);
    bot.yawVel += THREE.MathUtils.clamp(desired - bot.yawVel, -14 * dt, 14 * dt);
    bot.yaw += bot.yawVel * dt;
    bot.group.rotation.y = bot.yaw;
  }

  const _moveDir = new THREE.Vector3();
  // faceMove=false 时不转向移动方向（交战横移：脸始终朝敌人，身体侧移；
  // 否则每帧 faceToward 与 moveToward 抢朝向，机器人边横移边扭头，看着诡异）。
  function moveToward(bot, tx, tz, speed, dt, faceMove = true) {
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
    // 朝向：二阶转向移动方向（横移时跳过，脸留在敌人身上）
    if (faceMove) turnToward(bot, Math.atan2(mx, mz), dt, 3.5);
    // 到达半径 1.0m：必须大于玩家排斥半径（0.9m），否则玩家站在路径点
    // 上时机器人会被排斥圈挡在到达半径之外、永远到不了。
    return dist < 1.0;
  }

  function faceToward(bot, tx, tz, dt) {
    const dx = tx - bot.group.position.x;
    const dz = tz - bot.group.position.z;
    if (Math.hypot(dx, dz) < 0.01) return;
    turnToward(bot, Math.atan2(dx, dz), dt, 4.5);
  }

  // ---------- 主更新 ----------
  function update(dt, now, player, mods) {
    // mods: { blue: {bleedFactor, speedFactor}, red: {...} } 背水一战增益
    // 小队角色分配（1s 一次）：牵制/包抄只在交战中评估
    coordT += dt;
    if (coordT >= 1.0) {
      coordT = 0;
      if (combatEnabled) coordinateRoles(player);
    }
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

      // 撤退判定（v0.14）：边沿触发，见 retreatNeeded；包扎完冷却期内不重复触发。
      const minI = Math.min(
        bot.integrity.head, bot.integrity.chest, bot.integrity.abdomen, bot.integrity.arm, bot.integrity.leg
      );
      if (
        combatEnabled &&
        (bot.state === 'engage' || bot.state === 'patrol') &&
        now > bot.retreatCooldownUntil &&
        retreatNeeded(bot, now, minI)
      ) {
        startRetreat(bot, now, player);
      }
      bot.prevMinI = minI;

      // 感知（错峰）与交战决策
      bot.perceptT += dt;
      if (combatEnabled && bot.perceptT >= PERCEPT_INTERVAL) {
        bot.perceptT = Math.random() * 0.05;
        perceive(bot, now, player);
      }
      if (!combatEnabled && bot.state !== 'patrol' && bot.state !== 'dead') {
        releaseTactical(bot);
        bot.state = 'patrol';
        bot.target = null;
        bot.burstLeft = 0;
      }

      // 无转向指令时角速度衰减归零（有指令的帧 turnToward 会重新加速）。
      bot.yawVel *= Math.max(0, 1 - 10 * dt);
      if (Math.abs(bot.yawVel) < 0.01) bot.yawVel = 0;

      // v0.13：随玩家移速同比例上调（巡逻 2.4 → 3.0、交战 3.2 → 4.0），
      // 否则玩家提速后机器人相对像在原地踏步。
      const patrolSpeed = 3.0 * mod.speedFactor;
      const engageSpeed = 4.0 * mod.speedFactor;
      let moving = false;
      bot.strafing = false;

      // ---------- 状态机：撤退 / 包扎 / 交战 / 巡逻 ----------
      if (bot.state === 'retreat') {
        // 撤退：向掩体/己方半场跑，不开火，面朝移动方向（逃离姿态）。
        if (bot.retreatDest) {
          routeViaWaypoints(bot, bot.retreatDest.x, bot.retreatDest.z, engageSpeed, dt, true);
          moving = true;
          const dDest = Math.hypot(bot.group.position.x - bot.retreatDest.x, bot.group.position.z - bot.retreatDest.z);
          if (dDest < 1.0) {
            bot.state = 'bandage';
            bot.bandageT = 0;
            bot.bandageSeq = bot.hitSeq;
            bot.bandageInterrupts = 0;
          }
        } else {
          bot.state = 'bandage';
          bot.bandageT = 0;
          bot.bandageSeq = bot.hitSeq;
          bot.bandageInterrupts = 0;
        }
      } else if (bot.state === 'bandage') {
        // 包扎：静止 2.5s 止住全部失血（与玩家同一时长与规则）；挨打即
        // 打断（hitSeq 变化），打断两次就不再坚持，带伤重返战场。
        if (bot.retreatThreat) faceToward(bot, bot.retreatThreat.x, bot.retreatThreat.z, dt);
        if (bot.hitSeq !== bot.bandageSeq) {
          bot.bandageInterrupts += 1;
          bot.bandageT = 0;
          bot.bandageSeq = bot.hitSeq;
          if (bot.bandageInterrupts >= 2) endRetreat(bot, now, 10);
        } else {
          bot.bandageT += dt;
          if (bot.bandageT >= BOT_BANDAGE_TIME) {
            clearBleeds(bot.bleed);
            endRetreat(bot, now, 8);
          }
        }
      } else if (bot.state === 'engage' && bot.target && combatEnabled) {
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

        // 掩体决策（节流）：已有掩体先验证有效性，没有则就近找
        bot.coverDecideT -= dt;
        if (bot.coverDecideT <= 0) {
          bot.coverDecideT = 0.5 + Math.random() * 0.3;
          decideCover(bot, tx, tz, tDist);
        }

        // 开火门控：目标失联超 0.6s 不许隔墙开火（掩体必须真能挡子弹）；
        // 藏身掩体后不射击；包抄途中远离目标时不射击（到位前不暴露）。
        let fireSuppressed = bot.targetLostT > FIRE_FRESHNESS;
        const flanking = bot.role === 'flank' && bot.flankDest && !bot.flankArrived;
        if (flanking && tDist >= 12) fireSuppressed = true;

        // 掩体探头相位推进（移动在走位段执行）
        if (bot.cover) {
          const cv = bot.cover;
          if (cv.phase === 'hidden') {
            fireSuppressed = true;
            cv.phaseT -= dt;
            if (cv.phaseT <= 0) {
              const peek = pickPeek(cv, tx, tz);
              if (peek) {
                cv.phase = 'peek';
                cv.phaseT = 1.6;
                cv.peekPos = peek.pos;
                cv.peekSide = peek.side;
                cv.fired = false;
              } else {
                releaseCover(bot); // 两侧都探不出去，这个掩体打不了仗
              }
            }
          } else {
            cv.phaseT -= dt;
            if (cv.phaseT <= 0 || (cv.fired && bot.burstLeft === 0 && bot.pauseT > 0)) {
              cv.phase = 'hidden';
              cv.phaseT = 0.4 + Math.random() * 0.5; // 缩回时长随机，不机械
              cv.peekSide *= -1; // 下次换另一侧探头
              cv.fired = false;
              // 缩回时验证掩体仍有效（敌人可能已绕到侧面）
              if (!losBlocked(tx, tz, cv.point.x, cv.point.z)) releaseCover(bot);
            }
          }
        }

        // 换弹前先找掩体：弹仓打空时若 6m 内有掩体，先跑过去再换弹
        if (bot.reloadMove) {
          fireSuppressed = true;
          const rp = bot.reloadMove;
          if (moveToward(bot, rp.x, rp.z, easeSpeed(bot, engageSpeed, dt), dt, false)) {
            bot.reloadT = 1.8;
            releasePoint(rp, bot);
            bot.reloadMove = null;
          }
          moving = true;
        }

        // 换弹
        if (bot.reloadT > 0) {
          bot.reloadT -= dt;
          if (bot.reloadT <= 0) bot.magLeft = 30;
        } else if (bot.reactionT <= 0 && !fireSuppressed) {
          if (bot.burstLeft > 0) {
            bot.shotT -= dt;
            if (bot.shotT <= 0) {
              botShoot(bot, now, player);
              if (bot.cover && bot.cover.phase === 'peek') bot.cover.fired = true;
              bot.magLeft -= 1;
              bot.burstLeft -= 1;
              bot.shotT = 0.11;
              if (bot.magLeft <= 0) {
                bot.burstLeft = 0;
                // 换弹纪律：已在掩体后就原地换，否则 6m 内有掩体先跑过去
                const atCover = bot.cover &&
                  Math.hypot(bot.cover.point.x - bot.group.position.x, bot.cover.point.z - bot.group.position.z) < 1.2;
                const nearCover = atCover ? null : findCover(bot, { x: tx, z: tz }, 6, 'hide');
                if (nearCover) {
                  nearCover.reservedBy = bot.id;
                  bot.reloadMove = nearCover;
                } else {
                  bot.reloadT = 1.8;
                }
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

        // 走位（换弹跑位已在上面处理过）
        if (bot.reloadMove) {
          // 本帧已在换弹分支移动过，不再叠加走位
        } else if (bot.cover) {
          const cv = bot.cover;
          if (cv.phase === 'hidden') {
            // 藏身：跑到掩体点后，脸朝敌人等探头时机
            moveToward(bot, cv.point.x, cv.point.z, easeSpeed(bot, engageSpeed, dt), dt, false);
            moving = true;
          } else if (cv.peekPos) {
            // 探头：侧移到探头位开火，脸始终朝敌人
            moveToward(bot, cv.peekPos.x, cv.peekPos.z, easeSpeed(bot, engageSpeed * 0.7, dt), dt, false);
            moving = true;
            bot.strafing = true;
          }
          // 掩体战不设横移锚点：退出掩体时锚点就在脚下，横移从当前位置起
          bot.strafeAnchor.copy(bot.group.position);
        } else if (flanking) {
          // 包抄：沿路径点跑向侧翼位置，到位后转回常规交战
          routeViaWaypoints(bot, bot.flankDest.x, bot.flankDest.z, engageSpeed, dt, true);
          moving = true;
          if (Math.hypot(bot.group.position.x - bot.flankDest.x, bot.group.position.z - bot.flankDest.z) < 1.5) {
            bot.flankArrived = true;
            bot.role = null;
            bot.flankDest = null;
            bot.coverDecideT = 0; // 到位后立刻找掩体开火
          }
        } else if (bot.targetLostT > 0.5 && now - bot.lastKnownT < 8) {
          // 目标失联：沿路径点向最后已知位置迂回搜寻，不再原地盯着墙
          bot.hunting = true;
          routeViaWaypoints(bot, bot.lastKnown.x, bot.lastKnown.z, engageSpeed, dt, true);
          moving = true;
        } else {
          bot.hunting = false;
          // 走位：太远则向目标靠近（沿路径点），否则绕锚点横移
          if (tDist > 35) {
            routeViaWaypoints(bot, tx, tz, engageSpeed, dt, true);
            moving = true;
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
              // 横移：脸朝敌人（本帧开头 faceToward 已转好），不转向移动方向
              moveToward(bot, sx, sz, easeSpeed(bot, engageSpeed * 0.7, dt), dt, false);
              moving = true;
              bot.strafing = true;
            }
            // 锚点漂移：跟随目标慢慢前移，避免原地横移一整场
            bot.strafeAnchor.x += (bot.group.position.x - bot.strafeAnchor.x) * Math.min(1, dt * 0.3);
            bot.strafeAnchor.z += (bot.group.position.z - bot.strafeAnchor.z) * Math.min(1, dt * 0.3);
          }
        }
      } else {
        // 巡逻：受袭后先去掩体（alertCover），再沿路径点移动，到达后随机选下一个
        if (bot.alertCover) {
          const p = bot.alertCover;
          if (moveToward(bot, p.x, p.z, easeSpeed(bot, patrolSpeed, dt), dt)) {
            releasePoint(p, bot);
            bot.alertCover = null;
          }
          moving = true;
        } else if (bot.idleT > 0) {
          bot.idleT -= dt;
        } else if (bot.pathIdx < bot.path.length) {
          const wp = graph.nodes[bot.path[bot.pathIdx]];
          if (moveToward(bot, wp.x, wp.z, easeSpeed(bot, patrolSpeed, dt), dt)) {
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

      // 卡住检测：2s 内移动不足 0.3m → 换目标点；战术目标（掩体/包抄/
      // 换弹跑位）走不过去就放弃，撤退走不过去就地包扎（总比站着强）。
      bot.stuckCheckT += dt;
      if (bot.stuckCheckT > 2) {
        bot.stuckCheckT = 0;
        const moved = Math.hypot(bot.group.position.x - bot.lastPos.x, bot.group.position.z - bot.lastPos.z);
        if (moving && moved < 0.3) {
          bot.stuckT += 1;
          pickDestination(bot);
          bot.strafeDir *= -1;
          if (bot.cover) {
            releaseCover(bot);
            bot.coverDecideT = 1.5;
          }
          if (bot.reloadMove) {
            releasePoint(bot.reloadMove, bot);
            bot.reloadMove = null;
            bot.reloadT = 1.8;
          }
          if (bot.role === 'flank') {
            bot.role = null;
            bot.flankDest = null;
          }
          if (bot.state === 'retreat') {
            bot.state = 'bandage';
            bot.bandageT = 0;
            bot.bandageSeq = bot.hitSeq;
            bot.bandageInterrupts = 0;
          }
        } else {
          bot.stuckT = 0;
        }
        bot.lastPos.copy(bot.group.position);
      }

      // 机器人之间分离：避免重叠穿模；同队额外保持 1.6m 散开队形，
      // 不扎堆挤在一个掩体后（掩体后静止/包扎中的不推，避免推出掩体）。
      for (const other of bots) {
        if (other === bot || !other.alive) continue;
        const dx = bot.group.position.x - other.group.position.x;
        const dz = bot.group.position.z - other.group.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.001) continue;
        const sameTeam = other.team === bot.team;
        const radius = sameTeam ? 1.6 : 0.8;
        if (d >= radius) continue;
        if (sameTeam) {
          const busy = (b) => b.state === 'bandage' || (b.cover && b.cover.phase === 'hidden');
          if (busy(bot) || busy(other)) continue;
        }
        const push = (radius - d) * (sameTeam ? 0.3 : 0.5);
        bot.group.position.x += (dx / d) * push;
        bot.group.position.z += (dz / d) * push;
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

      // 不移动的帧速度向 0 刹车；动画重定时与选 clip 都用缓动后的速度，
      // 所以起步/停步时腿的摆动是加速/减速过程，不是开关。
      if (!moving) easeSpeed(bot, 0, dt);
      bot.speed = bot.moveSpeed;
      bot.collider.x = bot.group.position.x;
      bot.collider.z = bot.group.position.z;

      // 程序化侧倾：转身时身体向转弯方向内倾，横移时向移动方向侧倾，
      // 幅度 ≤0.1rad（约 5°），只软化 clip 本身的僵直感。侧倾本身也
      // 缓动跟随，不跳变。转弯内倾符号经数值验证（77 个采样 roll 恒与
      // yawVel 反号）；横移顺倾符号按同一推导，headless 采样窗口内无
      // 横移样本，尚未实测（幅度仅 0.05rad，即使反号也只是一点晃动）。
      // 符号：rotation.z 为正时上身倒向角色右侧；yawVel 为正时朝向
      // 转向角色左侧，故转弯内倾取负号（与横移顺倾的符号推导不同）。
      const turnLean = THREE.MathUtils.clamp(-bot.yawVel * 0.04, -0.06, 0.06);
      const strafeLean = bot.strafing ? bot.strafeDir * 0.05 : 0;
      const targetRoll = THREE.MathUtils.clamp(turnLean + strafeLean, -0.1, 0.1);
      bot.roll += (targetRoll - bot.roll) * Math.min(1, 8 * dt);
      bot.group.rotation.z = bot.roll;

      // 动画选择：受击 > 开火 > 移动（走/跑）> 待机；无动画时程序化摆动
      // 播放速率按地面速度重定时：clip 是原地动画，脚掌 Z 向跨度 Walk 1.09m/
      // 1.25s（自然速度 0.87m/s）、Run 1.33m/0.88s（1.51m/s），按 1.0 速率播而
      // 地面以 3~4m/s 移动时，机器人以 2~3 倍腿速滑行（溜冰/鬼影感），这是
      // v0.12“移动动画诡异”的主因。速率 = 地面速度/自然速度，夹在 0.8~2.0。
      if (bot.mixer) {
        if (bot.hitT > 0 && bot.actions.hit) playAction(bot, 'hit');
        else if (bot.burstLeft > 0 && bot.actions.shoot) playAction(bot, 'shoot');
        else if (moving && bot.speed >= 2.0 && bot.actions.run) playAction(bot, 'run');
        else if (moving && bot.actions.walk) playAction(bot, 'walk');
        else if (bot.actions.idle) playAction(bot, 'idle');
        const loco = bot.currentAction === 'run' ? bot.actions.run
          : bot.currentAction === 'walk' ? bot.actions.walk : null;
        for (const a of Object.values(bot.actions)) {
          if (a === loco) {
            const natural = bot.currentAction === 'run' ? RUN_NATURAL_SPEED : WALK_NATURAL_SPEED;
            a.setEffectiveTimeScale(THREE.MathUtils.clamp(bot.speed / natural, 0.8, 2.0));
          } else {
            a.setEffectiveTimeScale(1);
          }
        }
      } else if (moving) {
        // 无动画回退：摆动频率/幅度随缓动速度走，停步时高度缓落回 0
        const speedNorm = Math.min(1, bot.moveSpeed / 3);
        bot.bobT += dt * (3 + 4 * speedNorm);
        bot.group.position.y = Math.abs(Math.sin(bot.bobT)) * 0.03 * speedNorm;
      } else {
        bot.group.position.y += (0 - bot.group.position.y) * Math.min(1, 8 * dt);
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
        action: b.currentAction,
        // 动画重定时调试：当前 clip 播放速率（= 地面速度/自然速度，夹 0.8~2.0）
        rate: b.currentAction && b.actions[b.currentAction]
          ? +b.actions[b.currentAction].getEffectiveTimeScale().toFixed(2) : null,
        speed: +b.speed.toFixed(2),
        yawVel: +b.yawVel.toFixed(2),
        roll: +b.roll.toFixed(3),
        strafing: b.strafing,
        alive: b.alive,
        integrity: { ...b.integrity },
        gear: { ...b.gear },
        bleeding: bleedingZones(b.bleed),
        hasTarget: !!b.target,
        // 战术调试（v0.14）：角色/掩体/包抄/包扎/搜寻状态
        role: b.role,
        coverId: b.cover ? b.cover.point.id : null,
        coverPhase: b.cover ? b.cover.phase : null,
        coverPoint: b.cover ? { x: +b.cover.point.x.toFixed(1), z: +b.cover.point.z.toFixed(1) } : null,
        bandaging: b.state === 'bandage',
        bandageT: +b.bandageT.toFixed(2),
        hunting: b.hunting,
        flankDest: b.flankDest ? { x: +b.flankDest.x.toFixed(1), z: +b.flankDest.z.toFixed(1) } : null,
        magLeft: b.magLeft,
        reloading: b.reloadT > 0,
        reloadMove: !!b.reloadMove,
        targetKey: !b.target ? null : b.target.kind === 'player' ? 'player' : 'bot:' + b.target.bot.id,
      }));
    },
    // 掩体点快照（验证用）：位置与占用情况。
    coverPoints() {
      return coverPoints.map((p) => ({
        id: p.id,
        x: +p.x.toFixed(2),
        z: +p.z.toFixed(2),
        top: +p.top.toFixed(2),
        reservedBy: p.reservedBy,
      }));
    },
    getColliders() {
      return colliders;
    },
    // 调试：对机器人当前目标跑一遍找掩体决策并返回淘汰统计（无副作用，
    // 不占用掩体点）。用于定位“附近有点却不找掩体”的原因。
    coverProbe(i) {
      const bot = bots[i];
      if (!bot || !bot.alive || !bot.target) return null;
      let tPos;
      if (bot.target.kind === 'player') {
        tPos = bot.lastKnown; // 玩家实时位置不在此作用域内，用最后已知位置
      } else {
        const tb = bot.target.bot;
        if (!tb.alive) return null;
        tPos = tb.group.position;
      }
      const tDist = Math.hypot(tPos.x - bot.group.position.x, tPos.z - bot.group.position.z);
      const trace = { cands: 0, checked: 0, segFail: 0, losFail: 0, peekFail: 0 };
      const found = tDist <= 35 ? findCover(bot, tPos, 14, 'fight', trace) : null;
      return {
        tDist: +tDist.toFixed(1),
        hasCover: !!bot.cover,
        role: bot.role,
        hunting: bot.hunting,
        ...trace,
        found: found ? found.id : null,
      };
    },
    // 调试：对机器人造成一次非致命命中（手臂/腿部，不触发 incapacitated），
    // 攻击者位置可指定（默认机器人正南 10m）。返回命中结果与机器人状态。
    hurtBot(i, zone, severity, ax, az) {
      const bot = bots[i];
      if (!bot || !bot.alive) return null;
      const pos = new THREE.Vector3(
        ax !== undefined ? ax : bot.group.position.x,
        0,
        az !== undefined ? az : bot.group.position.z + 10
      );
      const res = applyHit(
        bot,
        {
          zone,
          zoneLabel: ZONE_LABELS[zone] || zone,
          severity,
          outcomeLabel: '贯穿',
          incapacitated: false,
        },
        1,
        { team: 'blue', name: '测试员', isPlayer: true, pos }
      );
      return {
        ...res,
        alive: bot.alive,
        state: bot.state,
        integrity: { ...bot.integrity },
        bleeding: bleedingZones(bot.bleed),
      };
    },
    // 调试：传送机器人并清战术状态（掩体占用/角色/目标/冷却全复位）。
    // 可选 yaw：让脚本场景里的机器人一落地就面对对手。
    teleportBot(i, x, z, yaw) {
      const bot = bots[i];
      if (!bot) return;
      releaseTactical(bot);
      bot.group.position.set(x, 0, z);
      if (yaw !== undefined) {
        bot.yaw = yaw;
        bot.group.rotation.y = yaw;
      }
      bot.collider.x = x;
      bot.collider.z = z;
      bot.path = [];
      bot.pathIdx = 0;
      bot.lastPos.set(x, 0, z);
      bot.target = null;
      bot.targetLostT = 0;
      bot.state = bot.alive ? 'patrol' : 'dead';
      bot.retreatCooldownUntil = 0;
      bot.prevMinI = 1;
      bot.lastRetreatDestroyed = 0;
      bot.moveSpeed = 0;
      bot.yawVel = 0;
      bot.idleT = 0;
    },
    // 调试：设置机器人剩余弹药（换弹掩体测试用）。
    setBotMag(i, n) {
      const bot = bots[i];
      if (bot) bot.magLeft = n;
    },
    // 调试：回满机器人状态（完整度/防具/失血），不碰位置、目标与战术
    // 状态——用于把“走位机制”与“TTK 竞速”分开验证。
    healBot(i) {
      const bot = bots[i];
      if (!bot || !bot.alive) return;
      bot.integrity = { head: 1, chest: 1, abdomen: 1, arm: 1, leg: 1 };
      bot.destroyed.clear();
      bot.gear = createGearState();
      clearBleeds(bot.bleed);
      bot.prevMinI = 1;
      bot.lastRetreatDestroyed = 0;
    },
  };
}
