// HUD：弹药、射击模式、准星散布、命中标记、毁伤日志、计分、提示浮层。
// 全部中文界面。注意：界面上没有任何血条。

export function createHud() {
  const el = (id) => document.getElementById(id);
  const ammoMag = el('ammo-mag');
  const ammoRes = el('ammo-res');
  const fireModeEl = el('fire-mode');
  const adsState = el('ads-state');
  const crosshair = el('crosshair');
  const hitmarker = el('hitmarker');
  const hitLabel = el('hitmarker-label');
  const logEl = el('damage-log');
  const scoreLine = el('score-line');
  const zoneLine = el('zone-line');
  const toastEl = el('toast');
  const reloadWrap = el('reload-wrap');
  const reloadBar = el('reload-bar');
  const startOverlay = el('start-overlay');
  const pauseOverlay = el('pause-overlay');
  const btnMode = el('btn-mode');

  let hitTimer = null;
  let toastTimer = null;

  function setAmmo(mag, reserveText) {
    ammoMag.textContent = String(mag);
    ammoRes.textContent = `/ ${reserveText}`;
    ammoMag.classList.toggle('low', mag <= 6);
  }

  function setFireMode(mode) {
    const label = mode === 'auto' ? '连发' : '单发';
    fireModeEl.textContent = label;
    // 模式按钮用图标表示：三发子弹=连发，单发子弹=单发（CSS 按 .auto 切换显示）。
    if (btnMode) btnMode.classList.toggle('auto', mode === 'auto');
  }

  function setAds(active) {
    adsState.textContent = active ? '机瞄' : '腰射';
    adsState.classList.toggle('on', active);
  }

  function setReloading(active, progress = 0) {
    reloadWrap.classList.toggle('show', active);
    reloadBar.style.width = `${Math.round(progress * 100)}%`;
  }

  // 准星散布：bloomPx 越大，四条线离中心越远。
  function setCrosshair(bloomPx, visible) {
    crosshair.style.setProperty('--gap', `${6 + bloomPx}px`);
    crosshair.style.opacity = visible ? '1' : '0.25';
  }

  function showHitmarker(zoneLabel) {
    hitmarker.classList.remove('show');
    void hitmarker.offsetWidth; // 重新触发 CSS 动画
    hitmarker.classList.add('show');
    hitLabel.textContent = zoneLabel || '';
    if (hitTimer) clearTimeout(hitTimer);
    hitTimer = setTimeout(() => {
      hitmarker.classList.remove('show');
      hitLabel.textContent = '';
    }, 220);
  }

  function addLog(text, cls = '') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${cls}`;
    entry.textContent = text;
    logEl.prepend(entry);
    while (logEl.children.length > 6) logEl.removeChild(logEl.lastChild);
  }

  function setScore({ shots, hits, zoneCounts, elapsedSec }) {
    const acc = shots > 0 ? Math.round((hits / shots) * 100) : 0;
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const ss = String(Math.floor(elapsedSec % 60)).padStart(2, '0');
    scoreLine.textContent = `命中率 ${acc}%（${hits}/${shots}）· 用时 ${mm}:${ss}`;
    zoneLine.textContent =
      `头 ${zoneCounts.head} · 胸 ${zoneCounts.chest} · 腹 ${zoneCounts.abdomen} · ` +
      `臂 ${zoneCounts.arm} · 腿 ${zoneCounts.leg}`;
  }

  function toast(text, ms = 1600) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function showStart() { startOverlay.classList.add('show'); }
  function hideStart() { startOverlay.classList.remove('show'); }
  function showPause() { pauseOverlay.classList.add('show'); }
  function hidePause() { pauseOverlay.classList.remove('show'); }

  return {
    setAmmo,
    setFireMode,
    setAds,
    setReloading,
    setCrosshair,
    showHitmarker,
    addLog,
    setScore,
    toast,
    showStart,
    hideStart,
    showPause,
    hidePause,
  };
}
