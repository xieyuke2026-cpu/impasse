// 步枪：程序化低模视图模型 + 后坐力系统。
// 后坐力手感 = 镜头上跳 + 持续抬升 + 枪身后座 + 准星散布扩大，四者叠加。
// 没有外部模型文件，全部由 Three.js 几何体拼成。

import * as THREE from 'three';

const HIP_POS = new THREE.Vector3(0.26, -0.22, -0.45);
const ADS_POS = new THREE.Vector3(0, -0.06, -0.38);

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

export function createGun({ camera }) {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.55, metalness: 0.6 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.8, metalness: 0.2 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x8a6b3f, roughness: 0.6, metalness: 0.3 });

  function box(w, h, d, mat, x, y, z, rx = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    group.add(m);
    return m;
  }

  box(0.07, 0.09, 0.42, metal, 0, 0, 0); // 机匣
  box(0.06, 0.055, 0.26, polymer, 0, 0.005, -0.3); // 护木
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 12), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.36);
  group.add(barrel);
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 12), metal);
  brake.rotation.x = Math.PI / 2;
  brake.position.set(0, 0.012, -0.52);
  group.add(brake);
  box(0.05, 0.15, 0.085, polymer, 0, -0.1, 0.03, 0.12); // 弹匣
  box(0.05, 0.07, 0.24, polymer, 0, -0.015, 0.3); // 枪托
  box(0.045, 0.09, 0.055, polymer, 0, -0.085, 0.13, 0.35); // 握把
  box(0.02, 0.03, 0.03, metal, 0, 0.06, 0.1); // 照门
  box(0.008, 0.03, 0.008, metal, 0, 0.058, -0.44); // 准星
  box(0.02, 0.02, 0.1, accent, 0, 0.052, -0.2); // 导轨

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, -0.56);
  group.add(muzzle);

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
    flashLife: 0,
    timeSinceShot: 99,
  };

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

    group.position.lerpVectors(HIP_POS, ADS_POS, state.ads);
    group.position.z += state.kickZ;
    group.position.y -= state.reloadDip * 0.1;
    group.rotation.x = state.kickRot + state.reloadDip * 0.55;

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
  }

  function muzzleWorldPosition(out) {
    return muzzle.getWorldPosition(out);
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
    muzzleWorldPosition,
  };
}
