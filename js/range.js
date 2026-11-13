// 靶场环境：室内射击场 —— 地面、墙体、天花板、灯光、枪道隔板、掩体道具。
// 全部程序化几何体 + Canvas 生成的纹理，没有外部素材。

import * as THREE from 'three';

function floorTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#70747a';
  g.fillRect(0, 0, 512, 1024);
  // 混凝土地面噪点
  for (let i = 0; i < 2600; i++) {
    const shade = 100 + Math.floor(Math.random() * 40);
    g.fillStyle = `rgb(${shade},${shade},${shade + 4})`;
    g.fillRect(Math.random() * 512, Math.random() * 1024, 2, 2);
  }
  // 枪道分界线（黄色虚线）
  g.strokeStyle = '#d8b93a';
  g.lineWidth = 5;
  g.setLineDash([26, 20]);
  for (const x of [128, 256, 384]) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 1024);
    g.stroke();
  }
  // 射击线（红色实线，靠近射手一端）
  g.setLineDash([]);
  g.strokeStyle = '#c0392b';
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(0, 880);
  g.lineTo(512, 880);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#22252a';
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#d8b93a';
  g.lineWidth = 6;
  g.strokeRect(8, 8, 496, 112);
  g.fillStyle = '#f2d54b';
  g.font = 'bold 64px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('射 击 靶 场', 256, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createRange({ scene }) {
  const hitMeshes = [];

  function solid(mesh, kind, hardness) {
    mesh.userData.surface = { kind, hardness };
    hitMeshes.push(mesh);
    return mesh;
  }

  // 灯光：半球光 + 环境光 + 顶灯（含射手区一盏，避免近处天花板死黑）
  scene.add(new THREE.HemisphereLight(0xfff2e0, 0x4a4a52, 0.95));
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  for (const [x, z] of [[-4, -6], [4, -6], [0, -16], [0, 6]]) {
    const light = new THREE.PointLight(0xffe6b8, 26, 30, 2);
    light.position.set(x, 3.7, z);
    scene.add(light);
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.95, metalness: 0 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.9, metalness: 0.1 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x55555c, roughness: 0.95, metalness: 0 });

  // 地面 14m × 36m（z 从 -22 到 14）
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(14, 0.2, 36),
    new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.95, metalness: 0 })
  );
  floor.position.set(0, -0.1, -4);
  scene.add(solid(floor, 'floor', 0.9));

  // 天花板
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(14, 0.2, 36), ceilMat);
  ceil.position.set(0, 4.3, -4);
  scene.add(solid(ceil, 'wall', 0.7));

  // 左右墙
  for (const sx of [-7, 7]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.4, 36), wallMat);
    wall.position.set(sx, 2.1, -4);
    scene.add(solid(wall, 'wall', 0.9));
  }
  // 后墙（射手身后）
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(14, 4.4, 0.3), wallMat);
  backWall.position.set(0, 2.1, 14);
  scene.add(solid(backWall, 'wall', 0.9));

  // 靶场尽头：挡弹墙 + 橡胶条
  const stopWall = new THREE.Mesh(new THREE.BoxGeometry(14, 4.4, 0.4), darkMat);
  stopWall.position.set(0, 2.1, -22);
  scene.add(solid(stopWall, 'wall', 0.9));
  for (let i = 0; i < 9; i++) {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 3.6, 0.08),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0x2c2c30 : 0x35353a, roughness: 1 })
    );
    strip.position.set(-5.6 + i * 1.4, 1.9, -21.75);
    scene.add(strip);
  }

  // 招牌
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 1.1),
    new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.8 })
  );
  sign.position.set(0, 3.5, -21.7);
  scene.add(sign);

  // 顶灯灯板（发光贴片）
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0 });
  for (const [x, z] of [[-4, -6], [4, -6], [0, -16], [-4, -16], [4, -16], [0, 6]]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.5), panelMat);
    panel.position.set(x, 4.18, z);
    scene.add(panel);
  }

  // 墙面吸音板（装饰）
  const panelDark = new THREE.MeshStandardMaterial({ color: 0x4c4a44, roughness: 1 });
  for (const sx of [-6.8, 6.8]) {
    for (let i = 0; i < 5; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, 2.4), panelDark);
      p.position.set(sx, 2.2, -18 + i * 6);
      scene.add(p);
    }
  }

  // 枪道隔板（矮墙，射手区）
  const dividerMat = new THREE.MeshStandardMaterial({ color: 0x9a7b4f, roughness: 0.85 });
  for (const x of [-2.2, 2.2]) {
    const div = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.1, 5), dividerMat);
    div.position.set(x, 0.55, 6.5);
    scene.add(solid(div, 'prop', 0.6));
  }

  // 掩体道具：木箱 + 油桶（硬表面，可跳弹）
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x7d6242, roughness: 0.9 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x51606e, roughness: 0.5, metalness: 0.6 });
  const cratePositions = [[-5.6, -8], [-5.6, -8.9], [-5.6, 1.05, -8.45], [5.6, -10], [5.6, 1.05, -10]];
  for (const [x, y, z] of cratePositions.map((p) => (p.length === 2 ? [p[0], 0.5, p[1]] : p))) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), crateMat);
    crate.position.set(x, y, z);
    crate.rotation.y = (x + z) * 0.13;
    scene.add(solid(crate, 'prop', 0.6));
  }
  for (const [x, z] of [[-5.8, -14], [5.8, -6]]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 18), barrelMat);
    barrel.position.set(x, 0.55, z);
    scene.add(solid(barrel, 'prop', 0.9));
  }

  return { hitMeshes };
}
