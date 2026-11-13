// 靶场 v0.1 —— 主循环：场景、射击判定、曳光/命中特效、计分、游戏状态。
// 渲染：Three.js（CDN）；输入：Pointer Lock + 触屏；毁伤：damage.js 纯函数。

import * as THREE from 'three';
import { createControls } from './controls.js';
import { createGun } from './gun.js';
import { createTargets } from './targets.js';
import { createRange } from './range.js';
import { createHud } from './hud.js';
import { evaluateHit, evaluateRicochet } from './damage.js';

const MAG_SIZE = 30;
const RELOAD_TIME = 1.8;
const AUTO_INTERVAL = 0.1; // 600 RPM
const SEMI_INTERVAL = 0.14;
const EYE_HEIGHT = 1.6;
const BOUNDS = { x: 5.8, zMin: -1.5, zMax: 10.5 };

// ---------- 渲染器与场景 ----------
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c20);
scene.fog = new THREE.Fog(0x1a1c20, 30, 55);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 80);
camera.rotation.order = 'YXZ';
scene.add(camera);

const range = createRange({ scene });
const targets = createTargets({ scene });
const gun = createGun({ camera });
const hud = createHud();

const controls = createControls({
  canvas,
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
  },
});
if (controls.isTouch) document.body.classList.add('touch');

const allHitMeshes = [...range.hitMeshes, ...targets.hitMeshes];

// ---------- 玩家状态 ----------
const player = {
  pos: new THREE.Vector3(0, EYE_HEIGHT, 8),
  yaw: 0,
  pitch: 0,
  bobT: 0,
};
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

// ---------- 特效：曳光与命中火花 ----------
const tracers = [];
const impacts = [];

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

function spawnTracer(a, b, color = 0xffd27a) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ line, life: 0.07, maxLife: 0.07 });
}

function spawnImpact(point, big = false) {
  const mat = new THREE.SpriteMaterial({
    map: sparkTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(point);
  const s = big ? 0.3 : 0.18;
  sprite.scale.setScalar(s);
  scene.add(sprite);
  impacts.push({ sprite, life: 0.22, maxLife: 0.22, size: s });
}

function updateEffects(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.life <= 0) {
      scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
      tracers.splice(i, 1);
    } else {
      t.line.material.opacity = (t.life / t.maxLife) * 0.9;
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
      const k = im.life / im.maxLife;
      im.sprite.material.opacity = k;
      im.sprite.scale.setScalar(im.size * (1 + (1 - k) * 0.8));
    }
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

function shoot(now) {
  if (ammo <= 0) {
    startReload();
    return;
  }
  ammo -= 1;
  score.shots += 1;
  const aiming = controls.state.aiming;
  gun.fire(aiming);

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
    const res = targets.applyDummyHit(obj, evalResult);
    score.hits += 1;
    score.zoneCounts[evalResult.zone] += 1;
    hud.showHitmarker(evalResult.zoneLabel);
    hud.addLog(res.log, evalResult.zone === 'head' ? 'crit' : '');
    if (res.incapacitated) hud.toast('目标失能！');
    spawnImpact(_hitPoint, false);
    return;
  }

  if (surface.kind === 'paper') {
    const res = targets.applyPaperHit(obj, _hitPoint);
    score.hits += 1;
    hud.showHitmarker('纸靶');
    hud.addLog(res.log);
    spawnImpact(_hitPoint, false);
    return;
  }

  if (surface.kind === 'steel') {
    const res = targets.applySteelHit(obj, energy);
    score.hits += 1;
    hud.showHitmarker('钢板');
    hud.addLog(res.log);
    spawnImpact(_hitPoint, true);
    // 钢板是硬表面：小角度命中可能跳弹
    const ric = evaluateRicochet({ incidenceDeg, hardness: 1, roll: Math.random() });
    if (ric.ricochet) deflectTracer(_hitPoint, normal);
    return;
  }

  // 硬表面（墙/地面/掩体）：命中火花 + 可能跳弹
  spawnImpact(_hitPoint, true);
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
function startReload() {
  if (reloading || ammo === MAG_SIZE) return;
  reloading = true;
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
  targets.reset();
  hud.addLog('靶子已重置');
  hud.toast('靶子已重置');
}

controls.on('reload', () => { if (playing) startReload(); });
controls.on('toggleMode', () => { if (playing) toggleMode(); });
controls.on('reset', () => { if (playing) resetTargets(); });
controls.on('lockLost', () => {
  if (playing && !controls.isTouch) hud.showPause();
});

// ---------- 开始 / 暂停 ----------
function startGame() {
  playing = true;
  startedAt = performance.now() / 1000;
  hud.hideStart();
  hud.hidePause();
  controls.requestPointerLock();
  hud.addLog('靶场已就绪，开始射击');
  hud.setScore({ shots: 0, hits: 0, zoneCounts: score.zoneCounts, elapsedSec: 0 });
}

document.getElementById('btn-start').addEventListener('click', startGame);
document.getElementById('btn-resume').addEventListener('click', () => {
  hud.hidePause();
  controls.requestPointerLock();
});
canvas.addEventListener('click', () => {
  if (playing && !controls.isTouch && !controls.state.pointerLocked) {
    controls.requestPointerLock();
    hud.hidePause();
  }
});

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

    // 移动
    const aiming = controls.state.aiming && !reloading;
    const speed = aiming ? 1.9 : controls.state.sprint ? 5.2 : 3.4;
    const sin = Math.sin(player.yaw);
    const cos = Math.cos(player.yaw);
    const mx = controls.state.moveX;
    const my = controls.state.moveY;
    // 前进方向为 -Z 旋转 yaw
    const vx = mx * cos - my * sin;
    const vz = -my * cos - mx * sin;
    player.pos.x = THREE.MathUtils.clamp(player.pos.x + vx * speed * dt, -BOUNDS.x, BOUNDS.x);
    player.pos.z = THREE.MathUtils.clamp(player.pos.z + vz * speed * dt, BOUNDS.zMin, BOUNDS.zMax);
    const moving = Math.hypot(mx, my) > 0.1;
    if (moving) player.bobT += dt * (controls.state.sprint ? 11 : 8);
    const bobY = moving ? Math.sin(player.bobT) * 0.014 : 0;

    // 换弹
    if (reloading) {
      const progress = 1 - (reloadEnd - now) / RELOAD_TIME;
      hud.setReloading(true, Math.min(1, progress));
      if (now >= reloadEnd) {
        reloading = false;
        ammo = MAG_SIZE;
        gun.setReloading(false);
        hud.setReloading(false);
        hud.addLog('换弹完成');
      }
    }

    // 射击：连发按住连续，单发每次扣动一下
    const firing = controls.state.firing;
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

    // 后坐力叠加到镜头
    const recoil = gun.getRecoil();
    camera.position.set(player.pos.x, player.pos.y + bobY, player.pos.z);
    camera.rotation.y = player.yaw + recoil.yaw;
    camera.rotation.x = player.pitch + recoil.pitch;

    // 机瞄 FOV
    const targetFov = aiming ? 55 : 75;
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
    }
  } else {
    // 菜单状态：镜头缓缓扫视靶场
    camera.position.set(0, EYE_HEIGHT, 8);
    camera.rotation.y = Math.sin(now * 0.08) * 0.15;
    camera.rotation.x = -0.02;
    gun.update(dt, false);
  }

  targets.update(dt, now);
  updateEffects(dt);
  renderer.render(scene, camera);
}

hud.setAmmo(MAG_SIZE, '∞');
hud.setFireMode(fireMode);
hud.setCrosshair(0, true);
hud.showStart();
animate();
