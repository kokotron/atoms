/* Atoms! game rules, shared by the page (window.AtomsCore) and the LAN server (require). No DOM access here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtomsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAMES = ['Coral', 'Teal', 'Amber', 'Lilac'];
  const SIZES = { '5×8': [5, 8], '6×9': [6, 9], '7×11': [7, 11] };

  // slots: array of 4 entries, each 'human' | 'cpu' | 'off'
  function makeGame(cols, rows, slots) {
    const players = [];
    slots.forEach((k, i) => { if (k !== 'off') players.push({ c: i, kind: k, alive: true, moved: false }); });
    const n = cols * rows, nb = [], cap = [];
    for (let i = 0; i < n; i++) {
      const x = i % cols, y = (i / cols) | 0, a = [];
      if (y > 0) a.push(i - cols);
      if (x < cols - 1) a.push(i + 1);
      if (y < rows - 1) a.push(i + cols);
      if (x > 0) a.push(i - 1);
      nb.push(a); cap.push(a.length);
    }
    return { cols, rows, nb, cap, o: new Array(n).fill(-1), k: new Array(n).fill(0), players, turn: 0, over: false, moves: 0, seq: 0 };
  }

  const legal = (g, i, p) => g.o[i] === -1 || g.o[i] === p;
  const allMoved = g => g.players.every(p => p.moved || !p.alive);

  function owners(o) {
    const set = new Set(); for (const v of o) if (v >= 0) set.add(v); return set;
  }

  function nextAliveIndex(g, t) {
    for (let s = 1; s <= g.players.length; s++) {
      const j = (t + s) % g.players.length;
      if (g.players[j].alive) return j;
    }
    return t;
  }

  // How long the page spends animating chain wave number `w` (the server paces CPU moves with this).
  const waveDuration = (w, reduced) => reduced ? 90 : Math.max(130, 300 - w * 18);

  // One wave of explosions. Returns the exploding cells (with their owner), or null when the board is stable.
  function explodeWave(g) {
    const hot = [];
    for (let i = 0; i < g.o.length; i++) if (g.k[i] >= g.cap[i]) hot.push(i);
    if (!hot.length) return null;
    if (allMoved(g) && owners(g.o).size <= 1) return null;
    const burst = [];
    for (const u of hot) {
      const own = g.o[u];
      g.k[u] -= g.cap[u]; if (g.k[u] === 0) g.o[u] = -1;
      burst.push([u, own]);
    }
    return burst;
  }
  function landWave(g, burst) {
    for (const [u, own] of burst) for (const v of g.nb[u]) { g.k[v]++; g.o[v] = own; }
  }

  // Place an atom for the current player (no legality check; callers check first).
  function place(g, i) {
    const p = g.players[g.turn];
    p.moved = true; g.moves++;
    g.o[i] = p.c; g.k[i]++;
  }

  // After the chain settles: eliminate players, detect the winner, pass the turn. Returns the winner or null.
  function finishTurn(g) {
    if (allMoved(g)) {
      for (const p of g.players) if (p.alive && p.moved && !g.o.includes(p.c)) p.alive = false;
    }
    const alive = g.players.filter(p => p.alive);
    if (alive.length === 1 && allMoved(g)) {
      g.over = true; g.turn = g.players.indexOf(alive[0]);
      return alive[0];
    }
    g.turn = nextAliveIndex(g, g.turn);
    return null;
  }

  // Whole move in one go. Returns { waves, winner }.
  function applyMove(g, i) {
    place(g, i);
    let waves = 0, burst;
    while (waves <= 400 && (burst = explodeWave(g))) { landWave(g, burst); waves++; }
    const winner = finishTurn(g);
    g.seq++;
    return { waves, winner };
  }

  /* ---------- CPU ---------- */
  // Fast resolve on bare arrays, used for look-ahead.
  function simulate(g, o, k, i, p, everyoneMoved) {
    o[i] = p; k[i]++;
    let queue = k[i] >= g.cap[i] ? [i] : [], guard = 0;
    while (queue.length && guard++ < 300) {
      const next = [];
      for (const u of queue) {
        if (k[u] < g.cap[u]) continue;
        const own = o[u];
        k[u] -= g.cap[u]; if (k[u] === 0) o[u] = -1;
        for (const v of g.nb[u]) { k[v]++; o[v] = own; if (k[v] >= g.cap[v]) next.push(v); }
        if (k[u] >= g.cap[u]) next.push(u);
      }
      if (everyoneMoved && owners(o).size <= 1) break;
      queue = next;
    }
  }

  function evaluate(g, o, k, me, everyoneMoved) {
    let mine = 0, theirs = 0, score = 0;
    const live = new Set();
    for (let i = 0; i < o.length; i++) {
      if (o[i] === -1) continue;
      live.add(o[i]);
      if (o[i] !== me) { theirs += k[i]; continue; }
      mine += k[i];
      let threatened = false;
      for (const v of g.nb[i]) if (o[v] !== -1 && o[v] !== me && k[v] === g.cap[v] - 1) { threatened = true; score -= 5 - g.cap[i]; }
      if (!threatened) {
        if (g.cap[i] === 2) score += 3; else if (g.cap[i] === 3) score += 2;
        if (k[i] === g.cap[i] - 1) score += 2;
      }
    }
    if (mine === 0 && everyoneMoved) return -1e6;
    if (everyoneMoved && live.size === 1 && live.has(me)) return 1e6;
    return score + mine - theirs * 0.8;
  }

  function cpuMove(g) {
    const cur = g.players[g.turn], me = cur.c, n = g.o.length;
    const moved = g.players.every(p => p.moved || p === cur || !p.alive);
    const nextP = g.players[nextAliveIndex(g, g.turn)];
    let best = -Infinity, pick = [];
    for (let i = 0; i < n; i++) {
      if (!legal(g, i, me)) continue;
      const o = g.o.slice(), k = g.k.slice();
      simulate(g, o, k, i, me, moved);
      let s = evaluate(g, o, k, me, moved);
      if (s < 1e6 && nextP && nextP.c !== me) {
        // assume the next player replies with whatever hurts us most
        let worst = Infinity;
        for (let j = 0; j < n; j++) {
          if (o[j] !== -1 && o[j] !== nextP.c) continue;
          const o2 = o.slice(), k2 = k.slice();
          simulate(g, o2, k2, j, nextP.c, true);
          const s2 = evaluate(g, o2, k2, me, true);
          if (s2 < worst) worst = s2;
        }
        if (worst !== Infinity) s = worst * 0.85 + s * 0.15;
      }
      s += Math.random() * 0.5;
      if (s > best + 1e-9) { best = s; pick = [i]; } else if (Math.abs(s - best) < 1e-9) pick.push(i);
    }
    return pick[(Math.random() * pick.length) | 0];
  }

  return { NAMES, SIZES, makeGame, legal, allMoved, owners, nextAliveIndex, waveDuration, explodeWave, landWave, place, finishTurn, applyMove, cpuMove };
});
