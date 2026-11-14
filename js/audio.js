// 音效：真实采样优先，合成音效回退。
// 采样是 AAC（.m4a）：iPad Safari / WebKit 对 OGG Vorbis 的 decodeAudioData
// 支持不可靠，OGG 方案已撤回；AAC 在所有现代浏览器（含 Safari）均可解码。
// 都只影响它对应的那一声——其余采样照常，失败的那一声走合成回退。
// 合成回退 = v0.2 起的 WebAudio 程序化音色，全部保留，一个采样都加载
// 不出来时游戏音效与旧版完全一致。任何环节失败都静默降级，绝不抛错。
//
// 采样来源（CC0，见 README 致谢）：Free Firearm Sound Library（枪声）、
// OGA 换弹采样、Kenney 脚步/命中/UI 采样。
// 传输格式：采样以 base64 文本（.b64）存在仓库里（推送工具拒二进制），
// 这里复用 assets.js 的 fetchAssetBytes() 取回原始字节再解码。

import { fetchAssetBytes } from './assets.js?v=0.11';

const SAMPLE_FILES = {
  shotNear: 'shot-ar15-near.m4a',
  shotMid: 'shot-ar15-mid.m4a', // 已加载，留给将来的远处枪声，v0.10 未用
  shotAk: 'shot-ak47-near.m4a', // 已加载，留给将来的第二把枪，v0.10 未用
  reloadMagOut: 'clipload1.m4a',
  reloadMagIn: 'assaultriflereload1_0.m4a',
  reloadCock: 'shotguncock_0.m4a',
  dryClick: 'equip-click-a.m4a',
  foot1: 'footstep_concrete_000.m4a',
  foot2: 'footstep_concrete_001.m4a',
  foot3: 'footstep_concrete_002.m4a',
  metalLight: 'impactMetal_light_002.m4a',
  metalMedium: 'impactMetal_medium_001.m4a',
  plateMedium: 'impactPlate_medium_000.m4a', // 已加载，留给钢板专属音，v0.10 未用
  softHeavy: 'impactSoft_heavy_001.m4a',
  softMedium: 'impactSoft_medium_001.m4a',
  woodMedium: 'impactWood_medium_001.m4a', // 已加载，留给木质命中，v0.10 未用
  uiClick: 'click_001.m4a',
  uiSelect: 'select_001.m4a',
  uiSwitch: 'switch_001.m4a',
};

export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  const samples = {};
  const failedSamples = new Set();
  let preloadStarted = false;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') {
        try {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) { /* 忽略 */ }
      }
      return true;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.15;
      master.connect(ctx.destination);
      const len = Math.floor(ctx.sampleRate * 0.5);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return true;
    } catch (e) {
      ctx = null;
      return false;
    }
  }

  // 必须在用户手势中调用一次（开始按钮点击），否则浏览器不许出声。
  function unlock() {
    ensure();
  }

  // 预加载全部采样：fire-and-forget，主循环在初始化时调用一次。
  // decodeAudioData 在 suspended 的 AudioContext 下也能工作，所以加载
  // 不必等用户手势；每个采样独立 try/catch，失败只记名，不阻塞其余。
  async function preloadSamples() {
    if (preloadStarted) return;
    preloadStarted = true;
    if (!ensure()) return;
    const jobs = Object.entries(SAMPLE_FILES).map(async ([key, file]) => {
      try {
        const buf = await fetchAssetBytes(`audio/${file}`);
        samples[key] = await ctx.decodeAudioData(buf);
      } catch (e) {
        failedSamples.add(key);
      }
    });
    await Promise.allSettled(jobs);
  }

  // 播放一个已解码的采样；没加载出来返回 false，调用方走合成回退。
  function playSample(key, gain = 1) {
    const buf = samples[key];
    if (!ctx || !master || !buf) return false;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(master);
      src.start();
      return true;
    } catch (e) {
      return false;
    }
  }

  function noiseHit({ dur = 0.15, filterType = 'lowpass', freq = 1200, q = 0.7, gain = 1 }) {
    if (!ctx || !master || !noiseBuf) return;
    try {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = filterType;
      filt.frequency.value = freq;
      filt.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(filt);
      filt.connect(g);
      g.connect(master);
      src.start(t);
      src.stop(t + dur + 0.05);
    } catch (e) { /* 静默降级 */ }
  }

  function tone({ freq = 440, freqEnd = null, dur = 0.1, type = 'sine', gain = 0.5 }) {
    if (!ctx || !master) return;
    try {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    } catch (e) { /* 静默降级 */ }
  }

  function shot() {
    if (!ensure()) return;
    if (playSample('shotNear', 1)) return;
    noiseHit({ dur: 0.14, filterType: 'lowpass', freq: 1600, gain: 1 });
    noiseHit({ dur: 0.05, filterType: 'highpass', freq: 3000, gain: 0.5 });
    tone({ freq: 75, freqEnd: 45, dur: 0.12, type: 'sine', gain: 0.7 });
  }

  // 换弹分段咔哒：主循环按 freq 区分三个阶段（1500 退弹匣 / 900 装回 /
  // 1900 拉机柄），dryFire 用 2000——按 freq 映射到对应采样，采样缺失
  // 时退回原合成咔哒，接口与旧版完全一致。
  function click(freq = 1500) {
    if (!ensure()) return;
    let key = 'reloadMagIn';
    if (freq >= 1950) key = 'dryClick';
    else if (freq >= 1700) key = 'reloadCock';
    else if (freq >= 1200) key = 'reloadMagOut';
    if (playSample(key, 0.9)) return;
    noiseHit({ dur: 0.03, filterType: 'bandpass', freq, q: 2.5, gain: 0.7 });
  }

  function dryFire() {
    click(2000);
  }

  // 钢板 / 硬表面：高频金属命中
  function tink() {
    if (!ensure()) return;
    if (playSample('metalMedium', 0.9)) return;
    tone({ freq: 3200, dur: 0.12, type: 'sine', gain: 0.35 });
    tone({ freq: 4300, dur: 0.09, type: 'sine', gain: 0.22 });
  }

  // 假人 / 纸靶：低频闷响 thud
  function thud() {
    if (!ensure()) return;
    if (playSample('softMedium', 0.9)) return;
    noiseHit({ dur: 0.11, filterType: 'lowpass', freq: 320, gain: 0.8 });
    tone({ freq: 95, freqEnd: 60, dur: 0.09, type: 'sine', gain: 0.4 });
  }

  // 落地：比 thud 更轻更低的闷响
  function land() {
    if (!ensure()) return;
    if (playSample('softHeavy', 0.6)) return;
    noiseHit({ dur: 0.09, filterType: 'lowpass', freq: 220, gain: 0.55 });
    tone({ freq: 70, freqEnd: 45, dur: 0.09, type: 'sine', gain: 0.3 });
  }

  // 脚步声：三段混凝土脚步采样随机取一段；主循环在 bob 周期过谷底时调用
  // （一步一声），不要在别处按固定间隔调用，会与步伐脱节。
  // 采样缺失时退回旧合成音（左右脚音调交替）。
  const FOOT_KEYS = ['foot1', 'foot2', 'foot3'];
  let stepSide = 0;
  function footstep() {
    if (!ensure()) return;
    const key = FOOT_KEYS[Math.floor(Math.random() * FOOT_KEYS.length)];
    if (playSample(key, 0.8)) return;
    stepSide = 1 - stepSide;
    const freq = stepSide ? 190 : 160;
    noiseHit({ dur: 0.07, filterType: 'lowpass', freq, gain: 0.35 });
    tone({ freq: 60, freqEnd: 40, dur: 0.06, type: 'sine', gain: 0.12 });
  }

  // 包扎完成：两声轻柔的上行音（无采样，合成音保留）
  function heal() {
    if (!ensure()) return;
    tone({ freq: 520, dur: 0.1, type: 'sine', gain: 0.3 });
    setTimeout(() => tone({ freq: 780, dur: 0.14, type: 'sine', gain: 0.3 }), 90);
  }

  // 界面点击（主页选图 / 帮助开关）：采样缺失时退回合成咔哒。
  function uiClick() {
    if (!ensure()) return;
    if (playSample('uiSelect', 0.8)) return;
    noiseHit({ dur: 0.03, filterType: 'bandpass', freq: 1200, q: 2.5, gain: 0.5 });
  }

  // 射击模式切换：采样缺失时退回合成咔哒。
  function modeSwitch() {
    if (!ensure()) return;
    if (playSample('uiSwitch', 0.8)) return;
    noiseHit({ dur: 0.03, filterType: 'bandpass', freq: 1000, q: 2.5, gain: 0.5 });
  }

  // 调试用：自动化验证读取采样加载状态，不影响游戏。
  function sampleStatus() {
    return {
      loaded: Object.keys(samples).length,
      total: Object.keys(SAMPLE_FILES).length,
      failed: [...failedSamples],
    };
  }

  return { unlock, preloadSamples, shot, click, dryFire, tink, thud, land, heal, footstep, uiClick, modeSwitch, sampleStatus };
}
