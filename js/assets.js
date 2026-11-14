// 开源素材加载：GLB 模型（Kenney / Quaternius，CC0）、PBR 贴图与 HDRI
// （Poly Haven，CC0）、Rajdhani 字体（OFL）。全部走“加载失败即回退”：
// 任何一件素材失败都只记一个 fallback 标志，游戏用程序化模型/纯色材质/
// 系统字体继续跑，绝不抛未处理异常。
// 音频不在这里解码：audio.js 自己按需加载采样（需要 AudioContext 解码），
// 但它复用这里导出的 fetchAssetBytes() 读 .b64。
//
// 传输格式：仓库推送工具只接受 UTF-8 文本，二进制会被拒，所以 assets/ 里
// 全是 base64 文本（<原名>.b64，见 tools/encode-assets.mjs）。这里 fetch 到
// 文本后解码回 ArrayBuffer 再交给 Three.js / FontFace。解码是分块 atob，
// 不会因为 ~1.5MB 的 HDRI .b64 产生巨型中间字符串。
// 缓存策略：素材 URL 带 ?v=0.13，与模块版本查询串同一版本号，素材更新即换地址。

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export const ASSETS_VERSION = '0.13';
const BASE = 'assets/';
const av = (p) => `${BASE}${p}.b64?v=${ASSETS_VERSION}`;

// ---------- base64 解码（分块 atob） ----------
// 输入含换行（编码器每 72 字符换行），先去掉空白符再按 64KB（4 的倍数，
// 保证每块都是完整量子）分块 atob，直接写入预分配的 Uint8Array。
export function decodeBase64ToArrayBuffer(b64) {
  const s = b64.replace(/[\r\n\t ]/g, '');
  if (s.length === 0) return new ArrayBuffer(0);
  let pad = 0;
  if (s.endsWith('==')) pad = 2;
  else if (s.endsWith('=')) pad = 1;
  const outLen = Math.floor((s.length * 3) / 4) - pad;
  const bytes = new Uint8Array(outLen);
  const CHUNK = 65536; // 4 的倍数
  let offset = 0;
  for (let i = 0; i < s.length; i += CHUNK) {
    const part = atob(s.slice(i, i + CHUNK));
    for (let j = 0; j < part.length; j++) bytes[offset + j] = part.charCodeAt(j);
    offset += part.length;
  }
  return bytes.buffer;
}

// 取一件素材的原始字节：fetch .b64 文本 → 解码。失败抛错，调用方各自兜底。
export async function fetchAssetBytes(relPath) {
  const res = await fetch(av(relPath));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${relPath}`);
  const text = await res.text();
  return decodeBase64ToArrayBuffer(text);
}

// ---------- blob URL 注册表 ----------
// 解码后的字节转 blob URL，供 TextureLoader / GLTF 外部贴图使用；整个会话
// 内保留（revoke 会导致已建纹理失效），页面关闭时由浏览器回收。
const blobUrls = new Map();
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.hdr': 'application/octet-stream',
};
function mimeFor(relPath) {
  const dot = relPath.lastIndexOf('.');
  return MIME_BY_EXT[relPath.slice(dot).toLowerCase()] || 'application/octet-stream';
}
function blobUrlFor(relPath, buffer) {
  let url = blobUrls.get(relPath);
  if (!url) {
    url = URL.createObjectURL(new Blob([buffer], { type: mimeFor(relPath) }));
    blobUrls.set(relPath, url);
  }
  return url;
}

// ---------- 素材清单 ----------
// 模型：key → 相对路径。Kenney 套件的 GLB 内部引用外部贴图
// Textures/colormap.png（相对路径），5 个套件各有一张不同的 colormap，
// 见 KIT_COLORMAPS；加载时用“假 resourcePath + URLModifier”按套件分流。
const MODEL_FILES = {
  // 商业楼（city-kit-commercial）
  'bld-a': 'models/city-kit-commercial/building-a.glb',
  'bld-b': 'models/city-kit-commercial/building-b.glb',
  'bld-c': 'models/city-kit-commercial/building-c.glb',
  'bld-d': 'models/city-kit-commercial/building-d.glb',
  'bld-e': 'models/city-kit-commercial/building-e.glb',
  'bld-f': 'models/city-kit-commercial/building-f.glb',
  'sky-a': 'models/city-kit-commercial/building-skyscraper-a.glb',
  'sky-c': 'models/city-kit-commercial/building-skyscraper-c.glb',
  'sky-e': 'models/city-kit-commercial/building-skyscraper-e.glb',
  'low-a': 'models/city-kit-commercial/low-detail-building-a.glb',
  'low-b': 'models/city-kit-commercial/low-detail-building-b.glb',
  'low-c': 'models/city-kit-commercial/low-detail-building-c.glb',
  'low-d': 'models/city-kit-commercial/low-detail-building-d.glb',
  'low-wide-a': 'models/city-kit-commercial/low-detail-building-wide-a.glb',
  'low-wide-b': 'models/city-kit-commercial/low-detail-building-wide-b.glb',
  'awning': 'models/city-kit-commercial/detail-awning-wide.glb',
  'parasol': 'models/city-kit-commercial/detail-parasol-a.glb',
  // 住宅（city-kit-suburban）
  'house-a': 'models/city-kit-suburban/building-type-a.glb',
  'house-f': 'models/city-kit-suburban/building-type-f.glb',
  'house-m': 'models/city-kit-suburban/building-type-m.glb',
  'house-r': 'models/city-kit-suburban/building-type-r.glb',
  'tree-large': 'models/city-kit-suburban/tree-large.glb',
  'tree-small': 'models/city-kit-suburban/tree-small.glb',
  'planter': 'models/city-kit-suburban/planter.glb',
  'fence': 'models/city-kit-suburban/fence.glb',
  // 工业（city-kit-industrial）
  'ind-a': 'models/city-kit-industrial/building-a.glb',
  'ind-c': 'models/city-kit-industrial/building-c.glb',
  'ind-k': 'models/city-kit-industrial/building-k.glb',
  'container-a': 'models/city-kit-industrial/shipping-container-a.glb',
  'container-b': 'models/city-kit-industrial/shipping-container-b.glb',
  'container-c': 'models/city-kit-industrial/shipping-container-c.glb',
  'water-tower': 'models/city-kit-industrial/water-tower.glb',
  'chimney': 'models/city-kit-industrial/chimney-large.glb',
  // 道路设施（city-kit-roads）
  'lamp-curved': 'models/city-kit-roads/light-curved.glb',
  'lamp-square': 'models/city-kit-roads/light-square.glb',
  'traffic-light': 'models/city-kit-roads/traffic-light.glb',
  'dumpster': 'models/city-kit-roads/dumpster.glb',
  'road-barrier': 'models/city-kit-roads/construction-barrier.glb',
  'cone': 'models/city-kit-roads/construction-cone.glb',
  'sign-stop': 'models/city-kit-roads/road-sign-stop.glb',
  'power-pole': 'models/city-kit-roads/electricity-pole.glb',
  // 车辆（car-kit）
  'car-sedan': 'models/car-kit/sedan.glb',
  'car-suv': 'models/car-kit/suv.glb',
  'car-taxi': 'models/car-kit/taxi.glb',
  'car-van': 'models/car-kit/van.glb',
  'car-truck': 'models/car-kit/truck.glb',
  // 武器与角色（贴图内嵌/无贴图，不走 colormap）
  'rifle': 'models/weapons/rifle-quaternius.glb',
  'pistol': 'models/weapons/pistol-kenney.glb',
  'sniper': 'models/weapons/sniper-kenney.glb',
  'soldier': 'models/characters/soldier-male.glb',
  'soldier-blue': 'models/characters/soldier-male-blue.glb',
};

// 每件模型所属的 Kenney 套件（由路径第二段推导）；武器/角色不在此列。
const KIT_COLORMAPS = {
  'city-kit-commercial': 'models/city-kit-commercial/Textures/colormap.png',
  'city-kit-suburban': 'models/city-kit-suburban/Textures/colormap.png',
  'city-kit-industrial': 'models/city-kit-industrial/Textures/colormap.png',
  'city-kit-roads': 'models/city-kit-roads/Textures/colormap.png',
  'car-kit': 'models/car-kit/Textures/colormap.png',
};
function kitOf(relPath) {
  const kit = relPath.split('/')[1];
  return Object.prototype.hasOwnProperty.call(KIT_COLORMAPS, kit) ? kit : null;
}

// PBR 贴图：每套 Diffuse + 法线（OpenGL 约定）+ 粗糙度，1K JPG。
// 法线/粗糙度保持线性色彩空间，只有 Diffuse 用 sRGB。
const TEXTURE_SETS = {
  asphalt: {
    map: 'textures/asphalt_01/asphalt_01_diff_1k.jpg',
    normalMap: 'textures/asphalt_01/asphalt_01_nor_gl_1k.jpg',
    roughnessMap: 'textures/asphalt_01/asphalt_01_rough_1k.jpg',
  },
  concrete: {
    map: 'textures/concrete/concrete_diff_1k.jpg',
    normalMap: 'textures/concrete/concrete_nor_gl_1k.jpg',
    roughnessMap: 'textures/concrete/concrete_rough_1k.jpg',
  },
  brickWall: {
    map: 'textures/brick_wall_001/brick_wall_001_diffuse_1k.jpg',
    normalMap: 'textures/brick_wall_001/brick_wall_001_nor_gl_1k.jpg',
    roughnessMap: 'textures/brick_wall_001/brick_wall_001_rough_1k.jpg',
  },
  brickPavement: {
    map: 'textures/brick_pavement/brick_pavement_diff_1k.jpg',
    normalMap: 'textures/brick_pavement/brick_pavement_nor_gl_1k.jpg',
    roughnessMap: 'textures/brick_pavement/brick_pavement_rough_1k.jpg',
  },
};

const HDRI_FILE = 'textures/qwantani_noon_puresky_1k.hdr';

const FONT_FILES = [
  { file: 'fonts/rajdhani-600-latin.woff2', weight: '600' },
  { file: 'fonts/rajdhani-700-latin.woff2', weight: '700' },
];

// 士兵站姿：绑定姿态是双臂张开的 T 形，必须播一段 Idle clip 再冻结，
// 否则假人会是个稻草人。只播一次（mixer.update(0.5)），之后不再更新 mixer，
// 姿态永久冻结，零持续开销；克隆（SkeletonUtils.clone）会继承冻结姿态。
function poseSoldier(scene, animations) {
  try {
    const clip = THREE.AnimationClip.findByName(animations, 'Idle');
    if (!clip) return;
    const mixer = new THREE.AnimationMixer(scene);
    const action = mixer.clipAction(clip);
    action.play();
    mixer.update(0.5);
    scene.updateMatrixWorld(true);
  } catch (e) { /* 摆姿失败也无妨：退回绑定姿态，游戏继续 */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// GLTFLoader.parse 的 Promise 包装（r160 的 parse 是回调式）。
function parseGltf(loader, buffer, resourcePath) {
  return new Promise((resolve, reject) => {
    try {
      loader.parse(buffer, resourcePath, resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

// 加载全部素材。onProgress(done, total) 供主页显示进度；
// 8 秒全局超时：超时后用已加载的部分 + 回退继续，绝不等死。
// 返回：{ models: Map, animations: Map（士兵模型的 clip 列表，供机器人 AI 用）,
//         failedModels: Set, textures: {...}, hdr: Texture|null,
//         fontsLoaded: number, timedOut: bool }
export async function loadAssets({ onProgress = null, timeoutMs = 8000 } = {}) {
  const jobs = [];
  let done = 0;
  const total =
    Object.keys(MODEL_FILES).length +
    Object.values(TEXTURE_SETS).reduce((n, s) => n + Object.keys(s).length, 0) +
    1 + // HDRI
    FONT_FILES.length;
  const tick = () => {
    done += 1;
    if (onProgress) {
      try { onProgress(done, total); } catch (e) { /* 进度回调绝不能炸掉加载 */ }
    }
  };

  // ---- 第一步：先解码 5 张 colormap，注册 blob URL ----
  // Kenney GLB 的外部贴图全是同一个相对名 Textures/colormap.png，但 5 个
  // 套件内容各不相同。parse 时给每件模型一个“假 resourcePath”
  // `__kit__/<套件>/`，GLTFLoader 会把贴图 URL 解析成
  // `__kit__/<套件>/Textures/colormap.png`，再由 LoadingManager 的
  // URLModifier 按套件映射到对应的 blob URL。并行解析也不会串套件，
  // 因为映射只看 URL 字符串本身。
  const colormapBlobUrls = new Map();
  await Promise.allSettled(Object.entries(KIT_COLORMAPS).map(async ([kit, file]) => {
    try {
      const buf = await fetchAssetBytes(file);
      colormapBlobUrls.set(kit, blobUrlFor(file, buf));
    } catch (e) { /* 该套件的模型随后解析失败，走程序化回退 */ }
  }));

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const m = /^__kit__\/([^/]+)\/Textures\/colormap\.png$/.exec(url);
    if (m && colormapBlobUrls.has(m[1])) return colormapBlobUrls.get(m[1]);
    return url;
  });
  const gltfLoader = new GLTFLoader(manager);
  const texLoader = new THREE.TextureLoader();
  const rgbeLoader = new RGBELoader();

  const models = new Map();
  const animations = new Map();
  const failedModels = new Set();
  for (const [key, file] of Object.entries(MODEL_FILES)) {
    jobs.push(
      (async () => {
        const kit = kitOf(file);
        const resourcePath = kit ? `__kit__/${kit}/` : '';
        const buf = await fetchAssetBytes(file);
        const gltf = await parseGltf(gltfLoader, buf, resourcePath);
        if (key === 'soldier' || key === 'soldier-blue') {
          poseSoldier(gltf.scene, gltf.animations);
          // 保留 clip：机器人 AI 要在克隆体上播 Walk/Run/Shoot/Death。
          // 冻结姿态不受影响——mixer 播放时会接管骨骼变换。
          animations.set(key, gltf.animations);
        }
        models.set(key, gltf.scene);
      })()
        .catch(() => { failedModels.add(key); })
        .finally(tick)
    );
  }

  const textures = {};
  for (const [setName, files] of Object.entries(TEXTURE_SETS)) {
    textures[setName] = {};
    for (const [slot, file] of Object.entries(files)) {
      jobs.push(
        (async () => {
          const buf = await fetchAssetBytes(file);
          const tex = await texLoader.loadAsync(blobUrlFor(file, buf));
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.anisotropy = 4;
          if (slot === 'map') tex.colorSpace = THREE.SRGBColorSpace;
          textures[setName][slot] = tex;
        })()
          .catch(() => { textures[setName][slot] = null; })
          .finally(tick)
      );
    }
  }

  let hdr = null;
  jobs.push(
    (async () => {
      const buf = await fetchAssetBytes(HDRI_FILE);
      hdr = rgbeLoader.parse(buf);
    })()
      .catch(() => { hdr = null; })
      .finally(tick)
  );

  // ---- 字体：FontFace 从解码字节加载，失败则系统字体兜底 ----
  let fontsLoaded = 0;
  for (const { file, weight } of FONT_FILES) {
    jobs.push(
      (async () => {
        const buf = await fetchAssetBytes(file);
        const face = new FontFace('Rajdhani', buf, { weight, style: 'normal' });
        await face.load();
        document.fonts.add(face);
        fontsLoaded += 1;
      })()
        .catch(() => { /* 字体失败无妨：CSS 字体栈落到系统字体 */ })
        .finally(tick)
    );
  }

  const timedOut = await Promise.race([
    Promise.allSettled(jobs).then(() => false),
    sleep(timeoutMs).then(() => true),
  ]);
  // 超时后未完成的任务仍在后台跑：它们都自带 catch，不会产生未处理 rejection；
  // 完成后写入的 models/textures 不会被使用（游戏已按回退建成），无害。
  return { models, animations, failedModels, textures, hdr, fontsLoaded, timedOut };
}
