'use strict';

const PAL = ['#000000', '#ffffff', '#813338', '#75cec8', '#8e3c97', '#56ac4d', '#2e2c9b', '#edf171',
  '#8e5029', '#553800', '#c46c71', '#4a4a4a', '#7b7b7b', '#a9ff9f', '#706deb', '#b2b2b2'];
const W = 40, H = 25, PF_X = 1, PF_Y = 3, PF_W = 25, PF_H = 14, INV_X = 28, INV_Y = 4;
const SC = { H: 0x40, V: 0x5d, RTL: 0x55, RTR: 0x49, RBL: 0x4a, RBR: 0x4b, BLOCK: 0xa0 };
const canvas = document.querySelector('#screen');
const ctx = canvas.getContext('2d', { alpha: false });
const statusEl = document.querySelector('#status');
const titleEl = document.querySelector('#gameTitle');
const chars = new Uint8Array(W * H);
const colors = new Uint8Array(W * H);

let charset, sheets = [], game, state, hovered = null, pointer = null, lastTime = 0, animTime = 0;

const item = id => game.items.find(it => it.id === id);
const room = id => game.rooms.find(r => r.id === id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sameHit = (a, b) => a && b && a.kind === b.kind && a.index === b.index && a.inst === b.inst;

function screenCode(c) {
  const n = c.toUpperCase().charCodeAt(0);
  if (n >= 64 && n < 96) return n - 64;
  return n;
}
function cell(x, y, ch, co) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x; chars[i] = ch; colors[i] = co & 15;
}
function fill(x, y, w, h, ch = 32, co = 15) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) cell(x + i, y + j, ch, co);
}
function paint(x, y, w, h, co) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = (y + j) * W + x + i; if (p >= 0 && p < colors.length) colors[p] = co;
  }
}
function text(x, y, value, co = 15, reverse = false, max = W - x) {
  [...String(value).toUpperCase()].slice(0, max).forEach((c, i) => cell(x + i, y, screenCode(c) | (reverse ? 0x80 : 0), co));
}
function box(x, y, w, h, co) {
  fill(x + 1, y, w - 2, 1, SC.H, co); fill(x + 1, y + h - 1, w - 2, 1, SC.H, co);
  fill(x, y + 1, 1, h - 2, SC.V, co); fill(x + w - 1, y + 1, 1, h - 2, SC.V, co);
  cell(x, y, SC.RTL, co); cell(x + w - 1, y, SC.RTR, co);
  cell(x, y + h - 1, SC.RBL, co); cell(x + w - 1, y + h - 1, SC.RBR, co);
}
function drawGfx(g, frame, x, y, dim = null) {
  if (!g?.frames?.length) return;
  const f = g.frames[frame % g.frames.length];
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
    const p = j * g.w + i; cell(x + i, y + j, f.ch[p], dim ?? f.co[p]);
  }
}
function isLit() {
  return state.inventory.some(id => item(id)?.light) || state.instances.some(o => o.room === state.room && !o.hidden && item(o.item)?.light);
}
function frameFor(g, now) {
  if (!g?.frames?.length) return 0;
  return Math.floor(now / ((g.delay || 30) * 1000 / 60)) % g.frames.length;
}
function currentInstances() { return state.instances.filter(o => o.room === state.room && o.item); }

function wrapMessage(value) {
  const words = String(value || '').toUpperCase().trim().split(/\s+/).filter(Boolean), lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= 38) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}
function say(value, append = false) {
  const message = String(value || '');
  state.message = append && state.message ? state.message + ' ' + message : message;
  state.page = 0;
}
function addMessage(value) { if (value) say(value, true); }

function drawHeader() {
  fill(0, 0, 40, 2, SC.BLOCK, 1);
  const lines = wrapMessage(state.message), start = state.page * 2;
  text(1, 0, lines[start] || '', 1, true, 38); text(1, 1, lines[start + 1] || '', 1, true, 38);
  if (start + 2 < lines.length) cell(39, 1, Math.floor(animTime / 250) % 2 ? 0xa9 : 0x3e, 1);
}
function drawPlayfield(now) {
  const r = room(state.room), bg = r.lit && isLit() ? r.lit : r.dark;
  for (let y = 0; y < PF_H; y++) for (let x = 0; x < PF_W; x++) {
    const p = y * PF_W + x; cell(PF_X + x, PF_Y + y, bg.ch[p], bg.co[p]);
  }
  fill(1, 2, 25, 1, SC.H, 15); text(2, 2, r.name, 1, false, 23);
  for (const o of currentInstances()) if (!o.hidden) {
    const g = item(o.item)?.glyph;
    drawGfx(g, frameFor(g, now), PF_X + o.x, PF_Y + o.y, pointer?.drag?.kind === 'object' && pointer.drag.inst === o.uid ? 11 : null);
  }
}
function drawInventory(now) {
  box(27, 2, 13, 16, hovered?.kind === 'inventory-panel' && pointer?.drag ? 7 : 15);
  text(29, 2, 'INVENTORY', 1, false, 9);
  state.inventory.forEach((id, i) => {
    fill(INV_X, INV_Y + i, 11, 1, 32, 15);
    if (!id) cell(INV_X, INV_Y + i, 46, 11);
    else {
      const it = item(id), dim = pointer?.drag?.kind === 'slot' && pointer.drag.index === i ? 11 : null;
      drawGfx(it.icon, frameFor(it.icon, now), INV_X, INV_Y + i, dim);
      text(INV_X + 2, INV_Y + i, it.name, dim ?? 1, false, 9);
    }
    if (hovered?.kind === 'slot' && hovered.index === i && pointer?.drag && !sameHit(hovered, pointer.drag)) paint(INV_X, INV_Y + i, 11, 1, 7);
  });
}
function drawButton(x, label, pressed) {
  box(x, 18, 8, 3, pressed ? 10 : 15);
  fill(x + 1, 19, 6, 1, pressed ? SC.BLOCK : 32, pressed ? 10 : 15);
  text(x + 1, 19, label, pressed ? 10 : 1, pressed, 6);
}
function drawStats() {
  const heroHot = pointer?.drag && ['hero', 'hp', 'mp'].includes(hovered?.kind);
  drawGfx(game.player.avatar, 0, 1, 19, heroHot ? 7 : (state.hp > state.hpmax / 4 ? null : 2));
  fill(8, 19, 14, 1, 32, 1); text(8, 19, game.player.name, 1, false, 14);
  text(8, 21, 'HP', 15); text(8, 23, 'MP', 15);
  for (let i = 0; i < 10; i++) {
    cell(11 + i, 21, SC.BLOCK, i * state.hpmax < state.hp * 10 ? (state.hp > state.hpmax / 4 ? 5 : 2) : 11);
    cell(11 + i, 23, SC.BLOCK, i * state.mpmax < state.mp * 10 ? 14 : 11);
  }
}
function hoverName() {
  if (!hovered) return '';
  if (hovered.kind === 'slot') return item(state.inventory[hovered.index])?.name || '';
  if (hovered.kind === 'object') return item(hovered.object.item)?.name || '';
  if (hovered.kind === 'button') return hovered.name.toUpperCase();
  if (hovered.kind === 'hero') return game.player.name;
  if (hovered.kind === 'hp') return `HP ${state.hp}/${state.hpmax}`;
  if (hovered.kind === 'mp') return `MP ${state.mp}/${state.mpmax}`;
  return '';
}
function drawScreen(now) {
  fill(0, 0, W, H, 32, 15);
  box(0, 2, 27, 16, 15); box(0, 18, 7, 7, 15);
  drawPlayfield(now); drawInventory(now); drawStats();
  drawButton(23, 'ATTACK', pointer?.pressed?.name === 'attack');
  drawButton(32, 'SEARCH', pointer?.pressed?.name === 'search');
  fill(23, 22, 17, 1, 32, 7); const hn = hoverName(); if (hn) text(23, 22, '> ' + hn, 7, false, 17);
  text(23, 24, 'L:USE/DRAG R:LOOK', 11, false, 17);
  drawHeader();
  ctx.fillStyle = PAL[0]; ctx.fillRect(0, 0, 320, 200); ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, ch = chars[p];
    ctx.drawImage(sheets[colors[p]], (ch & 15) * 8, (ch >> 4) * 8, 8, 8, x * 8, y * 8, 8, 8);
  }
  if (pointer?.drag && pointer.current) {
    const it = sourceItem(pointer.drag), g = pointer.drag.kind === 'slot' ? it?.icon : it?.glyph;
    if (g) {
      ctx.globalAlpha = .82;
      const f = g.frames[frameFor(g, now)], ox = pointer.current.x * 8 - g.w * 4, oy = pointer.current.y * 8 - g.h * 4;
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
        const p = y * g.w + x, ch = f.ch[p];
        ctx.drawImage(sheets[f.co[p] & 15], (ch & 15) * 8, (ch >> 4) * 8, 8, 8, ox + x * 8, oy + y * 8, 8, 8);
      }
      ctx.globalAlpha = 1;
    }
  }
}

function sourceItem(ref) { return ref?.kind === 'slot' ? item(state.inventory[ref.index]) : item(ref?.object?.item); }
function has(id) { return state.inventory.includes(id); }
function weaponPower() { return Math.max(1, ...state.inventory.map(id => item(id)?.power || 0)); }
function condsOk(conds = []) {
  return conds.every(c => ({
    flag: () => state.flags.has(c.flag), not_flag: () => !state.flags.has(c.flag),
    has: () => has(c.item), not_has: () => !has(c.item), lit: () => isLit(), not_lit: () => !isLit(),
    in_room: () => state.room === c.room,
  }[c.type]?.() || false));
}
function runRule(trigger, a, b, actionContext) {
  const rule = (game.rules || []).find(r => r.trigger === trigger && (!r.a || r.a === a) && (!r.b || r.b === b) && condsOk(r.if));
  if (!rule) return false;
  execute(rule.do || [], actionContext || {});
  return true;
}
function removeRef(ref) {
  if (ref?.kind === 'slot') state.inventory[ref.index] = null;
  else if (ref?.kind === 'object') ref.object.item = null;
}
function replaceRef(ref, id) {
  if (ref?.kind === 'slot') state.inventory[ref.index] = id;
  else if (ref?.kind === 'object') { ref.object.item = id; ref.object.hp = item(id)?.hp || 0; }
}
function changeHp(n) {
  state.hp = clamp(state.hp + Number(n || 0), 0, state.hpmax);
  if (state.hp <= 0) { state.hp = 1; addMessage('YOU COLLAPSE... AND WAKE UP AGAIN, WEAKER.'); }
}
function damage(n, ac) {
  const target = ac.target?.object;
  if (!target?.item) return;
  target.hp = Math.max(0, target.hp - (Number(n) || weaponPower()));
  if (!target.hp && !runRule('defeat', null, target.item, ac)) {
    target.item = null; addMessage('IT IS DEFEATED.');
  }
}
function execute(actions, ac) {
  for (const a of actions) {
    switch (a.type) {
      case 'msg': addMessage(a.text); break;
      case 'set_flag': state.flags.add(a.flag); break;
      case 'clear_flag': state.flags.delete(a.flag); break;
      case 'remove_a': removeRef(ac.source); break;
      case 'remove_target': removeRef(ac.target); break;
      case 'replace_a': replaceRef(ac.source, a.item); break;
      case 'replace_target': replaceRef(ac.target, a.item); break;
      case 'swap': state.instances.filter(o => o.room === state.room && o.item === a.item).forEach(o => replaceRef({ kind: 'object', object: o }, a.to)); break;
      case 'give': {
        const s = state.inventory.indexOf(null);
        if (s >= 0) state.inventory[s] = a.item; else spawn(a.item, 12, 8);
        break;
      }
      case 'spawn': spawn(a.item, Number(a.x), Number(a.y)); break;
      case 'reveal': state.instances.filter(o => o.room === state.room && (!a.item || o.item === a.item)).forEach(o => { o.hidden = false; }); break;
      case 'hp': changeHp(a.n); break;
      case 'hurt':
        if (ac.target?.object && !item(ac.target.object.item)?.enemy) break;
        addMessage(a.text); changeHp(-(1 + Math.floor(Math.random() * Math.max(1, Number(a.n))))); break;
      case 'damage': damage(a.n, ac); break;
      case 'mp': state.mp = clamp(state.mp + Number(a.n || 0), 0, state.mpmax); break;
      case 'goto': state.pendingRoom = a.room; break;
      case 'end': addMessage(a.text); state.gameOver = true; break;
    }
  }
}
function spawn(id, x, y) {
  state.instances.push({ uid: state.nextUid++, room: state.room, item: id, x, y, hidden: false, hp: item(id)?.hp || 0, door: null });
}
function beginAction() {
  state.previousMessage = state.message;
  state.previousPage = state.page;
  state.message = '';
  state.page = 0;
  state.pendingRoom = null;
}
function finishAction() {
  while (state.pendingRoom) {
    const next = state.pendingRoom; state.pendingRoom = null; state.room = next;
    if (!state.message) addMessage(room(next)?.desc || '');
    runRule('enter', next, null, {});
  }
  if (!state.message) {
    state.message = state.previousMessage || '';
    state.page = state.previousPage || 0;
  }
  state.previousMessage = '';
  state.previousPage = 0;
}
function tryCombine(a, b) {
  const ai = sourceItem(a)?.id, bi = sourceItem(b)?.id;
  return runRule('combine', ai, bi, { source: a, target: b }) || runRule('combine', bi, ai, { source: b, target: a });
}
function take(ref, preferred = -1) {
  let slot = preferred >= 0 && !state.inventory[preferred] ? preferred : state.inventory.indexOf(null);
  if (slot < 0) return addMessage('YOUR INVENTORY IS FULL.');
  const id = ref.object.item; state.inventory[slot] = id; ref.object.item = null;
  if (!runRule('take', id, null, { source: { kind: 'slot', index: slot } })) addMessage('TAKEN.');
}

function clickHit(hit, look = false) {
  if (!hit) return;
  if (hit.kind === 'header') {
    const pages = Math.ceil(wrapMessage(state.message).length / 2);
    if (state.page + 1 < pages) state.page++;
    return;
  }
  if (state.gameOver) return;
  beginAction();
  if (hit.kind === 'button') {
    if (hit.name === 'search') {
      if (!runRule('search', state.room, null, {})) addMessage('YOU FIND NOTHING SPECIAL.');
    } else {
      const enemy = currentInstances().find(o => !o.hidden && item(o.item)?.enemy);
      if (!enemy) addMessage('THERE IS NOTHING TO ATTACK.');
      else if (!runRule('attack', null, enemy.item, { target: { kind: 'object', object: enemy } })) {
        addMessage('YOU ATTACK.'); damage(weaponPower(), { target: { kind: 'object', object: enemy } });
      }
    }
  } else if (['hero', 'hp', 'mp'].includes(hit.kind)) addMessage(game.player.desc);
  else if (hit.kind === 'object') {
    const o = hit.object, ref = { kind: 'object', object: o };
    if (!runRule(look ? 'look' : 'click', null, o.item, { target: ref })) {
      if (!look && o.door) {
        if (!o.door.flag || state.flags.has(o.door.flag)) state.pendingRoom = o.door.to;
        else addMessage(o.door.locked || 'IT IS LOCKED.');
      } else addMessage(item(o.item)?.desc || '');
    }
  } else if (hit.kind === 'slot' && state.inventory[hit.index]) {
    const ref = { kind: 'slot', index: hit.index }, id = state.inventory[hit.index];
    if (!runRule('look', null, id, { target: ref })) addMessage(item(id)?.desc || '');
  } else if (hit.kind === 'playfield') addMessage(room(state.room)?.desc || '');
  finishAction();
}

function drop(src, dst, pos) {
  if (state.gameOver) return;
  beginAction();
  if (src.kind === 'object') {
    if (dst?.kind === 'slot' && state.inventory[dst.index]) {
      if (!tryCombine(src, dst)) take(src);
    } else if (dst?.kind === 'slot') take(src, dst.index);
    else if (dst?.kind === 'inventory-panel') take(src);
    else if (dst?.kind === 'object' && dst.object !== src.object) {
      if (!runRule('use', src.object.item, dst.object.item, { source: src, target: dst }) && !tryCombine(src, dst)) addMessage('NOTHING HAPPENS.');
    } else if (dst && ['hero', 'hp', 'mp'].includes(dst.kind)) {
      if (!runRule('use_player', src.object.item, null, { source: src })) addMessage("YOU CAN'T USE THAT ON YOURSELF.");
    } else if (dst?.kind === 'playfield') moveObject(src.object, pos);
  } else if (src.kind === 'slot') {
    const id = state.inventory[src.index];
    if (dst?.kind === 'slot' && dst.index !== src.index) {
      if (state.inventory[dst.index]) { if (!tryCombine(src, dst)) addMessage('THAT DOES NOT WORK.'); }
      else { state.inventory[dst.index] = id; state.inventory[src.index] = null; }
    } else if (dst?.kind === 'object') {
      if (!runRule('use', id, dst.object.item, { source: src, target: dst }) && !tryCombine(src, dst)) addMessage('NOTHING HAPPENS.');
    } else if (dst && ['hero', 'hp', 'mp'].includes(dst.kind)) {
      if (!runRule('use_player', id, null, { source: src })) addMessage("YOU CAN'T USE THAT ON YOURSELF.");
    } else if (dst?.kind === 'playfield') {
      const g = item(id).glyph, x = clamp(Math.floor(pos.x) - PF_X, 0, PF_W - g.w), y = clamp(Math.floor(pos.y) - PF_Y, 3, PF_H - g.h);
      spawn(id, x, y); state.inventory[src.index] = null; addMessage('DROPPED.');
    }
  }
  finishAction();
}
function moveObject(o, pos) {
  const g = item(o.item).glyph;
  o.x = clamp(Math.floor(pos.x) - PF_X, 0, PF_W - g.w);
  o.y = clamp(Math.floor(pos.y) - PF_Y, 3, PF_H - g.h);
}

function hitTest(x, y) {
  const col = Math.floor(x), row = Math.floor(y);
  if (row < 2) return { kind: 'header' };
  if (col >= 23 && col < 31 && row >= 18 && row < 21) return { kind: 'button', name: 'attack' };
  if (col >= 32 && col < 40 && row >= 18 && row < 21) return { kind: 'button', name: 'search' };
  if (col >= 1 && col < 6 && row >= 19 && row < 24) return { kind: 'hero' };
  if (col >= 8 && col < 21 && row === 21) return { kind: 'hp' };
  if (col >= 8 && col < 21 && row === 23) return { kind: 'mp' };
  if (col >= INV_X && col < INV_X + 11 && row >= INV_Y && row < INV_Y + 12) return { kind: 'slot', index: row - INV_Y };
  const objects = currentInstances();
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i], g = item(o.item)?.glyph;
    if (!o.hidden && g && col >= PF_X + o.x && col < PF_X + o.x + g.w && row >= PF_Y + o.y && row < PF_Y + o.y + g.h)
      return { kind: 'object', object: o, inst: o.uid };
  }
  if (col >= INV_X && col < INV_X + 11 && row >= PF_Y && row < PF_Y + PF_H) return { kind: 'inventory-panel' };
  if (col >= PF_X && col < PF_X + PF_W && row >= PF_Y && row < PF_Y + PF_H) return { kind: 'playfield' };
  return null;
}
function point(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
}
canvas.addEventListener('contextmenu', e => { e.preventDefault(); clickHit(hitTest(point(e).x, point(e).y), true); });
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const p = point(e), hit = hitTest(p.x, p.y);
  pointer = { id: e.pointerId, start: p, current: p, pressed: hit, drag: null };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  const p = point(e); hovered = hitTest(p.x, p.y);
  if (pointer?.id === e.pointerId) {
    pointer.current = p;
    if (!pointer.drag && Math.hypot(p.x - pointer.start.x, p.y - pointer.start.y) > .45) {
      const h = pointer.pressed;
      if (h?.kind === 'slot' && state.inventory[h.index]) pointer.drag = { kind: 'slot', index: h.index };
      if (h?.kind === 'object' && item(h.object.item)?.pickable) pointer.drag = { kind: 'object', object: h.object, inst: h.object.uid };
    }
  }
  canvas.style.cursor = hovered && !['playfield', 'inventory-panel'].includes(hovered.kind) ? 'pointer' : (pointer?.drag ? 'grabbing' : 'default');
});
canvas.addEventListener('pointerup', e => {
  if (!pointer || pointer.id !== e.pointerId) return;
  const p = point(e), dst = hitTest(p.x, p.y), old = pointer;
  pointer = null;
  if (old.drag) drop(old.drag, dst, p); else clickHit(dst);
});
canvas.addEventListener('pointercancel', () => { pointer = null; });
canvas.addEventListener('pointerleave', () => { if (!pointer) hovered = null; });

function validateGame(g) {
  if (g?.format !== 'advgui-game' || !g.player || !Array.isArray(g.items) || !Array.isArray(g.rooms)) throw new Error('Not an ADVGUI game JSON file.');
  if (!roomFrom(g, g.player.start)) throw new Error(`Start room "${g.player.start}" does not exist.`);
  return g;
}
function roomFrom(g, id) { return g.rooms.find(r => r.id === id); }
function resetGame(g) {
  game = validateGame(g);
  let uid = 1;
  state = {
    room: game.player.start, hp: game.player.hp, hpmax: game.player.hpmax, mp: game.player.mp, mpmax: game.player.mpmax,
    inventory: Array(12).fill(null), flags: new Set(), gameOver: false, pendingRoom: null, nextUid: 1,
    instances: game.rooms.flatMap(r => (r.objects || []).map(o => ({ ...structuredClone(o), uid: uid++, room: r.id, hp: itemFrom(game, o.item)?.hp || 0 }))),
    message: game.intro || roomFrom(game, game.player.start).desc, page: 0,
  };
  state.nextUid = uid;
  runRule('enter', state.room, null, {}); finishAction();
  titleEl.textContent = game.title || 'UNTITLED ADVENTURE'; document.title = `${game.title || 'ADVGUI'} - HTML5`;
  statusEl.textContent = 'GAME READY'; hovered = pointer = null;
}
function itemFrom(g, id) { return g.items.find(it => it.id === id); }

async function loadServerGame(name) {
  statusEl.textContent = 'LOADING GAME DATA';
  const res = await fetch(`/api/game?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Could not load ${name}.json.`);
  resetGame(await res.json());
}
async function init() {
  try {
    charset = new Uint8Array(await (await fetch('/api/chargen')).arrayBuffer(), 0, 2048);
    sheets = PAL.map(color => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const cx = c.getContext('2d'), image = cx.createImageData(128, 128);
      const rgb = color.match(/[\da-f]{2}/gi).map(n => parseInt(n, 16));
      for (let ch = 0; ch < 256; ch++) for (let row = 0; row < 8; row++) for (let bit = 0; bit < 8; bit++) {
        if (!(charset[ch * 8 + row] & (128 >> bit))) continue;
        const p = (((ch >> 4) * 8 + row) * 128 + (ch & 15) * 8 + bit) * 4;
        image.data.set([...rgb, 255], p);
      }
      cx.putImageData(image, 0, 0); return c;
    });
    const names = await (await fetch('/api/games')).json(), select = document.querySelector('#gameSelect');
    names.forEach(name => select.add(new Option(name, name)));
    const requested = new URLSearchParams(location.search).get('game');
    select.value = names.includes(requested) ? requested : (names.includes('demo') ? 'demo' : names[0]);
    select.onchange = () => loadServerGame(select.value).catch(showError);
    await loadServerGame(select.value);
    requestAnimationFrame(loop);
  } catch (e) { showError(e); }
}
function showError(e) { statusEl.textContent = e.message.toUpperCase(); console.error(e); }
function loop(now) {
  animTime = now; const elapsed = now - lastTime;
  if (elapsed > 25) { drawScreen(now); lastTime = now; }
  requestAnimationFrame(loop);
}
document.querySelector('#restart').onclick = () => game && resetGame(game);
document.querySelector('#fileInput').onchange = async e => {
  try { resetGame(JSON.parse(await e.target.files[0].text())); document.querySelector('#gameSelect').value = ''; statusEl.textContent = `LOCAL: ${e.target.files[0].name.toUpperCase()}`; }
  catch (err) { showError(err); }
  e.target.value = '';
};
init();
