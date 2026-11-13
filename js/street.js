// 城市街区：室外街区地图 —— 主街、广场、侧巷、可进入的临街房间、掩体道具。
// 全部程序化几何体 + Canvas 生成的纹理，没有外部素材。
// 布局（世界坐标，北为 -z）：主街 x ∈ [-4, 4]，z ∈ [-24, 20]，约 44m 贯通视线；
// 广场 z ∈ [-8, 2]，x ∈ [-16, 16]；侧巷 z ∈ [-17, -15] 与 z ∈ [8, 10]，连通主街
// 与两侧街；两侧街 x ∈ [-22, -16] 与 x ∈ [16, 22]；建筑块 x ∈ [-16, -4] 与
// x ∈ [4, 16]，其中 3 间临街房可进入（门 + 临街窗）。
// 靶子布局见 targets.js 的 STREET_LAYOUT，位置须与这里的建筑/巷道对齐。

import * as THREE from 'three';

// ---------- Canvas 纹理 ----------

// 外墙贴面：256×256 一块贴砖，含 2×2 扇窗；通过 repeat 按墙面尺寸平铺，
// 一块贴砖约 6m × 6m。颜色由材质 tint 叠加，同一张纹理可出多种墙色。
function facadeTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#b5aca0';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    const s = 165 + Math.floor(Math.random() * 30);
    g.fillStyle = `rgb(${s},${s - 6},${s - 14})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  for (const wx of [28, 140]) {
    for (const wy of [24, 136]) {
      g.fillStyle = '#8f867c';
      g.fillRect(wx - 6, wy - 6, 92, 92);
      const grad = g.createLinearGradient(wx, wy, wx + 80, wy + 80);
      grad.addColorStop(0, '#3d4c5c');
      grad.addColorStop(1, '#232c36');
      g.fillStyle = grad;
      g.fillRect(wx, wy, 80, 80);
      if (Math.random() < 0.25) {
        g.fillStyle = 'rgba(255, 214, 130, 0.55)';
        g.fillRect(wx, wy, 80, 80);
      }
      g.fillStyle = '#8f867c';
      g.fillRect(wx + 37, wy, 6, 80);
      g.fillRect(wx, wy + 37, 80, 6);
      g.fillStyle = '#9a9184';
      g.fillRect(wx - 6, wy + 86, 92, 6);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// 临街商铺门面：招牌带 + 遮阳篷 + 落地玻璃 + 门。按招牌文字缓存。
function shopfrontTexture(label) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#a89e90';
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#33302c';
  g.fillRect(0, 0, 512, 62);
  g.fillStyle = '#f2d54b';
  g.font = 'bold 38px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 256, 32);
  for (let x = 0; x < 512; x += 32) {
    g.fillStyle = (x / 32) % 2 ? '#7a2e2e' : '#e8e2d4';
    g.fillRect(x, 62, 32, 26);
  }
  g.fillStyle = '#2c3844';
  g.fillRect(16, 100, 300, 140);
  g.fillStyle = 'rgba(255, 255, 255, 0.14)';
  g.beginPath();
  g.moveTo(60, 240);
  g.lineTo(140, 100);
  g.lineTo(180, 100);
  g.lineTo(100, 240);
  g.closePath();
  g.fill();
  g.fillStyle = '#8f867c';
  g.fillRect(160, 100, 6, 140);
  g.fillStyle = '#4a3b2c';
  g.fillRect(340, 100, 92, 140);
  g.fillStyle = '#2c3844';
  g.fillRect(352, 112, 68, 82);
  g.fillStyle = '#c9c2b4';
  g.fillRect(448, 120, 48, 60);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// 地面：1024×1024 覆盖 44m × 44m。画布即俯视图（北朝上）：
// u=0 为西（x=-22），v=1（画布顶行）为北（z=-24）。
function groundTexture() {
  const S = 1024 / 44;
  const X = (x) => (x + 22) * S;
  const Z = (z) => (z + 24) * S;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#6b6e72';
  g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 5200; i++) {
    const s = 95 + Math.floor(Math.random() * 35);
    g.fillStyle = `rgb(${s},${s},${s + 3})`;
    g.fillRect(Math.random() * 1024, Math.random() * 1024, 3, 3);
  }
  // 广场地砖
  g.fillStyle = '#83878c';
  g.fillRect(X(-16), Z(-8), 32 * S, 10 * S);
  g.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  g.lineWidth = 2;
  for (let x = -16; x <= 16; x += 2) {
    g.beginPath();
    g.moveTo(X(x), Z(-8));
    g.lineTo(X(x), Z(2));
    g.stroke();
  }
  for (let z = -8; z <= 2; z += 2) {
    g.beginPath();
    g.moveTo(X(-16), Z(z));
    g.lineTo(X(16), Z(z));
    g.stroke();
  }
  // 主街边缘线（广场段除外）
  g.strokeStyle = 'rgba(235, 235, 235, 0.55)';
  g.lineWidth = 4;
  for (const x of [-4, 4]) {
    for (const [z0, z1] of [[-24, -8], [2, 20]]) {
      g.beginPath();
      g.moveTo(X(x), Z(z0));
      g.lineTo(X(x), Z(z1));
      g.stroke();
    }
  }
  // 主街中央黄虚线（广场段除外）
  g.strokeStyle = '#d8b93a';
  g.lineWidth = 5;
  g.setLineDash([2 * S, 2 * S]);
  for (const [z0, z1] of [[-24, -8], [2, 20]]) {
    g.beginPath();
    g.moveTo(X(0), Z(z0));
    g.lineTo(X(0), Z(z1));
    g.stroke();
  }
  g.setLineDash([]);
  // 斑马线：广场南北两个入口 + 南段一处
  g.fillStyle = 'rgba(235, 235, 235, 0.78)';
  for (const z0 of [-8, 2, 12]) {
    for (let x = -4; x < 4; x += 1.2) {
      g.fillRect(X(x), Z(z0), 0.6 * S, 2 * S);
    }
  }
  // 油渍与井盖
  for (const [x, z, r] of [[-1.5, -13, 1.1], [2.5, 7, 0.9], [-18, -6, 1.2], [18, 14, 1.0]]) {
    g.fillStyle = 'rgba(30, 30, 32, 0.35)';
    g.beginPath();
    g.ellipse(X(x), Z(z), r * S, r * 0.7 * S, 0.4, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#4a4d52';
  g.beginPath();
  g.arc(X(2), Z(8), 0.5 * S, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#7a7d82';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(X(2), Z(8), 0.5 * S, 0, Math.PI * 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createStreet({ scene }) {
  const group = new THREE.Group();
  scene.add(group);
  const hitMeshes = [];
  // 碰撞体格式与 range.js 完全一致（aabb/circle + top），主循环的高度感知
  // 碰撞系统直接复用：矮掩体可跳上/跳过，高墙跳不过去。
  const colliders = [];

  function solid(mesh, kind, hardness) {
    mesh.userData.surface = { kind, hardness };
    hitMeshes.push(mesh);
    return mesh;
  }

  // ---------- 环境：天空 + 雾 + 半球光 + 太阳（带阴影） ----------
  // 灯光挂在地图组里：切回靶场时组隐藏，灯光随之失效，不重建。
  const skyColor = new THREE.Color(0x9db8d6);
  const hemi = new THREE.HemisphereLight(0xcfe0f2, 0x7d7668, 0.85);
  group.add(hemi);
  // 房间内灯：屋顶挡住太阳后室内只剩半球光，太暗看不清靶子；
  // 每间房一盏暖色顶灯（无阴影，靶场已有 4 盏点光灯在先，iPad 负担相当）。
  // 点光灯不投射阴影，会少量漏到室外，读作店里透出的灯光，可以接受。
  for (const [x, z] of [[-10, -11.5], [-10, 5], [10, -20.5]]) {
    const lamp = new THREE.PointLight(0xffe0b0, 10, 14, 2);
    lamp.position.set(x, 2.7, z);
    group.add(lamp);
  }
  const sun = new THREE.DirectionalLight(0xffe8c0, 1.9);
  sun.position.set(28, 38, 12);
  sun.target.position.set(0, 0, -2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -32;
  sun.shadow.camera.right = 32;
  sun.shadow.camera.top = 32;
  sun.shadow.camera.bottom = -32;
  sun.shadow.camera.near = 5;
  sun.shadow.camera.far = 100;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  group.add(sun, sun.target);

  // ---------- 材质 ----------
  const facadeBase = facadeTexture();
  const facadeCache = new Map();
  // 按墙面尺寸平铺贴砖（约 6m 一块），同尺寸同色复用同一材质。
  function facadeMat(w, h, tint) {
    const key = `${w}|${h}|${tint}`;
    if (facadeCache.has(key)) return facadeCache.get(key);
    const tex = facadeBase.clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 6)));
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: tint, roughness: 0.9, metalness: 0 });
    facadeCache.set(key, mat);
    return mat;
  }
  const shopCache = new Map();
  function shopMat(label) {
    if (shopCache.has(label)) return shopCache.get(label);
    const mat = new THREE.MeshStandardMaterial({ map: shopfrontTexture(label), roughness: 0.85, metalness: 0 });
    shopCache.set(label, mat);
    return mat;
  }
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 1, metalness: 0 });

  // ---------- 地面 ----------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 44),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, -2);
  ground.receiveShadow = true;
  group.add(solid(ground, 'floor', 0.9));

  // ---------- 实心建筑 ----------
  // streetSide：临街面的朝向（'east' = 建筑在街西侧，+x 面临街）。
  function building({ x0, x1, z0, z1, height, tint, streetSide = null, shop = null }) {
    const w = x1 - x0;
    const d = z1 - z0;
    const fx = facadeMat(d, height, tint);
    const fz = facadeMat(w, height, tint);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, height, d),
      [fx, fx, roofMat, roofMat, fz, fz]
    );
    mesh.position.set((x0 + x1) / 2, height / 2, (z0 + z1) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(solid(mesh, 'wall', 0.9));
    colliders.push({ type: 'aabb', minX: x0, maxX: x1, minZ: z0, maxZ: z1, top: height });
    if (shop && streetSide) {
      // 门面带：薄盒子贴在临街立面上（建筑沿 z 向长，带子也沿 z 向），
      // 长度不超过 6.5m，避免招牌文字拉得太宽。
      const bandLen = Math.min(d, 6.5);
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, bandLen), shopMat(shop));
      band.position.set(
        streetSide === 'east' ? x1 + 0.07 : x0 - 0.07,
        1.3,
        (z0 + z1) / 2
      );
      group.add(solid(band, 'wall', 0.7));
    }
  }

  // ---------- 可进入的房间 ----------
  // 一堵带开口的墙：沿墙方向按开口区间切段；开口下方补窗台段、上方补过梁段。
  // 过梁（底部高于 1.8m）不设碰撞体：跳跃摸不到，设了反而误触落地吸附；
  // 窗台段顶面 1.0m——跳得好可以翻窗进屋，算是留给玩家的跑酷口子。
  function segmentedWall({ axis, at, from, to, height, thickness, openings, matFn }) {
    const gaps = [...openings].sort((a, b) => a.start - b.start);
    const segments = [];
    let cursor = from;
    for (const gap of gaps) {
      if (gap.start > cursor) segments.push({ s: cursor, e: gap.start, y0: 0, y1: height });
      if (gap.y0 > 0) segments.push({ s: gap.start, e: gap.end, y0: 0, y1: gap.y0 });
      if (gap.y1 < height) segments.push({ s: gap.start, e: gap.end, y0: gap.y1, y1: height });
      cursor = gap.end;
    }
    if (cursor < to) segments.push({ s: cursor, e: to, y0: 0, y1: height });
    for (const seg of segments) {
      const len = seg.e - seg.s;
      const h = seg.y1 - seg.y0;
      if (len <= 0 || h <= 0) continue;
      const mesh = new THREE.Mesh(
        axis === 'z'
          ? new THREE.BoxGeometry(thickness, h, len)
          : new THREE.BoxGeometry(len, h, thickness),
        matFn(len, h)
      );
      if (axis === 'z') mesh.position.set(at, seg.y0 + h / 2, (seg.s + seg.e) / 2);
      else mesh.position.set((seg.s + seg.e) / 2, seg.y0 + h / 2, at);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(solid(mesh, 'wall', 0.9));
      if (seg.y0 < 1.8) {
        const half = thickness / 2;
        if (axis === 'z') {
          colliders.push({ type: 'aabb', minX: at - half, maxX: at + half, minZ: seg.s, maxZ: seg.e, top: seg.y1 });
        } else {
          colliders.push({ type: 'aabb', minX: seg.s, maxX: seg.e, minZ: at - half, maxZ: at + half, top: seg.y1 });
        }
      }
    }
  }

  // openings: [{ wall: 'east'|'west'|'north'|'south', at, width, y0, y1 }]
  // wall 指开口所在的墙；at 是沿墙方向的中心坐标。
  function room({ x0, x1, z0, z1, height, tint, openings }) {
    const t = 0.3;
    const matFn = (len, h) => facadeMat(len, h, tint);
    const byWall = { east: [], west: [], north: [], south: [] };
    for (const o of openings) {
      byWall[o.wall].push({ start: o.at - o.width / 2, end: o.at + o.width / 2, y0: o.y0, y1: o.y1 });
    }
    segmentedWall({ axis: 'z', at: x1, from: z0, to: z1, height, thickness: t, openings: byWall.east, matFn });
    segmentedWall({ axis: 'z', at: x0, from: z0, to: z1, height, thickness: t, openings: byWall.west, matFn });
    segmentedWall({ axis: 'x', at: z1, from: x0, to: x1, height, thickness: t, openings: byWall.south, matFn });
    segmentedWall({ axis: 'x', at: z0, from: x0, to: x1, height, thickness: t, openings: byWall.north, matFn });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 0.6, 0.25, z1 - z0 + 0.6), roofMat);
    roof.position.set((x0 + x1) / 2, height + 0.125, (z0 + z1) / 2);
    roof.castShadow = true;
    group.add(solid(roof, 'wall', 0.7));
  }

  const WALL_H = 3.2;
  // 西侧建筑块（临街面朝东）
  building({ x0: -16, x1: -4, z0: -24, z1: -17, height: 9, tint: 0xcfc4b4, streetSide: 'east', shop: '便利店' });
  room({
    x0: -16, x1: -4, z0: -15, z1: -8, height: WALL_H, tint: 0xbfae9c,
    openings: [
      { wall: 'east', at: -11.5, width: 1.2, y0: 0, y1: 2.2 }, // 门
      { wall: 'east', at: -9.5, width: 1.6, y0: 1.0, y1: 2.1 }, // 临街窗
    ],
  });
  room({
    x0: -16, x1: -4, z0: 2, z1: 8, height: WALL_H, tint: 0xc4b8a8,
    openings: [
      { wall: 'east', at: 5, width: 1.2, y0: 0, y1: 2.2 },
      { wall: 'east', at: 3, width: 1.6, y0: 1.0, y1: 2.1 },
    ],
  });
  building({ x0: -16, x1: -4, z0: 10, z1: 20, height: 7, tint: 0xd8cfc0, streetSide: 'east', shop: '面馆' });
  // 东侧建筑块（临街面朝西）
  room({
    x0: 4, x1: 16, z0: -24, z1: -17, height: WALL_H, tint: 0xb0a89a,
    openings: [
      { wall: 'west', at: -20.5, width: 1.2, y0: 0, y1: 2.2 },
      { wall: 'west', at: -18.5, width: 1.6, y0: 1.0, y1: 2.1 },
    ],
  });
  building({ x0: 4, x1: 16, z0: -15, z1: -8, height: 8, tint: 0xcfc4b4, streetSide: 'west', shop: '五金店' });
  building({ x0: 4, x1: 16, z0: 2, z1: 8, height: 6, tint: 0xbfae9c, streetSide: 'west', shop: '水果店' });
  building({ x0: 4, x1: 16, z0: 10, z1: 20, height: 10, tint: 0xc4b8a8, streetSide: 'west', shop: '修车铺' });

  // ---------- 地图边缘背景建筑（挡住视线尽头，兼作边界墙） ----------
  building({ x0: -22, x1: 0, z0: -27, z1: -23.5, height: 12, tint: 0x9a938a });
  building({ x0: 0, x1: 22, z0: -27, z1: -23.5, height: 14, tint: 0x8d867e });
  building({ x0: -22, x1: 0, z0: 19.5, z1: 23, height: 10, tint: 0x8d867e });
  building({ x0: 0, x1: 22, z0: 19.5, z1: 23, height: 12, tint: 0x9a938a });
  building({ x0: -24, x1: -21, z0: -24, z1: -2, height: 11, tint: 0x9a938a });
  building({ x0: -24, x1: -21, z0: -2, z1: 20, height: 13, tint: 0x8d867e });
  building({ x0: 21, x1: 24, z0: -24, z1: -2, height: 13, tint: 0x8d867e });
  building({ x0: 21, x1: 24, z0: -2, z1: 20, height: 10, tint: 0x9a938a });

  // ---------- 掩体道具 ----------
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x7d6242, roughness: 0.9, metalness: 0 });
  const crateGeo = new THREE.BoxGeometry(1, 1, 1);
  for (const [x, z] of [[-3, 14], [3.2, 12], [-4.5, -5.5], [6, -6], [-12, -16], [12, 9], [-7, -13.5], [12, -19]]) {
    const crate = new THREE.Mesh(crateGeo, crateMat);
    crate.position.set(x, 0.5, z);
    crate.rotation.y = ((x * 31 + z * 17) % 7) * 0.06;
    crate.castShadow = true;
    crate.receiveShadow = true;
    group.add(solid(crate, 'prop', 0.6));
    // 木箱顶面 1.0m，可跳上/跳过（半边 0.6 覆盖小角度旋转后的角）
    colliders.push({ type: 'aabb', minX: x - 0.6, maxX: x + 0.6, minZ: z - 0.6, maxZ: z + 0.6, top: 1.0 });
  }

  const barrierMat = new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.95, metalness: 0 });
  const barrierGeo = new THREE.BoxGeometry(2, 0.9, 0.5);
  for (const [x, z] of [[-2, 6], [2, 6], [-8, 0], [8, -2], [0, -12]]) {
    const b = new THREE.Mesh(barrierGeo, barrierMat);
    b.position.set(x, 0.45, z);
    b.castShadow = true;
    b.receiveShadow = true;
    group.add(solid(b, 'prop', 0.9));
    colliders.push({ type: 'aabb', minX: x - 1, maxX: x + 1, minZ: z - 0.25, maxZ: z + 0.25, top: 0.9 });
  }

  const sandMat = new THREE.MeshStandardMaterial({ color: 0x8a7a58, roughness: 1, metalness: 0 });
  const sandGeo = new THREE.BoxGeometry(2.2, 0.8, 0.6);
  for (const [x, z] of [[-3, -1], [4, -4], [-19, 4]]) {
    const s = new THREE.Mesh(sandGeo, sandMat);
    s.position.set(x, 0.4, z);
    s.castShadow = true;
    s.receiveShadow = true;
    group.add(solid(s, 'prop', 0.4));
    colliders.push({ type: 'aabb', minX: x - 1.1, maxX: x + 1.1, minZ: z - 0.3, maxZ: z + 0.3, top: 0.8 });
  }

  const dumpMat = new THREE.MeshStandardMaterial({ color: 0x3d5240, roughness: 0.7, metalness: 0.4 });
  const dumpGeo = new THREE.BoxGeometry(2, 1.2, 1.1);
  for (const [x, z] of [[-5, -16], [19, 12]]) {
    const d = new THREE.Mesh(dumpGeo, dumpMat);
    d.position.set(x, 0.6, z);
    d.castShadow = true;
    d.receiveShadow = true;
    group.add(solid(d, 'prop', 0.8));
    colliders.push({ type: 'aabb', minX: x - 1, maxX: x + 1, minZ: z - 0.55, maxZ: z + 0.55, top: 1.2 });
  }

  // 停放的车：车身 + 车舱 + 四个轮子，实心碰撞体，不可进入，跳不上去。
  const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.9, metalness: 0 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x2c3844, roughness: 0.15, metalness: 0.6 });
  function car(x, z, rotY, color) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.55, 4.2),
      new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.6 })
    );
    body.position.set(0, 0.55, 0);
    body.castShadow = true;
    g.add(solid(body, 'prop', 0.8));
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2), glassMat);
    cabin.position.set(0, 1.05, -0.2);
    cabin.castShadow = true;
    g.add(solid(cabin, 'prop', 0.5));
    for (const [wx, wz] of [[-0.8, 1.35], [0.8, 1.35], [-0.8, -1.35], [0.8, -1.35]]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, 0.33, wz);
      g.add(solid(wheel, 'prop', 0.3));
    }
    group.add(g);
    // 车只沿街向停放（rotY 为 0 或 π），轴对齐包围盒即可；顶面 1.4m 跳不过去
    colliders.push({ type: 'aabb', minX: x - 0.95, maxX: x + 0.95, minZ: z - 2.15, maxZ: z + 2.15, top: 1.4 });
  }
  car(-2.8, 10, 0, 0x8a3b32);
  car(2.8, -14, Math.PI, 0x4a5a6a);

  // 路灯：灯杆 + 灯头（细碰撞体，防穿杆）
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.6, metalness: 0.5 });
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.09, 4.5, 10);
  const headGeo = new THREE.BoxGeometry(0.3, 0.1, 0.55);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.6, metalness: 0.3 });
  for (const [x, z] of [[-3.6, 14], [3.6, 4], [-3.6, -10], [3.6, -19]]) {
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, 2.25, z);
    pole.castShadow = true;
    group.add(solid(pole, 'prop', 0.9));
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(x, 4.5, z);
    group.add(solid(head, 'prop', 0.9));
    colliders.push({ type: 'circle', x, z, r: 0.12, top: 4.5 });
  }

  // 广场花坛：混凝土座 + 绿植
  const planterMat = new THREE.MeshStandardMaterial({ color: 0x8d867c, roughness: 0.95, metalness: 0 });
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x4a6b35, roughness: 1, metalness: 0 });
  for (const [x, z] of [[-9, -6], [9, -6], [0, -7]]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 1.6), planterMat);
    base.position.set(x, 0.3, z);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(solid(base, 'prop', 0.9));
    const bush = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 1.3), bushMat);
    bush.position.set(x, 0.85, z);
    bush.castShadow = true;
    group.add(solid(bush, 'prop', 0.2));
    colliders.push({ type: 'aabb', minX: x - 0.8, maxX: x + 0.8, minZ: z - 0.8, maxZ: z + 0.8, top: 0.6 });
  }

  return {
    group,
    hitMeshes,
    colliders,
    spawn: { x: 0, z: 16, yaw: 0 }, // 主街南端，面向北（-z）
    bounds: { x: 20.5, zMin: -23, zMax: 19 },
    env: {
      background: skyColor,
      fog: new THREE.Fog(skyColor.clone(), 45, 110),
    },
    menuCam: { x: 0, z: 16, yawBase: 0, yawAmp: 0.15, pitch: -0.02 },
  };
}
