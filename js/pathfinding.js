/* ==========================================================================
 * pathfinding.js — 길찾기 (A*) 와 이번 턴 이동 가능 범위
 *
 *  문명 방식의 이동 규칙을 그대로 계산한다.
 *   - 칸에 들어갈 때 지형 비용만큼 이동력을 쓴다.
 *   - 남은 이동력이 비용보다 적어도 RULES.minMovesToEnter 이상이면 들어갈 수 있다(남은 이동력 0).
 *   - 이동력이 0이 되면 그 칸에서 턴을 마치고 다음 턴에 이동력을 회복한다.
 *  비용 점수 g = 턴 수 × 최대 이동력 + (최대 이동력 − 남은 이동력)
 *   → '더 이른 턴에, 이동력을 더 남기고' 도착하는 경로가 항상 더 좋다.
 *
 *  알지 못하는 땅(미탐험)은 RULES.unexploredMoveCost 비용의 통과 가능한 타일로 가정한다.
 *  (실제 이동 중 새 땅이 보이면 state.js의 executeMove가 경로를 다시 계산)
 *  같은 종류 유닛이 있는 칸은 지나갈 수는 있지만 그 칸에서 턴을 마칠 수는 없다.
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});
  var Data = Game.Data, Hex = Game.Hex;

  /* ---------------------------------------------------------------
   * 이진 힙 (우선순위 큐)
   * ------------------------------------------------------------- */
  function MinHeap() {
    this.items = [];
    this.prios = [];
  }
  MinHeap.prototype.size = function () { return this.items.length; };
  MinHeap.prototype.push = function (item, prio) {
    var items = this.items, prios = this.prios;
    var i = items.length;
    items.push(item);
    prios.push(prio);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (prios[p] <= prio) break;
      items[i] = items[p]; prios[i] = prios[p];
      i = p;
    }
    items[i] = item; prios[i] = prio;
  };
  MinHeap.prototype.pop = function () {
    var items = this.items, prios = this.prios;
    var top = items[0];
    var lastItem = items.pop(), lastPrio = prios.pop();
    var n = items.length;
    if (n > 0) {
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, m = i;
        var mp = lastPrio;
        if (l < n && prios[l] < mp) { m = l; mp = prios[l]; }
        if (r < n && prios[r] < mp) { m = r; }
        if (m === i) break;
        items[i] = items[m]; prios[i] = prios[m];
        i = m;
      }
      items[i] = lastItem; prios[i] = lastPrio;
    }
    return top;
  };

  /* ---------------------------------------------------------------
   * 탐색 준비
   * ------------------------------------------------------------- */

  /** 길찾기에 필요한 정보 묶음 */
  function makeContext(state, unit) {
    var def = Data.UNITS[unit.type];
    var player = state.players[unit.owner];
    // 같은 종류 유닛 수 (자기 자신 제외)
    var occupied = {};
    state.units.forEach(function (u) {
      if (u === unit || Data.UNITS[u.type].category !== def.category) return;
      var k = Hex.index(u.q, u.r);
      occupied[k] = (occupied[k] || 0) + 1;
    });
    return {
      tiles: state.map.tiles,
      explored: player.explored,
      knowAll: !!(Game.Debug && Game.Debug.revealAll),
      domain: def.domain,
      maxMoves: def.moves,
      stackLimit: Data.RULES.stackLimits[def.category],
      occupied: occupied
    };
  }

  /** 플레이어가 아는 정보 기준으로 idx에 들어가는 비용 (Infinity = 통과 불가) */
  function enterCost(ctx, idx) {
    if (!ctx.knowAll && !ctx.explored[idx]) return Data.RULES.unexploredMoveCost;
    var tile = ctx.tiles[idx];
    return Game.Rules.isPassable(tile, ctx.domain) ? Game.Rules.moveCost(tile) : Infinity;
  }

  /** 그 칸에서 턴을 마칠 수 없는가 (같은 종류 유닛이 꽉 참) */
  function cannotStop(ctx, idx) {
    return (ctx.occupied[idx] || 0) >= ctx.stackLimit;
  }

  /** 휴리스틱 배율: 한 칸 이동이 점수를 최소 얼마나 올리는지 (허용 가능한 하한) */
  function minStepCost() {
    var m = Math.min(Data.RULES.unexploredMoveCost, Data.RULES.minMovesToEnter);
    var k;
    for (k in Data.TERRAINS) m = Math.min(m, Data.TERRAINS[k].moveCost);
    for (k in Data.FEATURES) if (Data.FEATURES[k].passable) m = Math.min(m, Data.FEATURES[k].moveCost);
    return Math.max(0.01, m);
  }

  /* ---------------------------------------------------------------
   * A*
   * ------------------------------------------------------------- */

  /**
   * unit이 targetIdx까지 가는 경로
   * @returns {{target, steps: [{idx, turn, movesLeft}], turns}|null}
   *   turn: 0 = 이번 턴에 도착하는 칸, 1 = 다음 턴 …   turns: 도착까지 걸리는 턴 수(이번 턴 = 1)
   */
  function findPath(state, unit, targetIdx) {
    var Rules = Game.Rules;
    var start = Hex.index(unit.q, unit.r);
    if (targetIdx < 0 || start < 0 || targetIdx === start) return null;
    var ctx = makeContext(state, unit);
    if (!isFinite(enterCost(ctx, targetIdx)) || cannotStop(ctx, targetIdx)) return null;

    var N = ctx.tiles.length;
    var M = ctx.maxMoves;
    var g = new Float64Array(N).fill(Infinity);
    var ml = new Float64Array(N);
    var turnAt = new Int32Array(N);
    var parent = new Int32Array(N).fill(-1);
    var closed = new Uint8Array(N);
    var hScale = minStepCost();
    var NB = Hex.grid.neighbors;
    var heap = new MinHeap();

    g[start] = M - unit.movesLeft;
    ml[start] = unit.movesLeft;
    turnAt[start] = 0;
    heap.push(start, g[start] + Hex.distance(start, targetIdx) * hScale);

    while (heap.size()) {
      var cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === targetIdx) break;
      for (var d = 0; d < 6; d++) {
        var nb = NB[cur * 6 + d];
        if (nb < 0 || closed[nb]) continue;
        var cost = enterCost(ctx, nb);
        if (!isFinite(cost)) continue;
        var t = turnAt[cur], m = ml[cur];
        if (!Rules.canEnterWithMoves(m, cost)) {
          // 지금 칸에서 턴을 마치고 다음 턴에 들어간다 → 지금 칸에 머물 수 있어야 함
          if (cur !== start && cannotStop(ctx, cur)) continue;
          t += 1;
          m = M;
        }
        var nm = Rules.movesAfterEnter(m, cost);
        if ((nm <= 0 || nb === targetIdx) && cannotStop(ctx, nb)) continue;
        var ng = t * M + (M - nm);
        if (ng < g[nb]) {
          g[nb] = ng;
          ml[nb] = nm;
          turnAt[nb] = t;
          parent[nb] = cur;
          heap.push(nb, ng + Hex.distance(nb, targetIdx) * hScale);
        }
      }
    }

    if (!closed[targetIdx]) return null;
    var steps = [];
    for (var i = targetIdx; i !== start; i = parent[i]) {
      steps.push({ idx: i, turn: turnAt[i], movesLeft: ml[i] });
    }
    steps.reverse();
    return { target: targetIdx, steps: steps, turns: turnAt[targetIdx] + 1, g: g[targetIdx] };
  }

  /**
   * 기억해 둔 경로를 현재 지식으로 다시 평가한다.
   * 그대로 따라갈 수 있으면 { g, turns, steps }, 막혔으면 null
   * (새 경로와 점수가 같으면 기존 경로를 유지해서 유닛이 이리저리 흔들리지 않게 한다)
   */
  function evaluatePath(state, unit, path) {
    var Rules = Game.Rules;
    if (!path || !path.length) return null;
    var ctx = makeContext(state, unit);
    var M = ctx.maxMoves, t = 0, m = unit.movesLeft;
    var start = Hex.index(unit.q, unit.r), cur = start;
    var steps = [];
    for (var i = 0; i < path.length; i++) {
      var nb = Hex.index(path[i].q, path[i].r);
      if (nb < 0 || cur < 0 || Hex.distance(cur, nb) !== 1) return null;
      var cost = enterCost(ctx, nb);
      if (!isFinite(cost)) return null;
      if (!Rules.canEnterWithMoves(m, cost)) {
        if (cur !== start && cannotStop(ctx, cur)) return null;
        t += 1;
        m = M;
      }
      m = Rules.movesAfterEnter(m, cost);
      if ((m <= 0 || i === path.length - 1) && cannotStop(ctx, nb)) return null;
      steps.push({ idx: nb, turn: t, movesLeft: m });
      cur = nb;
    }
    return { target: cur, steps: steps, turns: t + 1, g: t * M + (M - m) };
  }

  /**
   * 이번 턴에 이동해서 멈출 수 있는 타일들
   * @returns {Object} { 타일번호: 도착 후 남은 이동력 }
   */
  function reachableThisTurn(state, unit) {
    var Rules = Game.Rules;
    var out = {};
    var start = Hex.index(unit.q, unit.r);
    if (start < 0 || unit.movesLeft <= 0) return out;
    var ctx = makeContext(state, unit);
    var N = ctx.tiles.length;
    var best = new Float64Array(N).fill(-1);
    var NB = Hex.grid.neighbors;
    var heap = new MinHeap();
    best[start] = unit.movesLeft;
    heap.push(start, -unit.movesLeft);
    while (heap.size()) {
      var cur = heap.pop();
      var m = best[cur];
      if (m <= 0) continue;
      for (var d = 0; d < 6; d++) {
        var nb = NB[cur * 6 + d];
        if (nb < 0 || nb === start) continue;
        var cost = enterCost(ctx, nb);
        if (!isFinite(cost) || !Rules.canEnterWithMoves(m, cost)) continue;
        var nm = Rules.movesAfterEnter(m, cost);
        if (nm <= 0 && cannotStop(ctx, nb)) continue;
        if (nm > best[nb]) {
          best[nb] = nm;
          heap.push(nb, -nm);
        }
      }
    }
    for (var i = 0; i < N; i++) {
      if (i !== start && best[i] >= 0 && !cannotStop(ctx, i)) out[i] = best[i];
    }
    return out;
  }

  Game.Path = {
    findPath: findPath,
    evaluatePath: evaluatePath,
    reachableThisTurn: reachableThisTurn,
    MinHeap: MinHeap
  };
})();
