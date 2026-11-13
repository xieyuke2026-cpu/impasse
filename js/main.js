// IMPASSE v0.8 —— 主循环：场景、射击判定、曳光/命中特效、计分、游戏状态。
// 渲染：Three.js（CDN）；输入：Pointer Lock + 触屏；毁伤：damage.js 纯函数；
// 失血：bleeding.js 纯函数（假人 + 玩家）；记录：records.js 纯函数 + localStorage。
// 两张地图（靶场 + 城市街区）同场建造、按组切换可见性；记录两张图共用。
// 缓存策略：全部本地模块带 ?v=0.8 查询串，版本升级即换地址，避免新旧文件混版。

import * as THREE from 'three';
import { createControls } from './controls.js?v=0.8';
import { createGun } from './gun.js?v=0.8';
import { createTargets, RANGE_LAYOUT, STREET_LAYOUT } from './targets.js?v=0.8';
import { createRange } from './range.js?v=0.8';
import { createStreet } from './street.js?v=0.8';
import { createHud } from './hud.js?v=0.8';
import { createAudio } from './audio.js?v=0.8';
import { createSettingsStore, initSettingsPanel, KEY_ACTIONS, keyLabel } from './settings.js?v=0.8';
import { createRecordsStore } from './records.js?v=0.8';
import { evaluateHit, evaluateRicochet, ZONE_LABELS } from './damage.js?v=0.8';
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
} from './bleeding.js?v=0.8';

// 唯一版本号：由脚本写进主页的版本标签，显示的版本即脚本版本，
// 旧脚本缓存不会谎报新版本（HTML 里的 v0.8 只是加载前的占位文案）。
const VERSION = '0.8';

const MAG_SIZE = 30;
const RELOAD_TIME = 1.8;
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
// 街区同理：花坛 0.6m、沙袋 0.8m、路障 0.9m、木箱 1.0m、垃圾箱 1.2m 可跳，
// 汽车 1.4m、墙体 3.2m 跳不过去。
const JUMP_VELOCITY = 5.8; // m/s
const BANDAGE_TIME = 2.5; // 包扎读条（秒）：键盘按住 B / 触屏点按包扎键开关；开火打断
const COLLAPSE_FADE_TIME = 0.9; // 倒地黑场时长（秒），黑满后重生
const COYOTE_TIME = 0.08; // 土狼时间：离地后 0.08s 内仍可起跳
const JUMP_BUFFER = 0.1; // 输入缓冲：落地前 0.1s 内的跳跃输入仍生效

// ---------- 渲染器与场景 ----------
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// 阴影：只有街区的太阳投射阴影（1024 贴图），靶场的灯一律不投射，
// 开启阴影贴图对靶场没有额外开销。
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c20);
scene.fog = new THREE.Fog(0x1a1c20, 30, 55);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 120);
camera.rotation.order = 'YXZ';
scene.add(camera);

// ---------- 地图：两张图同场建造，按组切换 ----------
// 每张地图的环境与靶子挂在同一个组里（靶子以环境组为 parent）：
// 切图 = 换组的 visible + 换射线/碰撞集合 + 换天空/雾。灯光挂在组里，
// 隐藏的组灯光自动失效，不重建。靶子 update 只跑当前地图的一套。
const rangeEnv = createRange({ scene });
const streetEnv = createStreet({ scene });
const hud = createHud();
const audio = createAudio();
const settings = createSettingsStore();
const recordsStore = createRecordsStore();
// 失血导致模块损毁时，targets 通过事件回调让主循环写日志/弹提示（两套靶子共用）。
const onTargetEvent = (evt) => {
  if (evt.type === 'bleedDestroy') {
    hud.addLog(`假人${evt.zoneLabel}模块因失血损毁！`, 'crit');
    if (evt.incapacitated) hud.toast('目标失能！');
  }
};
const rangeTargets = createTargets({ parent: rangeEnv.group, onEvent: onTargetEvent, layout: RANGE_LAYOUT });
const streetTargets = createTargets({ parent: streetEnv.group, onEvent: onTargetEvent, layout: STREET_LAYOUT });
const MAPS = {
  range: { id: 'range', label: '靶场', env: rangeEnv, targets: rangeTargets },
  street: { id: 'street', label: '街区', env: streetEnv, targets: streetTargets },
};
let activeMapId = 'range';
let activeMap = MAPS.range;
let allHitMeshes = [];
let colliders = [];
function setActiveMap(id) {
  activeMapId = id;
  activeMap = MAPS[id];
  for (const m of Object.values(MAPS)) m.env.group.visible = m === activeMap;
  allHitMeshes = [...activeMap.env.hitMeshes, ...activeMap.targets.hitMeshes];
  colliders = [...activeMap.env.colliders, ...activeMap.targets.colliders];
  scene.background = activeMap.env.env.background;
  scene.fog = activeMap.env.env.fog;
}
setActiveMap('range');
const gun = createGun({ camera });

const controls = createControls({
  canvas,
  settings,
  elements: {
    joystickZone: document.getElementById('joystick-zone'),
    joystickBase: document.getElementById('joystick-base'),
    joystickKnob: document.getElementById('joystick-knob'),
    lookZone: document.getElementById('look-zone'),
    btnFire: document.getElementById('btn-fire'),
    btnAim: document.getElementById('btn-aim'),
    btnReload: document.getElementById('btn-reload'),
    btnMode: document.getElementById('btn-mode'),
    btnReset: document.getElementById('btn-reset'),
    btnJump: document.getElementById('btn-jump'),
    btnBandage: document.getElementById('btn-bandage'),
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
// 玩家受伤接口：未来的敌人命中玩家时调用。当前版本只有设置里的“模拟受伤”
// 测试钩子调用它。severity 为命中严重度 0..1（由毁伤模型给出）。
function playerTakeHit(zone, severity = 0.4) {
  const z = ZONE_LABELS[zone] ? zone : 'abdomen';
  bloodLoss += severity * IMMEDIATE_BLEED_FACTOR;
  const r = rollBleed(playerBleed, z, Math.random());
  if (r.triggered && !r.refreshed) {
    hud.addLog(`你${ZONE_LABELS[z]}中弹，开始失血！`, 'crit');
    hud.toast('失血！快包扎止血');
  } else if (r.triggered) {
    hud.addLog(`你${ZONE_LABELS[z]}再次中弹，失血持续`, 'crit');
  } else {
    hud.addLog(`你${ZONE_LABELS[z]}中弹（未触发失血）`);
  }
  updateBleedHud();
}

function updateBleedHud() {
  hud.setBleeding(bleedingZones(playerBleed).map((z) => ZONE_LABELS[z]));
  const btnBandage = document.getElementById('btn-bandage');
  if (btnBandage) btnBandage.classList.toggle('toggled', isBleeding(playerBleed));
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
let startedAt = 0;
let ammo = MAG_SIZE;
let fireMode = 'auto';
let reloading = false;
let reloadEnd = 0;
let nextShotAt = 0;
let prevFiring = false;

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
raycaster.far = 60;
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _eject = new THREE.Vector3();

function shoot(now) {
  if (ammo <= 0) {
    audio.dryFire();
    startReload();
    return;
  }
  ammo -= 1;
  score.shots += 1;
  const aiming = controls.state.aiming;
  gun.fire(aiming);
  audio.shot();

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
    const evalResult = evaluateHit({
      zone: obj.userData.zone,
      incidenceDeg,
      rangeM,
      energy,
      roll: Math.random(),
    });
    const res = activeMap.targets.applyDummyHit(obj, evalResult);
    score.hits += 1;
    score.zoneCounts[evalResult.zone] += 1;
    hud.showHitmarker(evalResult.zoneLabel);
    hud.addLog(res.log, evalResult.zone === 'head' ? 'crit' : '');
    if (res.incapacitated) hud.toast('目标失能！');
    spawnImpact(_hitPoint, false);
    audio.thud();
    return;
  }

  if (surface.kind === 'paper') {
    const res = activeMap.targets.applyPaperHit(obj, _hitPoint);
    score.hits += 1;
    hud.showHitmarker('纸靶');
    hud.addLog(res.log);
    spawnImpact(_hitPoint, false);
    audio.thud();
    return;
  }

  if (surface.kind === 'steel') {
    const res = activeMap.targets.applySteelHit(obj, energy);
    score.hits += 1;
    hud.showHitmarker('钢板');
    hud.addLog(res.log);
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
    hud.addLog(`跳弹！（入射角 ${Math.round(incidenceDeg)}°，${surface.kind === 'floor' ? '地面' : '硬表面'}）`, 'ricochet');
  }
}

// 跳弹曳光：按反射定律生成第二段短曳光
function deflectTracer(point, normal) {
  const reflect = _dir.clone().sub(normal.clone().multiplyScalar(2 * _dir.dot(normal))).normalize();
  const end = point.clone().addScaledVector(reflect, 4 + Math.random() * 2);
  spawnTracer(point.clone(), end, 0xff9a4d);
  spawnImpact(point, true);
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
  if (reloading || ammo === MAG_SIZE) return;
  cancelBandage(); // 开始换弹取消包扎（两者互斥，姿态不打架）
  reloading = true;
  reloadStage = 0;
  reloadEnd = performance.now() / 1000 + RELOAD_TIME;
  gun.setReloading(true);
  hud.addLog('换弹中…');
}

function toggleMode() {
  fireMode = fireMode === 'auto' ? 'semi' : 'auto';
  hud.setFireMode(fireMode);
  hud.toast(fireMode === 'auto' ? '切换为连发' : '切换为单发');
}

function resetTargets() {
  activeMap.targets.reset();
  clearAnnounced = false; // 重置后可以再次达成并播报全清
  hud.addLog('靶子已重置');
  hud.toast('靶子已重置');
}

controls.on('reload', () => { if (playing) startReload(); });
controls.on('toggleMode', () => { if (playing) toggleMode(); });
controls.on('reset', () => { if (playing) resetTargets(); });
controls.on('jump', () => { if (playing) player.jumpBuffer = JUMP_BUFFER; });
controls.on('bandageToggle', (on) => {
  // 空按反馈：没失血时点开包扎开关，给一次提示——按钮不能悄悄没反应。
  // 事件只在点按瞬间发一次，不会每帧重复。
  if (on && playing && !isBleeding(playerBleed)) hud.toast('没有失血，无需包扎');
});
const pauseSub = document.getElementById('pause-sub');
controls.on('lockLost', () => {
  if (playing && !controls.isTouch) {
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
  if (r.totalSessions === 0) {
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
  ammo = MAG_SIZE;
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
  hudTimer = 0;
  hud.setAmmo(MAG_SIZE, '∞');
  hud.setScore({ shots: 0, hits: 0, zoneCounts: score.zoneCounts, elapsedSec: 0 });
  hud.clearLog();
}

// 结算一场：只有开过火的场次才计入记录，0 发的空场次不污染总场次与上次成绩。
function endSession() {
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
  if (document.exitPointerLock) document.exitPointerLock();
  controls.setAimActive(false);
  controls.clearBandageLatch();
  resetSession();
  renderRecords();
  hud.hidePause();
  hud.showStart();
  document.body.classList.add('home'); // 回主页：隐藏局内 HUD
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

// ---------- 开始 / 暂停 ----------
function startGame() {
  resetSession();
  document.body.classList.remove('home'); // 进地图：显示局内 HUD
  playing = true;
  startedAt = performance.now() / 1000;
  audio.unlock(); // 用户手势中创建/恢复 AudioContext
  hud.hideStart();
  hud.hidePause();
  controls.requestPointerLock();
  hud.addLog(`${activeMap.label}已就绪，开始射击`);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

// 主页模式选择：点卡片切换地图（金色高亮移动），进入按钮文案跟随，
// 背景 3D 场景即时切换。记录两张图共用，v0.8 不分地图统计。
function selectMap(id) {
  if (!MAPS[id] || id === activeMapId) return;
  document.querySelectorAll('.mode-card[data-map]').forEach((c) => {
    c.classList.toggle('selected', c.dataset.map === id);
  });
  document.getElementById('btn-start').textContent = `进入${MAPS[id].label}`;
  setActiveMap(id);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
document.querySelectorAll('.mode-card[data-map]').forEach((card) => {
  card.addEventListener('click', () => selectMap(card.dataset.map));
});

document.getElementById('btn-start').addEventListener('click', startGame);
document.getElementById('btn-resume').addEventListener('click', () => {
  audio.unlock();
  hud.hidePause();
  controls.requestPointerLock();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
document.getElementById('btn-home').addEventListener('click', goHome);
document.getElementById('btn-pause').addEventListener('click', () => {
  if (!playing) return;
  if (pauseSub) pauseSub.textContent = `点继续回到${activeMap.label}`;
  hud.showPause();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
canvas.addEventListener('click', () => {
  if (playing && !controls.isTouch && !controls.state.pointerLocked) {
    controls.requestPointerLock();
    hud.hidePause();
  }
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
      ${keyRows}
    </div>
    <div class="help-section"><h3>触屏（iPad）</h3>
      <div class="help-row"><span>移动</span><span class="help-key">左半屏虚拟摇杆</span></div>
      <div class="help-row"><span>转动视角</span><span class="help-key">右半屏滑动</span></div>
      <div class="help-row"><span>射击 / 机瞄 / 换弹 / 切换模式</span><span class="help-key">右侧圆形按键</span></div>
      <div class="help-row"><span>跳跃 / 包扎</span><span class="help-key">右侧圆形按键</span></div>
      <div class="help-row"><span>按钮位置与大小</span><span class="help-key">设置里拖拽编辑</span></div>
    </div>
    <div class="help-section"><h3>毁伤与失血</h3>
      <p class="help-note">假人分头 / 胸 / 腹 / 手臂 / 腿部五个模块，命中按部位与入射角判定贯穿、擦伤或骨骼偏转；跳弹只发生在钢板、墙体等硬表面。命中可能触发失血，持续加重模块毁伤；玩家受伤后也会失血（红屏、晃动、减速随失血量渐变加重），用包扎键止血，失血过多会倒地重生。</p>
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
  openHelp();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
document.getElementById('btn-help-close').addEventListener('click', closeHelp);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- 主循环 ----------
const clock = new THREE.Clock();
let hudTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now() / 1000;
  const elapsed = playing ? now - startedAt : 0;

  controls.update();
  const look = controls.consumeLook();

  if (playing) {
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
    const aiming = controls.state.aiming && !reloading && !bandaging;
    const bleedFrac = bleedFraction(bloodLoss);
    const baseSpeed = aiming ? 1.9 : controls.state.sprint ? 5.2 : 3.4;
    const speed = baseSpeed * bleedSpeedFactor(bleedFrac);
    const sin = Math.sin(player.yaw);
    const cos = Math.cos(player.yaw);
    const mx = collapsing ? 0 : controls.state.moveX;
    const my = collapsing ? 0 : controls.state.moveY;
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

    // 失血滴答 + 倒地判定（黑场中不推进）。玩家滴答用 0.05/s（假人 0.1/s 不动）。
    if (!collapsing) {
      if (isBleeding(playerBleed)) bloodLoss += tickBleed(playerBleed, dt, PLAYER_BLEED_TICK_RATE).total;
      if (bloodLoss >= COLLAPSE_THRESHOLD) {
        collapsing = true;
        collapseT = 0;
        collapseRespawned = false;
        cancelBandage();
        hud.setCollapseFade(1);
      }
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
        hud.addLog('包扎完成，失血止住了');
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

    // 头部摆动：幅度随速度淡入淡出（停下不跳变），strafing 时轻微侧倾；空中不摆动
    const speedNow = Math.hypot(player.vel.x, player.vel.z);
    const speedNorm = Math.min(1, speedNow / 3.4);
    const bobTarget = player.grounded ? 0.02 * speedNorm : 0;
    player.bobAmp += (bobTarget - player.bobAmp) * Math.min(1, 6 * dt);
    if (speedNorm > 0.05) player.bobT += dt * (5 + 5 * speedNorm);
    const bobY = Math.sin(player.bobT) * player.bobAmp;
    const bobX = Math.cos(player.bobT * 0.5) * player.bobAmp * 0.4;
    const leanTarget = -mx * 0.012 * speedNorm;
    player.lean += (leanTarget - player.lean) * Math.min(1, 8 * dt);

    // 换弹：进度驱动枪身分段动画 + 分段咔哒声
    if (reloading) {
      const progress = 1 - (reloadEnd - now) / RELOAD_TIME;
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
        ammo = MAG_SIZE;
        gun.setReloading(false);
        hud.setReloading(false);
        hud.addLog('换弹完成');
      }
    }

    // 射击：连发按住连续，单发每次扣动一下；倒地黑场中不能射击
    const firing = controls.state.firing && !collapsing;
    const triggerEdge = firing && !prevFiring;
    const interval = fireMode === 'auto' ? AUTO_INTERVAL : SEMI_INTERVAL;
    if (!reloading && now >= nextShotAt) {
      if (fireMode === 'auto' && firing) {
        shoot(now);
        nextShotAt = now + interval;
      } else if (fireMode === 'semi' && triggerEdge) {
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
    camera.rotation.z = player.lean;

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
    hud.setAmmo(ammo, '∞');

    hudTimer += dt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      hud.setScore({ shots: score.shots, hits: score.hits, zoneCounts: score.zoneCounts, elapsedSec: elapsed });
      // 全清判定：纸靶（含移动靶）全倒 + 钢板全倒 + 假人失能。达成即时保存
      // 最快全清（不等回主页结算），每局只播报一次。
      if (!clearAnnounced && activeMap.targets.getClearState().cleared) {
        clearAnnounced = true;
        recordsStore.recordClear(Math.max(0, Math.round(elapsed)));
        hud.addLog(`全部清除！用时 ${formatElapsed(elapsed)}`, 'ricochet');
        hud.toast('全部清除！');
      }
    }
  } else {
    // 菜单状态：镜头在当前地图的出生点缓缓扫视（主页背景随选中的地图切换）
    const mc = activeMap.env.menuCam;
    camera.position.set(mc.x, EYE_HEIGHT, mc.z);
    camera.rotation.y = mc.yawBase + Math.sin(now * 0.08) * mc.yawAmp;
    camera.rotation.x = mc.pitch;
    camera.rotation.z = 0;
    gun.update(dt, false);
  }

  activeMap.targets.update(dt, now);
  updateEffects(dt);
  renderer.render(scene, camera);
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
    return { range: count(rangeEnv.group), street: count(streetEnv.group) };
  },
  get playerY() { return player.pos.y; },
  get feetY() { return player.pos.y - EYE_HEIGHT; },
  get cameraY() { return camera.position.y; },
  get grounded() { return player.grounded; },
  get groundHeight() { return player.groundHeight; },
  get playerPos() { return { x: player.pos.x, y: player.pos.y, z: player.pos.z }; },
  get bloodLoss() { return bloodLoss; },
  get bleeding() { return bleedingZones(playerBleed); },
  get bleedFraction() { return bleedFraction(bloodLoss); },
  get speedFactor() { return bleedSpeedFactor(bleedFraction(bloodLoss)); },
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
  simulateHit(zone, severity) { playerTakeHit(zone, severity); },
  getDummies() { return activeMap.targets.getDummies(); },
};

hud.setAmmo(MAG_SIZE, '∞');
hud.setFireMode(fireMode);
hud.setCrosshair(0, true);
renderRecords();
hud.showStart();
animate();
