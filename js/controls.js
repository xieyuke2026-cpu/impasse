// 输入控制：桌面端（Pointer Lock + 键鼠）与触屏端（虚拟摇杆 + 滑动视角 + 按钮）
// 触屏是第一公民：iPad 上只用触摸就能完成全部操作。
// 键位、触屏灵敏度、机瞄方式等来自 settings.js，可由玩家自定义。

import { DEFAULT_KEYS } from './settings.js?v=0.8';

export function createControls({ canvas, elements, settings }) {
  const isTouch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0);

  const state = {
    moveX: 0, // -1..1，右为正
    moveY: 0, // -1..1，前为正
    firing: false,
    aiming: false,
    sprint: false,
    bandaging: false, // 包扎输入有效：键盘按住包扎键，或触屏包扎键点按开关已打开
    pointerLocked: false,
    touchMode: isTouch,
  };

  let lookDX = 0;
  let lookDY = 0;
  const listeners = {};
  const emit = (name, ...args) => {
    (listeners[name] || []).forEach((fn) => fn(...args));
  };
  const on = (name, fn) => {
    (listeners[name] = listeners[name] || []).push(fn);
  };

  let suspended = false; // 设置面板打开时：忽略全部游戏输入
  let layoutEditing = false; // 布局编辑中：触屏按钮不触发动作，只响应拖拽

  // 触屏包扎键是开关式：点一下打开读条，再点关闭（单手拇指按住 2.5s 的同时
  // 另一只手还要转视角，太别扭；Ryan 点按后期待立刻有反应）。
  // 开关由主循环在包扎完成/被取消时清掉（clearBandageLatch），避免读条自己续上。
  let touchBandageToggle = false;
  function setBandageToggle(v) {
    touchBandageToggle = v;
    if (elements.btnBandage) elements.btnBandage.classList.toggle('active', v);
  }

  // ---------- 键盘（键位可重绑，见 settings.js） ----------
  const keys = new Set();
  const boundKeys = () => (settings ? settings.state.keys : DEFAULT_KEYS);
  // 方向键是移动的固定备用键；一旦被绑到其它动作上，备用关系自动让位。
  function arrowFree(code) {
    const k = boundKeys();
    return k.jump !== code && k.reload !== code && k.fireMode !== code &&
      k.reset !== code && k.sprint !== code && k.bandage !== code;
  }
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (settings && settings.capturing) return; // 键位录入中：不触发游戏动作
    if (suspended) return;
    keys.add(e.code);
    const k = boundKeys();
    if (e.code === k.reload) emit('reload');
    if (e.code === k.fireMode) emit('toggleMode');
    if (e.code === k.reset) emit('reset');
    if (e.code === k.jump) {
      e.preventDefault(); // 防止空格激活获得焦点的按钮
      emit('jump');
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => {
    keys.clear();
    setBandageToggle(false);
    state.firing = false;
    state.aiming = false;
    state.bandaging = false;
  });

  // ---------- 鼠标（Pointer Lock） ----------
  document.addEventListener('pointerlockchange', () => {
    state.pointerLocked =
      document.pointerLockElement === canvas ||
      document.pointerLockElement === document.body;
    if (!state.pointerLocked) {
      state.firing = false;
      state.aiming = false;
      emit('lockLost');
    }
  });
  document.addEventListener('mousemove', (e) => {
    if (!state.pointerLocked) return;
    lookDX += e.movementX;
    lookDY += e.movementY;
  });
  document.addEventListener('mousedown', (e) => {
    if (!state.pointerLocked) return;
    if (e.button === 0) state.firing = true;
    if (e.button === 2) state.aiming = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.firing = false;
    if (e.button === 2) state.aiming = false;
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  function requestPointerLock() {
    if (isTouch) return;
    const target = canvas.requestPointerLock ? canvas : document.body;
    const p = target.requestPointerLock();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  // ---------- 触屏：虚拟摇杆（左半屏，动态原点） ----------
  const joystick = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };
  const JOY_RADIUS = 52;
  const joyZone = elements.joystickZone;
  const joyBase = elements.joystickBase;
  const joyKnob = elements.joystickKnob;

  function joyStart(t) {
    joystick.active = true;
    joystick.id = t.identifier;
    joystick.ox = t.clientX;
    joystick.oy = t.clientY;
    joystick.x = 0;
    joystick.y = 0;
    joyBase.style.display = 'block';
    joyBase.style.left = `${t.clientX - 60}px`;
    joyBase.style.top = `${t.clientY - 60}px`;
    joyKnob.style.transform = 'translate(-50%, -50%)';
  }
  function joyMove(t) {
    let dx = t.clientX - joystick.ox;
    let dy = t.clientY - joystick.oy;
    const len = Math.hypot(dx, dy);
    if (len > JOY_RADIUS) {
      dx = (dx / len) * JOY_RADIUS;
      dy = (dy / len) * JOY_RADIUS;
    }
    joystick.x = dx / JOY_RADIUS;
    joystick.y = -dy / JOY_RADIUS; // 上推 = 前进
    joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
  function joyEnd() {
    joystick.active = false;
    joystick.id = null;
    joystick.x = 0;
    joystick.y = 0;
    joyBase.style.display = 'none';
  }

  if (joyZone) {
    joyZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (!joystick.active) joyStart(t);
    }, { passive: false });
    joyZone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === joystick.id) joyMove(t);
      }
    }, { passive: false });
    const endHandler = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joystick.id) joyEnd();
      }
    };
    joyZone.addEventListener('touchend', endHandler);
    joyZone.addEventListener('touchcancel', endHandler);
  }

  // ---------- 触屏：滑动视角（右半屏） ----------
  const lookTouch = { id: null, lx: 0, ly: 0 };
  const lookZone = elements.lookZone;
  if (lookZone) {
    lookZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (lookTouch.id === null) {
        lookTouch.id = t.identifier;
        lookTouch.lx = t.clientX;
        lookTouch.ly = t.clientY;
      }
    }, { passive: false });
    lookZone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === lookTouch.id) {
          // 触屏灵敏度：基准系数 2.2 × 设置倍率（桌面鼠标不受影响）
          const sens = 2.2 * (settings ? settings.state.touchSensitivity : 1);
          lookDX += (t.clientX - lookTouch.lx) * sens;
          lookDY += (t.clientY - lookTouch.ly) * sens;
          lookTouch.lx = t.clientX;
          lookTouch.ly = t.clientY;
        }
      }
    }, { passive: false });
    const endHandler = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === lookTouch.id) lookTouch.id = null;
      }
    };
    lookZone.addEventListener('touchend', endHandler);
    lookZone.addEventListener('touchcancel', endHandler);
  }

  // ---------- 触屏/鼠标按钮 ----------
  function bindHold(el, down, up) {
    if (!el) return;
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (layoutEditing) return;
      el.classList.add('active');
      down();
    }, { passive: false });
    const release = (e) => {
      e.preventDefault();
      el.classList.remove('active');
      if (layoutEditing) return;
      up();
    };
    el.addEventListener('touchend', release);
    el.addEventListener('touchcancel', release);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (layoutEditing) return;
      el.classList.add('active');
      down();
    });
    el.addEventListener('mouseup', () => {
      el.classList.remove('active');
      up();
    });
    el.addEventListener('mouseleave', () => {
      if (el.classList.contains('active')) {
        el.classList.remove('active');
        up();
      }
    });
  }
  function bindTap(el, fn) {
    if (!el) return;
    // 防重复触发：部分浏览器在 preventDefault 后的 touchstart 之外仍会补发一
    // 次合成 click；若 click 紧跟 touchstart（<350ms），只算一次。
    // 纯鼠标点击没有 touchstart，照常触发，不受影响。
    let lastTouchFire = 0;
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (layoutEditing) return;
      lastTouchFire = performance.now();
      fn();
    }, { passive: false });
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (layoutEditing) return;
      if (performance.now() - lastTouchFire < 350) return; // 合成 click，touchstart 已处理
      fn();
      if (el.blur) el.blur(); // 防止空格键再次激活获得焦点的按钮
    });
  }

  // 开火：右下主开火键与左上角备用键共用同一对处理函数（同一状态，不复制逻辑）。
  // 两键同时按住时，松开任意一个即停火——不会卡住持续开火。
  const fireDown = () => { state.firing = true; };
  const fireUp = () => { state.firing = false; };
  bindHold(elements.btnFire, fireDown, fireUp);
  bindHold(elements.btnFireAlt, fireDown, fireUp);

  // 瞄准键：切换模式（点按切换）或按住模式（按住才机瞄），由设置决定。
  // 触屏走 touchstart/touchend（touchstart 的 preventDefault 会抑制随后的合成 click）；
  // 鼠标在切换模式走 click，在按住模式走 mousedown/mouseup。
  const aimEl = elements.btnAim;
  if (aimEl) {
    const holdMode = () => settings && settings.state.adsMode === 'hold';
    aimEl.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (layoutEditing) return;
      aimEl.classList.add('active');
      if (holdMode()) setAimActive(true);
      else {
        setAimActive(!state.aiming);
        emit('aimToggle', state.aiming);
      }
    }, { passive: false });
    const aimRelease = (e) => {
      e.preventDefault();
      aimEl.classList.remove('active');
      if (holdMode()) setAimActive(false);
    };
    aimEl.addEventListener('touchend', aimRelease);
    aimEl.addEventListener('touchcancel', aimRelease);
    aimEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (layoutEditing) return;
      aimEl.classList.add('active');
      if (holdMode()) setAimActive(true);
    });
    aimEl.addEventListener('mouseup', () => {
      aimEl.classList.remove('active');
      if (holdMode()) setAimActive(false);
    });
    aimEl.addEventListener('mouseleave', () => {
      if (aimEl.classList.contains('active')) {
        aimEl.classList.remove('active');
        if (holdMode()) setAimActive(false);
      }
    });
    aimEl.addEventListener('click', (e) => {
      e.preventDefault();
      if (layoutEditing) return;
      if (!holdMode()) {
        setAimActive(!state.aiming);
        emit('aimToggle', state.aiming);
      }
      if (aimEl.blur) aimEl.blur();
    });
  }
  bindTap(elements.btnReload, () => emit('reload'));
  bindTap(elements.btnMode, () => emit('toggleMode'));
  bindTap(elements.btnReset, () => emit('reset'));
  bindTap(elements.btnJump, () => emit('jump'));

  // 包扎键：触屏/鼠标点按开关式。点按后发 'bandageToggle' 事件带上新状态，
  // 主循环据此给无失血时的空按一次反馈（不能让按钮悄悄没反应）。
  // 键盘包扎键仍为按住式（见 update 里的 keys.has(k.bandage)）。
  bindTap(elements.btnBandage, () => {
    setBandageToggle(!touchBandageToggle);
    emit('bandageToggle', touchBandageToggle);
  });

  function setAimActive(active) {
    state.aiming = active;
    if (elements.btnAim) elements.btnAim.classList.toggle('toggled', active);
  }

  // ---------- 每帧更新 ----------
  function update() {
    if (suspended || layoutEditing) {
      state.moveX = 0;
      state.moveY = 0;
      state.sprint = false;
      state.bandaging = false;
      return;
    }
    const k = boundKeys();
    let x = 0;
    let y = 0;
    if (keys.has(k.forward) || (arrowFree('ArrowUp') && keys.has('ArrowUp'))) y += 1;
    if (keys.has(k.back) || (arrowFree('ArrowDown') && keys.has('ArrowDown'))) y -= 1;
    if (keys.has(k.left) || (arrowFree('ArrowLeft') && keys.has('ArrowLeft'))) x -= 1;
    if (keys.has(k.right) || (arrowFree('ArrowRight') && keys.has('ArrowRight'))) x += 1;
    if (joystick.active) {
      x = joystick.x;
      y = joystick.y;
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    state.moveX = x;
    state.moveY = y;
    // 疾跑默认左 Shift：左右 Shift 都认；一旦重绑到其它键，就只认绑定的键。
    state.sprint = keys.has(k.sprint) ||
      ((k.sprint === 'ShiftLeft' || k.sprint === 'ShiftRight') &&
        (keys.has('ShiftLeft') || keys.has('ShiftRight')));
    // 包扎：键盘绑定键按住，或触屏包扎键开关已打开。
    state.bandaging = keys.has(k.bandage) || touchBandageToggle;
  }

  function consumeLook() {
    if (suspended) {
      lookDX = 0;
      lookDY = 0;
      return { dx: 0, dy: 0 };
    }
    const out = { dx: lookDX, dy: lookDY };
    lookDX = 0;
    lookDY = 0;
    return out;
  }

  function setSuspended(v) {
    suspended = v;
    if (v) {
      keys.clear();
      setBandageToggle(false);
      state.firing = false;
      state.bandaging = false;
      setAimActive(false);
    }
  }

  function setLayoutEditing(v) {
    layoutEditing = v;
    if (v) {
      state.firing = false;
      setBandageToggle(false); // 布局编辑不该让读条在身后自己续上
    }
  }

  return {
    state,
    isTouch,
    on,
    update,
    consumeLook,
    requestPointerLock,
    setAimActive,
    setSuspended,
    setLayoutEditing,
    clearBandageLatch: () => setBandageToggle(false),
  };
}
