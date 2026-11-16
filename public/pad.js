// pad.js — the controller: touch, mouse and keyboard become the 1-byte input register.
//
//   bit 0-2 stick direction | bit 3 stick active | bit 4 A | bit 5 B | bit 6-7 action button
//
// The page handles every touch itself. All browser defaults are cancelled (no zoom, no
// scroll, no long-press menu, no made-up click), so nothing here depends on how a browser
// guesses what a tap means. The one exception is the text field for the room name.

const DIRS = { '0,-1': 0, '1,-1': 1, '1,0': 2, '1,1': 3, '0,1': 4, '-1,1': 5, '-1,0': 6, '-1,-1': 7 };
const KNOB = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const STICK_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
const A_KEYS = ['KeyZ', 'KeyJ', 'KeyL', 'Enter', 'Space'], B_KEYS = ['KeyX', 'KeyK', 'Backspace'];

// onByte(byte): the register changed.  onHome(): button 1.  onTouch(element): a tap or click landed.
export function createPad({ onByte, onHome, onTouch }) {
  const stick = document.getElementById('stick'), knob = document.getElementById('knob');
  const keys = new Set();                    // held stick keys
  const fingers = new Map();                 // pointer id -> button name, or null while between buttons
  let keyA = false, keyB = false;
  const keyActs = new Set();
  let touchDir = -1, knobAt = null, stickId = null, byte = 0;

  const inField = (e) => e.target instanceof Element && e.target.closest('input') !== null;

  // ---- no browser gestures, anywhere
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    document.addEventListener(type, (e) => { if (!inField(e) && e.cancelable) e.preventDefault(); }, { passive: false });
  }
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu', 'dragstart']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener('selectstart', (e) => { if (!inField(e)) e.preventDefault(); });

  function update() {
    const dx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0), dy = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
    const dir = (dx || dy) ? DIRS[dx + ',' + dy] : touchDir;
    const on = new Set(fingers.values());
    const a = keyA || on.has('a'), b = keyB || on.has('b');
    let action = 0;                                        // one action button at a time: the lowest held
    for (let n = 3; n >= 1; n--) if (keyActs.has(n) || on.has('act' + n)) action = n;
    const next = (dir >= 0 ? 8 | dir : 0) | (a ? 0x10 : 0) | (b ? 0x20 : 0) | (action << 6);

    knob.style.transform = knobAt ? `translate(${knobAt[0]}px, ${knobAt[1]}px)` : dir >= 0 ? `translate(${KNOB[dir][0] * 55}%, ${KNOB[dir][1] * 55}%)` : '';
    for (const el of document.querySelectorAll('[data-btn]')) {
      const n = el.dataset.btn;
      el.classList.toggle('down', n === 'a' ? a : n === 'b' ? b : n.startsWith('act') && action === Number(n[3]));
    }
    if (next !== byte) { const prev = byte; byte = next; onByte(byte, prev); }
  }

  // ---- buttons: a finger that starts on a button is followed until it lifts, so it can
  // roll from B to A, also across the gap between them
  function finger(e) {
    const followed = fingers.has(e.pointerId);
    if (!followed && e.type !== 'pointerdown') return;      // a mouse just passing over, or a finger that began elsewhere
    const el = document.elementFromPoint(e.clientX, e.clientY);
    let name = el?.closest('[data-btn]')?.dataset.btn ?? null;
    if (!followed) {
      if (!inField(e)) document.activeElement?.blur?.();    // a tap outside the room field closes the keyboard
      if (name === 'home') return onHome();                 // HOME answers a fresh tap only, never a slide
      if (!name) { if (el) onTouch(el); return; }
    }
    if (name === 'home') name = null;
    if (followed && fingers.get(e.pointerId) === name) return;
    fingers.set(e.pointerId, name);
    update();
  }
  document.addEventListener('pointerdown', finger);
  document.addEventListener('pointermove', finger);
  const lift = (e) => { if (fingers.delete(e.pointerId)) update(); };
  document.addEventListener('pointerup', lift);
  document.addEventListener('pointercancel', lift);

  // ---- stick: 8 directions and rest. The knob follows the finger, the direction snaps,
  // and a direction once taken is kept until the finger is clearly in the next one.
  function aim(e) {
    const r = stick.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy), max = r.width * 0.3;
    if (dist < r.width * 0.11) touchDir = -1;
    else {
      const turn = Math.atan2(dx, -dy) / (Math.PI / 4);     // 0 = up, 2 = right, in eighths of a circle
      const off = touchDir < 0 ? 1 : Math.abs(((turn - touchDir + 12) % 8) - 4);
      if (off > 0.62) touchDir = (Math.round(turn) + 8) % 8;
    }
    const k = dist > max ? max / dist : 1;
    knobAt = [dx * k, dy * k];
    update();
  }
  stick.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    document.activeElement?.blur?.();
    stickId = e.pointerId;
    try { stick.setPointerCapture(e.pointerId); } catch {}
    aim(e);
  });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) aim(e); });
  const rest = (e) => { if (e.pointerId !== stickId) return; stickId = null; touchDir = -1; knobAt = null; update(); };
  stick.addEventListener('pointerup', rest);
  stick.addEventListener('pointercancel', rest);

  // ---- keyboard
  addEventListener('keydown', (e) => {
    if (inField(e)) { if (e.code === 'Enter' || e.code === 'Escape') e.target.blur(); return; }
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const c = e.code;
    if (STICK_KEYS[c]) keys.add(STICK_KEYS[c]);
    else if (A_KEYS.includes(c)) keyA = true;
    else if (B_KEYS.includes(c)) keyB = true;
    else if (c === 'Digit2' || c === 'Digit3' || c === 'Digit4') keyActs.add(Number(c[5]) - 1);
    else if (c === 'Digit1' || c === 'Escape') { e.preventDefault(); return onHome(); }
    else return;
    e.preventDefault();
    update();
  });
  addEventListener('keyup', (e) => {
    const c = e.code;
    if (STICK_KEYS[c]) keys.delete(STICK_KEYS[c]);
    else if (A_KEYS.includes(c)) keyA = false;
    else if (B_KEYS.includes(c)) keyB = false;
    else if (c === 'Digit2' || c === 'Digit3' || c === 'Digit4') keyActs.delete(Number(c[5]) - 1);
    else return;
    update();
  });
  addEventListener('blur', () => {                           // the window lost the keys: nothing stays held
    keys.clear(); keyActs.clear(); fingers.clear(); keyA = keyB = false; touchDir = -1; knobAt = null; stickId = null;
    update();
  });

  return { get byte() { return byte; } };
}
