// 靶子：纸靶、钢板、移动靶、分区假人。
// 假人按模块（头/胸/腹/手臂/腿部）累计毁伤，没有血条；
// 头部或胸部模块损毁即失能倒地。
// 命中可能触发失血（见 bleeding.js）：持续累积所在模块的毁伤，
// 直到部位损毁、目标失能或靶子重置。

import * as THREE from 'three';
import {
  createBleedState,
  rollBleed,
  tickBleed,
  stopBleed,
  clearBleeds,
  bleedingZones,
  totalSeverity,
} from './bleeding.js?v=0.8';
import { ZONE_LABELS } from './damage.js?v=0.8';

const HOLE_GEO = new THREE.CircleGeometry(0.014, 10);
const HOLE_MAT = new THREE.MeshBasicMaterial({ color: 0x111111 });

function paperTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 352;
  const g = c.getContext('2d');
  g.fillStyle = '#e8e2d4';
  g.fillRect(0, 0, 256, 352);
  const cx = 128;
  const cy = 150;
  const rings = [
    [110, '#2b2b2b'],
    [88, '#e8e2d4'],
    [66, '#2b2b2b'],
    [44, '#e8e2d4'],
    [24, '#c0392b'],
  ];
  for (const [r, col] of rings) {
    g.fillStyle = col;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#c0392b';
  g.beginPath();
  g.arc(cx, cy, 10, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#2b2b2b';
  g.lineWidth = 3;
  g.strokeRect(6, 6, 244, 340);
  g.fillStyle = '#2b2b2b';
  g.font = 'bold 26px sans-serif';
  g.textAlign = 'center';
  g.fillText('靶', 128, 322);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// 各部位伤口高度（米，从 part() 的实际摆放位置量得），用于失血滴落点。
const ZONE_ANCHOR_Y = { leg: 0.4, abdomen: 0.98, chest: 1.42, arm: 1.32, head: 1.82 };

function dripTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 2, 16, 16, 15);
  grad.addColorStop(0, 'rgba(150, 16, 16, 1)');
  grad.addColorStop(0.6, 'rgba(120, 10, 10, 0.9)');
  grad.addColorStop(1, 'rgba(90, 8, 8, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- 靶子布局 ----------
// 每张地图一套：纸靶/钢板/假人的位置与朝向（rotY，0 = 面向 +z，即面向出生点
// 方向），以及一个轨道移动靶（mover：沿 axis 在 center 两侧 amplitude 内滑动）。
// 街区布局的位置须与 street.js 的建筑/巷道对齐，改地图几何时这里要同步改。
export const RANGE_LAYOUT = {
  papers: [
    { x: -4.2, z: -18, rotY: 0 },
    { x: -1.4, z: -18, rotY: 0 },
    { x: 1.4, z: -18, rotY: 0 },
  ],
  steels: [
    { x: -2.8, z: -15, rotY: 0 },
    { x: 0, z: -15, rotY: 0 },
    { x: 4.2, z: -18, rotY: 0 },
  ],
  dummies: [{ x: 2.8, z: -14, rotY: 0 }],
  mover: { x: 0, z: -20, axis: 'x', amplitude: 3.6, speed: 0.45, railLength: 8.6, rotY: 0, posts: false },
};

export const STREET_LAYOUT = {
  papers: [
    { x: -6, z: -3, rotY: 0 }, // 广场西
    { x: 7, z: -5, rotY: 0 }, // 广场东
    { x: -10, z: -16, rotY: Math.PI / 2 }, // 北侧西巷，面向巷口（东）
    { x: 10, z: 9, rotY: -Math.PI / 2 }, // 南侧东巷，面向巷口（西）
    { x: -12, z: -11, rotY: Math.PI / 2 }, // 西北房间内，面向房门（东）
    { x: 2, z: -21, rotY: 0 }, // 主街北端远靶（距出生点约 37m）
  ],
  steels: [
    { x: -3.5, z: -12, rotY: 0 }, // 主街北段西侧
    { x: -19, z: 12, rotY: 0 }, // 西侧街南段
    { x: 19, z: -20, rotY: 0 }, // 东侧街北端
  ],
  dummies: [
    { x: -2, z: -6, rotY: 0 }, // 广场
    { x: 8, z: -20, rotY: 0 }, // 东北房间内
    { x: -19, z: -19, rotY: 0 }, // 西侧街北端
  ],
  // 移动靶横穿北侧东巷（z=-16，x 在 5.5..14.5 之间滑动），面向巷口（西）。
  mover: { x: 10, z: -16, axis: 'x', amplitude: 4.5, speed: 0.4, railLength: 10.4, rotY: -Math.PI / 2, posts: true },
};

export function createTargets({ parent, onEvent, layout }) {
  const hitMeshes = [];
  // 障碍物碰撞体（与 range.js 相同格式），由 main.js 做圆形推离。
  // top 从几何体实测：纸靶支架腿高 1.1m，钢板立柱顶 1.6m，假人头顶 1.95m。
  const colliders = [];
  const papers = [];
  const steels = [];
  const dummies = [];

  const paperTex = paperTexture();
  const standMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.8, metalness: 0.3 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.85 });

  // ---------- 纸靶 ----------
  function makePaper(group) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.9),
      // 双面：街区里玩家会绕到靶子背后，背面也要能命中（背面纹理镜像，可接受）。
      new THREE.MeshStandardMaterial({ map: paperTex, roughness: 0.9, metalness: 0, side: THREE.DoubleSide })
    );
    mesh.castShadow = true; // 街区阳光下纸靶投下阴影；靶场无投射阴影的灯，无影响。
    mesh.position.set(0, 1.45, 0);
    group.add(mesh);
    const paper = { group, mesh, hits: 0, falling: false, fallT: 0, holes: [] };
    mesh.userData.surface = { kind: 'paper', hardness: 0.1 };
    mesh.userData.paper = paper;
    hitMeshes.push(mesh);
    papers.push(paper);
    return paper;
  }

  function makeStand(group) {
    const legGeo = new THREE.BoxGeometry(0.05, 1.1, 0.05);
    for (const sx of [-0.25, 0.25]) {
      const leg = new THREE.Mesh(legGeo, standMat);
      leg.position.set(sx, 0.55, 0);
      group.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.3), standMat);
      foot.position.set(sx, 0.025, 0);
      group.add(foot);
    }
  }

  // 固定纸靶（按布局摆放，朝向由 rotY 定；碰撞盒随朝向旋转：0° 时
  // x 半边 0.35 / z 半边 0.2，90° 时互换——与靶场旧版数值一致）。
  for (const p of layout.papers) {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    g.rotation.y = p.rotY || 0;
    parent.add(g);
    makePaper(g);
    makeStand(g);
    const c = Math.abs(Math.cos(p.rotY || 0));
    const s = Math.abs(Math.sin(p.rotY || 0));
    const hx = 0.35 * c + 0.2 * s;
    const hz = 0.35 * s + 0.2 * c;
    colliders.push({ type: 'aabb', minX: p.x - hx, maxX: p.x + hx, minZ: p.z - hz, maxZ: p.z + hz, top: 1.1 });
  }

  // ---------- 移动靶：轨道 + 滑架 ----------
  // 轨道沿 mover.axis 铺设，滑架在中心两侧 amplitude 内正弦滑动；
  // posts 为真时在轨道两端立支撑杆（街区露天巷道需要，靶场轨道贴墙不需要）。
  let moverState = null;
  if (layout.mover) {
    const m = layout.mover;
    const alongX = m.axis === 'x';
    const rail = new THREE.Mesh(
      alongX ? new THREE.BoxGeometry(m.railLength, 0.08, 0.08) : new THREE.BoxGeometry(0.08, 0.08, m.railLength),
      standMat
    );
    rail.position.set(m.x, 2.4, m.z);
    parent.add(rail);
    if (m.posts) {
      const postGeo = new THREE.BoxGeometry(0.08, 2.4, 0.08);
      for (const end of [-m.railLength / 2, m.railLength / 2]) {
        const post = new THREE.Mesh(postGeo, standMat);
        post.position.set(alongX ? m.x + end : m.x, 1.2, alongX ? m.z : m.z + end);
        parent.add(post);
      }
    }
    const carrier = new THREE.Group();
    carrier.position.set(m.x, 0, m.z);
    carrier.rotation.y = m.rotY || 0;
    parent.add(carrier);
    const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.06), standMat);
    hanger.position.set(0, 2.15, 0);
    carrier.add(hanger);
    makePaper(carrier);
    moverState = { carrier, base: alongX ? m.x : m.z, axis: m.axis, amplitude: m.amplitude, speed: m.speed };
  }

  // ---------- 钢板靶：顶部铰链悬挂，命中摆动，打满 3 发倒下 ----------
  function makeSteel(x, z, rotY = 0) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 1.6, z);
    pivot.rotation.y = rotY;
    parent.add(pivot);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, 0.08), standMat);
    post.position.set(0, -0.8, 0.25);
    pivot.add(post);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.04), standMat);
    arm.position.set(0, -0.15, 0);
    pivot.add(arm);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 24), steelMat.clone());
    plate.rotation.x = Math.PI / 2;
    plate.position.set(0, -0.38, 0);
    plate.castShadow = true;
    pivot.add(plate);
    const steel = { pivot, plate, angle: 0, angVel: 0, hits: 0, fallen: false };
    plate.userData.surface = { kind: 'steel', hardness: 1.0 };
    plate.userData.steel = steel;
    hitMeshes.push(plate);
    steels.push(steel);
    // 立柱在 pivot 后方局部 z+0.25 处，随 rotY 旋转；立柱顶面 1.6m
    // （pivot 1.6m，立柱中心 0.8m、高 1.6m）。rotY=0 时与靶场旧版数值一致。
    const px = x + Math.sin(rotY) * 0.25;
    const pz = z + Math.cos(rotY) * 0.25;
    colliders.push({ type: 'aabb', minX: px - 0.1, maxX: px + 0.1, minZ: pz - 0.1, maxZ: pz + 0.1, top: 1.6 });
    return steel;
  }
  for (const s of layout.steels) makeSteel(s.x, s.z, s.rotY || 0);

  // ---------- 分区假人 ----------
  function makeDummy(x, z, rotY = 0) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotY;
    parent.add(group);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x5a6248, roughness: 0.85, metalness: 0.05 });
    const dummy = {
      group,
      integrity: { head: 1, chest: 1, abdomen: 1, arm: 1, leg: 1 },
      destroyed: new Set(),
      incapacitated: false,
      fallT: 0,
      meshes: [],
      bleed: createBleedState(),
      dripT: 0, // 失血滴落计时
      pool: null, // 脚下血泊（随总失血量长大）
    };
    function part(w, h, d, px, py, zone) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), baseMat.clone());
      m.castShadow = true;
      m.position.set(px, py, 0);
      m.userData.surface = { kind: 'dummy', hardness: 0.15 };
      m.userData.zone = zone;
      m.userData.dummy = dummy;
      m.userData.flashT = 0;
      m.material.emissive = new THREE.Color(0xff4030);
      m.material.emissiveIntensity = 0;
      group.add(m);
      hitMeshes.push(m);
      dummy.meshes.push(m);
      return m;
    }
    part(0.13, 0.8, 0.13, -0.11, 0.4, 'leg');
    part(0.13, 0.8, 0.13, 0.11, 0.4, 'leg');
    part(0.34, 0.35, 0.2, 0, 0.98, 'abdomen');
    part(0.4, 0.45, 0.22, 0, 1.42, 'chest');
    part(0.1, 0.62, 0.1, -0.27, 1.32, 'arm');
    part(0.1, 0.62, 0.1, 0.27, 1.32, 'arm');
    part(0.24, 0.26, 0.24, 0, 1.82, 'head');
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.06, 20), standMat);
    platform.position.set(0, 0.03, 0);
    group.add(platform);
    // 血泊：平时隐藏，失血后出现并随总失血量长大（盖在底座顶面上方 5mm）
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(1, 20),
      new THREE.MeshBasicMaterial({ color: 0x5a0d0d, transparent: true, opacity: 0.8, depthWrite: false })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.065, 0);
    pool.scale.setScalar(0.001);
    pool.visible = false;
    group.add(pool);
    dummy.pool = pool;
    dummies.push(dummy);
    // 假人整体（含身体）高 1.95m（头顶 1.82 + 0.26 / 2），跳不过去
    colliders.push({ type: 'circle', x, z, r: 0.45, top: 1.95 });
    return dummy;
  }
  for (const d of layout.dummies) makeDummy(d.x, d.z, d.rotY || 0);

  // ---------- 失血滴落粒子（对象池） ----------
  const dripTex = dripTexture();
  const drips = [];
  const DRIP_POOL = 24;
  function spawnDrip(dummy, zone) {
    let d = drips.find((x) => !x.active);
    if (!d) {
      if (drips.length >= DRIP_POOL) return;
      const mat = new THREE.SpriteMaterial({ map: dripTex, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      parent.add(sprite);
      d = { sprite, vel: new THREE.Vector3(), life: 0, active: false };
      drips.push(d);
    }
    d.active = true;
    d.life = 1.2;
    d.sprite.visible = true;
    d.sprite.material.opacity = 1;
    d.sprite.scale.setScalar(0.03 + Math.random() * 0.03);
    d.sprite.position.set(
      dummy.group.position.x + (Math.random() - 0.5) * 0.2,
      ZONE_ANCHOR_Y[zone] ?? 1.0,
      dummy.group.position.z + (Math.random() - 0.5) * 0.15
    );
    d.vel.set((Math.random() - 0.5) * 0.15, -0.3, (Math.random() - 0.5) * 0.15);
  }
  function updateDrips(dt) {
    for (const d of drips) {
      if (!d.active) continue;
      d.life -= dt;
      d.vel.y -= 4 * dt;
      d.sprite.position.addScaledVector(d.vel, dt);
      if (d.sprite.position.y <= 0.07) {
        d.sprite.position.y = 0.07;
        d.life = Math.min(d.life, 0.25); // 落地后快速淡出
      }
      if (d.life <= 0) {
        d.active = false;
        d.sprite.visible = false;
      } else if (d.life < 0.25) {
        d.sprite.material.opacity = d.life / 0.25;
      }
    }
  }

  // 部位损毁（命中或失血都走这里）：变色、停掉该部位失血、头/胸损毁即失能。
  function destroyZone(dummy, zone) {
    dummy.destroyed.add(zone);
    stopBleed(dummy.bleed, zone);
    for (const m of dummy.meshes) {
      if (m.userData.zone === zone) m.material.color.setHex(0x3a3f30);
    }
    if (zone === 'head' || zone === 'chest') {
      dummy.incapacitated = true;
      clearBleeds(dummy.bleed); // 失能即止血（不再滴落）
    }
  }

  // ---------- 命中处理 ----------
  function applyPaperHit(mesh, point) {
    const paper = mesh.userData.paper;
    if (!paper || paper.falling) return { log: '命中纸靶', zoneLabel: null };
    paper.hits += 1;
    const hole = new THREE.Mesh(HOLE_GEO, HOLE_MAT);
    const local = paper.group.worldToLocal(point.clone());
    hole.position.set(local.x, local.y, 0.003);
    paper.group.add(hole);
    paper.holes.push(hole);
    if (paper.hits >= 8) {
      paper.falling = true;
      return { log: `命中纸靶（第 ${paper.hits} 弹），纸靶被打落！`, zoneLabel: null };
    }
    return { log: `命中纸靶（第 ${paper.hits} 弹）`, zoneLabel: null };
  }

  function applySteelHit(mesh, energy) {
    const steel = mesh.userData.steel;
    if (!steel) return { log: '命中钢板', zoneLabel: null };
    if (steel.fallen) return { log: '命中已倒下的钢板', zoneLabel: null };
    steel.hits += 1;
    steel.angVel += 2.6 + energy * 1.6;
    steel.plate.material.emissive = new THREE.Color(0xff9040);
    steel.plate.material.emissiveIntensity = 0.8;
    if (steel.hits >= 3) {
      steel.fallen = true;
      return { log: `命中钢板（第 ${steel.hits} 弹），钢板倒下！`, zoneLabel: null };
    }
    return { log: `命中钢板（第 ${steel.hits} 弹），钢板摆动`, zoneLabel: null };
  }

  function applyDummyHit(mesh, evalResult) {
    const dummy = mesh.userData.dummy;
    const zone = mesh.userData.zone;
    mesh.userData.flashT = 0.18;
    mesh.material.emissiveIntensity = 1;
    if (!dummy || dummy.incapacitated) {
      return {
        log: `命中${evalResult.zoneLabel} · ${evalResult.outcomeLabel}（目标已失能）`,
        zoneLabel: evalResult.zoneLabel,
        incapacitated: false,
      };
    }
    dummy.integrity[zone] -= evalResult.severity;
    let log = `命中 ${evalResult.zoneLabel} · ${evalResult.outcomeLabel} · ${evalResult.effectLabel}（${evalResult.detail}）`;
    let incapacitatedNow = false;
    if (dummy.integrity[zone] <= 0 && !dummy.destroyed.has(zone)) {
      destroyZone(dummy, zone);
      if (zone === 'head' || zone === 'chest') {
        incapacitatedNow = true;
        log += ' —— 目标失能！';
      } else if (zone === 'arm') {
        log += ' —— 手臂模块损毁';
      } else if (zone === 'leg') {
        log += ' —— 腿部模块损毁';
      }
    } else if (evalResult.incapacitated) {
      destroyZone(dummy, zone);
      incapacitatedNow = true;
      log += ' —— 目标失能！';
    } else if (!dummy.destroyed.has(zone)) {
      // 部位未损毁：roll 失血（擦伤/偏转也会出血，概率相同——伤口就是伤口）
      const bleedRoll = rollBleed(dummy.bleed, zone, Math.random());
      if (bleedRoll.triggered && !bleedRoll.refreshed) {
        log += ` —— ${evalResult.zoneLabel}失血！`;
      }
    }
    return { log, zoneLabel: evalResult.zoneLabel, incapacitated: incapacitatedNow };
  }

  // ---------- 更新 ----------
  function update(dt, elapsed) {
    if (moverState) {
      moverState.carrier.position[moverState.axis] =
        moverState.base + Math.sin(elapsed * moverState.speed) * moverState.amplitude;
    }
    for (const paper of papers) {
      if (paper.falling && paper.fallT < 1) {
        paper.fallT = Math.min(1, paper.fallT + dt / 0.8);
        const e = easeOutCubic(paper.fallT);
        paper.mesh.rotation.x = -1.25 * e;
        paper.mesh.position.y = 1.45 - 1.1 * e;
      }
    }
    for (const steel of steels) {
      if (steel.fallen) {
        steel.angle += (1.35 - steel.angle) * Math.min(1, dt * 5);
      } else {
        const acc = -16 * Math.sin(steel.angle) - 2.8 * steel.angVel;
        steel.angVel += acc * dt;
        steel.angle += steel.angVel * dt;
      }
      steel.pivot.rotation.x = steel.angle;
      if (steel.plate.material.emissiveIntensity > 0) {
        steel.plate.material.emissiveIntensity = Math.max(0, steel.plate.material.emissiveIntensity - dt * 4);
      }
    }
    for (const dummy of dummies) {
      if (dummy.incapacitated && dummy.fallT < 1) {
        dummy.fallT = Math.min(1, dummy.fallT + dt / 0.6);
        dummy.group.rotation.x = -1.52 * easeOutCubic(dummy.fallT);
      }
      for (const m of dummy.meshes) {
        if (m.userData.flashT > 0) {
          m.userData.flashT -= dt;
          m.material.emissiveIntensity = Math.max(0, m.userData.flashT / 0.18);
        }
      }
      // 失血：每处失血持续累积所在模块的毁伤；失能后停止。
      if (!dummy.incapacitated) {
        const tick = tickBleed(dummy.bleed, dt);
        for (const zone of Object.keys(tick.added)) {
          dummy.integrity[zone] -= tick.added[zone];
          if (dummy.integrity[zone] <= 0 && !dummy.destroyed.has(zone)) {
            destroyZone(dummy, zone);
            if (onEvent) {
              onEvent({
                type: 'bleedDestroy',
                zone,
                zoneLabel: ZONE_LABELS[zone],
                incapacitated: dummy.incapacitated,
              });
            }
          }
        }
        const zones = bleedingZones(dummy.bleed);
        if (zones.length > 0) {
          dummy.dripT -= dt;
          if (dummy.dripT <= 0) {
            dummy.dripT = 0.4;
            spawnDrip(dummy, zones[Math.floor(Math.random() * zones.length)]);
          }
          // 血泊随总失血量长大，上限 0.5m 半径
          const r = Math.min(0.5, 0.12 + totalSeverity(dummy.bleed) * 0.15);
          dummy.pool.visible = true;
          dummy.pool.scale.setScalar(Math.max(0.001, r));
        }
      }
    }
    updateDrips(dt);
  }

  // ---------- 重置 ----------
  function reset() {
    for (const paper of papers) {
      for (const hole of paper.holes) paper.group.remove(hole);
      paper.holes = [];
      paper.hits = 0;
      paper.falling = false;
      paper.fallT = 0;
      paper.mesh.rotation.x = 0;
      paper.mesh.position.y = 1.45;
    }
    for (const steel of steels) {
      steel.angle = 0;
      steel.angVel = 0;
      steel.hits = 0;
      steel.fallen = false;
      steel.pivot.rotation.x = 0;
      steel.plate.material.emissiveIntensity = 0;
    }
    for (const dummy of dummies) {
      dummy.integrity = { head: 1, chest: 1, abdomen: 1, arm: 1, leg: 1 };
      dummy.destroyed.clear();
      dummy.incapacitated = false;
      dummy.fallT = 0;
      dummy.group.rotation.x = 0;
      clearBleeds(dummy.bleed);
      dummy.dripT = 0;
      dummy.pool.visible = false;
      dummy.pool.scale.setScalar(0.001);
      for (const m of dummy.meshes) {
        m.material.color.setHex(0x5a6248);
        m.material.emissiveIntensity = 0;
        m.userData.flashT = 0;
      }
    }
    for (const d of drips) {
      d.active = false;
      d.sprite.visible = false;
    }
  }

  // 全清状态（只读快照，供主循环判定“全部清除”与记录最快全清用）：
  // 本布局的全部纸靶（含轨道移动靶）、钢板、假人倒下/失能才算全清；
  // 主循环只问当前地图的这一套，不跨地图统计。
  function getClearState() {
    const papersDown = papers.filter((p) => p.falling).length;
    const steelsDown = steels.filter((s) => s.fallen).length;
    const dummiesDown = dummies.filter((d) => d.incapacitated).length;
    return {
      papersDown,
      papersTotal: papers.length,
      steelsDown,
      steelsTotal: steels.length,
      dummiesDown,
      dummiesTotal: dummies.length,
      cleared: papersDown === papers.length && steelsDown === steels.length && dummiesDown === dummies.length,
    };
  }

  return {
    hitMeshes,
    colliders,
    update,
    reset,
    applyPaperHit,
    applySteelHit,
    applyDummyHit,
    getClearState,
    // 调试用：自动化验证读取假人状态（模块完整度/失血/失能），不影响游戏。
    getDummies() {
      return dummies.map((d) => ({
        integrity: { ...d.integrity },
        bleeding: bleedingZones(d.bleed),
        incapacitated: d.incapacitated,
        poolVisible: d.pool.visible,
        poolRadius: d.pool.scale.x,
      }));
    },
  };
}
