'use strict';
// ADVGUI editor: edits game/<name>.json (items, rooms, doors, interactions, PETSCII graphics).
// The format is documented in tools/pack.py and README.md.

const PAL = ['#000000', '#ffffff', '#813338', '#75cec8', '#8e3c97', '#56ac4d', '#2e2c9b', '#edf171',
  '#8e5029', '#553800', '#c46c71', '#4a4a4a', '#7b7b7b', '#a9ff9f', '#706deb', '#b2b2b2'];   // Colodore
const PAL_NAMES = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'brown',
  'light red', 'dark grey', 'grey', 'light green', 'light blue', 'light grey'];
const PF_W = 25, PF_H = 14;
const MSG_W = 38;   // characters per description line on the C64

const TRIGGERS = {
  combine: { label: 'Combine: item A dropped on item B (inventory or floor, both ways round)', a: 'item', b: 'item' },
  use: { label: 'Use: item A (inventory or floor) dropped on room object B', a: 'item', b: 'item' },
  use_player: { label: 'Use on the hero: item A dropped on the portrait / HP / MP', a: 'item' },
  click: { label: 'Click on room object B (doors: replaces going through)', b: 'item' },
  look: { label: 'Right click (look at) object or item B', b: 'item' },
  attack: { label: 'ATTACK button, B = the enemy in the room', b: 'item' },
  defeat: { label: 'Enemy B drops to 0 HP', b: 'item' },
  search: { label: 'SEARCH button in room A', a: 'room' },
  enter: { label: 'Entering room A (also at the start)', a: 'room' },
  take: { label: 'Item A was taken into the inventory', a: 'item' },
};
const CONDS = { flag: 'flag', not_flag: 'flag', has: 'item', not_has: 'item', lit: null, not_lit: null, in_room: 'room' };
const COND_LABELS = { flag: 'flag is set', not_flag: 'flag is not set', has: 'hero has item', not_has: 'hero does not have item',
  lit: 'hero carries a light', not_lit: 'hero has no light', in_room: 'current room is' };
const ACTIONS = {
  msg: ['text'], set_flag: ['flag'], clear_flag: ['flag'], remove_a: [], remove_target: [],
  replace_target: ['item'], replace_a: ['item'], give: ['item'], spawn: ['item', 'x', 'y'], reveal: ['item_any'],
  hp: ['n'], hurt: ['n', 'text'], damage: ['n'], mp: ['n'], goto: ['room'], end: ['text'],
  swap: ['item', 'to'],
};
const ACTION_LABELS = {
  msg: 'show message', set_flag: 'set flag', clear_flag: 'clear flag', remove_a: 'remove item A (the dragged one)',
  remove_target: 'remove target B', replace_target: 'turn target B into', replace_a: 'turn item A into',
  give: 'give hero item', spawn: 'put item in this room at', reveal: 'reveal hidden objects (item or any)',
  hp: 'change HP by', hurt: 'enemy hits hero for 1..n (with message)', damage: 'damage target B by (0 = hero\'s best weapon)',
  mp: 'change MP by', goto: 'go to room', end: 'end the game with message',
  swap: 'in this room, turn every',
};

// ------------------------------------------------------------------ state
let G = null, gameName = 'demo', dirty = false;
const history = [];
let charset = null, sheets = [];
const brush = { ch: 0xA0, co: 1, tool: 'draw' };
const sel = { item: 0, room: 0, rule: 0, obj: -1, bgLit: false, objMode: false };

const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
function status(msg, cls = '') { const s = $('#status'); s.textContent = msg; s.className = cls; }
function snapshot() { history.push(JSON.stringify(G)); if (history.length > 80) history.shift(); dirty = true; status('unsaved changes'); }
function undo() { if (!history.length) return; G = JSON.parse(history.pop()); dirty = true; renderAll(); status('undone'); }

// ------------------------------------------------------------------ charset rendering
async function loadCharset() {
  const buf = await (await fetch('/api/chargen')).arrayBuffer();
  charset = new Uint8Array(buf, 0, 2048);     // upper case / graphics set
  sheets = PAL.map(col => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d'), img = x.createImageData(128, 128);
    const r = parseInt(col.slice(1, 3), 16), g = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16);
    for (let ch = 0; ch < 256; ch++)
      for (let row = 0; row < 8; row++) {
        const bits = charset[ch * 8 + row];
        for (let bit = 0; bit < 8; bit++)
          if (bits & (128 >> bit)) {
            const px = ((ch >> 4) * 8 + row) * 128 + (ch & 15) * 8 + bit;
            img.data.set([r, g, b, 255], px * 4);
          }
      }
    x.putImageData(img, 0, 0);
    return c;
  });
}
function drawCell(ctx, x, y, code, color, z) {
  ctx.fillStyle = '#000'; ctx.fillRect(x, y, 8 * z, 8 * z);
  ctx.drawImage(sheets[color & 15], (code & 15) * 8, (code >> 4) * 8, 8, 8, x, y, 8 * z, 8 * z);
}
function drawGfx(ctx, g, frame, x0, y0, z) {
  const f = g.frames[Math.min(frame, g.frames.length - 1)];
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++)
    drawCell(ctx, x0 + i * 8 * z, y0 + j * 8 * z, f.ch[j * g.w + i], f.co[j * g.w + i], z);
}
// mouse position in canvas pixels (the element may be drawn larger or smaller than its pixel size)
function canvasXY(c, e) {
  const r = c.getBoundingClientRect();
  return [(e.clientX - r.left - c.clientLeft) * c.width / c.clientWidth,
          (e.clientY - r.top - c.clientTop) * c.height / c.clientHeight];
}
function ascii2sc(c) {
  const k = c.toUpperCase().charCodeAt(0);
  if (k >= 64 && k < 96) return k - 64;
  if (k >= 32 && k < 64) return k;
  return null;
}

// ------------------------------------------------------------------ PETSCII editor
// model: {w, h, delay, frames:[{ch, co}]}; opts: {maxW, maxH, fixed, zoom, frames, overlay, mouseHook, onChange}
class PetsciiEditor {
  constructor(model, opts) {
    this.m = model; this.o = opts; this.frame = 0; this.cursor = null; this.playing = null;
    this.z = opts.zoom || 3;
    this.el = h('div', { class: 'pe' });
    this.canvas = h('canvas', { tabindex: 0 });
    this.info = h('div', { class: 'cur' });
    this.palette = h('canvas', { width: 256, height: 256, title: 'click to pick a character (128-255 are reversed)' });
    this.colors = h('div', { class: 'colors' });
    this.framesEl = h('div', { class: 'frames' });
    this.build();
  }
  get f() { return this.m.frames[this.frame]; }
  build() {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('mousedown', e => this.mouse(e, 'down'));
    c.addEventListener('mousemove', e => this.mouse(e, 'move'));
    c.addEventListener('keydown', e => this.key(e));
    this.palette.addEventListener('mousedown', e => {
      const [x, y] = canvasXY(this.palette, e);
      brush.ch = (Math.floor(y / 16) << 4) | Math.floor(x / 16);
      if (brush.tool === 'pick' || brush.tool === 'text') this.setTool('draw');
      refreshEditors();
    });
    PAL.forEach((col, i) => this.colors.append(h('div', {
      style: `background:${col}`, title: `${i} ${PAL_NAMES[i]}`,
      onclick: () => { brush.co = i; refreshEditors(); }
    })));
    const tools = h('div', { class: 'inline' }, ...[['draw', 'Draw'], ['paint', 'Colour only'], ['pick', 'Pick'], ['text', 'Type text']]
      .map(([t, l]) => h('button', { 'data-tool': t, onclick: () => this.setTool(t) }, l)),
      h('button', { onclick: () => this.clear() }, 'Clear'));
    this.toolsEl = tools;
    const side = h('div', { class: 'side' }, tools, this.palette, this.colors, this.info,
      h('div', { class: 'hint' }, 'Left: draw · Right: erase · Text: click, then type'));
    const main = h('div', { class: 'main' }, this.canvas);
    if (!this.o.fixed) {
      const wIn = h('input', { type: 'number', min: 1, max: this.o.maxW, value: this.m.w });
      const hIn = h('input', { type: 'number', min: 1, max: this.o.maxH, value: this.m.h });
      const apply = () => this.resize(+wIn.value, +hIn.value);
      wIn.onchange = apply; hIn.onchange = apply;
      main.append(h('div', { class: 'inline' }, 'Size', wIn, '×', hIn, h('span', { class: 'hint' }, `max ${this.o.maxW}×${this.o.maxH}`)));
    }
    if (this.o.frames !== false) main.append(this.framesEl);
    this.el.append(main, side);
    this.render();
  }
  setTool(t) { brush.tool = t; this.cursor = null; refreshEditors(); if (t === 'text') this.canvas.focus(); }
  cell(e) {
    const s = 8 * this.z, [px, py] = canvasXY(this.canvas, e);
    const x = Math.floor(px / s), y = Math.floor(py / s);
    return x >= 0 && y >= 0 && x < this.m.w && y < this.m.h ? [x, y] : null;
  }
  mouse(e, type) {
    const p = this.cell(e);
    if (this.o.mouseHook && this.o.mouseHook(type, p, e)) return;
    if (!p) return;
    if (type === 'down') { snapshot(); this.drag = true; this.canvas.focus(); }
    else if (!this.drag) { this.info.textContent = `${p[0]},${p[1]}`; return; }
    const [x, y] = p, i = y * this.m.w + x, f = this.f;
    const erase = e.buttons & 2;
    if (brush.tool === 'pick') { brush.ch = f.ch[i]; brush.co = f.co[i]; this.setTool('draw'); return; }
    if (brush.tool === 'text') { this.cursor = [x, y]; this.drag = false; this.render(); return; }
    if (brush.tool === 'paint') f.co[i] = erase ? 1 : brush.co;
    else { f.ch[i] = erase ? 32 : brush.ch; if (!erase) f.co[i] = brush.co; }
    this.changed();
  }
  key(e) {
    if (brush.tool !== 'text' || !this.cursor) return;
    let [x, y] = this.cursor;
    if (e.key === 'ArrowLeft') x = Math.max(0, x - 1);
    else if (e.key === 'ArrowRight') x = Math.min(this.m.w - 1, x + 1);
    else if (e.key === 'ArrowUp') y = Math.max(0, y - 1);
    else if (e.key === 'ArrowDown' || e.key === 'Enter') y = Math.min(this.m.h - 1, y + 1);
    else if (e.key === 'Backspace') { x = Math.max(0, x - 1); snapshot(); this.f.ch[y * this.m.w + x] = 32; this.changed(); }
    else if (e.key.length === 1) {
      const sc = ascii2sc(e.key);
      if (sc == null) return;
      snapshot();
      const i = y * this.m.w + x;
      this.f.ch[i] = sc; this.f.co[i] = brush.co;
      x = Math.min(this.m.w - 1, x + 1);
      this.changed();
    } else return;
    e.preventDefault();
    this.cursor = [x, y]; this.render();
  }
  clear() {
    snapshot();
    this.f.ch.fill(32); this.f.co.fill(brush.co);
    this.changed();
  }
  resize(w, hh) {
    w = Math.max(1, Math.min(this.o.maxW, w)); hh = Math.max(1, Math.min(this.o.maxH, hh));
    snapshot();
    for (const f of this.m.frames) {
      const ch = Array(w * hh).fill(32), co = Array(w * hh).fill(brush.co);
      for (let j = 0; j < Math.min(hh, this.m.h); j++) for (let i = 0; i < Math.min(w, this.m.w); i++) {
        ch[j * w + i] = f.ch[j * this.m.w + i]; co[j * w + i] = f.co[j * this.m.w + i];
      }
      f.ch = ch; f.co = co;
    }
    this.m.w = w; this.m.h = hh;
    this.changed();
  }
  changed() { this.render(); if (this.o.onChange) this.o.onChange(); }
  // the picture only (playback calls this, so the buttons stay clickable)
  drawMain() {
    const m = this.m, z = this.z, c = this.canvas;
    if (c.width !== m.w * 8 * z || c.height !== m.h * 8 * z) { c.width = m.w * 8 * z; c.height = m.h * 8 * z; }
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
    drawGfx(ctx, m, this.frame, 0, 0, z);
    if (this.o.overlay) this.o.overlay(ctx, z);
    if (this.cursor && brush.tool === 'text') {
      ctx.strokeStyle = '#fff'; ctx.strokeRect(this.cursor[0] * 8 * z + .5, this.cursor[1] * 8 * z + .5, 8 * z - 1, 8 * z - 1);
    }
  }
  render() {
    this.drawMain();
    // palette in the brush colour
    const p = this.palette.getContext('2d'); p.imageSmoothingEnabled = false;
    p.fillStyle = '#000'; p.fillRect(0, 0, 256, 256);
    p.drawImage(sheets[brush.co === 0 ? 15 : brush.co], 0, 0, 128, 128, 0, 0, 256, 256);
    p.strokeStyle = '#fff'; p.strokeRect((brush.ch & 15) * 16 + .5, (brush.ch >> 4) * 16 + .5, 15, 15);
    [...this.colors.children].forEach((d, i) => d.classList.toggle('sel', i === brush.co));
    [...this.toolsEl.querySelectorAll('[data-tool]')].forEach(b => b.classList.toggle('on', b.dataset.tool === brush.tool));
    this.info.textContent = `char $${brush.ch.toString(16).padStart(2, '0')} (${brush.ch}), colour ${brush.co} ${PAL_NAMES[brush.co]}`;
    if (this.o.frames !== false) this.renderFrames();
  }
  renderFrames() {
    const fe = this.framesEl; fe.innerHTML = '';
    fe.append('Frames');
    this.m.frames.forEach((f, k) => {
      const t = h('canvas', { width: this.m.w * 8 * 2, height: this.m.h * 8 * 2, class: k === this.frame ? 'sel' : '', title: `frame ${k + 1}` });
      const ctx = t.getContext('2d'); ctx.imageSmoothingEnabled = false;
      drawGfx(ctx, this.m, k, 0, 0, 2);
      t.onclick = () => { this.stop(); this.frame = k; this.render(); };
      fe.append(t);
    });
    const delay = h('input', { type: 'number', min: 1, max: 255, value: this.m.delay || 30, title: 'jiffies (1/60 s) per frame' });
    delay.onchange = () => { snapshot(); this.m.delay = +delay.value; };
    fe.append(
      h('button', { onclick: () => { snapshot(); const f = this.f; this.m.frames.splice(this.frame + 1, 0, { ch: [...f.ch], co: [...f.co] }); this.frame++; this.changed(); } }, 'Duplicate'),
      h('button', { onclick: () => { if (this.m.frames.length < 2) return; snapshot(); this.m.frames.splice(this.frame, 1); this.frame = Math.max(0, this.frame - 1); this.changed(); } }, 'Delete'),
      h('button', { onclick: () => this.move(-1) }, '◀'), h('button', { onclick: () => this.move(1) }, '▶'),
      'Delay', delay,
      h('button', { onclick: () => this.playing ? this.stop(true) : this.play() }, this.playing ? 'Stop' : 'Play'));
  }
  move(d) {
    const k = this.frame, j = k + d, fr = this.m.frames;
    if (j < 0 || j >= fr.length) return;
    snapshot(); [fr[k], fr[j]] = [fr[j], fr[k]]; this.frame = j; this.changed();
  }
  play() {
    this.playing = setInterval(() => {
      this.frame = (this.frame + 1) % this.m.frames.length;
      this.drawMain();
      [...this.framesEl.querySelectorAll('canvas')].forEach((t, k) => t.classList.toggle('sel', k === this.frame));
    }, (this.m.delay || 30) * 1000 / 60);
    this.render();
  }
  stop(redraw) {
    if (!this.playing) return;
    clearInterval(this.playing); this.playing = null;
    if (redraw) this.render();      // the button label goes back to Play
  }
}
let editors = [];
window.addEventListener('mouseup', () => editors.forEach(e => { e.drag = false; if (e.o.mouseHook) e.o.mouseHook('up'); }));
function refreshEditors() { editors.forEach(e => e.render()); }
function mountEditor(container, model, opts) {
  const e = new PetsciiEditor(model, opts);
  editors.push(e);
  container.append(e.el);
  return e;
}

// ------------------------------------------------------------------ form helpers
function field(obj, key, kind = 'text', opts = {}) {
  let el;
  if (kind === 'bool') {
    el = h('input', { type: 'checkbox' }); el.checked = !!obj[key];
    el.onchange = () => { snapshot(); obj[key] = el.checked; opts.onChange && opts.onChange(); };
    return el;
  }
  if (kind === 'textarea') el = h('textarea', { rows: 2 });
  else el = h('input', { type: kind === 'number' ? 'number' : 'text', ...(opts.attrs || {}) });
  el.value = obj[key] ?? '';
  const counter = opts.counter ? h('span', { class: 'count' }) : null;
  const count = () => {
    if (!counter) return;
    const pages = Math.ceil(wrapLines(el.value).length / 2);
    counter.textContent = `${el.value.length} chars · ${pages || 0} page${pages === 1 ? '' : 's'} (2 lines of ${MSG_W})`;
    counter.classList.toggle('over', pages > 1);
  };
  el.oninput = () => count();
  el.onchange = () => {
    snapshot();
    let v = el.value;
    if (kind === 'number') v = +v;
    if (opts.upper) { v = v.toUpperCase(); el.value = v; }
    obj[key] = v; count(); opts.onChange && opts.onChange(v);
  };
  count();
  return counter ? h('div', {}, el, counter) : el;
}
function wrapLines(s) {
  const words = (s || '').toUpperCase().split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w; else if (cur.length + 1 + w.length <= MSG_W) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
function select(options, value, onchange, allowEmpty) {
  const s = h('select', {});
  if (allowEmpty) s.append(h('option', { value: '' }, allowEmpty));
  for (const [v, l] of options) s.append(h('option', { value: v }, l));
  s.value = value ?? '';
  s.onchange = () => { snapshot(); onchange(s.value); };
  return s;
}
const itemOpts = () => G.items.map(it => [it.id, `${it.id} (${it.name})`]);
const roomOpts = () => G.rooms.map(r => [r.id, `${r.id} (${r.name})`]);
function allFlags() {
  const f = new Set();
  for (const r of G.rules) { for (const c of r.if || []) if (c.flag) f.add(c.flag); for (const a of r.do || []) if (a.flag) f.add(a.flag); }
  for (const r of G.rooms) for (const o of r.objects) if (o.door && o.door.flag) f.add(o.door.flag);
  return [...f].sort();
}
function flagInput(obj, key) {
  const id = 'flags-list';
  if (!document.getElementById(id)) document.body.append(h('datalist', { id }));
  const dl = document.getElementById(id); dl.innerHTML = '';
  allFlags().forEach(f => dl.append(h('option', { value: f })));
  const el = h('input', { type: 'text', list: id, placeholder: 'flag name', style: 'width:9em' });
  el.value = obj[key] || '';
  el.onchange = () => { snapshot(); obj[key] = el.value.trim(); };
  return el;
}
function listPanel(title, arr, selKey, label, onAdd, onDel, onDup) {
  const items = h('div', { class: 'items' });
  arr.forEach((x, i) => items.append(h('div', {
    class: 'row' + (i === sel[selKey] ? ' sel' : ''), onclick: () => { sel[selKey] = i; sel.obj = -1; renderAll(); }
  }, label(x, i))));
  return h('div', { class: 'list' }, h('h3', {}, title), items,
    h('div', { class: 'tools' },
      h('button', { onclick: () => { snapshot(); onAdd(); renderAll(); } }, 'Add'),
      onDup && h('button', { onclick: () => { if (!arr[sel[selKey]]) return; snapshot(); onDup(); renderAll(); } }, 'Duplicate'),
      h('button', { onclick: e => { if (!arr[sel[selKey]]) return; if (onDel(e.currentTarget)) renderAll(); } }, 'Delete'),
      h('button', { onclick: () => moveIn(arr, selKey, -1) }, '▲'), h('button', { onclick: () => moveIn(arr, selKey, 1) }, '▼')));
}
function moveIn(arr, key, d) {
  const i = sel[key], j = i + d;
  if (j < 0 || j >= arr.length) return;
  snapshot(); [arr[i], arr[j]] = [arr[j], arr[i]]; sel[key] = j; renderAll();
}
// returns true on the second click within 3 s; the first click changes the label to ask
function armed(btn, ask) {
  if (btn.dataset.armed) return true;
  const label = btn.textContent;
  btn.dataset.armed = '1'; btn.textContent = ask; btn.classList.add('on');
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; btn.classList.remove('on'); }, 3000);
  return false;
}
function card(title, ...kids) { return h('div', { class: 'card' }, h('h3', {}, title), ...kids); }
function grid(...pairs) {
  const g = h('div', { class: 'grid' });
  for (let i = 0; i < pairs.length; i += 2) g.append(h('label', {}, pairs[i]), pairs[i + 1]);
  return g;
}
const blankGfx = (w, hh, ch = 32, co = 1) => ({ w, h: hh, delay: 30, frames: [{ ch: Array(w * hh).fill(ch), co: Array(w * hh).fill(co) }] });
const blankBg = () => ({ ch: Array(PF_W * PF_H).fill(32), co: Array(PF_W * PF_H).fill(11) });
const bgModel = bg => ({ w: PF_W, h: PF_H, delay: 30, frames: [bg] });
function uniqueId(base, list) { let n = 1, id = base; while (list.some(x => x.id === id)) id = base + ++n; return id; }

// ------------------------------------------------------------------ references (rename / delete)
function forEachRef(fn) {
  // fn(kind, obj, key) for every place that names an item or a room
  G.player.start && fn('room', G.player, 'start');
  for (const r of G.rooms) for (const o of r.objects) { fn('item', o, 'item'); if (o.door) fn('room', o.door, 'to'); }
  for (const ru of G.rules) {
    const t = TRIGGERS[ru.trigger] || {};
    if (t.a) fn(t.a, ru, 'a');
    if (t.b) fn(t.b, ru, 'b');
    for (const c of ru.if || []) { if (c.item) fn('item', c, 'item'); if (c.room) fn('room', c, 'room'); }
    for (const a of ru.do || []) { if (a.item) fn('item', a, 'item'); if (a.to) fn('item', a, 'to'); if (a.room) fn('room', a, 'room'); }
  }
}
function rename(kind, from, to) { forEachRef((k, o, key) => { if (k === kind && o[key] === from) o[key] = to; }); }
function countRefs(kind, id) { let n = 0; forEachRef((k, o, key) => { if (k === kind && o[key] === id) n++; }); return n; }

// ------------------------------------------------------------------ tab: game & player
function renderGame() {
  const t = $('#tab-game'); t.innerHTML = '';
  const p = G.player;
  t.append(h('div', { class: 'cols' },
    h('div', { class: 'form' },
      card('Game', grid(
        'Title', field(G, 'title', 'text', { upper: true }),
        'Intro text', field(G, 'intro', 'textarea', { counter: true, upper: true }))),
      card('Hero', grid(
        'Name', field(p, 'name', 'text', { upper: true }),
        'Description', field(p, 'desc', 'textarea', { counter: true, upper: true }),
        'HP / max', h('div', { class: 'inline' }, field(p, 'hp', 'number'), '/', field(p, 'hpmax', 'number')),
        'MP / max', h('div', { class: 'inline' }, field(p, 'mp', 'number'), '/', field(p, 'mpmax', 'number')),
        'Start room', select(roomOpts(), p.start, v => p.start = v))),
      card('Portrait (5×5)', (() => { const d = h('div'); mountEditor(d, p.avatar, { fixed: true, zoom: 5, frames: false }); return d; })()),
      card('Summary', h('div', { class: 'hint' },
        `${G.items.length} items · ${G.rooms.length} rooms · ${G.rules.length} interactions · flags: ${allFlags().join(', ') || 'none'}`)))));
}

// ------------------------------------------------------------------ tab: items
function renderItems() {
  const t = $('#tab-items'); t.innerHTML = '';
  sel.item = Math.min(sel.item, G.items.length - 1);
  const it = G.items[sel.item];
  const list = listPanel('Items', G.items, 'item', x => `${x.id} — ${x.name}`,
    () => { const id = uniqueId('item', G.items); G.items.push({ id, name: id.toUpperCase(), desc: '', pickable: true, glyph: blankGfx(1, 1, 0x51), icon: blankGfx(1, 1, 0x51) }); sel.item = G.items.length - 1; },
    btn => {
      const n = countRefs('item', it.id);
      if (n && !armed(btn, `Used ${n}× – click again`)) return false;
      snapshot(); G.items.splice(sel.item, 1); return true;
    },
    () => { const c = JSON.parse(JSON.stringify(it)); c.id = uniqueId(it.id, G.items); G.items.splice(sel.item + 1, 0, c); sel.item++; });
  const form = h('div', { class: 'form' });
  if (it) {
    const idIn = h('input', { type: 'text', value: it.id });
    idIn.onchange = () => {
      const v = idIn.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (!v || G.items.some(x => x !== it && x.id === v)) { idIn.value = it.id; return status('id must be unique', 'err'); }
      snapshot(); rename('item', it.id, v); it.id = v; renderAll();
    };
    form.append(
      card('Item', grid(
        'Id', idIn,
        'Name', field(it, 'name', 'text', { upper: true, attrs: { maxlength: 15 } }),
        'Description', field(it, 'desc', 'textarea', { counter: true, upper: true }),
        'Pickable', h('div', { class: 'inline' }, field(it, 'pickable', 'bool'), h('span', { class: 'hint' }, 'can be dragged into the inventory (name: 9 chars fit)')),
        'Light source', h('div', { class: 'inline' }, field(it, 'light', 'bool'), h('span', { class: 'hint' }, 'carrying it shows the rooms\' lit backgrounds')),
        'Enemy', h('div', { class: 'inline' }, field(it, 'enemy', 'bool', { onChange: renderAll }), 'HP', field(it, 'hp', 'number')),
        'Attack power', h('div', { class: 'inline' }, field(it, 'power', 'number'), h('span', { class: 'hint' }, 'damage of ATTACK while carried (best weapon counts; bare hands = 1)')))),
      card('In the room (up to 8×6, animated by frames)', (() => { const d = h('div'); mountEditor(d, it.glyph, { maxW: 8, maxH: 6, zoom: 4 }); return d; })()),
      card('Inventory icon (1×1, animated by frames)', (() => { const d = h('div'); mountEditor(d, it.icon, { fixed: true, zoom: 5 }); return d; })()),
      card('Used in', h('div', { class: 'hint' }, usage(it.id))));
  }
  t.append(h('div', { class: 'cols' }, list, form));
}
function usage(id) {
  const out = [];
  G.rooms.forEach(r => r.objects.forEach(o => o.item === id && out.push(`room ${r.id} at ${o.x},${o.y}`)));
  G.rules.forEach((ru, i) => JSON.stringify(ru).includes(`"${id}"`) && out.push(`interaction ${i + 1} (${ru.trigger})`));
  return out.join(' · ') || 'nowhere yet';
}

// ------------------------------------------------------------------ tab: rooms
function renderRooms() {
  const t = $('#tab-rooms'); t.innerHTML = '';
  sel.room = Math.min(sel.room, G.rooms.length - 1);
  const r = G.rooms[sel.room];
  const list = listPanel('Rooms', G.rooms, 'room', x => `${x.id} — ${x.name}`,
    () => { const id = uniqueId('room', G.rooms); G.rooms.push({ id, name: id.toUpperCase(), desc: '', dark: blankBg(), lit: null, objects: [] }); sel.room = G.rooms.length - 1; },
    btn => {
      const n = countRefs('room', r.id);
      if (n && !armed(btn, `Used ${n}× – click again`)) return false;
      snapshot(); G.rooms.splice(sel.room, 1); return true;
    },
    () => { const c = JSON.parse(JSON.stringify(r)); c.id = uniqueId(r.id, G.rooms); G.rooms.splice(sel.room + 1, 0, c); sel.room++; });
  const form = h('div', { class: 'form' });
  if (r) {
    if (sel.bgLit && !r.lit) sel.bgLit = false;
    const idIn = h('input', { type: 'text', value: r.id });
    idIn.onchange = () => {
      const v = idIn.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (!v || G.rooms.some(x => x !== r && x.id === v)) { idIn.value = r.id; return status('id must be unique', 'err'); }
      snapshot(); rename('room', r.id, v); r.id = v; renderAll();
    };
    const bg = sel.bgLit ? r.lit : r.dark;
    const editorBox = h('div');
    let ed;
    let dragging = null;
    const objAt = (x, y) => {
      for (let k = r.objects.length - 1; k >= 0; k--) {
        const o = r.objects[k], g = itemById(o.item)?.glyph;
        if (g && x >= o.x && x < o.x + g.w && y >= o.y && y < o.y + g.h) return k;
      }
      return -1;
    };
    ed = mountEditor(editorBox, bgModel(bg), {
      fixed: true, zoom: 3, frames: false,
      overlay: (ctx, z) => {
        r.objects.forEach((o, k) => {
          const it = itemById(o.item); if (!it) return;
          ctx.globalAlpha = o.hidden ? 0.45 : 1;
          drawGfx(ctx, it.glyph, 0, o.x * 8 * z, o.y * 8 * z, z);
          ctx.globalAlpha = 1;
          if (sel.objMode || k === sel.obj) {
            ctx.strokeStyle = k === sel.obj ? '#9ad284' : 'rgba(255,255,255,.35)';
            ctx.strokeRect(o.x * 8 * z + .5, o.y * 8 * z + .5, it.glyph.w * 8 * z - 1, it.glyph.h * 8 * z - 1);
          }
          if (o.door) { ctx.fillStyle = '#ffd24d'; ctx.font = `${3 * z}px sans-serif`; ctx.fillText('→' + o.door.to, o.x * 8 * z + 2, o.y * 8 * z + 4 * z); }
        });
      },
      mouseHook: (type, p, e) => {
        if (!sel.objMode) return false;
        if (type === 'up') { dragging = null; return true; }
        if (!p) return true;
        if (type === 'down') {
          const k = objAt(p[0], p[1]);
          if (k >= 0) { snapshot(); sel.obj = k; dragging = { k, dx: p[0] - r.objects[k].x, dy: p[1] - r.objects[k].y }; }
          else if (addItem.value) {
            const g = itemById(addItem.value).glyph;
            if (r.objects.length >= 12) { status('max 12 objects per room', 'err'); return true; }
            snapshot();
            r.objects.push({ item: addItem.value, x: Math.min(p[0], PF_W - g.w), y: Math.min(p[1], PF_H - g.h) });
            sel.obj = r.objects.length - 1;
          } else sel.obj = -1;
          renderRooms();
          return true;
        }
        if (type === 'move' && dragging && e.buttons) {
          const o = r.objects[dragging.k], g = itemById(o.item).glyph;
          o.x = Math.max(0, Math.min(PF_W - g.w, p[0] - dragging.dx));
          o.y = Math.max(0, Math.min(PF_H - g.h, p[1] - dragging.dy));
          ed.render(); dirty = true;
        }
        return true;
      },
    });
    const addItem = select(itemOpts(), '', () => { }, '— click an object to select it —');
    const modeBtns = h('div', { class: 'inline' },
      h('button', { class: sel.objMode ? '' : 'on', onclick: () => { sel.objMode = false; renderRooms(); } }, 'Paint background'),
      h('button', { class: sel.objMode ? 'on' : '', onclick: () => { sel.objMode = true; renderRooms(); } }, 'Place objects'),
      sel.objMode ? h('span', { class: 'inline' }, 'Add', addItem, h('span', { class: 'hint' }, 'then click an empty spot; drag to move')) : null);
    const bgBtns = h('div', { class: 'inline' },
      h('button', { class: sel.bgLit ? '' : 'on', onclick: () => { sel.bgLit = false; renderRooms(); } }, 'Normal / dark background'),
      r.lit ? h('button', { class: sel.bgLit ? 'on' : '', onclick: () => { sel.bgLit = true; renderRooms(); } }, 'Lit background') : null,
      r.lit ? h('button', { onclick: e => { if (!armed(e.currentTarget, 'Click again to remove')) return; snapshot(); r.lit = null; sel.bgLit = false; renderRooms(); } }, 'Remove lit')
        : h('button', { onclick: () => { snapshot(); r.lit = JSON.parse(JSON.stringify(r.dark)); sel.bgLit = true; renderRooms(); } }, 'Add lit version (copy)'),
      h('span', { class: 'hint' }, 'the lit background is shown while the hero carries a light source'));
    form.append(
      card('Room', grid(
        'Id', idIn,
        'Name', field(r, 'name', 'text', { upper: true, attrs: { maxlength: 23 } }),
        'Description', field(r, 'desc', 'textarea', { counter: true, upper: true }))),
      card('Playfield 25×14', bgBtns, modeBtns, editorBox),
      objectProps(r),
      card('Doors in the game', doorList()));
  }
  t.append(h('div', { class: 'cols' }, list, form));
}
function itemById(id) { return G.items.find(x => x.id === id); }
function objectProps(r) {
  const o = r.objects[sel.obj];
  if (!o) return card('Object', h('div', { class: 'hint' }, `${r.objects.length}/12 objects. Switch to "Place objects" and click one to edit it.`));
  const doorBox = h('div', { class: 'sub' });
  if (o.door) doorBox.append(grid(
    'Leads to', select(roomOpts(), o.door.to, v => { o.door.to = v; renderRooms(); }),
    'Locked until flag', h('div', { class: 'inline' }, flagInput(o.door, 'flag'), h('span', { class: 'hint' }, 'empty = always open')),
    'Locked message', field(o.door, 'locked', 'text', { upper: true })));
  return card('Object', grid(
    'Item', select(itemOpts(), o.item, v => { o.item = v; renderRooms(); }),
    'Position', h('div', { class: 'inline' }, field(o, 'x', 'number', { onChange: renderRooms }), field(o, 'y', 'number', { onChange: renderRooms })),
    'Hidden', h('div', { class: 'inline' }, field(o, 'hidden', 'bool', { onChange: renderRooms }), h('span', { class: 'hint' }, 'appears through a "reveal" action (e.g. SEARCH)')),
    'Door', h('div', { class: 'inline' }, h('input', {
      type: 'checkbox', ...(o.door ? { checked: true } : {}),
      onchange: e => { snapshot(); o.door = e.target.checked ? { to: G.rooms.find(x => x !== r)?.id || r.id } : null; renderRooms(); }
    }), h('span', { class: 'hint' }, 'clicking it goes to another room')),
    '', doorBox,
    '', h('button', { onclick: () => { snapshot(); r.objects.splice(sel.obj, 1); sel.obj = -1; renderRooms(); } }, 'Remove object')));
}
function doorList() {
  const rows = [];
  G.rooms.forEach(r => r.objects.forEach(o => {
    if (!o.door) return;
    const ok = G.rooms.some(x => x.id === o.door.to);
    rows.push(h('div', { class: ok ? '' : 'err' }, `${r.id} → ${o.door.to}`, o.door.flag ? ` (locked until flag ${o.door.flag})` : '', ok ? '' : '  — missing room!'));
  }));
  return rows.length ? h('div', {}, rows) : h('div', { class: 'hint' }, 'no doors yet: place an object and tick "Door"');
}

// ------------------------------------------------------------------ tab: rules
function ruleSummary(ru) {
  const t = TRIGGERS[ru.trigger] || {};
  const a = ru.a || 'any', b = ru.b || 'any';
  const head = { combine: `${a} + ${b}`, use: `${a} → ${b}`, use_player: `${a} → hero`, click: `click ${b}`, look: `look ${b}`,
    attack: `attack ${b}`, defeat: `${b} defeated`, search: `search in ${a}`, enter: `enter ${a}`, take: `take ${a}` }[ru.trigger] || ru.trigger;
  const conds = (ru.if || []).map(c => `${c.type}${c.flag || c.item || c.room ? ' ' + (c.flag || c.item || c.room) : ''}`).join(', ');
  const msg = (ru.do || []).find(x => x.text);
  return [head, conds, msg ? msg.text : (ru.do || []).map(x => x.type).join(', ')];
}
function renderRules() {
  const t = $('#tab-rules'); t.innerHTML = '';
  sel.rule = Math.min(sel.rule, G.rules.length - 1);
  const tbl = h('table', { class: 'rules' });
  G.rules.forEach((ru, i) => {
    const [a, b, c] = ruleSummary(ru);
    tbl.append(h('tr', { class: i === sel.rule ? 'sel' : '', onclick: () => { sel.rule = i; renderRules(); } },
      h('td', {}, String(i + 1)), h('td', {}, h('b', {}, ru.trigger)), h('td', {}, a), h('td', { class: 'hint' }, b), h('td', {}, c)));
  });
  const ru = G.rules[sel.rule];
  const tools = h('div', { class: 'inline' },
    h('button', { onclick: () => { snapshot(); G.rules.splice(sel.rule + 1, 0, { trigger: 'use', a: null, b: null, if: [], do: [{ type: 'msg', text: '' }] }); sel.rule++; renderRules(); } }, 'Add'),
    h('button', { onclick: () => { if (!ru) return; snapshot(); G.rules.splice(sel.rule + 1, 0, JSON.parse(JSON.stringify(ru))); sel.rule++; renderRules(); } }, 'Duplicate'),
    h('button', { onclick: () => { if (!ru) return; snapshot(); G.rules.splice(sel.rule, 1); renderRules(); } }, 'Delete'),
    h('button', { onclick: () => moveIn(G.rules, 'rule', -1) }, '▲'), h('button', { onclick: () => moveIn(G.rules, 'rule', 1) }, '▼'),
    h('span', { class: 'hint' }, 'The first interaction whose trigger and conditions match runs; order matters.'));
  t.append(card('Interactions', tools, tbl));
  if (ru) t.append(ruleEditor(ru));
}
function ruleEditor(ru) {
  const T = TRIGGERS[ru.trigger];
  const pick = (kind, key) => kind === 'room'
    ? select(roomOpts(), ru[key], v => { ru[key] = v || null; renderRules(); }, 'any room')
    : select(itemOpts(), ru[key], v => { ru[key] = v || null; renderRules(); }, 'any item');
  const trig = select(Object.entries(TRIGGERS).map(([k, v]) => [k, `${k} — ${v.label}`]), ru.trigger, v => {
    ru.trigger = v; if (!TRIGGERS[v].a) ru.a = null; if (!TRIGGERS[v].b) ru.b = null; renderRules();
  });
  const conds = h('div', { class: 'sub' });
  (ru.if = ru.if || []).forEach((c, k) => {
    const arg = CONDS[c.type];
    conds.append(h('div', { class: 'line' },
      select(Object.keys(CONDS).map(x => [x, COND_LABELS[x]]), c.type, v => { ru.if[k] = { type: v }; renderRules(); }),
      arg === 'flag' ? flagInput(c, 'flag') : arg === 'item' ? select(itemOpts(), c.item, v => { c.item = v; renderRules(); }, '—')
        : arg === 'room' ? select(roomOpts(), c.room, v => { c.room = v; renderRules(); }, '—') : null,
      h('button', { onclick: () => { snapshot(); ru.if.splice(k, 1); renderRules(); } }, '✕')));
  });
  conds.append(h('button', { onclick: () => { snapshot(); ru.if.push({ type: 'flag', flag: '' }); renderRules(); } }, 'Add condition'));
  const acts = h('div', { class: 'sub' });
  (ru.do = ru.do || []).forEach((a, k) => {
    const line = h('div', { class: 'line' },
      select(Object.keys(ACTIONS).map(x => [x, ACTION_LABELS[x]]), a.type, v => { ru.do[k] = { type: v }; renderRules(); }));
    for (const p of ACTIONS[a.type] || []) {
      if (p === 'text') line.append(h('div', { style: 'flex:1;min-width:280px' }, field(a, 'text', 'textarea', { counter: true, upper: true, onChange: () => renderRulesTableOnly() })));
      else if (p === 'flag') line.append(flagInput(a, 'flag'));
      else if (p === 'item') line.append(select(itemOpts(), a.item, v => { a.item = v; }, '—'));
      else if (p === 'to') line.append('into', select(itemOpts(), a.to, v => { a.to = v; }, '—'));
      else if (p === 'item_any') line.append(select(itemOpts(), a.item, v => { a.item = v || null; }, 'any hidden object'));
      else if (p === 'room') line.append(select(roomOpts(), a.room, v => { a.room = v; }, '—'));
      else if (p === 'n') { if (a.n == null) a.n = 1; line.append('n', field(a, 'n', 'number')); }
      else if (p === 'x' || p === 'y') { if (a[p] == null) a[p] = 0; line.append(p, field(a, p, 'number')); }
    }
    line.append(h('button', { onclick: () => moveAct(ru, k, -1) }, '▲'), h('button', { onclick: () => moveAct(ru, k, 1) }, '▼'),
      h('button', { onclick: () => { snapshot(); ru.do.splice(k, 1); renderRules(); } }, '✕'));
    acts.append(line);
  });
  acts.append(h('button', { onclick: () => { snapshot(); ru.do.push({ type: 'msg', text: '' }); renderRules(); } }, 'Add action'));
  return card(`Interaction ${sel.rule + 1}`, grid(
    'When', trig,
    T.a ? (T.a === 'room' ? 'Room A' : 'Item A') : '', T.a ? pick(T.a, 'a') : h('span'),
    T.b ? 'Item B' : '', T.b ? pick('item', 'b') : h('span'),
    'Only if', conds,
    'Then', acts),
    h('p', { class: 'hint' }, 'Without a matching interaction the engine does the default: descriptions on click, going through doors, "THAT DOES NOT WORK" when combining, damage 1 on ATTACK, removing a defeated enemy.'));
}
function moveAct(ru, k, d) { const j = k + d; if (j < 0 || j >= ru.do.length) return; snapshot(); [ru.do[k], ru.do[j]] = [ru.do[j], ru.do[k]]; renderRules(); }
function renderRulesTableOnly() { /* the summary refreshes on the next render */ }

// ------------------------------------------------------------------ main
function renderAll() {
  editors.forEach(e => e.stop()); editors = [];
  renderGame(); renderItems(); renderRooms(); renderRules();
}
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return r.json();
}
async function loadGame(name) {
  G = await api(`/api/game?name=${encodeURIComponent(name)}`);
  if (G.error) { status(G.error, 'err'); return; }
  G.rules = G.rules || [];
  gameName = name; history.length = 0; dirty = false;
  sel.item = sel.room = sel.rule = 0; sel.obj = -1;
  renderAll(); status(`loaded ${name}.json`);
}
async function save(name = gameName) {
  const r = await api(`/api/game?name=${encodeURIComponent(name)}`, G);
  if (r.ok) { dirty = false; gameName = name; status(`saved game/${name}.json`, 'ok'); } else status(r.error, 'err');
  return r.ok;
}
function showLog(text) { const l = $('#log'); l.hidden = !text; l.textContent = text; l.onclick = () => l.hidden = true; }
async function validate() {
  if (!await save()) return;
  const r = await api(`/api/validate?name=${gameName}`, '');
  showLog([...(r.warnings || []).map(w => 'warning: ' + w), r.ok ? `OK: game data ${r.size} bytes` : 'ERROR: ' + r.error].join('\n') + '\n(click to close)');
  status(r.ok ? 'valid' : r.error, r.ok ? 'ok' : 'err');
}
async function build(run) {
  if (!await save()) return;
  status('building…');
  const r = await api(`/api/build?name=${gameName}&run=${run ? 1 : 0}`, '');
  showLog((r.log || r.error || '') + '\n(click to close)');
  status(r.ok ? (run ? 'built, VICE starting' : 'built out/advgui_vdev.prg') : 'build failed', r.ok ? 'ok' : 'err');
}

async function init() {
  await loadCharset();
  const names = await api('/api/games');
  const gs = $('#gameSel');
  names.forEach(n => gs.append(h('option', { value: n }, n)));
  gs.value = names.includes('demo') ? 'demo' : names[0];
  let discard = null;
  gs.onchange = () => {
    if (dirty && discard !== gs.value) {
      discard = gs.value; gs.value = gameName;
      status(`unsaved changes: save first, or choose "${discard}" again to discard them`, 'err');
      return;
    }
    discard = null; loadGame(gs.value);
  };
  $('#btnSave').onclick = () => save();
  const nameIn = h('input', { type: 'text', placeholder: 'new name', style: 'width:9em', hidden: true });
  $('#btnNew').after(nameIn);
  $('#btnNew').onclick = async () => {
    if (nameIn.hidden) { nameIn.hidden = false; nameIn.value = gameName + '2'; nameIn.focus(); nameIn.select(); return status('type a name, then Enter or Save as… again'); }
    const n = nameIn.value.trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(n)) return status('use letters, digits, - and _', 'err');
    if (await save(n)) { if (![...gs.options].some(o => o.value === n)) gs.append(h('option', { value: n }, n)); gs.value = n; nameIn.hidden = true; }
  };
  nameIn.onkeydown = e => { if (e.key === 'Enter') $('#btnNew').click(); if (e.key === 'Escape') nameIn.hidden = true; };
  $('#btnValidate').onclick = validate;
  $('#btnBuild').onclick = () => build(false);
  $('#btnRun').onclick = () => build(true);
  $('#btnPlay').onclick = async () => {
    if (await save()) window.open(`/player/?game=${encodeURIComponent(gameName)}`, '_blank', 'noopener');
  };
  $('#btnUndo').onclick = undo;
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab));
  });
  await loadGame(gs.value);
}
init();
