// 城市街区：90×90m 户外地图 —— 三纵三横街道、16 个街区、2 个广场、
// 5 间可进入的房间、工业角、环形天际线。
// 建筑/车辆/道具用 Kenney 城市套件 GLB（CC0，见 README 致谢）；
// Kenney 套件是微缩比例（楼 ~1.3m），按实测尺寸放大 ×6–×8，
// 以 1.8m 的士兵模型为参照校准。模型加载失败时用同尺寸色块盒子代替，
// 游戏不受影响（见 placeModel 的回退分支）。
// 地面/人行道/广场用 Poly Haven PBR 贴图（CC0），房间墙体用砖墙 PBR。
//
// 布局坐标（x/z ∈ [-45, 45]）：街道宽 8m，中心线 x/z ∈ {0, ±26}；
// 街区中心 x/z ∈ {±13, ±37}（内圈 18m、外圈 14m）；出生点主街南端 (0, 40)。
// 房间：R1(-13,-40) 门朝南、R2(-40,-13) 门朝东、R3(13,-40) 门朝南、
// R4(40,13) 门朝西、R5(-13,40) 门朝北。靶子布局在 targets.js 的
// STREET_LAYOUT，与这里的建筑/巷道对齐，改几何时两边同步改。

import * as THREE from 'three';

// 回退盒子的模型空间尺寸（GLB 实测，米）：模型加载失败时按同一缩放
// 生成同尺寸色块盒子，碰撞体与占位都不变。
const FALLBACK_DIMS = {
  'bld-a': [0.9, 1.1, 1.0], 'bld-b': [0.9, 1.1, 1.0], 'bld-c': [0.9, 1.1, 1.0],
  'bld-d': [0.9, 1.1, 1.0], 'bld-e': [0.9, 1.1, 1.0], 'bld-f': [0.9, 1.1, 1.0],
  'sky-a': [1.36, 2.88, 1.36], 'sky-c': [1.28, 4.08, 1.39], 'sky-e': [1.3, 3.4, 1.3],
  'low-a': [0.5, 2.0, 0.5], 'low-b': [0.5, 2.0, 0.5], 'low-c': [0.5, 2.0, 0.5], 'low-d': [0.5, 2.0, 0.5],
  'low-wide-a': [1.0, 1.1, 0.5], 'low-wide-b': [1.0, 1.1, 0.5],
  awning: [0.8, 0.4, 0.15], parasol: [0.35, 0.45, 0.4],
  'house-a': [1.3, 0.83, 1.03], 'house-f': [1.43, 1.14, 1.41],
  'house-m': [1.43, 0.74, 1.43], 'house-r': [1.3, 0.9, 1.2],
  'tree-large': [0.21, 0.77, 0.21], 'tree-small': [0.21, 0.57, 0.21],
  planter: [0.4, 0.18, 0.3], fence: [0.48, 0.27, 0.08],
  'ind-a': [2.08, 1.47, 1.24], 'ind-c': [1.5, 1.0, 1.0], 'ind-k': [1.3, 0.77, 0.91],
  'container-a': [0.37, 0.35, 0.82], 'container-b': [0.37, 0.35, 0.82], 'container-c': [0.37, 0.35, 0.82],
  'water-tower': [0.85, 2.14, 0.83], chimney: [1.08, 1.7, 1.08],
  'lamp-curved': [0.05, 0.68, 0.23], 'lamp-square': [0.05, 0.6, 0.24],
  'traffic-light': [0.12, 0.52, 0.09], dumpster: [0.28, 0.21, 0.37],
  'road-barrier': [0.14, 0.13, 0.23], cone: [0.08, 0.09, 0.08],
  'sign-stop': [0.08, 0.49, 0.14], 'power-pole': [0.58, 0.53, 0.21],
  'car-sedan': [1.5, 1.3, 2.55], 'car-suv': [1.5, 1.3, 2.7], 'car-taxi': [1.5, 1.5, 2.75],
  'car-van': [1.5, 1.35, 2.75], 'car-truck': [1.5, 1.3, 2.95],
};
const FALLBACK_COLORS = {
  bld: 0x8a8f96, sky: 0x7d8590, low: 0x9aa0a8, house: 0xa89880, ind: 0x7a7f85,
  container: 0xc06028, tree: 0x4a7a3a, car: 0xb03030, default: 0x888888,
};
function fallbackColorFor(key) {
  if (key.startsWith('bld-')) return FALLBACK_COLORS.bld;
  if (key.startsWith('sky-')) return FALLBACK_COLORS.sky;
  if (key.startsWith('low')) return FALLBACK_COLORS.low;
  if (key.startsWith('house-')) return FALLBACK_COLORS.house;
  if (key.startsWith('ind-')) return FALLBACK_COLORS.ind;
  if (key.startsWith('container-')) return FALLBACK_COLORS.container;
  if (key.startsWith('tree-')) return FALLBACK_COLORS.tree;
  if (key.startsWith('car-')) return FALLBACK_COLORS.car;
  return FALLBACK_COLORS.default;
}

// 命中面材质（毁伤/跳弹判定用）：硬度 ≥0.8 响金属声且可能跳弹。
const SURFACES = {
  concrete: { kind: 'wall', hardness: 0.9 },
  metal: { kind: 'wall', hardness: 1.0 },
  wood: { kind: 'prop', hardness: 0.6 },
  foliage: { kind: 'prop', hardness: 0.2 },
  plastic: { kind: 'prop', hardness: 0.5 },
};

export function createStreet({ scene, assets, soldierModel }) {
  const group = new THREE.Group();
  scene.add(group);
  const hitMeshes = [];
  const colliders = [];

  function solid(mesh, surface) {
    mesh.userData.surface = surface || SURFACES.concrete;
    hitMeshes.push(mesh);
    return mesh;
  }

  // ---------- PBR 材质（贴图失败时退回纯色） ----------
  function pbrMaterial(set, fallbackColor, roughness = 0.9) {
    if (!set || !set.map) {
      return new THREE.MeshStandardMaterial({ color: fallbackColor, roughness, metalness: 0 });
    }
    return new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap || null,
      roughnessMap: set.roughnessMap || null,
      roughness: set.roughnessMap ? 1.0 : roughness,
      metalness: 0,
    });
  }
  const textures = assets ? assets.textures : {};
  const asphaltMat = pbrMaterial(textures.asphalt, 0x3c3f44, 0.95);
  if (textures.asphalt && textures.asphalt.map) {
    for (const t of [textures.asphalt.map, textures.asphalt.normalMap, textures.asphalt.roughnessMap]) {
      if (t) t.repeat.set(23, 23); // 94m 地面，每块贴图约 4m
    }
  }
  // 墙面/人行道贴图按面尺寸调 repeat：缓存 (宽, 高) 取整到 0.5m 的材质，
  // 避免每个墙段一张贴图克隆（克隆会重复上传 GPU）。
  const sizedMatCache = new Map();
  function sizedPbrMaterial(set, fallbackColor, w, h, tileMeters) {
    if (!set || !set.map) {
      return new THREE.MeshStandardMaterial({ color: fallbackColor, roughness: 0.9, metalness: 0 });
    }
    const rw = Math.max(0.5, Math.round(w * 2) / 2);
    const rh = Math.max(0.5, Math.round(h * 2) / 2);
    const key = `${set === textures.brickWall ? 'bw' : set === textures.concrete ? 'cc' : 'bp'}:${rw}x${rh}`;
    if (sizedMatCache.has(key)) return sizedMatCache.get(key);
    const cloneTex = (t) => {
      if (!t) return null;
      const c = t.clone();
      c.needsUpdate = true;
      c.repeat.set(rw / tileMeters, rh / tileMeters);
      return c;
    };
    const mat = new THREE.MeshStandardMaterial({
      map: cloneTex(set.map),
      normalMap: cloneTex(set.normalMap),
      roughnessMap: cloneTex(set.roughnessMap),
      roughness: set.roughnessMap ? 1.0 : 0.9,
      metalness: 0,
    });
    sizedMatCache.set(key, mat);
    return mat;
  }
  const brickWallMat = (w, h) => sizedPbrMaterial(textures.brickWall, 0x8a6a58, w, h, 2);
  const concreteMat = (w, h) => sizedPbrMaterial(textures.concrete, 0x9a9a96, w, h, 3);
  const brickPaveMat = (w, h) => sizedPbrMaterial(textures.brickPavement, 0x8a7a68, w, h, 2.5);

  // ---------- 灯光 ----------
  // 太阳：2048 阴影贴图，±55m 正交范围覆盖整张 90m 图（v0.8 是 1024/±32，
  // 地图大了 4 倍，阴影范围与分辨率同步放大，否则远处阴影糊成一片）。
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
  sun.position.set(40, 60, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0004;
  group.add(sun);
  group.add(sun.target);
  // 半球光补暗部（与 HDRI 环境光叠加，强度压低，防过曝）。
  group.add(new THREE.HemisphereLight(0xbfd8ff, 0x5a5a52, 0.4));

  // ---------- 地面 ----------
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(94, 94), asphaltMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(solid(ground, { kind: 'floor', hardness: 0.9 }));

  // ---------- 街区地面板（人行道/广场）：顶面高出地面 2cm，无碰撞体 ----------
  // 地面高度只降不升的规则（见 main.js）：带碰撞体的凸起会让玩家“走不上去”，
  // 所以 2cm 的薄板不设碰撞体，视觉上是抬高的人行道，脚下仍是平地。
  const BLOCKS = [
    [-44, -30, -44, -30, 'build'], [-22, -4, -44, -30, 'room'], [4, 22, -44, -30, 'room'], [30, 44, -44, -30, 'industrial'],
    [-44, -30, -22, -4, 'room'], [-22, -4, -22, -4, 'plaza'], [4, 22, -22, -4, 'build'], [30, 44, -22, -4, 'build'],
    [-44, -30, 4, 22, 'build'], [-22, -4, 4, 22, 'build'], [4, 22, 4, 22, 'plaza'], [30, 44, 4, 22, 'room'],
    [-44, -30, 30, 44, 'build'], [-22, -4, 30, 44, 'room'], [4, 22, 30, 44, 'build'], [30, 44, 30, 44, 'build'],
  ];
  for (const [x0, x1, z0, z1, type] of BLOCKS) {
    const w = x1 - x0;
    const d = z1 - z0;
    const mat = type === 'plaza' ? brickPaveMat(w, d) : concreteMat(w, d);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), mat);
    slab.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    slab.receiveShadow = true;
    group.add(slab);
  }

  // ---------- 路面标线：车道虚线（Canvas 纹理，6 条） ----------
  function dashTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 8;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 64, 8);
    g.fillStyle = '#d8d8d0';
    g.fillRect(0, 0, 36, 8);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(30, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const dashMat = new THREE.MeshBasicMaterial({ map: dashTexture(), transparent: true, depthWrite: false });
  for (const [x, z, rotY] of [[0, 0, 0], [-26, 0, 0], [26, 0, 0], [0, 0, Math.PI / 2], [0, -26, Math.PI / 2], [0, 26, Math.PI / 2]]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(88, 0.15), dashMat);
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = rotY;
    line.position.set(x, 0.01, z);
    group.add(line);
  }

  // ---------- GLB 摆放：克隆 + 缩放 + 碰撞体 ----------
  // 所有摆放均为 90° 整数倍朝向，碰撞体直接取变换后世界包围盒；
  // 树/灯杆类用圆形碰撞体（只挡树干/杆身，不挡树冠/灯头）。
  const fallbackMats = new Map();
  function fallbackMat(color) {
    if (!fallbackMats.has(color)) {
      fallbackMats.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 }));
    }
    return fallbackMats.get(color);
  }
  function placeModel(key, x, z, rotY, scale, opts = {}) {
    const src = assets && assets.models.get(key);
    const sx = opts.sx ?? scale;
    const sy = opts.sy ?? scale;
    const sz = opts.sz ?? scale;
    let obj;
    if (src) {
      obj = src.clone(true);
      obj.position.set(x, opts.y ?? 0, z);
      obj.rotation.y = rotY;
      obj.scale.set(sx, sy, sz);
      obj.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = opts.castShadow !== false;
          o.receiveShadow = true;
          o.userData.surface = opts.surface || SURFACES.concrete;
          hitMeshes.push(o);
        }
      });
    } else {
      // 回退：同尺寸色块盒子（原点在底部中心，与 GLB 一致）。
      const dims = FALLBACK_DIMS[key] || [1, 1, 1];
      const w = dims[0] * sx;
      const h = dims[1] * sy;
      const d = dims[2] * sz;
      const swapped = Math.abs(Math.sin(rotY)) > 0.5;
      obj = new THREE.Mesh(
        new THREE.BoxGeometry(swapped ? d : w, h, swapped ? w : d),
        fallbackMat(opts.fallbackColor ?? fallbackColorFor(key))
      );
      obj.castShadow = opts.castShadow !== false;
      obj.receiveShadow = true;
      obj.position.set(x, (opts.y ?? 0) + h / 2, z);
      obj.rotation.y = rotY;
      solid(obj, opts.surface || SURFACES.concrete);
    }
    group.add(obj);
    obj.updateMatrixWorld(true);
    if (opts.collider !== false) {
      const box = new THREE.Box3().setFromObject(obj);
      if (opts.collider === 'circle' || opts.r !== undefined) {
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        const r = opts.r ?? (Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2) * 0.8;
        colliders.push({ type: 'circle', x: cx, z: cz, r, top: box.max.y });
      } else {
        colliders.push({
          type: 'aabb',
          minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z,
          top: box.max.y,
        });
      }
    }
    return obj;
  }

  // ---------- 街区建筑（内圈两栋、外圈一栋，留巷道间隙） ----------
  const BUILDINGS = [
    ['bld-a', -37, -37, 0, 8],
    ['house-a', 9.5, -17, 0, 8], ['bld-b', 17, -8, 0, 8],
    ['bld-c', 37, -13, 0, 8],
    ['house-f', -37, 13, Math.PI / 2, 8],
    ['bld-d', -18, 8, 0, 8], ['bld-e', -9, 17, 0, 8],
    ['ind-c', -37, 37, 0, 6],
    ['house-r', 8.5, 34.5, 0, 8], ['bld-f', 17.5, 40.5, 0, 8],
    ['bld-e', 34, 34, 0, 8], ['ind-k', 41, 41, 0, 6],
  ];
  for (const [key, x, z, rotY, scale] of BUILDINGS) {
    placeModel(key, x, z, rotY, scale);
  }
  // 工业角（37,-37）：厂房 + 水塔 + 集装箱（一个叠放）。
  placeModel('ind-a', 38, -40, 0, 5);
  placeModel('water-tower', 41, -32.5, 0, 6, { collider: 'circle', r: 2.2 });
  placeModel('container-a', 31.3, -39, 0, 7, { surface: SURFACES.metal });
  placeModel('container-b', 31.3, -39, 0, 7, { y: 2.45, collider: false, surface: SURFACES.metal });
  placeModel('container-c', 35, -32, Math.PI / 2, 7, { surface: SURFACES.metal });

  // ---------- 天际线环（界外装饰，无碰撞体，不投射阴影） ----------
  const SKYLINE = [
    ['sky-a', 0, -52, 0, 8], ['sky-c', 26, -52, 0, 8], ['sky-e', -26, -52, 0, 8],
    ['sky-a', 52, 0, 0, 8], ['sky-c', 52, 26, 0, 8], ['low-wide-b', 52, -26, 0, 8],
    ['low-a', -52, 0, 0, 8], ['low-b', -52, -26, 0, 8], ['sky-e', -52, 26, 0, 8],
    ['low-c', 0, 52, 0, 8], ['low-d', 26, 52, 0, 8], ['low-wide-a', -26, 52, Math.PI / 2, 8],
    ['chimney', 48, -37, 0, 6],
  ];
  for (const [key, x, z, rotY, scale] of SKYLINE) {
    placeModel(key, x, z, rotY, scale, { collider: false, castShadow: false });
  }

  // ---------- 车辆（沿街停放；车套件比例与城市套件不同，非均匀缩放） ----------
  const CARS = [
    ['car-sedan', 2.8, 12, 0, 1.2, 1.1, 1.8],
    ['car-suv', -2.8, -8, Math.PI, 1.2, 1.1, 1.8],
    ['car-taxi', 23.5, 34, 0, 1.2, 1.1, 1.8],
    ['car-van', -23.5, -34, Math.PI, 1.3, 1.2, 1.7],
    ['car-truck', 12, 2.8, Math.PI / 2, 1.3, 1.2, 1.7],
    ['car-sedan', -12, -27.5, -Math.PI / 2, 1.2, 1.1, 1.8],
  ];
  for (const [key, x, z, rotY, sx, sy, sz] of CARS) {
    placeModel(key, x, z, rotY, 1, { sx, sy, sz, surface: SURFACES.metal });
  }

  // ---------- 街灯 / 交通灯 / 电杆 / 指示牌 ----------
  const LAMPS = [
    ['lamp-curved', 6, 6], ['lamp-square', -6, 6], ['lamp-curved', 6, -6], ['lamp-square', -6, -6],
    ['lamp-curved', 24, 6], ['lamp-square', -24, -6], ['lamp-curved', 6, 24], ['lamp-square', -6, -24],
    ['lamp-curved', 24, -24], ['lamp-square', -24, 24],
  ];
  for (const [key, x, z] of LAMPS) {
    placeModel(key, x, z, 0, 8, { collider: 'circle', r: 0.3, surface: SURFACES.metal });
  }
  for (const [x, z, rotY] of [[5.5, 5.5, Math.PI], [-5.5, 5.5, Math.PI / 2], [5.5, -5.5, -Math.PI / 2], [-5.5, -5.5, 0]]) {
    placeModel('traffic-light', x, z, rotY, 8, { collider: 'circle', r: 0.3, surface: SURFACES.metal });
  }
  for (const [x, z] of [[-6, -26], [6, 26], [-26, 6], [26, -6]]) {
    placeModel('power-pole', x, z, 0, 8, { collider: 'circle', r: 0.4, surface: SURFACES.wood });
  }
  placeModel('sign-stop', 5, 7, Math.PI, 6, { collider: 'circle', r: 0.2, surface: SURFACES.metal });
  placeModel('sign-stop', -5, -7, 0, 6, { collider: 'circle', r: 0.2, surface: SURFACES.metal });

  // ---------- 广场小品：花坛 / 遮阳伞 / 树 / 围栏 ----------
  const PLANTERS = [[-18, -18], [-8, -18], [-18, -8], [8, 8], [18, 8], [18, 18], [-32, -41]];
  for (const [x, z] of PLANTERS) placeModel('planter', x, z, 0, 5);
  const PARASOLS = [[-10, -16], [-16, -10], [10, 16], [16, 10]];
  for (const [x, z] of PARASOLS) placeModel('parasol', x, z, 0, 8, { collider: 'circle', r: 0.15 });
  const TREES = [
    ['tree-large', -16, -16], ['tree-small', -10, -10], ['tree-large', 16, 16], ['tree-small', 10, 10],
    ['tree-large', 7, -6], ['tree-small', 41, -19], ['tree-small', -32, 19],
    ['tree-large', -32, 42], ['tree-small', -41, -41], ['tree-large', -8, -42], ['tree-small', -18, 42],
  ];
  for (const [key, x, z] of TREES) {
    placeModel(key, x, z, 0, 8, { collider: 'circle', r: 0.25, surface: SURFACES.foliage });
  }
  const FENCES = [[-16, -21, 0], [-10, -21, 0], [10, 21, 0], [16, 21, 0]];
  for (const [x, z, rotY] of FENCES) placeModel('fence', x, z, rotY, 6, { surface: SURFACES.wood });

  // ---------- 街头道具：垃圾箱 / 路障 / 交通锥 ----------
  const DUMPSTERS = [[-5, -10, 0], [5, 16, Math.PI / 2], [-33, -33, 0], [33, 33, Math.PI / 2]];
  for (const [x, z, rotY] of DUMPSTERS) {
    placeModel('dumpster', x, z, rotY, 5.5, { surface: SURFACES.metal }); // 顶面 1.15m，可跳
  }
  const BARRIERS = [[0, 20, Math.PI / 2], [0, -6, Math.PI / 2], [-26, 6, 0], [26, -20, 0], [-14, 0, 0], [14, 0, 0]];
  for (const [x, z, rotY] of BARRIERS) {
    placeModel('road-barrier', x, z, rotY, 8, { surface: SURFACES.plastic }); // 顶面 1.04m，可跳
  }
  const CONES = [[3, 30], [-3, 28], [24, 10], [-24, -14], [10, -3], [-10, 3]];
  for (const [x, z] of CONES) {
    placeModel('cone', x, z, 0, 8, { collider: 'circle', r: 0.15, surface: SURFACES.plastic });
  }
  // 雨篷：贴在两栋临街建筑的南立面上（无碰撞体，2.4m 高，头顶上方）。
  placeModel('awning', -37, -32.8, 0, 8, { y: 2.4, collider: false });
  placeModel('awning', 37, -8.8, 0, 8, { y: 2.4, collider: false });

  // ---------- 程序化掩体（木箱 / 路障 / 沙袋）：街区里的可跳掩体 ----------
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x7d6242, roughness: 0.9 });
  const barrierMat = new THREE.MeshStandardMaterial({ color: 0xc25e2e, roughness: 0.8 });
  const sandMat = new THREE.MeshStandardMaterial({ color: 0x9a8a68, roughness: 1 });
  function coverBox(w, h, d, x, z, rotY, mat, surface) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, h / 2, z);
    m.rotation.y = rotY;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(solid(m, surface));
    const swapped = Math.abs(Math.sin(rotY)) > 0.5;
    const hw = (swapped ? d : w) / 2;
    const hd = (swapped ? w : d) / 2;
    colliders.push({ type: 'aabb', minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd, top: h });
  }
  for (const [x, z] of [[2, 30], [-2, -24], [24, -12], [-24, 12]]) {
    coverBox(1, 1, 1, x, z, 0.2, crateMat, SURFACES.wood);
  }
  for (const [x, z] of [[4, -20], [-4, 8], [20, 26], [-20, -26]]) {
    coverBox(1.8, 0.9, 0.4, x, z, 0, barrierMat, SURFACES.plastic);
  }
  for (const [x, z] of [[-2, 36], [2, 36], [-28, 0], [28, 0]]) {
    coverBox(2.2, 0.8, 0.6, x, z, 0, sandMat, SURFACES.concrete);
  }

  // ---------- 可进入的房间：砖墙 + 门洞 + 窗洞 + 天花板 + 暖光 ----------
  // 墙体分段：门洞（1.2m 宽、高 2.2m）与窗洞（1.6m 宽、窗台 1.0m、顶 2.6m）
  // 只开在临街的一面墙上，其余三面整墙。窗台顶面 1.0m 可翻越（碰撞体 top
  // 1.0m）；门楣与窗楣底沿 ≥2.2m，高于玩家身高，不设碰撞体。
  const ROOM_H = 3.2;
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.95 });
  function segmentedWall(axis, at, a0, a1, openings) {
    // axis 'x'：墙沿 x 走向，固定 z=at；axis 'z'：墙沿 z 走向，固定 x=at。
    // openings：[{a0, a1, bottom, top}]，沿墙方向的区间与洞口上下沿。
    const edges = [a0];
    for (const o of openings) edges.push(o.a0, o.a1);
    edges.push(a1);
    edges.sort((a, b) => a - b);
    const inOpening = (c) => openings.some((o) => c >= o.a0 && c <= o.a1);
    for (let i = 0; i < edges.length - 1; i++) {
      const s0 = edges[i];
      const s1 = edges[i + 1];
      if (s1 - s0 < 0.01) continue;
      const mid = (s0 + s1) / 2;
      if (!inOpening(mid)) {
        addWallSeg(axis, at, s0, s1, 0, ROOM_H);
      } else {
        const o = openings.find((oo) => mid >= oo.a0 && mid <= oo.a1);
        if (o.bottom > 0.01) addWallSeg(axis, at, s0, s1, 0, o.bottom); // 窗台
        if (o.top < ROOM_H - 0.01) addWallSeg(axis, at, s0, s1, o.top, ROOM_H); // 门楣/窗楣
      }
    }
    function addWallSeg(ax, atPos, s0, s1, y0, y1) {
      const len = s1 - s0;
      const h = y1 - y0;
      const center = (s0 + s1) / 2;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(ax === 'x' ? len : 0.3, h, ax === 'x' ? 0.3 : len),
        brickWallMat(len, h)
      );
      m.position.set(ax === 'x' ? center : atPos, y0 + h / 2, ax === 'x' ? atPos : center);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(solid(m, SURFACES.concrete));
      // 碰撞体：底沿高于 1.8m 的楣段不挡人（门楣 2.2m、窗楣 2.6m）；
      // 其余段顶面即段顶（窗台 1.0m 可翻越，整墙 3.2m 挡死）。
      if (y0 > 1.8) return;
      if (ax === 'x') {
        colliders.push({ type: 'aabb', minX: s0, maxX: s1, minZ: atPos - 0.15, maxZ: atPos + 0.15, top: y1 });
      } else {
        colliders.push({ type: 'aabb', minX: atPos - 0.15, maxX: atPos + 0.15, minZ: s0, maxZ: s1, top: y1 });
      }
    }
  }
  function room(x0, x1, z0, z1, doorWall) {
    // doorWall：开门洞的那面墙（'south' z=z1 / 'north' z=z0 / 'east' x=x1 / 'west' x=x0）。
    // 门洞居中 1.2m 宽；窗洞一个，偏向一侧 1.6m 宽（省 mesh，每间房 10 个墙段以内）。
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const door = { a0: -0.6, a1: 0.6, bottom: 0, top: 2.2 };
    const win = { a0: 2.2, a1: 3.8, bottom: 1.0, top: 2.6 };
    const shift = (o, c) => ({ a0: o.a0 + c, a1: o.a1 + c, bottom: o.bottom, top: o.top });
    if (doorWall === 'south') {
      segmentedWall('x', z1, x0, x1, [shift(door, cx), shift(win, cx)]);
      segmentedWall('x', z0, x0, x1, []);
      segmentedWall('z', x0, z0, z1, []);
      segmentedWall('z', x1, z0, z1, []);
    } else if (doorWall === 'north') {
      segmentedWall('x', z0, x0, x1, [shift(door, cx), shift(win, cx)]);
      segmentedWall('x', z1, x0, x1, []);
      segmentedWall('z', x0, z0, z1, []);
      segmentedWall('z', x1, z0, z1, []);
    } else if (doorWall === 'east') {
      segmentedWall('z', x1, z0, z1, [shift(door, cz), shift(win, cz)]);
      segmentedWall('z', x0, z0, z1, []);
      segmentedWall('x', z0, x0, x1, []);
      segmentedWall('x', z1, x0, x1, []);
    } else {
      segmentedWall('z', x0, z0, z1, [shift(door, cz), shift(win, cz)]);
      segmentedWall('z', x1, z0, z1, []);
      segmentedWall('x', z0, x0, x1, []);
      segmentedWall('x', z1, x0, x1, []);
    }
    // 天花板（挡子弹）+ 暖色顶灯（房间内不死黑）
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.15, z1 - z0), ceilMat);
    ceil.position.set(cx, ROOM_H + 0.075, cz);
    group.add(solid(ceil, SURFACES.concrete));
    const light = new THREE.PointLight(0xffd9a0, 22, 14, 2);
    light.position.set(cx, 2.4, cz);
    group.add(light);
  }
  room(-20, -6, -44, -36, 'south'); // R1：北侧中段西
  room(-44, -36, -20, -6, 'east'); // R2：西侧中段北
  room(6, 20, -44, -36, 'south'); // R3：北侧中段东
  room(36, 44, 6, 20, 'west'); // R4：东侧中段南
  room(-20, -6, 36, 44, 'north'); // R5：南侧中段西

  return {
    group,
    hitMeshes,
    colliders,
    spawn: { x: 0, z: 40, yaw: 0 },
    bounds: { x: 43, zMin: -43, zMax: 43 },
    env: {
      background: new THREE.Color(0x8fb3d9),
      fog: new THREE.Fog(0x8fb3d9, 55, 140),
      exposure: 1.0, // 室外 + HDRI 环境光，曝光略低于靶场的 1.05
    },
    menuCam: { x: 0, z: 40, yawBase: 0, yawAmp: 0.2, pitch: -0.02 },
  };
}
