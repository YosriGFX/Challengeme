// Which keyboard keys and gamepad inputs press which Game Boy button, and the Controls
// panel that changes them. Each button has two keyboard slots and two gamepad slots. The
// choice is kept in this browser only; the server just receives the button byte.
//
// Keys are KeyboardEvent.code values (the key's position, so any layout works; Bluetooth
// controllers in keyboard mode send these too). Gamepad inputs are "b<n>" for button n
// and "a<n>-" / "a<n>+" for axis n pushed past halfway, in the Gamepad API's "standard"
// layout, where the face buttons are 0 bottom, 1 right, 2 left, 3 top.

export const BUTTONS = { right: 1, left: 2, up: 4, down: 8, a: 16, b: 32, select: 64, start: 128 };
const ORDER = ["up", "down", "left", "right", "a", "b", "select", "start"];
const NAMES = { up: "Up", down: "Down", left: "Left", right: "Right", a: "A", b: "B", select: "SELECT", start: "START" };

export const DEFAULTS = Object.freeze({
  keys: { up: ["ArrowUp", "KeyW"], down: ["ArrowDown", "KeyS"], left: ["ArrowLeft", "KeyA"], right: ["ArrowRight", "KeyD"],
          a: ["KeyX", "KeyK"], b: ["KeyZ", "KeyJ"], select: ["ShiftRight", "Backspace"], start: ["Enter", "Space"] },
  pad: { up: ["b12", "a1-"], down: ["b13", "a1+"], left: ["b14", "a0-"], right: ["b15", "a0+"],
         a: ["b1", "b3"], b: ["b0", "b2"], select: ["b8", ""], start: ["b9", ""] },
});
const STORE = "bindings";

const copy = (b) => ({ keys: Object.fromEntries(ORDER.map((k) => [k, [...b.keys[k]]])),
                       pad: Object.fromEntries(ORDER.map((k) => [k, [...b.pad[k]]])) });

export function loadBindings() {
  const b = copy(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    for (const kind of ["keys", "pad"]) {
      for (const k of ORDER) {
        const slots = saved?.[kind]?.[k];
        if (Array.isArray(slots) && slots.length === 2 && slots.every((v) => typeof v === "string" && v.length < 32)) b[kind][k] = slots;
      }
    }
  } catch { /* defaults */ }
  return b;
}
function saveBindings(b) {
  try { localStorage.setItem(STORE, JSON.stringify(b)); } catch { /* not kept */ }
}

// code -> button bits, for the keydown / keyup handlers.
export function keyMap(b) {
  const map = new Map();
  for (const k of ORDER) for (const code of b.keys[k]) if (code) map.set(code, (map.get(code) ?? 0) | BUTTONS[k]);
  return map;
}

function padInputs(g) {
  const on = new Set();
  g.buttons.forEach((btn, i) => { if (btn?.pressed) on.add(`b${i}`); });
  g.axes.forEach((v, i) => { if (v > 0.5) on.add(`a${i}+`); else if (v < -0.5) on.add(`a${i}-`); });
  return on;
}

// The Game Boy buttons held on the connected gamepads.
export function readPads(pads, b) {
  let bits = 0;
  for (const g of pads) {
    const on = padInputs(g);
    for (const k of ORDER) if (b.pad[k].some((v) => v && on.has(v))) bits |= BUTTONS[k];
  }
  return bits;
}

const KEY_LABELS = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space",
                     ShiftLeft: "L Shift", ShiftRight: "R Shift", ControlLeft: "L Ctrl", ControlRight: "R Ctrl",
                     AltLeft: "L Alt", AltRight: "R Alt", NumpadEnter: "Num Enter" };
function keyLabel(code) {
  if (!code) return "–";
  return KEY_LABELS[code] ?? code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
}
const PAD_LABELS = ["Bottom", "Right", "Left", "Top", "LB", "RB", "LT", "RT", "Back", "Start", "L stick", "R stick",
                    "D-pad ↑", "D-pad ↓", "D-pad ←", "D-pad →", "Home"];
function padLabel(v) {
  if (!v) return "–";
  const m = /^a(\d+)([+-])$/.exec(v);
  if (m) {
    const stick = m[1] < 2 ? "L stick" : m[1] < 4 ? "R stick" : `Axis ${m[1]}`;
    const dir = Number(m[1]) % 2 ? (m[2] === "-" ? "↑" : "↓") : (m[2] === "-" ? "←" : "→");
    return `${stick} ${dir}`;
  }
  return PAD_LABELS[Number(v.slice(1))] ?? `Button ${v.slice(1)}`;
}

// The Controls panel. `dialog` is an empty <dialog>; `changed(b)` gets the new bindings.
export function controlsPanel(dialog, bindings, changed) {
  let listen = null, frame = 0;                       // { kind, button, slot, el, before }

  function render() {
    dialog.innerHTML = `<form method="dialog"><h2>Controls</h2>
      <p>Tap a slot, then press the key or the controller button for it. Esc empties the slot.</p>
      <table><thead><tr><th></th><th colspan="2">Keyboard</th><th colspan="2">Controller</th></tr></thead><tbody></tbody></table>
      <div class="row"><button type="button" value="reset">Reset</button><button value="close">Done</button></div></form>`;
    const body = dialog.querySelector("tbody");
    for (const k of ORDER) {
      const tr = document.createElement("tr");
      tr.append(Object.assign(document.createElement("th"), { textContent: NAMES[k] }));
      for (const kind of ["keys", "pad"]) {
        for (const slot of [0, 1]) {
          const td = document.createElement("td");
          const btn = Object.assign(document.createElement("button"), { type: "button", className: "slot" });
          btn.textContent = (kind === "keys" ? keyLabel : padLabel)(bindings[kind][k][slot]);
          btn.addEventListener("click", () => start(kind, k, slot, btn));
          td.append(btn);
          tr.append(td);
        }
      }
      body.append(tr);
    }
    dialog.querySelector("[value=reset]").addEventListener("click", () => set(copy(DEFAULTS)));
  }

  function set(b) {
    bindings = b;
    saveBindings(b);
    changed(b);
    stop();
    render();
  }

  // Put `value` in one slot, and take it out of any other slot so one input is one button.
  function assign(value) {
    const { kind, button, slot } = listen, b = copy(bindings);
    if (value) for (const k of ORDER) b[kind][k] = b[kind][k].map((v) => (v === value ? "" : v));
    b[kind][button][slot] = value;
    set(b);
  }

  function start(kind, button, slot, el) {
    stop();
    for (const old of dialog.querySelectorAll(".slot.listen")) old.classList.remove("listen");
    el.classList.add("listen");
    el.textContent = kind === "keys" ? "press a key" : "press a button";
    listen = { kind, button, slot };
    if (kind === "pad") {
      // Only an input that was not already held when listening began counts.
      const held = new Set(pads().flatMap((g) => [...padInputs(g)]));
      const poll = () => {
        for (const v of new Set(pads().flatMap((g) => [...padInputs(g)]))) {
          if (!held.has(v)) { assign(v); return; }
        }
        for (const v of [...held]) if (!pads().some((g) => padInputs(g).has(v))) held.delete(v);
        frame = requestAnimationFrame(poll);
      };
      frame = requestAnimationFrame(poll);
    }
  }
  function stop() {
    cancelAnimationFrame(frame);
    listen = null;
  }

  dialog.addEventListener("keydown", (e) => {
    if (!listen) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape") assign("");
    else if (listen.kind === "keys") assign(e.code);
  });
  dialog.addEventListener("close", () => { stop(); render(); });
  render();
  return { open() { render(); dialog.showModal(); } };
}

export function pads() {
  return [...(navigator.getGamepads?.() ?? [])].filter((g) => g?.connected);
}
