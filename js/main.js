// IMPASSE v0.14 —— 主循环：场景、射击判定、曳光/命中特效、计分、游戏状态。
// 渲染：Three.js（CDN）；输入：Pointer Lock + 触屏；毁伤：damage.js 纯函数；
// 失血：bleeding.js 纯函数（假人 + 玩家）；防具：armor.js 纯函数（包在毁伤
// 判定之前）；比赛：match.js 纯函数（计分 + 背水一战）；记录：records.js。
// 两张地图（靶场 + 城市街区）同场建造、按组切换可见性；团队死斗复用街区
// 环境，靶子隐藏、机器人上场。记录两张图共用，死斗胜负单独记。
// 素材（GLB/PBR/HDRI）由 assets.js 加载，加载完成（或超时回退）后才建造
// 地图与枪；任何一件素材失败都走程序化/纯色回退，游戏不受影响。
// 缓存策略：全部本地模块带 ?v=0.14 查询串，版本升级即换地址，避免新旧文件混版。

import * as THREE from 'three';
import { createControls } from './controls.js?v=0.14';
import { createGun, WEAPON_STATS, WEAPON_ORDER } from './gun.js?v=0.14';
import { createTargets, RANGE_LAYOUT, STREET_LAYOUT } from './targets.js?v=0.14';
import { createRange } from './range.js?v=0.14';
import { createStreet } from './street.js?v=0.14';
import { createHud } from './hud.js?v=0.14';
import { createAudio } from './audio.js?v=0.14';
import { createSettingsStore, initSettingsPanel, KEY_ACTIONS, keyLabel } from './settings.js?v=0.14';
import { createRecordsStore } from './records.js?v=0.14';
import { loadAssets } from './assets.js?v=0.14';
import { evaluateHit, evaluateRicochet, ZONE_LABELS } from './damage.js?v=0.14';
import {
  createBleedState,
  rollBleed,
  tickBleed,
  clearBleeds,
  bleedingZones,
  isBleeding,
  PLAYER_BLEED_TICK_RATE,
  COLLAPSE_THRESHOLD,
  IMMEDIATE_BLEED_FACTOR,
  bleedFraction,
  bleedSpeedFactor,
  bleedVignetteOpacity,
  bleedSwayAmplitude,
} from './bleeding.js?v=0.14';
import { createGearState, applyGearHit, gearStatus, GEAR_LABELS } from './armor.js?v=0.14';
import { createMatch, recordKill, buffModifiers, WIN_SCORE } from './match.js?v=0.14';
import { createBotManager } from './bots.js?v=0.14';

// 唯一版本号：由脚本写进主页的版本标签，显示的版本即脚本版本，
// 旧脚本缓存不会谎报新版本（HTML 里的占位文案只是加载前显示）。
const VERSION = '0.14';

// 移动速度（m/s）：v0.13 按 Ryan 反馈“移动太慢”上调——步行 3.4 → 4.25（+25%）、
// 疾跑 5.2 → 6.24（+20%）；机瞄 1.9 不动（战术慢速）。机器人速度在 bots.js
// 里同比例上调（巡逻 2.4 → 3.0、交战 3.2 → 4.0），避免玩家相对 AI 像开了加速。
const WALK_SPEED = 4.25;
const SPRINT_SPEED = 6.24;
const ADS_SPEED = 1.9;
const RELOAD_TIME = 1.8; // 步枪换弹时长（WEAPON_STATS.rifle.reloadTime 的镜像，初始值用）
const AUTO_INTERVAL = 0.1; // 600 RPM
const SEMI_INTERVAL = 0.14;
const EYE_HEIGHT = 1.6;
// 活动范围与出生点按地图走（各地图的 bounds/spawn）：靶场限制在射手区，
// 街区放开到整张图。不要在这里再写一份全局 BOUNDS。
const GRAVITY = 12; // m/s²
// 跳跃初速度 5.8 m/s：理论顶点 1.40m，60fps 半隐式积分实测约 1.35m。
// 障碍物顶面实测：隔板/油桶/纸靶架 1.1m、木箱 1.0m、钢板立柱 1.6m、假人 1.95m。
// 靶场活动范围被限制在射手区（z ≥ -1.5），区内仅有的两个障碍物就是
// 两块枪道隔板（1.1m）；木箱/油桶都在界外。顶点越过隔板留约 0.25m 余量，
// 走跳和疾跑跳都能过去；1.6m 的钢板立柱和 1.95m 的假人仍跳不过去。
// 街区同理：交通锥 0.72m、沙袋 0.8m、花坛 0.9m、路障 0.9–1.04m、木箱 1.0m、
// 垃圾箱 1.15m 可跳，汽车 ~1.5m、围栏 1.62m、集装箱 2.45m、墙体 3.2m 跳不过去。
const JUMP_VELOCITY = 5.8; // m/s
const BANDAGE_TIME = 2.5; // 包扎读条（秒）：键盘按住 B / 触屏点按包扎键开关；开火打断
const COLLAPSE_FADE_TIME = 0.9; // 倒地黑场时长（秒），黑满后重生
const RESPAWN_TIME = 3; // 团队死斗阵亡后重生倒计时（秒）
const KNIFE_DAMAGE_SCALE = 2.0; // 战术刀毁伤倍率：重型部位打击，两刀胸基本倒地
const BLEED_CREDIT_WINDOW = 15; // 玩家失血倒地时，15 秒内的最后攻击者记击杀
const COYOTE_TIME = 0.08; // 土狼时间：离地后 0.08s 内仍可起跳
const JUMP_BUFFER = 0.1; // 输入缓冲：落地前 0.1s 内的跳跃输入仍生效
// 头部摆动幅度上限（Ryan 反馈“抖动太小”后加大）：垂直 0.045m（峰峰值 0.09m）、
// 横向 0.02m、滚转 0.008rad；频率随移速走，幅度只到上限不再变大。
const BOB_VERT_AMP = 0.045;
const BOB_LAT_AMP = 0.02;
const BOB_ROLL_AMP = 0.008;

// ---------- 渲染器与场景 ----------
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.autoClear = false;
// 双通道渲染：主场景 + 视图模型场景分两次画，中间只清深度——
// 所以自动清空要关掉，由主循环显式控制（主场景背景色自带强制清空，
// 枪场景 background 为 null，不会误清主场景画面）。
// 阴影：只有街区的太阳投射阴影（1024 贴图），靶场的灯一律不投射，
// 开启阴影贴图对靶场没有额外开销。
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c20);
scene.fog = new THREE.Fog(0x1a1c20, 30, 55);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 160);
camera.rotation.order = 'YXZ';
scene.add(camera);

// 视图模型独立场景：枪/双手/绷带单独渲染，用与主镜头逐帧同步的第二台相机。
// 原因：three.js 按相机 layer 收集光源，layer 隔离挡不住世界点光源——
// 房间顶灯离枪约 1m、强度 22，会把浅色步枪照爆白；独立场景后枪只受
// 镜头补光 + HDRI 环境光影响。枪相机不同步（位置/朝向/FOV）枪就会与准星错位。
const gunScene = new THREE.Scene();
const gunCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 160);
gunCamera.rotation.order = 'YXZ';
gunScene.add(gunCamera);
// 枪相机必须挂进枪场景，否则枪组（枪相机的子级）不在渲染图里，
// 枪会直接消失——主场景里主相机同样是 scene.add(camera) 挂进去的。

// ---------- 地图：两张图同场建造，按组切换 ----------
// 每张地图的环境与靶子挂在同一个组里（靶子以环境组为 parent）：
// 切图 = 换组的 visible + 换射线/碰撞集合 + 换天空/雾。灯光挂在组里，
// 隐藏的组灯光自动失效，不重建。靶子 update 只跑当前地图的一套。
const hud = createHud();
const audio = createAudio();
const settings = createSettingsStore();
const recordsStore = createRecordsStore();
audio.preloadSamples(); // fire-and-forget：采样在后台解码，失败的那一声走合成回退
// 失血导致模块损毁时，targets 通过事件回调让主循环弹提示（两套靶子共用）。
// v0.13 起毁伤日志已删：模块损毁看假人变色 + 血泊，失能弹中央提示。
const onTargetEvent = (evt) => {
  if (evt.type === 'bleedDestroy') {
    if (evt.incapacitated) hud.toast('目标失能！');
  }
};
// 地图、靶子与枪在素材加载完成后才建造（见底部 init）：加载失败的模型
// 走程序化回退，建造参数按加载结果定。建造完成前 initialized 为 false，
// 开始按钮禁用、选图与开局都被挡住，主循环也不启动。
let rangeEnv = null;
let streetEnv = null;
let rangeTargets = null;
let streetTargets = null;
let MAPS = null;
let activeMapId = 'range';
let activeMap = null;
let allHitMeshes = [];
let colliders = [];
let gun = null;
let initialized = false;
let assetReport = null; // 素材加载结果摘要（调试钩子读取）
// 团队死斗：机器人管理器（首场比赛开始时创建）与比赛状态（每场比赛新建）。
let botManager = null;
let tdm = null;
// 机器人/比赛的素材（init 存下，首场比赛创建 botManager 时用）。
let soldierModels = null;
let soldierAnimations = null;

// 射线与碰撞集合按模式取舍：死斗时街区靶子隐藏，靶子的碰撞体与命中网格
// 也要排除（否则隐形靶子会挡路、吃子弹），换成机器人的网格与碰撞体。
function refreshHitSets() {
  if (activeMap.isTdm && botManager) {
    allHitMeshes = [...streetEnv.hitMeshes, ...botManager.hitMeshes];
    colliders = [...streetEnv.colliders, ...botManager.botColliders];
  } else {
    allHitMeshes = [...activeMap.env.hitMeshes, ...activeMap.targets.hitMeshes];
    colliders = [...activeMap.env.colliders, ...activeMap.targets.colliders];
  }
}
function setActiveMap(id) {
  activeMapId = id;
  activeMap = MAPS[id];
  // 死斗与街区共用同一个环境组：按环境组切换可见性，不能按 MAPS 条目
  // （两条目同组会互相覆盖 visible）。
  rangeEnv.group.visible = activeMap.env === rangeEnv;
  streetEnv.group.visible = activeMap.env === streetEnv;
  // 死斗时隐藏街区靶子（并复位，清除残留血滴）；切回街区时恢复显示。
  streetTargets.setVisible(!activeMap.isTdm);
  if (activeMap.isTdm) streetTargets.reset();
  refreshHitSets();
  document.body.classList.toggle('tdm', !!activeMap.isTdm);
  scene.background = activeMap.env.env.background;
  scene.fog = activeMap.env.env.fog;
  // 环境光与曝光按地图走：街区用 HDRI 环境贴图 + 曝光 1.0，靶场无环境光 + 1.05。
  scene.environment = activeMap.env.env.environment || null;
  renderer.toneMappingExposure = activeMap.env.env.exposure ?? 1.05;
}
function isTdmActive() {
  return !!(activeMap && activeMap.isTdm && tdm);
}

const controls = createControls({
  canvas,
  settings,
  elements: {
    joystickZone: document.getElementById('joystick-zone'),
    joystickBase: document.getElementById('joystick-base'),
    joystickKnob: document.getElementById('joystick-knob'),
    lookZone: document.getElementById('look-zone'),
    btnFire: document.getElementById('btn-fire'),
    btnFireAlt: document.getElementById('btn-fire-alt'),
    btnAim: document.getElementById('btn-aim'),
    btnReload: document.getElementById('btn-reload'),
    btnMode: document.getElementById('btn-mode'),
    btnReset: document.getElementById('btn-reset'),
    btnJump: document.getElementById('btn-jump'),
    btnBandage: document.getElementById('btn-bandage'),
    btnWeapon: document.getElementById('btn-weapon'),
    btnSprint: document.getElementById('btn-sprint'),
  },
});
initSettingsPanel({
  store: settings,
  controls,
  onSimulateHit: () => {
    // 测试钩子：模拟一次敌人命中（随机部位），走正式的玩家受伤接口。
    const zones = ['head', 'chest', 'abdomen', 'arm', 'leg'];
    playerTakeHit(zones[Math.floor(Math.random() * zones.length)], 0.4);
  },
});
if (controls.isTouch) document.body.classList.add('touch');

// ---------- 玩家失血状态 ----------
const playerBleed = createBleedState();
let bloodLoss = 0; // 总失血量（即时伤口失血 + 失血点滴答），达到阈值即倒地
let bandageT = 0; // 当前包扎读条进度（秒）
let bandaging = false; // 包扎读条进行中（驱动枪身包扎姿态）
let bandageShown = false;
let collapsing = false; // 倒地黑场进行中
let collapseT = 0;
let collapseRespawned = false;
let swayT = 0; // 失血晃动计时

// ---------- 玩家状态 ----------
const player = {
  pos: new THREE.Vector3(0, EYE_HEIGHT, 8),
  vel: new THREE.Vector3(), // 水平速度（速度平滑用）
  vy: 0, // 垂直速度（跳跃/重力）
  grounded: true,
  groundHeight: 0, // 当前脚下支撑面高度（0 = 地面，或障碍物顶）
  coyote: 0, // 土狼时间剩余
  jumpBuffer: 0, // 跳跃输入缓冲剩余
  landDip: 0, // 落地镜头下沉
  yaw: 0,
  pitch: 0,
  bobT: 0,
  bobAmp: 0, // 摆动幅度，随速度淡入淡出
  lean: 0, // strafing 侧倾
};

// 脚下支撑面高度：玩家中心正下方的最高可站立面（地面 0，或障碍物顶）。
function supportHeightAt(x, z) {
  let h = 0;
  for (const c of colliders) {
    const top = c.top ?? 99;
    if (top <= h) continue;
    if (c.type === 'aabb') {
      if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) h = top;
    } else if (c.type === 'circle') {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz < c.r * c.r) h = top;
    }
  }
  return h;
}

// 玩家圆形 vs 障碍物推离（圆形 vs AABB / 圆形），带高度感知：
// 脚高于顶面 + 0.05 时跳过（已经跳过去了）；正站在某顶面上时也跳过它。
const PLAYER_RADIUS = 0.35;
function resolveCollisions(pos) {
  const feetY = pos.y - EYE_HEIGHT;
  for (const c of colliders) {
    const top = c.top ?? 99;
    if (feetY > top + 0.05) continue;
    if (player.grounded && feetY >= top - 0.01) continue;
    if (c.type === 'aabb') {
      const cx = THREE.MathUtils.clamp(pos.x, c.minX, c.maxX);
      const cz = THREE.MathUtils.clamp(pos.z, c.minZ, c.maxZ);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= PLAYER_RADIUS * PLAYER_RADIUS) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * PLAYER_RADIUS;
        pos.z = cz + (dz / d) * PLAYER_RADIUS;
      } else {
        // 圆心落在矩形内：沿最小穿透轴推出
        const pl = pos.x - c.minX;
        const pr = c.maxX - pos.x;
        const pn = pos.z - c.minZ;
        const pf = c.maxZ - pos.z;
        const m = Math.min(pl, pr, pn, pf);
        if (m === pl) pos.x = c.minX - PLAYER_RADIUS;
        else if (m === pr) pos.x = c.maxX + PLAYER_RADIUS;
        else if (m === pn) pos.z = c.minZ - PLAYER_RADIUS;
        else pos.z = c.maxZ + PLAYER_RADIUS;
      }
    } else if (c.type === 'circle') {
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const rr = PLAYER_RADIUS + c.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      if (d2 < 1e-8) {
        pos.x = c.x + rr;
      } else {
        const d = Math.sqrt(d2);
        pos.x = c.x + (dx / d) * rr;
        pos.z = c.z + (dz / d) * rr;
      }
    }
  }
}
// ---------- 玩家受伤 / 失血 / 包扎 / 倒地 ----------
// 玩家受伤接口：机器人命中玩家时调用（靶场/街区只有设置里的“模拟受伤”
// 测试钩子调用它）。severity 为命中严重度 0..1（由毁伤模型给出）。
// 团队死斗：防具先挡（armor.js 包在毁伤判定之前，damage.js/bleeding.js
// 原样不动）→ 模块完整度 → 失血；头/胸模块归零即阵亡。靶场/街区保持
// 旧行为（只有失血，没有模块与防具）。
function playerTakeHit(zone, severity = 0.4, attacker = null) {
  const z = ZONE_LABELS[zone] ? zone : 'abdomen';
  if (isTdmActive()) {
    if (!tdm.playerAlive || tdm.matchOver) return;
    const gearRes = applyGearHit(tdm.playerGear, z, severity, Math.random());
    const finalSeverity = gearRes.severity;
    if (gearRes.gearHit) {
      const gearName = GEAR_LABELS[gearRes.gearHit];
      // 击穿/摧毁是重要事件，走中央提示；挡下伤害看身体状况图的耐久条。
      if (gearRes.penetrated) {
        hud.toast(`击穿！${gearName}被击穿，全额伤害`);
      } else if (gearRes.destroyed) {
        hud.toast(`你的${gearName}被摧毁！`);
      }
    }
    tdm.playerIntegrity[z] = Math.max(0, tdm.playerIntegrity[z] - finalSeverity);
    bloodLoss += finalSeverity * IMMEDIATE_BLEED_FACTOR;
    const r = rollBleed(playerBleed, z, Math.random());
    if (r.triggered && !r.refreshed) {
      hud.toast('失血！快包扎止血');
    }
    // 其余命中反馈看身体状况图（部位变色 + 失血脉冲），不再写日志。
    if (attacker) {
      tdm.playerLastAttacker = attacker;
      tdm.playerLastAttackerT = performance.now() / 1000;
    }
    updateBleedHud();
    // 头/胸模块归零即阵亡（与机器人同一规则；evaluateHit 的 incapacitated
    // 不直接杀玩家——5 个机器人围攻时一发爆头即死太苛刻）。
    if (tdm.playerIntegrity.head <= 0 || tdm.playerIntegrity.chest <= 0) {
      tdmDie(attacker);
    }
    return;
  }
  bloodLoss += severity * IMMEDIATE_BLEED_FACTOR;
  const r = rollBleed(playerBleed, z, Math.random());
  if (r.triggered && !r.refreshed) {
    hud.toast('失血！快包扎止血');
  }
  updateBleedHud();
}

// ---------- 团队死斗：记分 / 阵亡 / 重生 / 结算 ----------
// 一次击杀记分：更新比分与播报，处理背水一战触发/结束与比赛胜利。
// killer/victim 为 { name, team, isPlayer }，killer 为 null 表示无击杀者
// （失血倒地且无人记功），只播报不记分。比赛已结束时不再记分。
function recordTdmKill(killerTeam, killer, victim) {
  if (!isTdmActive() || tdm.match.winner) return;
  const events = recordKill(tdm.match, killerTeam);
  hud.addKillFeed(killer, victim);
  hud.setTdmScore(tdm.match.scores.blue, tdm.match.scores.red);
  for (const e of events) {
    if (e.type === 'buffTriggered') {
      const teamName = e.team === 'blue' ? '蓝队' : '红队';
      hud.showBuffBanner(`背水一战！${teamName}失血效果 -5%，速度 +5%`);
      hud.setBuffIndicator(true, e.team);
      // 触发已有居中横幅 + 常驻指示，不再写日志。
    } else if (e.type === 'buffEnded') {
      hud.setBuffIndicator(false, null);
      hud.addFeedNote('背水一战结束');
    } else if (e.type === 'win') {
      endMatch(e.team === 'blue');
    }
  }
}

// 机器人阵亡回调（bots.js）：killer 为攻击者描述或 null。
function onBotKill({ killer, victim }) {
  if (!isTdmActive()) return;
  if (killer) {
    recordTdmKill(killer.team, killer, victim);
  } else {
    hud.addKillFeed(null, victim);
  }
}

// 机器人命中玩家回调（bots.js）：severity 已乘机器人毁伤倍率。
function onBotHitPlayer(hit) {
  playerTakeHit(hit.zone, hit.severity, hit.attacker);
}

// 玩家阵亡：记分（击杀者队伍）、重生倒计时浮层、失血清零。
// killer 为直接击杀者；失血倒地（killer 为 null）时按最后攻击者记功。
function tdmDie(killer) {
  if (!isTdmActive() || !tdm.playerAlive || tdm.matchOver) return;
  tdm.playerAlive = false;
  cancelBandage();
  if (reloading) {
    reloading = false;
    gun.setReloading(false);
    hud.setReloading(false);
  }
  const now = performance.now() / 1000;
  const credited = killer ||
    (tdm.playerLastAttacker && now - tdm.playerLastAttackerT < BLEED_CREDIT_WINDOW
      ? tdm.playerLastAttacker : null);
  const victim = { name: '你', team: 'blue', isPlayer: true };
  if (credited) {
    recordTdmKill(credited.team, credited, victim);
    hud.showRespawn(`你被${credited.team === 'red' ? '红队' : '蓝队'} ${credited.name} 击毙`);
  } else {
    hud.addKillFeed(null, victim);
    hud.showRespawn('你失血过多，倒下了');
  }
  tdm.respawnT = RESPAWN_TIME;
  hud.setRespawnTimer(tdm.respawnT);
  // 阵亡即清零失血：倒地期间不再滴答，重生时满状态。
  clearBleeds(playerBleed);
  bloodLoss = 0;
  updateBleedHud();
  hud.setBleedVignette(0);
}

// 玩家重生：满血、崭新防具、失血清零、弹药补满、回蓝队出生点。
function respawnTdmPlayer() {
  respawnPlayer();
  tdm.playerGear = createGearState();
  tdm.playerIntegrity = { head: 1, chest: 1, abdomen: 1, arm: 1, leg: 1 };
  tdm.playerAlive = true;
  tdm.playerLastAttacker = null;
  ammoByWeapon.rifle = WEAPON_STATS.rifle.magSize;
  ammoByWeapon.pistol = WEAPON_STATS.pistol.magSize;
  hud.hideRespawn();
  updateBodyHud();
  updateWeaponHud();
}

// 比赛结束：冻结交战、记胜负（只记一次）、结算浮层、退出指针锁定。
function endMatch(won) {
  if (!isTdmActive() || tdm.matchOver) return;
  tdm.matchOver = true;
  if (!tdm.recorded) {
    tdm.recorded = true;
    recordsStore.recordTdmMatch(won);
    renderRecords();
  }
  if (botManager) botManager.setCombatEnabled(false);
  hud.setBuffIndicator(false, null);
  hud.hideRespawn();
  hud.showMatchOverlay(won, tdm.match.scores.blue, tdm.match.scores.red);
  if (document.exitPointerLock) document.exitPointerLock();
}

// 开始一场比赛：新建比赛状态、机器人全体上场、HUD 复位。
// 机器人管理器首场比赛创建（需要街区环境与士兵模型），之后复用。
function startMatch() {
  if (!botManager) {
    botManager = createBotManager({
      parent: streetEnv.group,
      soldierBlue: soldierModels.blue,
      soldierRed: soldierModels.red,
      animations: soldierAnimations,
      colliders: streetEnv.colliders,
      occluders: streetEnv.hitMeshes,
      // 回调必须包在 callbacks 对象里（bots.js 只从 callbacks 解构）：
      // 平铺传参会被静默丢弃，击杀记分/玩家受伤/曳光/远处枪声全断。
      callbacks: {
        onPlayerHit: onBotHitPlayer,
        onKill: onBotKill,
        spawnTracer,
        playDistantShot: (dist) => audio.distantShot(dist),
      },
    });
  }
  tdm = {
    match: createMatch(),
    playerGear: createGearState(),
    playerIntegrity: { head: 1, chest: 1, abdomen: 1, arm: 1, leg: 1 },
    playerAlive: true,
    respawnT: 0,
    playerLastAttacker: null,
    playerLastAttackerT: 0,
    matchOver: false,
    recorded: false,
  };
  streetTargets.setVisible(false);
  streetTargets.reset();
  botManager.setCombatEnabled(true);
  botManager.spawnAll();
  // spawnAll 先清掉上一场的机器人再重建（数组被换掉），所以必须在
  // 重建之后再刷新射线/碰撞集合，否则集合里还是上一场已撤场的网格，
  // 再来一局后子弹打不中机器人、机器人也不挡玩家。
  refreshHitSets();
  hud.setTdmScore(0, 0);
  hud.clearKillFeed();
  hud.setBuffIndicator(false, null);
  hud.hideMatchOverlay();
  hud.hideRespawn();
  updateBodyHud();
  hud.toast(`团队死斗开始！先到 ${WIN_SCORE} 分获胜`);
}

function updateBleedHud() {
  hud.setBleeding(bleedingZones(playerBleed).map((z) => ZONE_LABELS[z]));
  const btnBandage = document.getElementById('btn-bandage');
  if (btnBandage) btnBandage.classList.toggle('toggled', isBleeding(playerBleed));
  updateBodyHud();
}

// 身体状况图刷新：死斗用真实模块完整度 + 防具耐久；靶场/街区没有模块与
// 防具，部位默认全健康，只有失血会让部位变色+脉冲（模拟受伤看得见）。
// hud.setBodyStatus 内部做变化检测，重复调用不碰 DOM。
function updateBodyHud() {
  const tdmActive = activeMap.isTdm && !!tdm;
  hud.setBodyStatus({
    integrity: tdmActive ? { ...tdm.playerIntegrity } : null,
    bleeding: bleedingZones(playerBleed),
    gear: tdmActive ? gearStatus(tdm.playerGear) : null,
  });
}

// 取消包扎读条：姿态淡出、进度清零、触屏开关复位（读条不会自己续上）。
function cancelBandage() {
  if (bandaging) {
    bandaging = false;
    gun.setBandaging(false);
  }
  bandageT = 0;
  controls.clearBandageLatch();
}

function respawnPlayer() {
  const spawn = activeMap.env.spawn;
  player.pos.set(spawn.x, EYE_HEIGHT, spawn.z);
  player.vel.set(0, 0, 0);
  player.vy = 0;
  player.grounded = true;
  player.groundHeight = 0;
  player.coyote = 0;
  player.jumpBuffer = 0;
  player.landDip = 0;
  player.yaw = spawn.yaw;
  player.pitch = 0;
  clearBleeds(playerBleed);
  bloodLoss = 0;
  bandageT = 0;
  bandaging = false;
  gun.setBandaging(false);
  bandageShown = false;
  hud.setBandaging(false);
  hud.setBleedVignette(0);
  updateBleedHud();
}

let playing = false;
let paused = false; // 暂停浮层显示时冻结局内逻辑（移动/射击/机器人/靶子）
let startedAt = 0;
// 弹药按武器分开记（步枪 30 发 / 手枪 12 发），切换武器时各自保留余弹。
let ammoByWeapon = { rifle: WEAPON_STATS.rifle.magSize, pistol: WEAPON_STATS.pistol.magSize };
let currentWeapon = 'rifle';
let fireMode = 'auto'; // 只对步枪有效：手枪恒单发，战术刀没有射击模式
let reloading = false;
let reloadEnd = 0;
let reloadDuration = RELOAD_TIME; // 本次换弹总时长（按当前武器）
let nextShotAt = 0;
let prevFiring = false;
let meleeReadyAt = 0; // 战术刀下一次可挥刀的时间（挥刀 0.3s + 0.05s 间隔）

// 武器 HUD：弹药数（战术刀显示 —）+ 射击模式标签 + 武器槽高亮。
function updateWeaponHud() {
  if (currentWeapon === 'knife') {
    hud.setAmmo('—', '');
    hud.setFireMode('knife');
  } else {
    hud.setAmmo(ammoByWeapon[currentWeapon], '∞');
    hud.setFireMode(currentWeapon === 'rifle' ? fireMode : 'semi');
  }
  hud.setWeaponSlots(currentWeapon);
}

// 切换武器：取消换弹/包扎（姿态不打架）、换视图模型、刷新 HUD。
function switchWeapon(next) {
  if (!WEAPON_ORDER.includes(next) || next === currentWeapon) return;
  if (reloading) {
    reloading = false;
    gun.setReloading(false);
    hud.setReloading(false);
  }
  cancelBandage();
  currentWeapon = next;
  gun.setWeapon(next);
  updateWeaponHud();
  audio.weaponSwitch();
}

function cycleWeapon() {
  const i = WEAPON_ORDER.indexOf(currentWeapon);
  switchWeapon(WEAPON_ORDER[(i + 1) % WEAPON_ORDER.length]);
}

const score = {
  shots: 0,
  hits: 0,
  zoneCounts: { head: 0, chest: 0, abdomen: 0, arm: 0, leg: 0 },
};
let clearAnnounced = false; // 本局是否已播报过“全部清除”（重置靶子/新一局后复位）

// ---------- 特效：曳光、命中火花、弹壳 ----------
const tracers = [];
const impacts = [];
const shells = [];
const SHELL_POOL = 20;
const UP_AXIS = new THREE.Vector3(0, 1, 0);
const shellGeo = new THREE.CylinderGeometry(0.006, 0.0075, 0.026, 8);

function sparkTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255, 240, 200, 1)');
  grad.addColorStop(0.4, 'rgba(255, 160, 60, 0.9)');
  grad.addColorStop(1, 'rgba(255, 80, 20, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const sparkTex = sparkTexture();

// 曳光：细圆柱（线宽在多数平台上会被忽略，圆柱才能真正加粗）
function spawnTracer(a, b, color = 0xffd27a) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 0.01) return;
  const geo = new THREE.CylinderGeometry(0.0045, 0.0045, len, 5, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP_AXIS, dir.normalize());
  scene.add(mesh);
  tracers.push({ mesh, life: 0.08, maxLife: 0.08 });
}

// 命中火花：3–5 个带初速度的火花碎片，向外飞散
function spawnImpact(point, big = false) {
  const n = big ? 5 : 3;
  for (let i = 0; i < n; i++) {
    const mat = new THREE.SpriteMaterial({
      map: sparkTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(point);
    const s = (big ? 0.22 : 0.14) * (0.7 + Math.random() * 0.6);
    sprite.scale.setScalar(s);
    scene.add(sprite);
    const speed = big ? 1.4 : 1;
    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 2 * speed,
      (Math.random() * 1.6 + 0.4) * speed,
      (Math.random() - 0.5) * 2 * speed
    );
    const life = 0.28 + Math.random() * 0.14;
    impacts.push({ sprite, vel, life, maxLife: life, size: s });
  }
}

// 弹壳：对象池，抛壳口弹出、向右翻滚、落地弹跳一次、1.5s 后淡出
function spawnShell(origin, rightDir, shotDir) {
  let s = shells.find((x) => !x.active);
  if (!s) {
    if (shells.length >= SHELL_POOL) {
      s = shells[0]; // 池满：复用最旧的
    } else {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc9a227,
        roughness: 0.35,
        metalness: 0.8,
        transparent: true,
      });
      const mesh = new THREE.Mesh(shellGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      s = { mesh, vel: new THREE.Vector3(), angVel: new THREE.Vector3(), life: 0, bounced: false, active: false };
      shells.push(s);
    }
  }
  s.active = true;
  s.bounced = false;
  s.life = 1.5;
  s.mesh.visible = true;
  s.mesh.material.opacity = 1;
  s.mesh.position.copy(origin);
  s.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  s.vel.copy(rightDir).multiplyScalar(1.6 + Math.random() * 0.9);
  s.vel.y = 1.7 + Math.random() * 1.0;
  s.vel.addScaledVector(shotDir, (Math.random() - 0.5) * 0.5);
  s.angVel.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
}

function updateEffects(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.life <= 0) {
      scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
      tracers.splice(i, 1);
    } else {
      t.mesh.material.opacity = (t.life / t.maxLife) * 0.95;
    }
  }
  for (let i = impacts.length - 1; i >= 0; i--) {
    const im = impacts[i];
    im.life -= dt;
    if (im.life <= 0) {
      scene.remove(im.sprite);
      im.sprite.material.dispose();
      impacts.splice(i, 1);
    } else {
      im.vel.y -= 3.5 * dt;
      im.sprite.position.addScaledVector(im.vel, dt);
      const k = im.life / im.maxLife;
      im.sprite.material.opacity = k;
      im.sprite.scale.setScalar(im.size * (1 + (1 - k) * 0.6));
    }
  }
  for (const s of shells) {
    if (!s.active) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.active = false;
      s.mesh.visible = false;
      continue;
    }
    s.vel.y -= 9.8 * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    s.mesh.rotation.x += s.angVel.x * dt;
    s.mesh.rotation.y += s.angVel.y * dt;
    s.mesh.rotation.z += s.angVel.z * dt;
    if (s.mesh.position.y <= 0.012) {
      s.mesh.position.y = 0.012;
      if (!s.bounced) {
        s.vel.y *= -0.35;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
        s.angVel.multiplyScalar(0.5);
        s.bounced = true;
      } else {
        s.vel.set(0, 0, 0);
        s.angVel.set(0, 0, 0);
      }
    }
    if (s.life < 0.4) s.mesh.material.opacity = s.life / 0.4;
  }
}

// ---------- 射击 ----------
const raycaster = new THREE.Raycaster();
raycaster.far = 100; // 街区最长视线约 85m（主街贯通），60m 会在远端丢命中
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
let lastShot = null; // 调试：最近一发假人命中的点位与判定部位
const _eject = new THREE.Vector3();

function shoot(now) {
  lastShot = null; // 本发未命中假人时保持 null，不读上一发的旧值
  const stats = WEAPON_STATS[currentWeapon];
  if (ammoByWeapon[currentWeapon] <= 0) {
    audio.dryFire();
    startReload();
    return;
  }
  ammoByWeapon[currentWeapon] -= 1;
  score.shots += 1;
  const aiming = controls.state.aiming;
  gun.fire(aiming);
  if (currentWeapon === 'pistol') audio.pistolShot();
  else audio.shot();

  // 散布：在镜头方向上加一个随机锥形偏移
  const spread = gun.getSpread();
  camera.getWorldDirection(_dir);
  _right.crossVectors(_dir, camera.up).normalize();
  _up.crossVectors(_right, _dir).normalize();
  const r = Math.tan(spread) * Math.sqrt(Math.random());
  const theta = Math.random() * Math.PI * 2;
  _dir
    .addScaledVector(_right, Math.cos(theta) * r)
    .addScaledVector(_up, Math.sin(theta) * r)
    .normalize();

  raycaster.set(camera.getWorldPosition(new THREE.Vector3()), _dir);
  const hits = raycaster.intersectObjects(allHitMeshes, false);
  gun.muzzleWorldPosition(_muzzle);
  gun.ejectionWorldPosition(_eject);
  spawnShell(_eject, _right, _dir);

  if (hits.length === 0) {
    const end = _dir.clone().multiplyScalar(45).add(camera.position);
    spawnTracer(_muzzle.clone(), end);
    return;
  }

  const hit = hits[0];
  _hitPoint.copy(hit.point);
  spawnTracer(_muzzle.clone(), _hitPoint.clone());

  const obj = hit.object;
  const surface = obj.userData.surface || { kind: 'wall', hardness: 0.9 };
  const rangeM = hit.distance;
  const energy = Math.max(0.3, 1 - rangeM * 0.012);

  // 入射角：弹道反方向与命中面法线的夹角
  const normal = hit.face
    ? hit.face.normal.clone().transformDirection(obj.matrixWorld)
    : new THREE.Vector3(0, 0, 1);
  const cosInc = THREE.MathUtils.clamp(normal.dot(_dir.clone().negate()), -1, 1);
  const incidenceDeg = THREE.MathUtils.radToDeg(Math.acos(cosInc));

  if (surface.kind === 'dummy') {
    // 部位：士兵假人按命中点高度带判定（zoneAtPoint），程序化假人用 mesh
    // 自带的 zone（zoneAtPoint 返回 null 时回退），两条路径同一份毁伤评估。
    const zone = activeMap.targets.zoneAtPoint(obj.userData.dummy, _hitPoint) || obj.userData.zone;
    // 调试图：记录最近一发命中点与判定部位（probeRay 零散布对照用）。
    lastShot = {
      zone,
      point: { x: +_hitPoint.x.toFixed(3), y: +_hitPoint.y.toFixed(3), z: +_hitPoint.z.toFixed(3) },
      dist: +rangeM.toFixed(2),
      dummyIsSoldier: obj.userData.dummy ? obj.userData.dummy.isSoldier : null,
    };
    const evalResult = evaluateHit({
      zone,
      incidenceDeg,
      rangeM,
      energy,
      roll: Math.random(),
    });
    evalResult.severity *= stats.damageScale; // 手枪毁伤低于步枪
    const res = activeMap.targets.applyDummyHit(obj, evalResult);
    score.hits += 1;
    score.zoneCounts[evalResult.zone] += 1;
    hud.showHitmarker(evalResult.zoneLabel);
    if (res.incapacitated) hud.toast('目标失能！');
    spawnImpact(_hitPoint, false);
    audio.thud();
    return;
  }

  if (surface.kind === 'bot' && botManager) {
    // 机器人：与假人同一毁伤评估，防具/模块/失血由 bots.js 内部处理
    // （applyPlayerHit 里先过防具再算模块，毁伤倍率在里面乘）。
    const bot = obj.userData.bot;
    const zone = botManager.zoneAtPoint(bot, _hitPoint) || obj.userData.zone || 'chest';
    const evalResult = evaluateHit({
      zone,
      incidenceDeg,
      rangeM,
      energy,
      roll: Math.random(),
    });
    const res = botManager.applyPlayerHit(bot, evalResult, stats.damageScale, player.pos);
    score.hits += 1;
    score.zoneCounts[evalResult.zone] += 1;
    hud.showHitmarker(evalResult.zoneLabel);
    if (res.killed) hud.toast(`${bot.name} 被击毙！`);
    spawnImpact(_hitPoint, false);
    audio.thud();
    return;
  }

  if (surface.kind === 'paper') {
    const res = activeMap.targets.applyPaperHit(obj, _hitPoint);
    score.hits += 1;
    hud.showHitmarker('纸靶');
    spawnImpact(_hitPoint, false);
    audio.thud();
    return;
  }

  if (surface.kind === 'steel') {
    const res = activeMap.targets.applySteelHit(obj, energy);
    score.hits += 1;
    hud.showHitmarker('钢板');
    spawnImpact(_hitPoint, true);
    audio.tink();
    // 钢板是硬表面：小角度命中可能跳弹
    const ric = evaluateRicochet({ incidenceDeg, hardness: 1, roll: Math.random() });
    if (ric.ricochet) deflectTracer(_hitPoint, normal);
    return;
  }

  // 硬表面（墙/地面/掩体）：命中火花 + 可能跳弹
  spawnImpact(_hitPoint, true);
  if (surface.hardness >= 0.8) audio.tink();
  else audio.thud();
  const ric = evaluateRicochet({ incidenceDeg, hardness: surface.hardness, roll: Math.random() });
  if (ric.ricochet) {
    deflectTracer(_hitPoint, normal);
  }
}

// 跳弹曳光：按反射定律生成第二段短曳光
function deflectTracer(point, normal) {
  const reflect = _dir.clone().sub(normal.clone().multiplyScalar(2 * _dir.dot(normal))).normalize();
  const end = point.clone().addScaledVector(reflect, 4 + Math.random() * 2);
  spawnTracer(point.clone(), end, 0xff9a4d);
  spawnImpact(point, true);
}

// ---------- 战术刀 ----------
// 挥刀：0.3s 挥砍动画 + 前方 1.5m 射线命中（机器人/假人/纸靶/钢板都能砍，
// 毁伤按重型部位打击算）。挥刀中再次扣动无效，挥完 0.05s 后可再挥。
const _meleeRay = new THREE.Raycaster();
_meleeRay.far = 1.6;
function meleeAttack(now) {
  if (now < meleeReadyAt) return;
  if (!gun.swing()) return; // 正在挥砍中
  meleeReadyAt = now + WEAPON_STATS.knife.swingTime + 0.05;
  audio.swing();
  camera.getWorldDirection(_dir);
  _meleeRay.set(camera.getWorldPosition(new THREE.Vector3()), _dir);
  const hits = _meleeRay.intersectObjects(allHitMeshes, false);
  if (hits.length === 0) return;
  const hit = hits[0];
  const obj = hit.object;
  const surface = obj.userData.surface || { kind: 'wall', hardness: 0.9 };
  const rangeM = hit.distance;
  const energy = 1; // 贴身挥砍不衰减
  if (surface.kind === 'bot' && botManager) {
    const bot = obj.userData.bot;
    const zone = botManager.zoneAtPoint(bot, hit.point) || obj.userData.zone || 'chest';
    const evalResult = evaluateHit({ zone, incidenceDeg: 0, rangeM, energy, roll: Math.random() });
    const res = botManager.applyPlayerHit(bot, evalResult, KNIFE_DAMAGE_SCALE, player.pos);
    score.hits += 1;
    score.zoneCounts[evalResult.zone] += 1;
    hud.showHitmarker(evalResult.zoneLabel);
    if (res.killed) hud.toast(`${bot.name} 被击毙！`);
    spawnImpact(hit.point, false);
    audio.thud();
    return;
  }
  if (surface.kind === 'dummy') {
    const zone = activeMap.targets.zoneAtPoint(obj.userData.dummy, hit.point) || obj.userData.zone;
    const evalResult = evaluateHit({ zone, incidenceDeg: 0, rangeM, energy, roll: Math.random() });
    evalResult.severity *= KNIFE_DAMAGE_SCALE;
    const res = activeMap.targets.applyDummyHit(obj, evalResult);
    score.hits += 1;
    score.zoneCounts[evalResult.zone] += 1;
    hud.showHitmarker(evalResult.zoneLabel);
    if (res.incapacitated) hud.toast('目标失能！');
    spawnImpact(hit.point, false);
    audio.thud();
    return;
  }
  if (surface.kind === 'paper') {
    const res = activeMap.targets.applyPaperHit(obj, hit.point);
    score.hits += 1;
    hud.showHitmarker('纸靶');
    spawnImpact(hit.point, false);
    audio.thud();
    return;
  }
  if (surface.kind === 'steel') {
    const res = activeMap.targets.applySteelHit(obj, energy);
    score.hits += 1;
    hud.showHitmarker('钢板');
    spawnImpact(hit.point, true);
    audio.tink();
    return;
  }
  spawnImpact(hit.point, true);
  audio.thud();
}

// ---------- 换弹 / 模式 / 重置 ----------
// 换弹分段咔哒声时机（与 gun.js 的弹匣/拉机柄动画对齐）
const RELOAD_CLICK_STAGES = [
  { at: 0.05, freq: 1500 }, // 退弹匣
  { at: 0.55, freq: 900 }, // 新弹匣装回
  { at: 0.86, freq: 1900 }, // 拉机柄
];
let reloadStage = 0;

function startReload() {
  if (currentWeapon === 'knife') return; // 战术刀没有弹药
  const stats = WEAPON_STATS[currentWeapon];
  if (reloading || ammoByWeapon[currentWeapon] === stats.magSize) return;
  cancelBandage(); // 开始换弹取消包扎（两者互斥，姿态不打架）
  reloading = true;
  reloadStage = 0;
  reloadDuration = stats.reloadTime; // 手枪换弹比步枪快
  reloadEnd = performance.now() / 1000 + reloadDuration;
  gun.setReloading(true);
}

function toggleMode() {
  // 射击模式只对步枪有效：手枪恒单发，战术刀没有射击模式。
  if (currentWeapon === 'pistol') {
    hud.toast('手枪仅单发');
    return;
  }
  if (currentWeapon === 'knife') {
    hud.toast('战术刀没有射击模式');
    return;
  }
  fireMode = fireMode === 'auto' ? 'semi' : 'auto';
  hud.setFireMode(fireMode);
  audio.modeSwitch();
  hud.toast(fireMode === 'auto' ? '切换为连发' : '切换为单发');
}

function resetTargets() {
  activeMap.targets.reset();
  clearAnnounced = false; // 重置后可以再次达成并播报全清
  hud.toast('靶子已重置');
}

controls.on('reload', () => { if (playing && !paused) startReload(); });
controls.on('toggleMode', () => { if (playing && !paused) toggleMode(); });
controls.on('reset', () => { if (playing && !paused) resetTargets(); });
controls.on('jump', () => { if (playing && !paused) player.jumpBuffer = JUMP_BUFFER; });
controls.on('weaponCycle', () => { if (playing && !paused) cycleWeapon(); });
controls.on('weaponSelect', (index) => { if (playing && !paused) switchWeapon(WEAPON_ORDER[index]); });
controls.on('bandageToggle', (on) => {
  // 空按反馈：没失血时点开包扎开关，给一次提示——按钮不能悄悄没反应。
  // 事件只在点按瞬间发一次，不会每帧重复。
  if (on && playing && !isBleeding(playerBleed)) hud.toast('没有失血，无需包扎');
});
const pauseSub = document.getElementById('pause-sub');
controls.on('lockLost', () => {
  if (playing && !controls.isTouch) {
    paused = true; // 暂停即冻结：机器人与靶子不再推进
    if (pauseSub) pauseSub.textContent = '指针锁定已解除';
    hud.showPause();
  }
});

// ---------- 主页记录 ----------
function formatElapsed(sec) {
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${mm}:${ss}`;
}

// 主页记录面板：只显示存下的真实数据，没有记录时显示空状态，永不造假数字。
function renderRecords() {
  const body = document.getElementById('records-body');
  if (!body) return;
  const r = recordsStore.get();
  const tdmTotal = (r.tdmWins || 0) + (r.tdmLosses || 0);
  if (r.totalSessions === 0 && tdmTotal === 0) {
    body.innerHTML = '<p class="records-empty">暂无记录，去打一局</p>';
    return;
  }
  const rows = [
    ['最高命中率', r.bestAccuracy
      ? `${Math.round(r.bestAccuracy.accuracy * 100)}%（${r.bestAccuracy.hits}/${r.bestAccuracy.shots} 发）`
      : '—', true],
    ['最多命中', r.mostHits === null ? '—' : `${r.mostHits} 发`, false],
    ['最快全清', r.fastestClear === null ? '—' : formatElapsed(r.fastestClear), true],
    ['总场次', `${r.totalSessions} 场`, false],
  ];
  if (tdmTotal > 0) {
    rows.push(['团队死斗', `${r.tdmWins || 0} 胜 / ${r.tdmLosses || 0} 负`, false]);
  }
  if (r.lastSession) {
    const ls = r.lastSession;
    rows.push(['上次成绩',
      `${Math.round(ls.accuracy * 100)}% · ${ls.hits}/${ls.shots} 发 · ${formatElapsed(ls.elapsedSec)}${ls.cleared ? ' · 已全清' : ''}`,
      false]);
  }
  body.innerHTML = rows.map(([label, value, gold]) =>
    `<div class="record-row"><span class="record-label">${label}</span>` +
    `<span class="record-value${gold ? ' gold' : ''}">${value}</span></div>`).join('');
}

// ---------- 局内状态重置 / 结算 / 回主页 ----------
// 新一局开始前（进入靶场）和回主页时都调：计分、弹药、靶子、玩家位置与失血、
// 换弹/包扎/倒地状态全部复位，下一局从干净状态开始。
function resetSession() {
  score.shots = 0;
  score.hits = 0;
  score.zoneCounts = { head: 0, chest: 0, abdomen: 0, arm: 0, leg: 0 };
  ammoByWeapon = { rifle: WEAPON_STATS.rifle.magSize, pistol: WEAPON_STATS.pistol.magSize };
  currentWeapon = 'rifle';
  gun.setWeapon('rifle');
  reloading = false;
  reloadStage = 0;
  gun.setReloading(false);
  hud.setReloading(false);
  cancelBandage();
  collapsing = false;
  collapseT = 0;
  collapseRespawned = false;
  hud.setCollapseFade(0);
  hud.setBleedVignette(0);
  hud.setBandaging(false);
  respawnPlayer();
  activeMap.targets.reset();
  clearAnnounced = false;
  nextShotAt = 0;
  prevFiring = false;
  meleeReadyAt = 0;
  hudTimer = 0;
  updateWeaponHud();
  hud.setScore({ shots: 0, hits: 0, zoneCounts: score.zoneCounts, elapsedSec: 0 });
  updateBodyHud();
}

// 结算一场：只有开过火的场次才计入记录，0 发的空场次不污染总场次与上次成绩。
// 团队死斗不走这条：胜负只在比赛打完时记（endMatch），中途退出不记。
function endSession() {
  if (activeMap.isTdm) return;
  if (score.shots <= 0) return;
  const elapsed = playing ? performance.now() / 1000 - startedAt : 0;
  recordsStore.recordSession({
    shots: score.shots,
    hits: score.hits,
    elapsedSec: Math.max(0, Math.round(elapsed)),
    cleared: activeMap.targets.getClearState().cleared,
  });
}

function goHome() {
  endSession();
  playing = false; // 先停局内逻辑：随后解除指针锁定触发的 lockLost 不会再弹出暂停
  paused = false;
  if (document.exitPointerLock) document.exitPointerLock();
  controls.setAimActive(false);
  controls.clearBandageLatch();
  // 死斗收尾：机器人撤场、比赛状态丢弃、死斗浮层全部收起（中途退出不记胜负）。
  if (botManager) {
    botManager.setCombatEnabled(false);
    botManager.dispose();
    botManager = null;
  }
  tdm = null;
  hud.hideMatchOverlay();
  hud.hideRespawn();
  hud.setBuffIndicator(false, null);
  hud.clearKillFeed();
  resetSession();
  // 靶子恢复显示（死斗时隐藏）：下一局若是街区，靶子都在。
  streetTargets.setVisible(true);
  refreshHitSets();
  renderRecords();
  hud.hidePause();
  hud.showStart();
  document.body.classList.add('home'); // 回主页：隐藏局内 HUD
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

// ---------- 开始 / 暂停 ----------
function startGame() {
  if (!initialized) return; // 素材还在加载：按钮禁用中，这道是第二道防线
  resetSession();
  document.body.classList.remove('home'); // 进地图：显示局内 HUD
  playing = true;
  paused = false;
  startedAt = performance.now() / 1000;
  audio.unlock(); // 用户手势中创建/恢复 AudioContext
  hud.hideStart();
  hud.hidePause();
  controls.requestPointerLock();
  if (activeMap.isTdm) {
    startMatch();
  } else {
    hud.toast(`${activeMap.label}已就绪，开始射击`);
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

// 主页模式选择：点卡片切换地图（金色高亮移动），进入按钮文案跟随，
// 背景 3D 场景即时切换。记录两张图共用，死斗胜负单独记。
function selectMap(id) {
  if (!initialized || !MAPS[id] || id === activeMapId) return;
  document.querySelectorAll('.mode-card[data-map]').forEach((c) => {
    c.classList.toggle('selected', c.dataset.map === id);
  });
  document.getElementById('btn-start').textContent = `进入${MAPS[id].label}`;
  audio.uiClick();
  setActiveMap(id);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
document.querySelectorAll('.mode-card[data-map]').forEach((card) => {
  card.addEventListener('click', () => selectMap(card.dataset.map));
});

document.getElementById('btn-start').addEventListener('click', startGame);
document.getElementById('btn-resume').addEventListener('click', () => {
  audio.unlock();
  paused = false;
  hud.hidePause();
  controls.requestPointerLock();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
document.getElementById('btn-home').addEventListener('click', goHome);
document.getElementById('btn-pause').addEventListener('click', () => {
  if (!playing) return;
  paused = true;
  if (pauseSub) pauseSub.textContent = `点继续回到${activeMap.label}`;
  hud.showPause();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
canvas.addEventListener('click', () => {
  if (playing && !controls.isTouch && !controls.state.pointerLocked) {
    paused = false;
    controls.requestPointerLock();
    hud.hidePause();
  }
});
// 结算浮层：再来一局（全新一场比赛）与返回主页。
document.getElementById('btn-rematch').addEventListener('click', () => {
  if (!isTdmActive()) return;
  audio.uiClick();
  resetSession();
  startMatch();
  paused = false;
  startedAt = performance.now() / 1000;
  hud.hideMatchOverlay();
  controls.requestPointerLock();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
document.getElementById('btn-match-home').addEventListener('click', () => {
  audio.uiClick();
  goHome();
});

// ---------- 操作说明 ----------
const helpOverlay = document.getElementById('help-overlay');
const helpBody = document.getElementById('help-body');
function openHelp() {
  if (!helpOverlay || !helpBody) return;
  const keyRows = KEY_ACTIONS.map((a) =>
    `<div class="help-row"><span>${a.label}</span><span class="help-key">${keyLabel(settings.state.keys[a.id])}</span></div>`).join('');
  helpBody.innerHTML = `
    <div class="help-section"><h3>桌面端（键鼠）</h3>
      <div class="help-row"><span>瞄准</span><span class="help-key">鼠标</span></div>
      <div class="help-row"><span>射击</span><span class="help-key">左键</span></div>
      <div class="help-row"><span>机瞄</span><span class="help-key">右键（按住）</span></div>
      <div class="help-row"><span>直选武器（步枪 / 手枪 / 战术刀）</span><span class="help-key">1 / 2 / 3</span></div>
      ${keyRows}
    </div>
    <div class="help-section"><h3>触屏（iPad）</h3>
      <div class="help-row"><span>移动</span><span class="help-key">左半屏虚拟摇杆</span></div>
      <div class="help-row"><span>转动视角</span><span class="help-key">右半屏滑动</span></div>
      <div class="help-row"><span>射击 / 机瞄 / 换弹 / 切换模式</span><span class="help-key">右侧圆形按键</span></div>
      <div class="help-row"><span>射击（备用键）</span><span class="help-key">左上角圆形按键</span></div>
      <div class="help-row"><span>疾跑</span><span class="help-key">按住左侧双箭头键，或摇杆推到底</span></div>
      <div class="help-row"><span>跳跃 / 包扎 / 切换武器</span><span class="help-key">右侧圆形按键</span></div>
      <div class="help-row"><span>按钮位置与大小</span><span class="help-key">设置里拖拽编辑</span></div>
    </div>
    <div class="help-section"><h3>毁伤与失血</h3>
      <p class="help-note">假人分头 / 胸 / 腹 / 手臂 / 腿部五个模块，命中按部位与入射角判定贯穿、擦伤或骨骼偏转；跳弹只发生在钢板、墙体等硬表面。命中可能触发失血，持续加重模块毁伤；玩家受伤后也会失血（红屏、晃动、减速随失血量渐变加重），用包扎键止血，失血过多会倒地重生。右侧身体状况图实时显示你的各部位状态：绿健康、黄受损、红危重、黑损毁，红点脉冲表示正在失血；防具耐久显示在受保护部位的细条上。</p>
    </div>
    <div class="help-section"><h3>团队死斗 5v5</h3>
      <p class="help-note">你 + 4 名蓝队 AI 队友，对抗 5 名红队 AI 敌人，先到 30 分的队伍获胜。所有人配备步枪、手枪、战术刀、防弹衣与头盔：防弹衣护住胸腹、头盔护住头部，命中先打防具（吸收 70% 伤害），20% 概率击穿造成全额伤害，耐久耗尽即摧毁；阵亡 3 秒后重生，防具与状态全部重置。一方率先达到 20 分时，落后一方触发背水一战：失血效果 -5%、速度 +5%，直到该队再拿 5 个人头。</p>
    </div>`;
  helpOverlay.classList.add('show');
  document.body.classList.add('help-open'); // 放开触屏滚动，面板才能滑动
  hud.hideStart();
}
function closeHelp() {
  if (!helpOverlay) return;
  helpOverlay.classList.remove('show');
  document.body.classList.remove('help-open');
  hud.showStart();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
document.getElementById('btn-help').addEventListener('click', () => {
  audio.uiClick();
  openHelp();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
document.getElementById('btn-help-close').addEventListener('click', () => {
  audio.uiClick();
  closeHelp();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- 主循环 ----------
const clock = new THREE.Clock();
let hudTimer = 0;
let lastStepCycle = 0; // 脚步声：上一个 bob 谷底所在的周期号
let footstepCount = 0; // 脚步声触发总次数（调试计数，__impasseDebug.footstepCount）

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now() / 1000;
  const elapsed = playing ? now - startedAt : 0;

  controls.update();
  const look = controls.consumeLook();

  // 暂停时冻结局内逻辑（镜头/枪/机器人/靶子都不推进），只渲染当前画面；
  // 菜单状态走 else if 分支，暂停不走菜单镜头。
  if (playing && !paused) {
    // 死斗阵亡/比赛结束时的输入门：阵亡时不能移动与射击，结算后不能射击。
    const dead = isTdmActive() && !tdm.playerAlive;
    const matchOver = isTdmActive() && tdm.matchOver;
    // 背水一战增益（只影响玩家所在蓝队；机器人拿各自队伍的增益）。
    const tdmMods = isTdmActive()
      ? buffModifiers(tdm.match, 'blue')
      : { bleedFactor: 1, speedFactor: 1 };
    // 视角
    const SENS = 0.0023;
    player.yaw -= look.dx * SENS;
    player.pitch -= look.dy * SENS;
    player.pitch = THREE.MathUtils.clamp(player.pitch, -1.45, 1.45);

    // 倒地黑场：黑满后重生，黑场褪去后恢复控制
    if (collapsing) {
      collapseT += dt;
      if (!collapseRespawned && collapseT >= COLLAPSE_FADE_TIME) {
        collapseRespawned = true;
        respawnPlayer();
        hud.toast('失血过多，已重置');
        hud.setCollapseFade(0);
      }
      if (collapseT >= COLLAPSE_FADE_TIME + 0.9) collapsing = false;
    }

    // 移动：速度向目标速度插值（加速 12/s，减速 10/s），不再瞬起瞬停；
    // 失血减速随总失血量渐变（刚中弹几乎不减，接近倒地时满额 -15%）；
    // 倒地黑场中忽略移动输入。包扎时不机瞄（枪身去做包扎姿态）。
    // bandaging 取上一帧的值，1 帧滞后不可见。
    const aiming = controls.state.aiming && !reloading && !bandaging && currentWeapon !== 'knife';
    const bleedFrac = bleedFraction(bloodLoss);
    const baseSpeed = aiming ? ADS_SPEED : controls.state.sprint ? SPRINT_SPEED : WALK_SPEED;
    const speed = baseSpeed * bleedSpeedFactor(bleedFrac) * tdmMods.speedFactor;
    const sin = Math.sin(player.yaw);
    const cos = Math.cos(player.yaw);
    const mx = (collapsing || dead) ? 0 : controls.state.moveX;
    const my = (collapsing || dead) ? 0 : controls.state.moveY;
    // 前进方向为 -Z 旋转 yaw
    const vx = mx * cos - my * sin;
    const vz = -my * cos - mx * sin;
    const hasInput = Math.hypot(mx, my) > 0.1;
    // 空中水平加速度 0.8x
    const rate = (hasInput ? 12 : 10) * (player.grounded ? 1 : 0.8);
    const k = Math.min(1, rate * dt);
    player.vel.x += (vx * speed - player.vel.x) * k;
    player.vel.z += (vz * speed - player.vel.z) * k;
    player.pos.x += player.vel.x * dt;
    player.pos.z += player.vel.z * dt;
    const bounds = activeMap.env.bounds;
    player.pos.x = THREE.MathUtils.clamp(player.pos.x, -bounds.x, bounds.x);
    player.pos.z = THREE.MathUtils.clamp(player.pos.z, bounds.zMin, bounds.zMax);

    // 跳跃与支撑：脚下支撑面（地面或障碍物顶）决定落地高度；
    // 走出支撑边缘即下落；站上更高处只能靠跳跃落地（地面高度只降不升，
    // 防止走进障碍物脚印时被瞬移到顶上）。
    const supportNow = supportHeightAt(player.pos.x, player.pos.z);
    if (player.grounded) {
      player.coyote = COYOTE_TIME;
      if (supportNow < player.groundHeight - 0.01) {
        player.grounded = false;
        player.vy = 0;
      } else {
        player.pos.y = player.groundHeight + EYE_HEIGHT;
      }
    } else {
      player.coyote = Math.max(0, player.coyote - dt);
    }
    player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
    if (player.jumpBuffer > 0 && (player.grounded || player.coyote > 0)) {
      player.vy = JUMP_VELOCITY;
      player.grounded = false;
      player.coyote = 0;
      player.jumpBuffer = 0;
    }
    if (!player.grounded) {
      player.vy -= GRAVITY * dt;
      player.pos.y += player.vy * dt;
      const feet = player.pos.y - EYE_HEIGHT;
      const s = supportHeightAt(player.pos.x, player.pos.z);
      // 0.05 落地吸附：低帧率下也不会穿过顶面
      if (player.vy <= 0 && feet <= s + 0.05) {
        player.pos.y = s + EYE_HEIGHT;
        const impact = Math.min(1, -player.vy / 6);
        if (impact > 0.25) {
          player.landDip = 0.03 + 0.02 * impact;
          audio.land();
        }
        player.vy = 0;
        player.grounded = true;
        player.groundHeight = s;
      }
    }
    // 水平推离放在垂直结算之后：落地/站在顶面上时，脚下障碍物的推离会跳过。
    resolveCollisions(player.pos);
    player.pos.x = THREE.MathUtils.clamp(player.pos.x, -bounds.x, bounds.x);
    player.pos.z = THREE.MathUtils.clamp(player.pos.z, bounds.zMin, bounds.zMax);
    if (player.landDip > 0) player.landDip = Math.max(0, player.landDip - dt * 0.2); // 约 0.25s 回弹

    // 失血滴答 + 倒地判定（黑场/阵亡中不推进）。玩家滴答用 0.05/s（假人 0.1/s
    // 不动）；背水一战时失血速率 ×0.95。死斗里失血倒地走阵亡流程（记功 +
    // 重生倒计时），不走靶场/街区的黑场重生。
    if (!collapsing && !dead) {
      if (isBleeding(playerBleed)) bloodLoss += tickBleed(playerBleed, dt, PLAYER_BLEED_TICK_RATE * tdmMods.bleedFactor).total;
      if (bloodLoss >= COLLAPSE_THRESHOLD) {
        if (isTdmActive()) {
          tdmDie(null);
        } else {
          collapsing = true;
          collapseT = 0;
          collapseRespawned = false;
          cancelBandage();
          hud.setCollapseFade(1);
        }
      }
    }

    // 死斗重生倒计时：3 秒后满状态重生（防具/模块/失血/弹药全部重置）。
    if (isTdmActive() && !tdm.playerAlive && !tdm.matchOver) {
      tdm.respawnT -= dt;
      hud.setRespawnTimer(tdm.respawnT);
      if (tdm.respawnT <= 0) respawnTdmPlayer();
    }

    // 失血红屏：随总失血量渐变加深 + 缓慢脉冲（刚中弹只有淡淡一层）。
    swayT += dt;
    const pulse = 0.5 + 0.5 * Math.sin(now * 4);
    hud.setBleedVignette(collapsing ? 0 : bleedVignetteOpacity(bleedFrac, pulse));

    // 包扎：键盘按住 B / 触屏点按包扎键（开关式）开始读条，满 2.5s 止住全部失血；
    // 开火取消读条并复位开关；开始包扎取消换弹（开始换弹取消包扎见 startReload）。
    if (controls.state.bandaging && isBleeding(playerBleed) && !collapsing && !controls.state.firing) {
      if (reloading) {
        reloading = false;
        gun.setReloading(false);
        hud.setReloading(false);
      }
      if (!bandaging) {
        bandaging = true;
        gun.setBandaging(true);
      }
      bandageT += dt;
      if (bandageT >= BANDAGE_TIME) {
        clearBleeds(playerBleed);
        bloodLoss = 0;
        bandageT = 0;
        bandaging = false;
        gun.setBandaging(false);
        controls.clearBandageLatch();
        audio.heal();
        hud.setStatusLine('包扎完成，失血止住了', 2000);
        hud.toast('已止血');
        updateBleedHud();
      }
    } else {
      if (bandaging) {
        bandaging = false;
        gun.setBandaging(false);
      }
      bandageT = 0;
      // 开火/倒地取消时复位触屏开关，否则松开火键后读条会自己续上。
      if (controls.state.firing || collapsing) controls.clearBandageLatch();
    }
    const showBandage = bandageT > 0 && isBleeding(playerBleed);
    if (showBandage !== bandageShown || showBandage) {
      hud.setBandaging(showBandage, bandageT / BANDAGE_TIME);
      bandageShown = showBandage;
    }

    // 头部摆动：幅度随速度淡入淡出（停下不跳变），strafing 时轻微侧倾；空中不摆动。
    // 垂直摆动一周期一步，横向摆动与滚转半频（一步一晃）；机瞄时因移速变慢
    // 摆动自然变小，沿用旧行为，不特殊处理。
    const speedNow = Math.hypot(player.vel.x, player.vel.z);
    const speedNorm = Math.min(1, speedNow / WALK_SPEED);
    const bobTarget = player.grounded ? BOB_VERT_AMP * speedNorm : 0;
    player.bobAmp += (bobTarget - player.bobAmp) * Math.min(1, 6 * dt);
    if (speedNorm > 0.05) player.bobT += dt * (5 + 5 * speedNorm);
    const ampFrac = player.bobAmp / BOB_VERT_AMP; // 0..1，淡入系数
    const bobY = Math.sin(player.bobT) * player.bobAmp;
    const bobX = Math.cos(player.bobT * 0.5) * BOB_LAT_AMP * ampFrac;
    const bobRoll = Math.cos(player.bobT * 0.5) * BOB_ROLL_AMP * ampFrac;
    // 脚步声：bob 周期每次过谷底（sin 达 -1）即一步；落地瞬间不重复触发。
    // 占位合成音，等真实脚步素材落地后替换（见 audio.footstep 的注释）。
    const stepCycle = Math.floor((player.bobT - Math.PI * 1.5) / (Math.PI * 2));
    if (stepCycle !== lastStepCycle) {
      lastStepCycle = stepCycle;
      if (player.grounded && player.bobAmp > 0.01) {
        footstepCount++;
        audio.footstep();
      }
    }
    const leanTarget = -mx * 0.012 * speedNorm;
    player.lean += (leanTarget - player.lean) * Math.min(1, 8 * dt);

    // 换弹：进度驱动枪身分段动画 + 分段咔哒声（时长按当前武器：手枪更快）
    if (reloading) {
      const progress = 1 - (reloadEnd - now) / reloadDuration;
      const p = Math.min(1, Math.max(0, progress));
      hud.setReloading(true, p);
      gun.setReloadProgress(p);
      for (let i = 0; i < RELOAD_CLICK_STAGES.length; i++) {
        if (p >= RELOAD_CLICK_STAGES[i].at && reloadStage < i + 1) {
          reloadStage = i + 1;
          audio.click(RELOAD_CLICK_STAGES[i].freq);
        }
      }
      if (now >= reloadEnd) {
        reloading = false;
        ammoByWeapon[currentWeapon] = WEAPON_STATS[currentWeapon].magSize;
        gun.setReloading(false);
        hud.setReloading(false);
        hud.setStatusLine('换弹完成', 1500);
      }
    }

    // 射击：连发按住连续，单发每次扣动一下；倒地黑场/阵亡/比赛结束时不能射击；
    // 战术刀每次扣动挥砍一次（挥刀间隔由 meleeAttack 内部控制）。
    const firing = controls.state.firing && !collapsing && !dead && !matchOver;
    const triggerEdge = firing && !prevFiring;
    if (currentWeapon === 'knife') {
      if (triggerEdge) meleeAttack(now);
    } else if (!reloading && now >= nextShotAt) {
      const stats = WEAPON_STATS[currentWeapon];
      const canAuto = currentWeapon === 'rifle' && fireMode === 'auto';
      const interval = currentWeapon === 'rifle'
        ? (fireMode === 'auto' ? AUTO_INTERVAL : SEMI_INTERVAL)
        : stats.semiInterval;
      if ((canAuto && firing) || (!canAuto && triggerEdge)) {
        shoot(now);
        nextShotAt = now + interval;
      }
    }
    prevFiring = firing;

    // 后坐力叠加到镜头（摆动横向分量沿镜头右侧方向）；落地下沉直接扣在镜头高度上；
    // 失血时叠加小幅晃动（随总失血量渐变增强，满额与 v0.4 一致）
    const recoil = gun.getRecoil();
    const swayAmp = bleedSwayAmplitude(bleedFrac);
    const swayPitch = Math.sin(swayT * 1.7) * swayAmp;
    const swayYaw = Math.sin(swayT * 1.3 + 1.2) * swayAmp;
    camera.position.set(player.pos.x + bobX * cos, player.pos.y + bobY - player.landDip, player.pos.z - bobX * sin);
    camera.rotation.y = player.yaw + recoil.yaw + swayYaw;
    camera.rotation.x = player.pitch + recoil.pitch + swayPitch;
    camera.rotation.z = player.lean + bobRoll;

    // 机瞄 FOV + 疾跑 FOV 小幅扩张
    const sprinting = controls.state.sprint && my > 0.1 && speedNorm > 0.5;
    const targetFov = aiming ? 55 : sprinting ? 80 : 75;
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
      camera.updateProjectionMatrix();
    }

    gun.update(dt, aiming);
    hud.setCrosshair(gun.getBloom() * 900, true);
    hud.setAds(aiming);
    if (currentWeapon === 'knife') hud.setAmmo('—', '');
    else hud.setAmmo(ammoByWeapon[currentWeapon], '∞');

    hudTimer += dt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      hud.setScore({ shots: score.shots, hits: score.hits, zoneCounts: score.zoneCounts, elapsedSec: elapsed });
      updateBodyHud(); // 失血会随时间损毁模块（bleed tick），图要跟着变
      // 全清判定：纸靶（含移动靶）全倒 + 钢板全倒 + 假人失能。达成即时保存
      // 最快全清（不等回主页结算），每局只播报一次。死斗没有靶子，不判定。
      if (!activeMap.isTdm && !clearAnnounced && activeMap.targets.getClearState().cleared) {
        clearAnnounced = true;
        recordsStore.recordClear(Math.max(0, Math.round(elapsed)));
        hud.toast('全部清除！');
      }
    }
  } else if (!playing) {
    // 菜单状态：镜头在当前地图的出生点缓缓扫视（主页背景随选中的地图切换）
    const mc = activeMap.env.menuCam;
    camera.position.set(mc.x, EYE_HEIGHT, mc.z);
    camera.rotation.y = mc.yawBase + Math.sin(now * 0.08) * mc.yawAmp;
    camera.rotation.x = mc.pitch;
    camera.rotation.z = 0;
    gun.update(dt, false);
  }

  // 靶子/特效/机器人：暂停时全部冻结；菜单时靶子继续动（主页背景动画）。
  if (!paused) {
    activeMap.targets.update(dt, now);
    updateEffects(dt);
    if (playing && isTdmActive() && botManager && !tdm.matchOver) {
      botManager.update(dt, now, {
        pos: player.pos,
        alive: tdm.playerAlive,
        speed: Math.hypot(player.vel.x, player.vel.z),
      }, {
        blue: buffModifiers(tdm.match, 'blue'),
        red: buffModifiers(tdm.match, 'red'),
      });
    }
  }
  // 视图模型相机与主镜头逐帧同步（位置/朝向/FOV/宽高比），再分两次渲染：
  // 主场景先画（背景色自带强制清空），清空深度后画枪——枪永远在世界前面，
  // 不会被近处墙体裁掉，也不吃世界灯光。
  gunCamera.position.copy(camera.position);
  gunCamera.quaternion.copy(camera.quaternion);
  if (gunCamera.fov !== camera.fov || gunCamera.aspect !== camera.aspect) {
    gunCamera.fov = camera.fov;
    gunCamera.aspect = camera.aspect;
    gunCamera.updateProjectionMatrix();
  }
  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(gunScene, gunCamera);
}

// 版本标签由脚本写入：显示的版本即实际运行的脚本版本。
// 主页上有两处版本标签（标题旁 + 页脚），全部写一遍。
document.querySelectorAll('#start-overlay .ver').forEach((el) => {
  el.textContent = `v${VERSION}`;
});

// 调试钩子：仅供自动化验证读取状态与驱动测试场景，不影响游戏。
window.__impasseDebug = {
  version: VERSION,
  get playing() { return playing; },
  get mapId() { return activeMapId; },
  get records() { return recordsStore.get(); },
  get clearState() { return activeMap.targets.getClearState(); },
  get meshCounts() {
    const count = (g) => {
      let n = 0;
      g.traverse((o) => { if (o.isMesh || o.isSprite) n++; });
      return n;
    };
    return {
      range: rangeEnv ? count(rangeEnv.group) : 0,
      street: streetEnv ? count(streetEnv.group) : 0,
    };
  },
  get initialized() { return initialized; },
  get assets() { return assetReport; },
  get audioSamples() { return audio.sampleStatus(); },
  get playerY() { return player.pos.y; },
  get feetY() { return player.pos.y - EYE_HEIGHT; },
  get cameraY() { return camera.position.y; },
  get cameraX() { return camera.position.x; },
  get cameraZ() { return camera.position.z; },
  get cameraRoll() { return camera.rotation.z; },
  get bobAmp() { return player.bobAmp; },
  get bobT() { return player.bobT; },
  get footstepCount() { return footstepCount; },
  get grounded() { return player.grounded; },
  get groundHeight() { return player.groundHeight; },
  get playerPos() { return { x: player.pos.x, y: player.pos.y, z: player.pos.z }; },
  get bloodLoss() { return bloodLoss; },
  get bleeding() { return bleedingZones(playerBleed); },
  get bleedFraction() { return bleedFraction(bloodLoss); },
  get speedFactor() { return bleedSpeedFactor(bleedFraction(bloodLoss)); },
  get sprinting() { return controls.state.sprint; },
  get bandageProgress() { return bandageT / BANDAGE_TIME; },
  get bandaging() { return bandaging; },
  get bandagePose() { return gun.getBandagePose(); },
  get leftHandNdc() { return gun.getLeftHandNdc(); },
  get collapsing() { return collapsing; },
  settings: settings.state,
  setPlayerPos(x, z) {
    player.pos.set(x, EYE_HEIGHT + player.groundHeight, z);
    player.vel.set(0, 0, 0);
    player.vy = 0;
    player.grounded = true;
    player.groundHeight = supportHeightAt(x, z);
    player.pos.y = player.groundHeight + EYE_HEIGHT;
  },
  aimAt(yaw, pitch) {
    player.yaw = yaw;
    player.pitch = pitch;
  },
  // 零散布探针：从当前镜头向 (tx,ty,tz) 打一条无散布射线，返回命中点、
  // 假人组局部坐标与判定部位——用于定位分区判定与瞄准之间的偏差。
  // 不开火、不耗弹药、不改分数。
  probeRay(tx, ty, tz) {
    const dx = tx - camera.position.x, dy = ty - camera.position.y, dz = tz - camera.position.z;
    player.yaw = Math.atan2(-dx, -dz);
    player.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;
    camera.rotation.z = 0;
    camera.updateMatrixWorld(true);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    raycaster.set(camera.position.clone(), dir);
    const hits = raycaster.intersectObjects(allHitMeshes, false);
    if (!hits.length) return { hit: false };
    const h = hits[0];
    const dummy = h.object.userData.dummy;
    let local = null, zone = null;
    if (dummy) {
      const l = dummy.group.worldToLocal(h.point.clone());
      local = { x: +l.x.toFixed(3), y: +l.y.toFixed(3), z: +l.z.toFixed(3) };
      zone = activeMap.targets.zoneAtPoint(dummy, h.point);
    }
    return {
      hit: true,
      point: { x: +h.point.x.toFixed(3), y: +h.point.y.toFixed(3), z: +h.point.z.toFixed(3) },
      dist: +h.distance.toFixed(2),
      kind: h.object.userData.surface && h.object.userData.surface.kind,
      local, zone, dummyIsSoldier: dummy ? dummy.isSoldier : null,
    };
  },
  simulateHit(zone, severity) { playerTakeHit(zone, severity); },
  get lastShot() { return lastShot; },
  getDummies() { return activeMap.targets.getDummies(); },
  // 武器与防具状态（调试用）。
  get weapon() { return currentWeapon; },
  switchWeapon(name) { switchWeapon(name); },
  get gear() { return isTdmActive() ? gearStatus(tdm.playerGear) : null; },
  get integrity() { return isTdmActive() ? { ...tdm.playerIntegrity } : null; },
  // 团队死斗调试：比分/增益/机器人状态、强制比分（测背水一战）、强制击杀。
  tdm: {
    get active() { return isTdmActive(); },
    get scores() { return isTdmActive() ? { ...tdm.match.scores } : null; },
    get buff() {
      return isTdmActive()
        ? { active: tdm.match.buff, used: tdm.match.buffUsed }
        : null;
    },
    get matchOver() { return isTdmActive() ? tdm.matchOver : null; },
    get playerAlive() { return isTdmActive() ? tdm.playerAlive : null; },
    setScore(blue, red) {
      if (!isTdmActive()) return;
      tdm.match.scores.blue = blue;
      tdm.match.scores.red = red;
      hud.setTdmScore(blue, red);
    },
    get bots() { return botManager ? botManager.getBots() : []; },
    checkWaypoints() { return botManager ? botManager.checkWaypoints() : null; },
    // 战术调试（v0.14）：掩体点/碰撞体快照、定点伤害、传送、设弹药。
    coverPoints() { return botManager ? botManager.coverPoints() : []; },
    colliders() { return botManager ? botManager.getColliders() : []; },
    damageBot(i, zone, severity, ax, az) { return botManager ? botManager.hurtBot(i, zone, severity, ax, az) : null; },
    coverProbe(i) { return botManager ? botManager.coverProbe(i) : null; },
    teleportBot(i, x, z, yaw) { if (botManager) botManager.teleportBot(i, x, z, yaw); },
    setBotMag(i, n) { if (botManager) botManager.setBotMag(i, n); },
    healBot(i) { if (botManager) botManager.healBot(i); },
    killBot(i) {
      if (!botManager) return;
      const b = botManager.bots[i];
      if (b) {
        botManager.applyPlayerHit(b, {
          zone: 'head', zoneLabel: '头部', severity: 5,
          outcomeLabel: '贯穿', incapacitated: true,
        }, 1, player.pos);
      }
    },
    damagePlayer(zone, severity) { playerTakeHit(zone, severity); },
    scoreKill(team) {
      if (!isTdmActive()) return;
      recordTdmKill(team,
        { name: '测试员', team, isPlayer: false },
        { name: '靶子', team: team === 'blue' ? 'red' : 'blue', isPlayer: false });
    },
  },
};

updateWeaponHud();
hud.setCrosshair(0, true);
renderRecords();
hud.showStart();

// ---------- 素材加载 → 建造 → 启动 ----------
// 主页 DOM 立即显示（带“加载资源…”状态与禁用的进入按钮），3D 场景在
// 素材加载完成（或 8 秒超时回退）后建造，主循环随之启动。加载失败的
// 模型/贴图/HDRI 各自走回退：程序化枪与假人、色块建筑、纯色材质、
// 无环境光——游戏始终可玩。
async function init() {
  const statusEl = document.getElementById('asset-status');
  const startBtn = document.getElementById('btn-start');
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  let assetSet;
  try {
    assetSet = await loadAssets({
      onProgress: (done, total) => setStatus(`加载资源… ${done}/${total}`),
    });
  } catch (e) {
    // loadAssets 内部已全量兜底，这里是最后一道防线：空素材集 + 全回退。
    assetSet = { models: new Map(), failedModels: new Set(), textures: {}, hdr: null, timedOut: true };
  }
  assetReport = {
    modelsLoaded: assetSet.models.size,
    failedModels: [...assetSet.failedModels],
    hdr: !!assetSet.hdr,
    timedOut: assetSet.timedOut,
  };
  // HDRI → PMREM 环境贴图（只有街区用；失败则无环境光，靠太阳 + 半球光）。
  let envTexture = null;
  if (assetSet.hdr) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      envTexture = pmrem.fromEquirectangular(assetSet.hdr).texture;
      pmrem.dispose();
      assetSet.hdr.dispose();
    } catch (e) { envTexture = null; }
  }
  // 假人士兵：靶场用绿色版、街区用蓝色版，任一失败时互相顶替，都失败则程序化。
  const rangeSoldier = assetSet.models.get('soldier') || assetSet.models.get('soldier-blue') || null;
  const streetSoldier = assetSet.models.get('soldier-blue') || assetSet.models.get('soldier') || null;
  // 机器人队伍模型：蓝队用蓝色版、红队用绿色版（bots.js 内染红），任一失败
  // 时互相顶替；两个都失败则死斗卡片不可选（机器人没有身体可打）。
  soldierModels = {
    blue: assetSet.models.get('soldier-blue') || assetSet.models.get('soldier') || null,
    red: assetSet.models.get('soldier') || assetSet.models.get('soldier-blue') || null,
  };
  soldierAnimations = assetSet.animations || null;
  rangeEnv = createRange({ scene });
  streetEnv = createStreet({ scene, assets: assetSet });
  if (envTexture) {
    streetEnv.env.environment = envTexture;
    gunScene.environment = envTexture; // 视图模型的环境光与街区共用同一张 HDRI
  }
  rangeTargets = createTargets({ parent: rangeEnv.group, onEvent: onTargetEvent, layout: RANGE_LAYOUT, soldierModel: rangeSoldier });
  streetTargets = createTargets({ parent: streetEnv.group, onEvent: onTargetEvent, layout: STREET_LAYOUT, soldierModel: streetSoldier });
  MAPS = {
    range: { id: 'range', label: '靶场', env: rangeEnv, targets: rangeTargets },
    street: { id: 'street', label: '街区', env: streetEnv, targets: streetTargets },
    tdm: { id: 'tdm', label: '团队死斗', env: streetEnv, targets: streetTargets, isTdm: true },
  };
  if (!soldierModels.blue && !soldierModels.red) {
    const card = document.querySelector('.mode-card[data-map="tdm"]');
    if (card) {
      card.classList.add('disabled');
      card.setAttribute('aria-disabled', 'true');
      card.removeAttribute('data-map');
      const tag = document.createElement('span');
      tag.className = 'mode-tag';
      tag.textContent = '素材缺失';
      card.appendChild(tag);
    }
  }
  setActiveMap('range');
  gun = createGun({
    camera: gunCamera,
    rifleModel: assetSet.models.get('rifle') || null,
    pistolModel: assetSet.models.get('pistol') || null,
  });
  initialized = true;
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.textContent = `进入${MAPS[activeMapId].label}`;
  }
  setStatus(assetSet.failedModels.size > 0
    ? `部分素材加载失败，已用备用模型（${assetSet.failedModels.size} 件）`
    : '');
  animate();
}

// 先渲染一帧纯背景色，避免加载期间画布全黑；主循环由 init 启动。
renderer.clear();
renderer.render(scene, camera);
init();
