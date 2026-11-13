// 合成音效：WebAudio 程序化生成，零音频文件。
// 枪声 = 滤波噪声 + 低频闷响；换弹 = 分段咔哒；钢板 tink / 人体纸靶 thud。
// 任何环节失败都静默降级，游戏绝不因此抛错。

export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuf = null;

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
    noiseHit({ dur: 0.14, filterType: 'lowpass', freq: 1600, gain: 1 });
    noiseHit({ dur: 0.05, filterType: 'highpass', freq: 3000, gain: 0.5 });
    tone({ freq: 75, freqEnd: 45, dur: 0.12, type: 'sine', gain: 0.7 });
  }

  function click(freq = 1500) {
    if (!ensure()) return;
    noiseHit({ dur: 0.03, filterType: 'bandpass', freq, q: 2.5, gain: 0.7 });
  }

  function dryFire() {
    click(2000);
  }

  // 钢板 / 硬表面：高频金属 tink
  function tink() {
    if (!ensure()) return;
    tone({ freq: 3200, dur: 0.12, type: 'sine', gain: 0.35 });
    tone({ freq: 4300, dur: 0.09, type: 'sine', gain: 0.22 });
  }

  // 假人 / 纸靶：低频闷响 thud
  function thud() {
    if (!ensure()) return;
    noiseHit({ dur: 0.11, filterType: 'lowpass', freq: 320, gain: 0.8 });
    tone({ freq: 95, freqEnd: 60, dur: 0.09, type: 'sine', gain: 0.4 });
  }

  // 落地：比 thud 更轻更低的闷响
  function land() {
    if (!ensure()) return;
    noiseHit({ dur: 0.09, filterType: 'lowpass', freq: 220, gain: 0.55 });
    tone({ freq: 70, freqEnd: 45, dur: 0.09, type: 'sine', gain: 0.3 });
  }

  // 包扎完成：两声轻柔的上行音
  function heal() {
    if (!ensure()) return;
    tone({ freq: 520, dur: 0.1, type: 'sine', gain: 0.3 });
    setTimeout(() => tone({ freq: 780, dur: 0.14, type: 'sine', gain: 0.3 }), 90);
  }

  return { unlock, shot, click, dryFire, tink, thud, land, heal };
}
