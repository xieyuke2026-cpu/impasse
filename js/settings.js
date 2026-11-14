// 设置：localStorage 持久化（impasse.settings.v1）+ 设置面板 + 按钮布局编辑。
// 存储不可用或数据损坏时回落默认值，游戏不受影响。改动即时生效，无需刷新。

const STORAGE_KEY = 'impasse.settings.v1';

export const DEFAULT_KEYS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  jump: 'Space',
  reload: 'KeyR',
  fireMode: 'KeyV',
  reset: 'KeyT',
  bandage: 'KeyB',
  weaponCycle: 'KeyQ',
};

export const KEY_ACTIONS = [
  { id: 'forward', label: '前进' },
  { id: 'back', label: '后退' },
  { id: 'left', label: '左移' },
  { id: 'right', label: '右移' },
  { id: 'sprint', label: '疾跑' },
  { id: 'jump', label: '跳跃' },
  { id: 'reload', label: '换弹' },
  { id: 'fireMode', label: '切换单发/连发' },
  { id: 'reset', label: '重置靶子' },
  { id: 'bandage', label: '包扎（按住）' },
  { id: 'weaponCycle', label: '切换武器（循环）' },
];

const DEFAULTS = {
  touchSensitivity: 1, // 触屏灵敏度倍率（0.5–3），基准系数 2.2
  joystickSide: 'left', // 'left' 摇杆在左（默认）/ 'right' 摇杆在右
  buttonScale: 1, // 触屏按钮大小倍率（0.8–1.3）
  adsMode: 'toggle', // 触屏机瞄：'toggle' 切换 / 'hold' 按住
  layout: null, // 按钮自定义布局 { fire: {x, y}, ... }，x/y 为视口百分比，按标准（摇杆在左）坐标系存储
  keys: { ...DEFAULT_KEYS },
};

// 可拖拽布局的触屏按钮（摇杆不参与拖拽，换边即可）
const LAYOUT_BUTTONS = [
  { id: 'fire', el: 'btn-fire' },
  { id: 'fireAlt', el: 'btn-fire-alt' },
  { id: 'aim', el: 'btn-aim' },
  { id: 'reload', el: 'btn-reload' },
  { id: 'mode', el: 'btn-mode' },
  { id: 'jump', el: 'btn-jump' },
  { id: 'bandage', el: 'btn-bandage' },
  { id: 'weapon', el: 'btn-weapon' },
  { id: 'sprint', el: 'btn-sprint' },
];

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function round1(v) { return Math.round(v * 10) / 10; }

// 键位显示名：KeyW → W，Space → 空格……
export function keyLabel(code) {
  if (typeof code !== 'string') return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    Space: '空格',
    ShiftLeft: '左 Shift',
    ShiftRight: '右 Shift',
    ControlLeft: '左 Ctrl',
    ControlRight: '右 Ctrl',
    AltLeft: '左 Alt',
    AltRight: '右 Alt',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
    Enter: '回车',
    Tab: 'Tab',
    Backspace: '退格',
    CapsLock: '大写锁定',
    MetaLeft: '左 Cmd',
    MetaRight: '右 Cmd',
  };
  return map[code] || code;
}

function sanitize(saved) {
  const s = {
    ...DEFAULTS,
    keys: { ...DEFAULT_KEYS },
    layout: null,
  };
  if (!saved || typeof saved !== 'object') return s;
  if (typeof saved.touchSensitivity === 'number' && Number.isFinite(saved.touchSensitivity)) {
    s.touchSensitivity = clamp(saved.touchSensitivity, 0.5, 3);
  }
  if (saved.joystickSide === 'left' || saved.joystickSide === 'right') s.joystickSide = saved.joystickSide;
  if (typeof saved.buttonScale === 'number' && Number.isFinite(saved.buttonScale)) {
    s.buttonScale = clamp(saved.buttonScale, 0.8, 1.3);
  }
  if (saved.adsMode === 'toggle' || saved.adsMode === 'hold') s.adsMode = saved.adsMode;
  if (saved.keys && typeof saved.keys === 'object') {
    for (const a of KEY_ACTIONS) {
      if (typeof saved.keys[a.id] === 'string' && saved.keys[a.id]) s.keys[a.id] = saved.keys[a.id];
    }
  }
  if (saved.layout && typeof saved.layout === 'object') {
    // 容忍旧版本存下的不完整布局（例如 v0.3 没有包扎键）：有效的条目保留，
    // 缺失的按钮回落 CSS 默认位置，而不是整个布局作废。
    const layout = {};
    for (const b of LAYOUT_BUTTONS) {
      const p = saved.layout[b.id];
      if (p && typeof p.x === 'number' && typeof p.y === 'number' &&
          Number.isFinite(p.x) && Number.isFinite(p.y)) {
        layout[b.id] = { x: clamp(p.x, 0, 100), y: clamp(p.y, 0, 100) };
      }
    }
    if (Object.keys(layout).length > 0) s.layout = layout;
  }
  return s;
}

function buttonEl(id) { return document.getElementById(id); }

// 布局按标准（摇杆在左）坐标系存储；摇杆在右时显示层镜像。
function applyLayoutPositions(layout, joystickSide) {
  for (const b of LAYOUT_BUTTONS) {
    const el = buttonEl(b.el);
    if (!el || !layout[b.id]) continue;
    let x = layout[b.id].x;
    if (joystickSide === 'right') x = 100 - x;
    el.style.left = `${x}%`;
    el.style.top = `${layout[b.id].y}%`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'translate(-50%, -50%)';
  }
}

function clearLayoutPositions() {
  for (const b of LAYOUT_BUTTONS) {
    const el = buttonEl(b.el);
    if (!el) continue;
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
    el.style.transform = '';
  }
}

export function createSettingsStore() {
  let raw = null;
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch (e) { /* 存储不可用/数据损坏：用默认值 */ }
  const state = sanitize(raw);

  function applyToDocument() {
    document.body.classList.toggle('joystick-right', state.joystickSide === 'right');
    document.body.style.setProperty('--btn-scale', String(state.buttonScale));
    if (state.layout) applyLayoutPositions(state.layout, state.joystickSide);
    else clearLayoutPositions();
  }

  const store = {
    state,
    capturing: false, // 键位录入中：controls 收到此标志后忽略键盘
    save() {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) { /* 忽略：无痕模式等场景下游戏照常运行 */ }
    },
    set(patch) {
      Object.assign(state, patch);
      store.save();
      applyToDocument();
    },
    applyToDocument,
  };
  applyToDocument();
  return store;
}

export function initSettingsPanel({ store, controls, onSimulateHit }) {
  const overlay = document.getElementById('settings-overlay');
  const panel = document.getElementById('settings-panel');
  if (!overlay || !panel) return;

  panel.innerHTML = `
    <h2>设置</h2>
    <div class="settings-section">
      <h3>触屏</h3>
      <div class="setting-row">
        <label>触屏灵敏度</label>
        <input type="range" id="set-sens" min="0.5" max="3" step="0.1" aria-label="触屏灵敏度">
        <span class="setting-value" id="set-sens-val"></span>
      </div>
      <div class="setting-row">
        <label>摇杆位置</label>
        <div class="seg" id="set-handed">
          <button type="button" data-side="left">摇杆在左</button>
          <button type="button" data-side="right">摇杆在右</button>
        </div>
      </div>
      <div class="setting-row">
        <label>按钮大小</label>
        <input type="range" id="set-btnsize" min="0.8" max="1.3" step="0.05" aria-label="按钮大小">
        <span class="setting-value" id="set-btnsize-val"></span>
      </div>
      <div class="setting-row">
        <label>机瞄方式（触屏）</label>
        <div class="seg" id="set-ads">
          <button type="button" data-mode="toggle">切换</button>
          <button type="button" data-mode="hold">按住</button>
        </div>
      </div>
      <div class="setting-row">
        <label>按钮布局</label>
        <button type="button" class="key-bind" id="set-edit-layout">编辑布局</button>
      </div>
    </div>
    <div class="settings-section">
      <h3>键盘</h3>
      <div id="set-keys"></div>
      <p class="settings-hint">点击键位后按下新按键；如该键已被占用，两者互换。Esc 取消。</p>
    </div>
    <div class="settings-section">
      <h3>测试</h3>
      <div class="setting-row">
        <label>模拟受伤</label>
        <button type="button" class="key-bind" id="set-sim-hit">模拟受伤</button>
      </div>
      <p class="settings-hint">测试用：模拟一次敌人命中，触发玩家失血流程（红屏、晃动、减速、包扎、失血过多倒地）。正式的敌人伤害以后会接同一个接口。</p>
    </div>
    <div class="settings-actions">
      <button type="button" id="set-close">完成</button>
    </div>`;

  const sensInput = panel.querySelector('#set-sens');
  const sensVal = panel.querySelector('#set-sens-val');
  const sizeInput = panel.querySelector('#set-btnsize');
  const sizeVal = panel.querySelector('#set-btnsize-val');
  const handedSeg = panel.querySelector('#set-handed');
  const adsSeg = panel.querySelector('#set-ads');
  const keysContainer = panel.querySelector('#set-keys');

  let originOverlay = null;
  let capturing = null; // { action, btn }

  function renderKeyRows() {
    keysContainer.innerHTML = KEY_ACTIONS.map((a) => `
      <div class="setting-row">
        <label>${a.label}</label>
        <button type="button" class="key-bind" data-action="${a.id}">${keyLabel(store.state.keys[a.id])}</button>
      </div>`).join('');
    keysContainer.querySelectorAll('.key-bind').forEach((btn) => {
      btn.addEventListener('click', () => startCapture(btn.dataset.action, btn));
    });
  }

  function refreshControls() {
    const s = store.state;
    sensInput.value = String(s.touchSensitivity);
    sensVal.textContent = `${s.touchSensitivity.toFixed(1)}x`;
    sizeInput.value = String(s.buttonScale);
    sizeVal.textContent = `${Math.round(s.buttonScale * 100)}%`;
    handedSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('selected', b.dataset.side === s.joystickSide);
    });
    adsSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('selected', b.dataset.mode === s.adsMode);
    });
    renderKeyRows();
  }

  // ---------- 键位录入 ----------
  function startCapture(action, btn) {
    cancelCapture();
    capturing = { action, btn };
    store.capturing = true;
    btn.classList.add('capturing');
    btn.textContent = '按下按键…';
    window.addEventListener('keydown', onCaptureKey, true);
  }

  function onCaptureKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || !capturing) return;
    if (e.code === 'Escape') {
      cancelCapture();
      return;
    }
    const { action } = capturing;
    const keys = { ...store.state.keys };
    const other = KEY_ACTIONS.find((a) => a.id !== action && keys[a.id] === e.code);
    if (other) keys[other.id] = keys[action]; // 占用则互换
    keys[action] = e.code;
    endCapture();
    store.set({ keys });
    renderKeyRows();
  }

  function endCapture() {
    window.removeEventListener('keydown', onCaptureKey, true);
    store.capturing = false;
    if (capturing) {
      capturing.btn.classList.remove('capturing');
      if (capturing.btn.blur) capturing.btn.blur();
    }
    capturing = null;
  }

  function cancelCapture() {
    if (!capturing) return;
    endCapture();
    renderKeyRows();
  }

  // ---------- 面板开关 ----------
  function open(origin) {
    originOverlay = origin === 'pause'
      ? document.getElementById('pause-overlay')
      : document.getElementById('start-overlay');
    refreshControls();
    overlay.classList.add('show');
    document.body.classList.add('settings-open'); // 恢复触屏滚动/滑块拖动
    controls.setSuspended(true);
  }

  function close() {
    cancelCapture();
    overlay.classList.remove('show');
    document.body.classList.remove('settings-open');
    if (originOverlay) originOverlay.classList.add('show');
    controls.setSuspended(false);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // ---------- 布局编辑 ----------
  let editAbort = null;
  let workingLayout = null;
  let drag = null;

  function snapshotLayout() {
    const layout = {};
    for (const b of LAYOUT_BUTTONS) {
      const el = buttonEl(b.el);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      let x = ((r.left + r.width / 2) / window.innerWidth) * 100;
      const y = ((r.top + r.height / 2) / window.innerHeight) * 100;
      if (store.state.joystickSide === 'right') x = 100 - x; // 转回标准坐标系
      layout[b.id] = { x: round1(x), y: round1(y) };
    }
    return layout;
  }

  function onDragStart(e) {
    if (!e.isPrimary) return;
    const el = e.currentTarget;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    const r = el.getBoundingClientRect();
    drag = {
      id: el.dataset.layoutId,
      pointerId: e.pointerId,
      offX: e.clientX - (r.left + r.width / 2),
      offY: e.clientY - (r.top + r.height / 2),
      el,
    };
    el.classList.add('dragging');
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    let x = ((e.clientX - drag.offX) / window.innerWidth) * 100;
    const y = clamp(((e.clientY - drag.offY) / window.innerHeight) * 100, 6, 96);
    x = clamp(x, 4, 96);
    if (store.state.joystickSide === 'right') x = 100 - x; // 转回标准坐标系
    workingLayout[drag.id] = { x: round1(x), y: round1(y) };
    applyLayoutPositions(workingLayout, store.state.joystickSide);
  }

  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.el.classList.remove('dragging');
    drag = null;
    store.set({ layout: workingLayout });
  }

  function startLayoutEdit() {
    cancelCapture();
    overlay.classList.remove('show');
    document.body.classList.remove('settings-open');
    if (originOverlay) originOverlay.classList.remove('show');
    // 先加 layout-edit（强制显示触屏按钮），再量位置：桌面端 #touch-ui 平时是
    // display:none，量出来全是 0，按钮会被钉到左上角。
    document.body.classList.add('layout-edit');
    workingLayout = store.state.layout
      ? JSON.parse(JSON.stringify(store.state.layout))
      : snapshotLayout();
    applyLayoutPositions(workingLayout, store.state.joystickSide);
    controls.setLayoutEditing(true);
    controls.setSuspended(true);
    editAbort = new AbortController();
    const { signal } = editAbort;
    for (const b of LAYOUT_BUTTONS) {
      const el = buttonEl(b.el);
      if (!el) continue;
      el.dataset.layoutId = b.id;
      el.addEventListener('pointerdown', onDragStart, { signal });
    }
    window.addEventListener('pointermove', onDragMove, { signal });
    window.addEventListener('pointerup', onDragEnd, { signal });
    window.addEventListener('pointercancel', onDragEnd, { signal });
  }

  function finishLayoutEdit() {
    if (editAbort) editAbort.abort();
    editAbort = null;
    drag = null;
    document.body.classList.remove('layout-edit');
    controls.setLayoutEditing(false);
    document.body.classList.add('settings-open');
    overlay.classList.add('show'); // 回到设置面板
  }

  function resetLayout() {
    store.set({ layout: null });
    clearLayoutPositions();
    workingLayout = snapshotLayout();
    applyLayoutPositions(workingLayout, store.state.joystickSide);
  }

  // ---------- 接线 ----------
  sensInput.addEventListener('input', () => {
    store.set({ touchSensitivity: parseFloat(sensInput.value) });
    sensVal.textContent = `${store.state.touchSensitivity.toFixed(1)}x`;
  });
  sensInput.addEventListener('change', () => sensInput.blur());
  sizeInput.addEventListener('input', () => {
    store.set({ buttonScale: parseFloat(sizeInput.value) });
    sizeVal.textContent = `${Math.round(store.state.buttonScale * 100)}%`;
  });
  sizeInput.addEventListener('change', () => sizeInput.blur());

  handedSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      store.set({ joystickSide: b.dataset.side });
      handedSeg.querySelectorAll('button').forEach((x) => {
        x.classList.toggle('selected', x === b);
      });
      b.blur();
    });
  });
  adsSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      store.set({ adsMode: b.dataset.mode });
      controls.setAimActive(false); // 切换模式时不留一个锁死的机瞄状态
      adsSeg.querySelectorAll('button').forEach((x) => {
        x.classList.toggle('selected', x === b);
      });
      b.blur();
    });
  });

  panel.querySelector('#set-edit-layout').addEventListener('click', (e) => {
    if (e.currentTarget.blur) e.currentTarget.blur();
    startLayoutEdit();
  });
  const simHitBtn = panel.querySelector('#set-sim-hit');
  if (simHitBtn) {
    simHitBtn.addEventListener('click', () => {
      if (onSimulateHit) onSimulateHit();
      simHitBtn.blur();
    });
  }
  panel.querySelector('#set-close').addEventListener('click', () => close());

  const btnSettingsStart = document.getElementById('btn-settings-start');
  if (btnSettingsStart) {
    btnSettingsStart.addEventListener('click', () => {
      btnSettingsStart.blur();
      open('start');
    });
  }
  const btnSettingsPause = document.getElementById('btn-settings-pause');
  if (btnSettingsPause) {
    btnSettingsPause.addEventListener('click', () => {
      btnSettingsPause.blur();
      open('pause');
    });
  }
  const btnLayoutDone = document.getElementById('btn-layout-done');
  if (btnLayoutDone) btnLayoutDone.addEventListener('click', () => finishLayoutEdit());
  const btnLayoutReset = document.getElementById('btn-layout-reset');
  if (btnLayoutReset) btnLayoutReset.addEventListener('click', () => resetLayout());

  return { open, close };
}
