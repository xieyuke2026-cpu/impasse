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

import { fetchAssetBytes } from './assets.js?v=0.14';

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
  const trimmedMs = {}; // 采样名 -> 剪掉的前置静音（毫秒），调试用
  let preloadStarted = false;

  // 前置静音剪裁：实测枪声/换弹采样在 decodeAudioData 后的 buffer 里，
  // 可听瞬变之前有 15~64ms 近静音（shot-ar15-near 50.8ms、换弹匣装回
  // 63.7ms、拉机柄 46.6ms），声音相对枪口闪光/换弹动画固定晚到——这就
  // 是 Ryan 说的“音画不同步”。解码后直接剪掉首个 -40dBFS 之上的采样
  // 之前的内容（留 ~2ms 保护），不是播放时加偏移补偿：剪完的 buffer
  // 从第 0 帧就是声音，start() 当帧即响。脚步/命中采样本身只有 ~3ms
  // 前置，剪裁近乎无操作。
  function trimLeadingSilence(buf) {
    const THRESH = 0.01; // -40dBFS
    const GUARD = Math.floor(buf.sampleRate * 0.002); // 2ms 保护，不剪破瞬变
    let first = buf.length;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        if (Math.abs(d[i]) >= THRESH) {
          if (i < first) first = i;
          break;
        }
      }
    }
    const cut = Math.max(0, first - GUARD);
    if (cut <= 0) return { buf, trimmedMs: 0 };
    const out = ctx.createBuffer(buf.numberOfChannels, buf.length - cut, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      out.copyToChannel(buf.getChannelData(ch).subarray(cut), ch);
    }
    return { buf: out, trimmedMs: (cut / buf.sampleRate) * 1000 };
  }

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
        const decoded = await ctx.decodeAudioData(buf);
        const { buf: trimmed, trimmedMs: ms } = trimLeadingSilence(decoded);
        samples[key] = trimmed;
        trimmedMs[key] = Math.round(ms * 10) / 10;
      } catch (e) {
        failedSamples.add(key);
      }
    });
    await Promise.allSettled(jobs);
  }

  // 播放一个已解码的采样；没加载出来返回 false，调用方走合成回退。
  // rate: 播放速率（手枪用 1.3 倍速，听着更脆，与步枪区分开）。
  function playSample(key, gain = 1, rate = 1) {
    const buf = samples[key];
    if (!ctx || !master || !buf) return false;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
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

  // 手枪射击：步枪采样 1.3 倍速 + 低增益，听着更脆更短。
  function pistolShot() {
    if (!ensure()) return;
    if (playSample('shotNear', 0.85, 1.3)) return;
    noiseHit({ dur: 0.09, filterType: 'lowpass', freq: 2000, gain: 0.9 });
    tone({ freq: 90, freqEnd: 55, dur: 0.08, type: 'sine', gain: 0.5 });
  }

  // 机器人开火（远处枪声）：中距离采样，音量随距离衰减。
  function distantShot(distanceM) {
    if (!ensure()) return;
    const gain = Math.min(0.9, Math.max(0.12, 1.1 - distanceM / 40));
    if (playSample('shotMid', gain)) return;
    noiseHit({ dur: 0.12, filterType: 'lowpass', freq: 900, gain: gain * 0.8 });
  }

  // 挥刀破空声：短促的带通噪声扫过。
  function swing() {
    if (!ensure()) return;
    noiseHit({ dur: 0.12, filterType: 'bandpass', freq: 900, q: 1.2, gain: 0.5 });
  }

  // 武器切换：装备咔哒声。
  function weaponSwitch() {
    if (!ensure()) return;
    if (playSample('dryClick', 0.9)) return;
    noiseHit({ dur: 0.03, filterType: 'bandpass', freq: 1400, q: 2.5, gain: 0.6 });
  }

  // 调试用：自动化验证读取采样加载状态，不影响游戏。
  function sampleStatus() {
    return {
      loaded: Object.keys(samples).length,
      total: Object.keys(SAMPLE_FILES).length,
      failed: [...failedSamples],
      trimmedMs: { ...trimmedMs },
    };
  }

  return { unlock, preloadSamples, shot, pistolShot, distantShot, swing, weaponSwitch, click, dryFire, tink, thud, land, heal, footstep, uiClick, modeSwitch, sampleStatus };
}
