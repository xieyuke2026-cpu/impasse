// 步枪：视图模型 + 后坐力系统 + 双手 + 分段换弹动画。
// 后坐力手感 = 镜头上跳 + 持续抬升 + 枪身后座 + 准星散布扩大，四者叠加。
// （后坐力数值是 Ryan 在 iPad 上验过“可以”的，v0.2 一律不动。）
//
// 视图模型两条路径（assets.js 加载结果决定）：
//   A. Quaternius 步枪 GLB（CC0）：单体模型 + 内嵌贴图，枪口朝 -Z，
//      握把落在枪组原点附近，导轨顶沿对齐瞄准线 SIGHT_Y。
//   B. 程序化模型（加载失败回退）：v0.2 起的方块拼枪，含弹匣/拉机柄
//      分段动画；GLB 路径下弹匣与拉机柄是模型的一部分，换弹只做
//      枪身下沉/上翻 + 左手下探（姿态逻辑共用，子件动画跳过）。
// 两种路径共用：枪组位姿/后坐力/双手/绷带/枪口火光/抛壳锚点。
//
// 瞄准线约定（程序化路径）：瞄准线在枪身局部坐标 y = 0.06 处；ADS_POS 把枪身
// 放到 (0, -0.06, -0.50)，机瞄时镜头正好沿瞄准线看出去。
// GLB 步枪路径另有更高的瞄准线：枪口装置顶部实测高出 0.06 的线 0.044
// （几何截面探针），且枪身俯角让导轨前高后低——0.06 的线会穿过枪身，
// 机瞄时枪身挡住画面中央（v0.10 反馈 p3）。步枪用 RIFLE_SIGHT_Y = 0.112
// （枪口顶 0.104 上方留 0.008），环与准星都立在这条线上，枪身整体低于视线。
// ADS z 取 -0.50（而非 -0.38）：枪托顶面不再越过近裁剪面，机瞄时枪身只占画面
// 下方中央一条，不会铺满整个下半屏。步枪 ADS z 再推远到 -0.55，枪托角尺寸更小。

import * as THREE from 'three';

const HIP_POS = new THREE.Vector3(0.26, -0.22, -0.45);
const ADS_POS = new THREE.Vector3(0, -0.06, -0.50);
const SIGHT_Y = 0.06; // 瞄准线高度（局部坐标，程序化路径）
const RIFLE_SIGHT_Y = 0.112; // 瞄准线高度（局部坐标，GLB 步枪路径）
const RIFLE_ADS_POS = new THREE.Vector3(0, -RIFLE_SIGHT_Y, -0.55);
const MAG_BASE = new THREE.Vector3(0, -0.045, 0.02);
const HANDLE_BASE_Z = 0.17;
const LEFT_HAND_BASE = new THREE.Vector3(0, -0.028, -0.29);

// 步枪 GLB 摆放常数（模型实测：长 1.82m，沿 Z，枪口朝 +Z，握把在 z≈-0.10，
// 导轨顶沿约 y=0.50，枪管中心线约 y=0.38；绕 Y 旋转 180° 后枪口朝 -Z）。
// 以下数值按实测推导，截图验证过（见 v0.10 验证记录）。
const RIFLE_SCALE = 0.45;
const RIFLE_RAIL_Y = 0.50; // 模型空间导轨顶沿高度
const RIFLE_BARREL_Y = 0.38; // 模型空间枪管中心线高度（仅作模型实测记录；枪口锚点现由变换后几何取样，见 buildRifle）
const RIFLE_GRIP_Z = -0.10; // 模型空间握把 z（旋转前）
const RIFLE_GRIP_TARGET_Z = -0.06; // 握把落点（局部坐标）：枪组原点即握持点
const RIGHT_HAND_PROC = new THREE.Vector3(0, -0.07, 0.14);
// GLB 路径右手：握把在 z≈-0.06..0.05、向后下方倾斜（截面实测：z=0 处枪身
// 下沿 -0.128），手须坐低、靠后，掌心包住握把下半段才不被机匣挡住。
const RIGHT_HAND_RIFLE = new THREE.Vector3(0, -0.085, -0.03);
// GLB 路径左手基准：护木下沿在 y≈0.04（截面实测），v0.10 的 -0.01 让手
// 悬在护木下方 5cm、从镜头看被弹匣挡住；抬到 0.025，手指扣住护木两侧。
const LEFT_HAND_BASE_RIFLE = new THREE.Vector3(0, 0.025, -0.33);

function easeInQuad(t) {
  return t * t;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function smoothstep(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function makeFlashTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255, 255, 230, 1)');
  grad.addColorStop(0.35, 'rgba(255, 200, 90, 0.9)');
  grad.addColorStop(1, 'rgba(255, 120, 20, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  // 十字焰舌
  g.fillStyle = 'rgba(255, 220, 140, 0.95)';
  g.fillRect(28, 2, 8, 60);
  g.fillRect(2, 28, 60, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createGun({ camera, rifleModel = null }) {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.55, metalness: 0.6 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.5, metalness: 0.7 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.8, metalness: 0.2 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.95, metalness: 0 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x8a6b3f, roughness: 0.6, metalness: 0.3 });
  // 手套用沙色：深色手套在深色枪身上完全看不见，换浅色才能读出“手在握枪”。
  const glove = new THREE.MeshStandardMaterial({ color: 0x77664e, roughness: 0.95, metalness: 0 });

  function addBox(parent, w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  }

  // 换弹子件：只有程序化路径有（GLB 的弹匣/拉机柄是模型的一部分，不可分拆）。
  let magGroup = null;
  let chargingHandle = null;
  let muzzlePos;
  let ejectPos;
  let rightHandPos = RIGHT_HAND_PROC;
  let leftHandBase = LEFT_HAND_BASE; // 换弹/包扎动画的左手基准：GLB 路径改用护木位置
  let adsPos = ADS_POS; // 机瞄位姿：GLB 步枪路径改用更高的瞄准线/更远的 z

  // ---------- 路径 B：程序化模型（v0.2 原样，加载失败回退） ----------
  function buildProcedural() {
    // 机匣：上下两层叠出倒角感
    addBox(group, 0.062, 0.055, 0.34, metal, 0, -0.012, 0.02); // 下机匣
    addBox(group, 0.056, 0.045, 0.36, metal, 0, 0.032, 0); // 上机匣
    // 顶部导轨（在照门前方截止，给照门座留位置）
    addBox(group, 0.024, 0.01, 0.3, darkMetal, 0, 0.052, -0.13);
    for (let i = 0; i < 5; i++) {
      addBox(group, 0.026, 0.004, 0.01, rubber, 0, 0.056, -0.25 + i * 0.06);
    }

    // 抛壳口：右侧深色嵌块 + 抛壳挺
    addBox(group, 0.004, 0.028, 0.085, rubber, 0.0295, 0.015, -0.02);
    addBox(group, 0.006, 0.012, 0.02, darkMetal, 0.031, 0.028, 0.03);

    // 护木 + 散热槽
    addBox(group, 0.058, 0.052, 0.24, polymer, 0, 0.002, -0.29);
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        addBox(group, 0.004, 0.02, 0.04, rubber, sx * 0.03, 0, -0.22 - i * 0.07);
      }
    }
    for (let i = 0; i < 4; i++) {
      addBox(group, 0.02, 0.004, 0.012, rubber, 0, 0.03, -0.2 - i * 0.06);
    }

    // 枪管 + 导气箍 + 制退器
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.22, 12), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.012, -0.46);
    group.add(barrel);
    addBox(group, 0.028, 0.032, 0.03, darkMetal, 0, 0.018, -0.42); // 导气箍
    const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 12), darkMetal);
    brake.rotation.x = Math.PI / 2;
    brake.position.set(0, 0.012, -0.535);
    group.add(brake);
    for (const z of [-0.52, -0.545]) {
      addBox(group, 0.04, 0.008, 0.012, rubber, 0, 0.012, z); // 制退器侧孔
    }

    // 照门：透孔环 + 护耳（实心方块已废除）
    // 细环大孔：管径 0.0025、孔半径 0.0155，读作觇孔而不是甜甜圈。
    addBox(group, 0.02, 0.012, 0.05, darkMetal, 0, 0.036, 0.1); // 照门座（顶部低于环孔下缘）
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.0025, 8, 32), metal);
    ring.position.set(0, SIGHT_Y, 0.1);
    group.add(ring);
    for (const sx of [-1, 1]) {
      // 护耳收敛：顶部低于瞄准线，只在环座两侧露一点，不跟环糊成一团。
      addBox(group, 0.005, 0.018, 0.024, metal, sx * 0.0245, 0.049, 0.1);
    }

    // 准星：细柱 + 护翼，尖端恰在瞄准线上
    addBox(group, 0.005, 0.026, 0.005, darkMetal, 0, 0.047, -0.42);
    for (const sx of [-1, 1]) {
      addBox(group, 0.004, 0.026, 0.02, darkMetal, sx * 0.012, 0.046, -0.42);
    }

    // 弹匣：三段弯弹匣，独立成组以便换弹动画
    magGroup = new THREE.Group();
    magGroup.position.copy(MAG_BASE);
    group.add(magGroup);
    addBox(magGroup, 0.045, 0.055, 0.07, polymer, 0, -0.028, 0.005, 0.06);
    addBox(magGroup, 0.043, 0.055, 0.068, polymer, 0, -0.078, 0.018, 0.16);
    addBox(magGroup, 0.04, 0.05, 0.062, polymer, 0, -0.122, 0.038, 0.28);
    addBox(magGroup, 0.048, 0.012, 0.075, rubber, 0, -0.15, 0.048, 0.28); // 托弹板底盖

    // 扳机 + 护圈 + 握把
    addBox(group, 0.012, 0.008, 0.075, polymer, 0, -0.078, 0.095); // 护圈底边
    addBox(group, 0.012, 0.045, 0.008, polymer, 0, -0.055, 0.06); // 护圈前边
    addBox(group, 0.008, 0.03, 0.01, darkMetal, 0, -0.055, 0.1, 0.2); // 扳机
    addBox(group, 0.045, 0.085, 0.055, polymer, 0, -0.08, 0.135, 0.35); // 握把

    // 拉机柄：换弹末段会拉动
    chargingHandle = addBox(group, 0.02, 0.012, 0.05, darkMetal, 0, 0.048, HANDLE_BASE_Z);
    addBox(group, 0.034, 0.008, 0.016, darkMetal, 0, 0.048, HANDLE_BASE_Z + 0.028); // 拉柄翼

    // 枪托：托身 + 贴腮 + 底板
    // 顶面收窄、压低，并整体带一个向后的下坠角（真枪的“贴腮落差”）：机瞄时枪托
    // 顶面是离镜头最近的水平面——平着伸到镜头前就会铺满下半屏，下坠后它向画面
    // 下方滑出，只剩一条窄边。子组绕 z=0.15 枢轴旋转，握把/右手不受影响。
    const stockGroup = new THREE.Group();
    stockGroup.position.set(0, 0, 0.15);
    stockGroup.rotation.x = 0.14;
    group.add(stockGroup);
    addBox(stockGroup, 0.028, 0.026, 0.08, metal, 0, -0.002, 0.04); // 缓冲管
    addBox(stockGroup, 0.044, 0.055, 0.2, polymer, 0, -0.018, 0.13); // 托身
    addBox(stockGroup, 0.038, 0.016, 0.1, polymer, 0, 0.012, 0.12); // 贴腮
    addBox(stockGroup, 0.046, 0.07, 0.02, rubber, 0, -0.02, 0.24); // 枪托底板

    // 快慢机
    addBox(group, 0.006, 0.012, 0.03, accent, -0.033, -0.005, 0.06);

    muzzlePos = new THREE.Vector3(0, 0.012, -0.56);
    ejectPos = new THREE.Vector3(0.04, 0.02, -0.02);
    rightHandPos = RIGHT_HAND_PROC;
  }

  // ---------- 路径 A：Quaternius 步枪 GLB ----------
  function buildRifle(model) {
    const rifle = model.clone(true);
    // 枪口朝 -Z；再绕 X 下俯 0.14 rad：枪托顶面落到瞄准线下方约 0.011m，
    // 机瞄时枪托不再挡住画面中央（实测：0.08 仍高出 0.007，0.12 仅 -0.005）。
    rifle.rotation.set(0.14, Math.PI, 0);
    rifle.scale.setScalar(RIFLE_SCALE);
    // 导轨顶沿对齐 0.06（低于步枪瞄准线 0.112，枪身整体沉在视线之下）；
    // 握把落在枪组原点（握持点）。旋转后握把 z = -RIFLE_GRIP_Z * scale，再平移至目标落点。
    rifle.position.set(
      0,
      SIGHT_Y - RIFLE_RAIL_Y * RIFLE_SCALE,
      RIFLE_GRIP_TARGET_Z + RIFLE_GRIP_Z * RIFLE_SCALE
    );
    rifle.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false; // 视图模型不投射阴影
        o.receiveShadow = false;
      }
    });
    group.add(rifle);
    leftHandBase = LEFT_HAND_BASE_RIFLE;
    adsPos = RIFLE_ADS_POS;
    // ---------- 机瞄具：觇孔环 + 准星，立在步枪瞄准线上 ----------
    // 环心与准星尖端都在 RIFLE_SIGHT_Y 上，与机瞄时的镜头轴线重合；
    // 环座是一段立柱（机匣顶沿约 0.045，环下缘 0.0915），读作提把式照门。
    // 准星立在枪管上方（该处枪身顶沿约 0.09），尖端恰在瞄准线，护翼低于线。
    const riser = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.056, 0.016), darkMetal);
    riser.position.set(0, 0.064, 0.10);
    group.add(riser);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.0025, 8, 32), metal);
    ring.position.set(0, RIFLE_SIGHT_Y, 0.10);
    group.add(ring);
    for (const sx of [-1, 1]) {
      addBox(group, 0.005, 0.018, 0.02, metal, sx * 0.023, 0.10, 0.10); // 护耳，顶部低于瞄准线
    }
    addBox(group, 0.005, 0.03, 0.005, darkMetal, 0, 0.097, -0.40); // 准星柱，尖端在瞄准线
    for (const sx of [-1, 1]) {
      addBox(group, 0.004, 0.02, 0.02, darkMetal, sx * 0.012, 0.092, -0.40); // 准星护翼
    }
    // 枪口锚点：取变换后几何最前端（-Z 端）一小片顶点的平均位置。
    // 模型节点自带局部变换，直接用模型空间常数（RIFLE_BARREL_Y）算会落
    // 在错误帧里——实测旧算法算出的枪口 y 比真实低约 0.084m。
    rifle.updateMatrixWorld(true);
    const _v = new THREE.Vector3();
    let minZ = Infinity;
    rifle.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (_v.z < minZ) minZ = _v.z;
      }
    });
    let sx = 0, sy = 0, n = 0;
    rifle.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (_v.z <= minZ + 0.02) { sx += _v.x; sy += _v.y; n++; }
      }
    });
    // 探针实测值（俯角 0.14、握把 z -0.06 时枪口面中心 ≈ (0, 0.090, -0.484)），
    // 几何取样失败时用它兜底。
    const muzzleY = n > 0 ? sy / n : 0.09;
    const muzzleZ = Number.isFinite(minZ) ? minZ - 0.01 : -0.484;
    muzzlePos = new THREE.Vector3(n > 0 ? sx / n : 0, muzzleY, muzzleZ);
    ejectPos = new THREE.Vector3(0.04, muzzleY + 0.01, -0.02);
    rightHandPos = RIGHT_HAND_RIFLE;
  }

  if (rifleModel) {
    try {
      buildRifle(rifleModel);
    } catch (e) {
      // GLB 摆放失败：清空枪组，退回程序化模型，游戏不受影响。
      // 摆位/双手基准一并复位，否则残留的步枪数值会带偏回退模型。
      group.clear();
      magGroup = null;
      chargingHandle = null;
      leftHandBase = LEFT_HAND_BASE;
      adsPos = ADS_POS;
      buildProcedural();
    }
  } else {
    buildProcedural();
  }

  // ---------- 双手：战术手套，枪身的子级，跟随一切枪身运动 ----------
  const rightHand = new THREE.Group();
  rightHand.position.copy(rightHandPos);
  group.add(rightHand);
  // 手掌比握把宽一圈，屈指包到握把前方、拇指探出左侧——手必须“露在枪外面”才看得见。
  addBox(rightHand, 0.06, 0.06, 0.05, glove, 0, 0, 0.008); // 手掌
  addBox(rightHand, 0.056, 0.055, 0.026, glove, 0, -0.005, -0.04, -0.35); // 屈指
  addBox(rightHand, 0.016, 0.05, 0.022, glove, -0.034, 0.01, -0.002, -0.2, 0, 0.5); // 拇指

  const leftHand = new THREE.Group();
  leftHand.position.copy(leftHandBase);
  group.add(leftHand);
  addBox(leftHand, 0.064, 0.028, 0.075, glove, 0, -0.018, 0); // 手掌托住护木
  addBox(leftHand, 0.02, 0.05, 0.062, glove, -0.032, 0.008, 0, 0, 0, 0.5); // 左侧屈指
  addBox(leftHand, 0.02, 0.05, 0.062, glove, 0.032, 0.008, 0, 0, 0, -0.5); // 右侧屈指
  addBox(leftHand, 0.016, 0.042, 0.022, glove, -0.034, 0.012, -0.02, 0, 0, 0.6); // 拇指

  // ---------- 绷带卷 + 散出的绷带条：左手的子级，只在包扎姿态时可见 ----------
  // 白色，在沙色手套和深色枪身之间一眼能认出。卷放在手掌前方（+z 朝向镜头），
  // 散出的条垂在手边，包扎时跟着手一起摆动。
  const bandageMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.9, metalness: 0 });
  const bandageStrip = new THREE.Group();
  const bandageRoll = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.04, 12), bandageMat);
  bandageRoll.rotation.z = Math.PI / 2;
  bandageRoll.position.set(0, 0.005, 0.03);
  bandageStrip.add(bandageRoll);
  const stripTail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.003), bandageMat);
  stripTail.position.set(0.02, -0.035, 0.028);
  stripTail.rotation.z = 0.3;
  bandageStrip.add(stripTail);
  bandageStrip.visible = false;
  leftHand.add(bandageStrip);

  // ---------- 枪口 / 抛壳口锚点 ----------
  const muzzle = new THREE.Object3D();
  muzzle.position.copy(muzzlePos);
  group.add(muzzle);

  const ejectPort = new THREE.Object3D();
  ejectPort.position.copy(ejectPos);
  group.add(ejectPort);

  // 枪口火光：贴片 + 点光源，射击瞬间闪亮
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.3),
    new THREE.MeshBasicMaterial({
      map: makeFlashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  flash.position.copy(muzzle.position);
  flash.visible = false;
  group.add(flash);
  const flashLight = new THREE.PointLight(0xffa050, 0, 7, 2);
  flashLight.position.copy(muzzle.position);
  group.add(flashLight);

  group.position.copy(HIP_POS);
  camera.add(group);

  // 镜头补光：让深色枪身在暗处也能看出轮廓（只影响近处）
  const fillLight = new THREE.PointLight(0xfff2e0, 1.2, 2.5, 2);
  fillLight.position.set(0.3, 0.15, -0.1);
  camera.add(fillLight);
  // 注意：不要用 layer 把枪与世界灯光隔离——three.js 按相机 layer 收集光源，
  // 层 1 的枪仍会被层 0 的房间灯照到。隔离靠 main.js 的独立枪场景实现，
  // 这里枪的全部网格都留在默认层 0，灯光也一样。

  const state = {
    recoilPitch: 0, // 快速上跳，快速回落
    recoilYaw: 0,
    climb: 0, // 持续射击的累积抬升，停火后缓慢回落
    bloom: 0, // 散布扩大（弧度）
    ads: 0, // 0 = 腰射，1 = 机瞄
    kickZ: 0, // 枪身后座
    kickRot: 0, // 枪身上扬
    reloadDip: 0, // 换弹下沉
    reloading: false,
    reloadProgress: -1, // -1 = 不在换弹；0..1 = 换弹分段进度
    bandaging: false, // 包扎读条中（主循环保证与换弹互斥）
    bandagePose: 0, // 包扎姿态淡入淡出 0..1（0.3s 完成）
    bandageT: 0, // 包扎缠绕摆动计时
    flashLife: 0,
    timeSinceShot: 99,
  };

  // 后坐力数值与 v0.1 完全一致（Ryan 已验“可以”，不动）。
  function fire(aiming) {
    const k = aiming ? 0.7 : 1;
    state.recoilPitch += (0.01 + Math.random() * 0.006) * k;
    state.recoilYaw += (Math.random() - 0.5) * 0.005 * k;
    state.climb = Math.min(state.climb + 0.0022 * k, 0.05);
    state.bloom = Math.min(state.bloom + (aiming ? 0.006 : 0.011), 0.05);
    state.kickZ = Math.min(state.kickZ + 0.035, 0.07);
    state.kickRot = Math.min(state.kickRot + 0.05, 0.12);
    state.timeSinceShot = 0;
    state.flashLife = 0.045;
    flash.visible = true;
    flash.material.rotation = Math.random() * Math.PI;
    flash.scale.setScalar(0.8 + Math.random() * 0.5);
    flashLight.intensity = 14;
  }

  function update(dt, aiming) {
    state.timeSinceShot += dt;
    const fastDecay = Math.exp(-9 * dt);
    state.recoilPitch *= fastDecay;
    state.recoilYaw *= fastDecay;
    if (state.timeSinceShot > 0.35) state.climb *= Math.exp(-2.0 * dt);
    state.bloom *= Math.exp(-5.5 * dt);
    state.kickZ *= Math.exp(-11 * dt);
    state.kickRot *= Math.exp(-11 * dt);

    const adsTarget = aiming ? 1 : 0;
    state.ads += (adsTarget - state.ads) * Math.min(1, dt * 12);
    const dipTarget = state.reloading ? 1 : 0;
    state.reloadDip += (dipTarget - state.reloadDip) * Math.min(1, dt * 8);

    // 包扎姿态：0.3s 线性淡入/淡出，开始与取消都平滑，不跳变。
    const poseTarget = state.bandaging ? 1 : 0;
    if (state.bandagePose < poseTarget) state.bandagePose = Math.min(poseTarget, state.bandagePose + dt / 0.3);
    else if (state.bandagePose > poseTarget) state.bandagePose = Math.max(poseTarget, state.bandagePose - dt / 0.3);
    const bp = smoothstep(state.bandagePose);
    state.bandageT += dt;

    group.position.lerpVectors(HIP_POS, adsPos, state.ads);
    group.position.z += state.kickZ;
    group.position.y -= state.reloadDip * 0.1;
    group.rotation.x = state.kickRot + state.reloadDip * 0.55;
    // 包扎姿态与换弹姿态不同：枪身向中心靠拢、下沉、轻微上倾 + 内扣，
    // 读作“双手凑到一起处理伤口”，而不是换弹的“枪身大角度上翻”。
    // 下沉量 0.02 是取景框量出来的：再沉，持绷带的左手就贴着下边缘出画
    // （NDC y 会到 -0.95；0.02 时约 -0.65，居中偏下，绷带卷看得清）。
    group.position.x -= bp * 0.06;
    group.position.y -= bp * 0.02;
    group.rotation.x += bp * 0.22;
    group.rotation.z = bp * 0.16;

    // 换弹分段动画：弹匣落下/装回 + 拉机柄 + 左手下探（右手始终握把）。
    // 与包扎姿态互斥：换弹分支里不碰包扎量，包扎分支里弹匣/拉机柄归位。
    // GLB 路径没有可分拆的弹匣/拉机柄：子件动画跳过，左手下探照常。
    const rp = state.reloadProgress;
    if (rp >= 0) {
      if (magGroup) {
        let dropK;
        if (rp < 0.25) dropK = easeInQuad(rp / 0.25);
        else if (rp < 0.55) dropK = 1;
        else if (rp < 0.82) dropK = 1 - easeOutCubic((rp - 0.55) / 0.27);
        else dropK = 0;
        magGroup.position.y = MAG_BASE.y - 0.17 * dropK;
        magGroup.position.z = MAG_BASE.z + 0.04 * dropK;
        magGroup.rotation.x = 0.35 * dropK;
      }

      if (chargingHandle) {
        let tug = 0;
        if (rp >= 0.85) tug = Math.sin(Math.PI * Math.min(1, (rp - 0.85) / 0.15));
        chargingHandle.position.z = HANDLE_BASE_Z + 0.05 * tug;
      }

      let handK;
      if (rp < 0.3) handK = rp / 0.3;
      else if (rp < 0.6) handK = 1;
      else handK = Math.max(0, 1 - (rp - 0.6) / 0.25);
      handK = smoothstep(handK);
      leftHand.position.y = leftHandBase.y - 0.085 * handK;
      leftHand.position.z = leftHandBase.z + 0.14 * handK;
      leftHand.rotation.x = 0.5 * handK;
      bandageStrip.visible = false;
    } else {
      if (magGroup) {
        magGroup.position.copy(MAG_BASE);
        magGroup.rotation.x = 0;
      }
      if (chargingHandle) chargingHandle.position.z = HANDLE_BASE_Z;
      // 包扎：左手从护木移到中下方（凑到右手边），2 Hz 小幅缠绕摆动；
      // bp = 0 时精确回到护木原位，无残余偏移。
      // 手的目标位置按取景框调过三轮截图 + NDC 实测：手须在机匣左侧、
      // 靠镜头一侧、且抬到机匣顶沿高度，否则会被枪身挡住或贴着下边缘出画
      // （第一版手在机匣正后方只露个边；第二版 NDC y -0.95 几乎出画）。
      const wob = Math.sin(state.bandageT * Math.PI * 4);
      const wob2 = Math.sin(state.bandageT * Math.PI * 4 + Math.PI / 2);
      leftHand.position.x = leftHandBase.x + bp * -0.055;
      leftHand.position.y = leftHandBase.y + bp * (0.05 + wob * 0.006);
      leftHand.position.z = leftHandBase.z + bp * (0.30 + wob2 * 0.008);
      leftHand.rotation.x = bp * (0.4 + wob * 0.12);
      leftHand.rotation.z = bp * wob2 * 0.18;
      bandageStrip.visible = bp > 0.02;
      bandageStrip.rotation.x = wob * 0.25;
    }

    if (state.flashLife > 0) {
      state.flashLife -= dt;
      flashLight.intensity = Math.max(0, state.flashLife / 0.045) * 14;
      if (state.flashLife <= 0) {
        flash.visible = false;
        flashLight.intensity = 0;
      }
    }
  }

  // 当前总散布（弧度）：基础散布 + 射击积累，机瞄时大幅缩小。
  function getSpread() {
    const factor = 1 - 0.65 * state.ads;
    return (0.0035 + state.bloom) * factor;
  }

  function getRecoil() {
    return { pitch: state.recoilPitch + state.climb, yaw: state.recoilYaw };
  }

  function getBloom() {
    return state.bloom;
  }

  function getAdsAmount() {
    return state.ads;
  }

  function setReloading(v) {
    state.reloading = v;
    state.reloadProgress = v ? 0 : -1;
  }

  function setBandaging(v) {
    state.bandaging = v;
  }

  function getBandagePose() {
    return state.bandagePose;
  }

  // 调试用：左手中心在 NDC 里的位置（|x|,|y| < 1 才在画面内），
  // 供自动化验证确认包扎时手和绷带没有出画或被枪身挡住。
  const _ndc = new THREE.Vector3();
  function getLeftHandNdc() {
    leftHand.getWorldPosition(_ndc);
    _ndc.project(camera);
    return { x: +_ndc.x.toFixed(3), y: +_ndc.y.toFixed(3), behind: _ndc.z > 1 };
  }

  function setReloadProgress(p) {
    state.reloadProgress = p;
  }

  function muzzleWorldPosition(out) {
    return muzzle.getWorldPosition(out);
  }

  function ejectionWorldPosition(out) {
    return ejectPort.getWorldPosition(out);
  }

  return {
    group,
    muzzle,
    fire,
    update,
    getSpread,
    getRecoil,
    getBloom,
    getAdsAmount,
    setReloading,
    setReloadProgress,
    setBandaging,
    getBandagePose,
    getLeftHandNdc,
    muzzleWorldPosition,
    ejectionWorldPosition,
  };
}
