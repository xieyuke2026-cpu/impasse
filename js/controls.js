// 输入控制：桌面端（Pointer Lock + 键鼠）与触屏端（虚拟摇杆 + 滑动视角 + 按钮）
// 触屏是第一公民：iPad 上只用触摸就能完成全部操作。

export function createControls({ canvas, elements }) {
  const isTouch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0);

  const state = {
    moveX: 0, // -1..1，右为正
    moveY: 0, // -1..1，前为正
    firing: false,
    aiming: false,
    sprint: false,
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

  // ---------- 键盘 ----------
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'KeyR') emit('reload');
    if (e.code === 'KeyV') emit('toggleMode');
    if (e.code === 'KeyT') emit('reset');
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => {
    keys.clear();
    state.firing = false;
    state.aiming = false;
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
          lookDX += (t.clientX - lookTouch.lx) * 2.2;
          lookDY += (t.clientY - lookTouch.ly) * 2.2;
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
      el.classList.add('active');
      down();
    }, { passive: false });
    const release = (e) => {
      e.preventDefault();
      el.classList.remove('active');
      up();
    };
    el.addEventListener('touchend', release);
    el.addEventListener('touchcancel', release);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
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
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }, { passive: false });
    el.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
  }

  bindHold(elements.btnFire,
    () => { state.firing = true; },
    () => { state.firing = false; });
  bindTap(elements.btnAim, () => {
    state.aiming = !state.aiming;
    elements.btnAim.classList.toggle('toggled', state.aiming);
    emit('aimToggle', state.aiming);
  });
  bindTap(elements.btnReload, () => emit('reload'));
  bindTap(elements.btnMode, () => emit('toggleMode'));
  bindTap(elements.btnReset, () => emit('reset'));

  function setAimActive(active) {
    state.aiming = active;
    if (elements.btnAim) elements.btnAim.classList.toggle('toggled', active);
  }

  // ---------- 每帧更新 ----------
  function update() {
    let x = 0;
    let y = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
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
    state.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  }

  function consumeLook() {
    const out = { dx: lookDX, dy: lookDY };
    lookDX = 0;
    lookDY = 0;
    return out;
  }

  return {
    state,
    isTouch,
    on,
    update,
    consumeLook,
    requestPointerLock,
    setAimActive,
  };
}
