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
  const bleedIndicator = el('bleed-indicator');
  const bleedZones = el('bleed-zones');
  const bandageWrap = el('bandage-wrap');
  const bandageBar = el('bandage-bar');
  const bleedVignette = el('bleed-vignette');
  const collapseFade = el('collapse-fade');
  // 团队死斗 HUD（v0.12）：比分、击杀播报、增益、重生、结算、防具、武器槽。
  const tdmScore = el('tdm-score');
  const tdmBlue = el('tdm-blue');
  const tdmRed = el('tdm-red');
  const killFeed = el('kill-feed');
  const buffBanner = el('buff-banner');
  const buffIndicator = el('buff-indicator');
  const respawnOverlay = el('respawn-overlay');
  const respawnText = el('respawn-text');
  const respawnTimer = el('respawn-timer');
  const matchOverlay = el('match-overlay');
  const matchTitle = el('match-title');
  const matchScore = el('match-score');
  const gearPips = el('gear-pips');
  const gearArmorSegs = gearPips ? gearPips.querySelectorAll('#gear-armor .gear-seg') : [];
  const gearHelmetSegs = gearPips ? gearPips.querySelectorAll('#gear-helmet .gear-seg') : [];
  const weaponSlots = el('weapon-slots');

  let hitTimer = null;
  let toastTimer = null;
  let buffBannerTimer = null;

  function setAmmo(mag, reserveText) {
    ammoMag.textContent = String(mag);
    ammoRes.textContent = reserveText ? `/ ${reserveText}` : '';
    ammoMag.classList.toggle('low', typeof mag === 'number' && mag <= 6);
  }

  function setFireMode(mode) {
    // 'auto' 连发 / 'semi' 单发 / 'knife' 近战（战术刀没有射击模式）。
    const label = mode === 'auto' ? '连发' : mode === 'knife' ? '近战' : '单发';
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

  // 失血指示：水滴图标 + 正在失血的部位（没有数值条，严重程度看红屏）。
  function setBleeding(zoneLabels) {
    const active = Array.isArray(zoneLabels) && zoneLabels.length > 0;
    bleedIndicator.classList.toggle('show', active);
    if (active) bleedZones.textContent = `失血：${zoneLabels.join('、')}`;
  }

  // 包扎进度条（与换弹条同款式，绿色）。
  function setBandaging(active, progress = 0) {
    bandageWrap.classList.toggle('show', active);
    bandageBar.style.width = `${Math.round(progress * 100)}%`;
  }

  // 失血红屏：opacity 由主循环按失血速率 + 脉冲计算。
  function setBleedVignette(opacity) {
    bleedVignette.style.opacity = String(opacity);
  }

  // 失血过多倒地：全屏黑场过渡。
  function setCollapseFade(opacity) {
    collapseFade.style.opacity = String(opacity);
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

  // 新一局开始前清空旧日志（回主页 / 重新进入时调用）。
  function clearLog() {
    logEl.innerHTML = '';
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

  // ---------- 团队死斗 ----------

  // 比分：蓝 vs 红（30 分封顶显示，数字本身不封顶，比赛到 30 即结束）。
  function setTdmScore(blue, red) {
    if (tdmBlue) tdmBlue.textContent = String(blue);
    if (tdmRed) tdmRed.textContent = String(red);
  }

  // 击杀播报：killer/victim 为 { name, team }，killer 为 null 表示无击杀者
  // （如失血倒地）。名字按队伍着色，“你”永远金色。最多留 5 条，6s 后淡出。
  function addKillFeed(killer, victim) {
    if (!killFeed) return;
    const entry = document.createElement('div');
    entry.className = 'kill-entry';
    const nameHtml = (p) => {
      if (!p) return '';
      const cls = p.isPlayer ? 'kf-you' : p.team === 'blue' ? 'kf-blue' : 'kf-red';
      return `<span class="${cls}">${p.name}</span>`;
    };
    entry.innerHTML = killer
      ? `${nameHtml(killer)} <span class="kf-arrow">▸</span> ${nameHtml(victim)}`
      : `${nameHtml(victim)} <span class="kf-note">倒地</span>`;
    killFeed.prepend(entry);
    while (killFeed.children.length > 5) killFeed.removeChild(killFeed.lastChild);
    setTimeout(() => {
      entry.classList.add('fade');
      setTimeout(() => entry.remove(), 600);
    }, 6000);
  }

  function clearKillFeed() {
    if (killFeed) killFeed.innerHTML = '';
  }

  // 背水一战横幅：触发时居中大字显示 3.5s。
  function showBuffBanner(text) {
    if (!buffBanner) return;
    buffBanner.textContent = text;
    buffBanner.classList.add('show');
    if (buffBannerTimer) clearTimeout(buffBannerTimer);
    buffBannerTimer = setTimeout(() => buffBanner.classList.remove('show'), 3500);
  }

  // 背水一战常驻指示：增益生效期间显示在比分下方，标明受益队伍。
  function setBuffIndicator(active, team) {
    if (!buffIndicator) return;
    buffIndicator.classList.toggle('show', !!active);
    if (active) {
      buffIndicator.textContent = team === 'blue' ? '背水一战：蓝队增益中' : '背水一战：红队增益中';
      buffIndicator.classList.toggle('blue', team === 'blue');
      buffIndicator.classList.toggle('red', team === 'red');
    }
  }

  // 重生倒计时浮层：阵亡后显示击毙信息 + 剩余秒数。
  function showRespawn(text) {
    if (!respawnOverlay) return;
    if (respawnText) respawnText.textContent = text;
    respawnOverlay.classList.add('show');
  }
  function setRespawnTimer(seconds) {
    if (respawnTimer) respawnTimer.textContent = `${Math.max(0, seconds).toFixed(1)}s 后重生`;
  }
  function hideRespawn() {
    if (respawnOverlay) respawnOverlay.classList.remove('show');
  }

  // 比赛结算浮层：胜/负 + 最终比分，按钮由主循环接线。
  function showMatchOverlay(won, blue, red) {
    if (!matchOverlay) return;
    if (matchTitle) {
      matchTitle.textContent = won ? '胜利！' : '惜败';
      matchTitle.classList.toggle('win', !!won);
      matchTitle.classList.toggle('lose', !won);
    }
    if (matchScore) matchScore.textContent = `蓝队 ${blue} : ${red} 红队`;
    matchOverlay.classList.add('show');
  }
  function hideMatchOverlay() {
    if (matchOverlay) matchOverlay.classList.remove('show');
  }

  // 防具状态：两排 5 格耐久格（防弹衣/头盔），空格 = 已损耗，0 格 + 红框 = 已摧毁。
  function setGear(armorFrac, helmetFrac) {
    const paint = (segs, frac) => {
      const filled = Math.round(Math.max(0, Math.min(1, frac)) * segs.length);
      segs.forEach((s, i) => s.classList.toggle('on', i < filled));
    };
    paint(gearArmorSegs, armorFrac);
    paint(gearHelmetSegs, helmetFrac);
    const armorRow = el('gear-armor');
    const helmetRow = el('gear-helmet');
    if (armorRow) armorRow.classList.toggle('destroyed', armorFrac <= 0);
    if (helmetRow) helmetRow.classList.toggle('destroyed', helmetFrac <= 0);
  }

  // 武器槽高亮：当前武器金色边框。
  function setWeaponSlots(current) {
    if (!weaponSlots) return;
    weaponSlots.querySelectorAll('.weapon-slot').forEach((s) => {
      s.classList.toggle('current', s.dataset.weapon === current);
    });
  }

  return {
    setAmmo,
    setFireMode,
    setAds,
    setReloading,
    setBleeding,
    setBandaging,
    setBleedVignette,
    setCollapseFade,
    setCrosshair,
    showHitmarker,
    addLog,
    clearLog,
    setScore,
    toast,
    showStart,
    hideStart,
    showPause,
    hidePause,
    setTdmScore,
    addKillFeed,
    clearKillFeed,
    showBuffBanner,
    setBuffIndicator,
    showRespawn,
    setRespawnTimer,
    hideRespawn,
    showMatchOverlay,
    hideMatchOverlay,
    setGear,
    setWeaponSlots,
  };
}
