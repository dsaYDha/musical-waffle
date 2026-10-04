/* ==========================================================================
 * state.js — 게임 상태와 규칙
 *
 *  게임 상태(state)는 하나의 순수 데이터 객체다. DOM 요소·함수를 넣지 않으므로
 *  JSON.stringify / JSON.parse 로 그대로 저장·복원할 수 있다.
 *
 *  state = {
 *    version, seed, sizeKey, turn, year,
 *    rng:     { s }                      게임 진행용 난수 상태
 *    map:     { width, height, wrapX, tiles: [{ terrain, features: [] }], meta }
 *    players: [{ id, name, color, isHuman, gold, science, explored: [0|1], visible: [0|1], startIdx }]
 *    currentPlayer,
 *    units:   [{ id, type, owner, q, r, movesLeft, sentry, skipTurn,
 *               moveTarget: {q, r, issuedTurn, estimate}|null, path: [{q,r}]|null }]
 *    nextUnitId
 *  }
 *
 *  이 파일의 이름공간
 *   Game.Rules  — 데이터(data.js)로 타일 산출·이동 비용·통과 여부 등을 계산
 *   Game.Units  — 유닛 생성·명령·이동 실행
 *   Game.Vision — 전장의 안개(탐험/현재 시야)
 *   Game.Turn   — 연도 계산, 턴 처리(processTurn)
 *   Game.State  — 새 게임 만들기, 현재 상태, 직렬화
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});
  var Data = Game.Data, Hex = Game.Hex, RNG = Game.RNG;

  // 디버그 설정 — 게임 상태가 아니므로 저장하지 않는다
  Game.Debug = { revealAll: false };

  function zeros(n) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = 0;
    return a;
  }

  /* ===================================================================
   * Rules — 타일 규칙
   * ================================================================= */
  var Rules = {
    terrain: function (tile) {
      return Data.TERRAINS[tile.terrain];
    },

    hasFeature: function (tile, key) {
      return tile.features.indexOf(key) >= 0;
    },

    isWater: function (tile) {
      return Data.TERRAINS[tile.terrain].domain === 'water';
    },

    /** 산출량 = 지형 산출 (+ 특성 보정, 'replace' 특성은 대체) — 음수는 0 */
    yields: function (tile) {
      var t = Data.TERRAINS[tile.terrain];
      var out = {}, k;
      for (k in Data.YIELDS) out[k] = t.yields[k] || 0;
      tile.features.forEach(function (fk) {
        var f = Data.FEATURES[fk];
        if (f.yieldMode === 'replace') for (k in out) out[k] = f.yields[k] || 0;
      });
      tile.features.forEach(function (fk) {
        var f = Data.FEATURES[fk];
        if (f.yieldMode !== 'replace') for (k in out) out[k] += f.yields[k] || 0;
      });
      for (k in out) if (out[k] < 0) out[k] = 0;
      return out;
    },

    /** 이동 비용 = 지형·특성 비용 중 가장 큰 값 */
    moveCost: function (tile) {
      var c = Data.TERRAINS[tile.terrain].moveCost;
      for (var i = 0; i < tile.features.length; i++) c = Math.max(c, Data.FEATURES[tile.features[i]].moveCost);
      return c;
    },

    /** domain('land'|'water') 유닛이 들어갈 수 있는가. domain을 생략하면 지형 자체의 통과 여부만 본다 */
    isPassable: function (tile, domain) {
      var t = Data.TERRAINS[tile.terrain];
      if (!t.passable || (domain && t.domain !== domain)) return false;
      for (var i = 0; i < tile.features.length; i++) if (!Data.FEATURES[tile.features[i]].passable) return false;
      return true;
    },

    /** 방어 보너스(%) — 이번 단계는 표시만 */
    defense: function (tile) {
      var d = Data.TERRAINS[tile.terrain].defense || 0;
      tile.features.forEach(function (fk) { d += Data.FEATURES[fk].defense || 0; });
      return d;
    },

    sightBonus: function (tile) {
      var b = 0;
      tile.features.forEach(function (fk) { b += Data.FEATURES[fk].sightBonus || 0; });
      return b;
    },

    sightHeight: function (tile) {
      var h = 0;
      tile.features.forEach(function (fk) { h = Math.max(h, Data.FEATURES[fk].sightHeight || 0); });
      return h;
    },

    sightBlock: function (tile) {
      var b = 0;
      for (var i = 0; i < tile.features.length; i++) b = Math.max(b, Data.FEATURES[tile.features[i]].sightBlock || 0);
      return b;
    },

    /** 문명 방식: 비용만큼 이동력이 없어도 minMovesToEnter 이상 남아 있으면 한 칸 진입 가능 */
    canEnterWithMoves: function (movesLeft, cost) {
      return movesLeft > 0 && (movesLeft >= cost || movesLeft >= Data.RULES.minMovesToEnter);
    },

    movesAfterEnter: function (movesLeft, cost) {
      return movesLeft >= cost ? movesLeft - cost : 0;
    }
  };

  /* ===================================================================
   * Vision — 전장의 안개
   *   explored[i] = 1 : 한 번이라도 본 타일 (마지막으로 본 모습을 어둡게 표시)
   *   visible[i]  = 1 : 지금 유닛 시야 안
   *   ※ 이후 도시·시설처럼 변하는 요소가 생기면 '마지막으로 본 정보'를 따로 기록해 두면 된다.
   * ================================================================= */
  var Vision = {
    sightRadius: function (unit, tile) {
      return Data.RULES.baseSight + (Data.UNITS[unit.type].sightBonus || 0) + Rules.sightBonus(tile);
    },

    /** from에서 to가 보이는가 — 사이에 있는 타일의 sightBlock이 보는 높이보다 크면 가려진다 */
    hasLineOfSight: function (tiles, from, to, eyeHeight) {
      var line = Hex.line(from, to);
      for (var i = 1; i < line.length - 1; i++) {
        if (Rules.sightBlock(tiles[line[i]]) > eyeHeight) return false;
      }
      return true;
    },

    /** 플레이어의 현재 시야를 다시 계산. 새로 탐험한 타일 수를 돌려준다 */
    update: function (state, playerId) {
      var player = state.players[playerId];
      var vis = player.visible, exp = player.explored, tiles = state.map.tiles;
      var i;
      for (i = 0; i < vis.length; i++) vis[i] = 0;
      state.units.forEach(function (u) {
        if (u.owner !== playerId) return;
        var from = Hex.index(u.q, u.r);
        var tile = tiles[from];
        var eye = Rules.sightHeight(tile);
        Hex.range(from, Vision.sightRadius(u, tile)).forEach(function (to) {
          if (!vis[to] && Vision.hasLineOfSight(tiles, from, to, eye)) vis[to] = 1;
        });
      });
      var newly = 0;
      for (i = 0; i < vis.length; i++) {
        if (vis[i] && !exp[i]) { exp[i] = 1; newly++; }
      }
      return newly;
    }
  };

  /* ===================================================================
   * Units — 유닛
   * ================================================================= */
  var Units = {
    def: function (unit) {
      return Data.UNITS[unit.type];
    },

    tileIndex: function (unit) {
      return Hex.index(unit.q, unit.r);
    },

    create: function (state, type, owner, idx) {
      var c = Hex.coords(idx);
      var unit = {
        id: state.nextUnitId++,
        type: type,
        owner: owner,
        q: c.q,
        r: c.r,
        movesLeft: Data.UNITS[type].moves,
        sentry: false,       // 경계: 직접 깨울 때까지 '다음 유닛'에서 건너뜀
        skipTurn: false,     // 대기: 이번 턴만 건너뜀
        moveTarget: null,    // 여러 턴 이동 목적지
        path: null           // 남은 경로 (현재 위치 제외)
      };
      state.units.push(unit);
      return unit;
    },

    get: function (state, id) {
      for (var i = 0; i < state.units.length; i++) if (state.units[i].id === id) return state.units[i];
      return null;
    },

    at: function (state, idx) {
      return state.units.filter(function (u) { return Hex.index(u.q, u.r) === idx; });
    },

    /** idx 타일에 unit이 머물 수 있는가 (같은 종류 유닛 수 제한) */
    canStack: function (state, unit, idx) {
      var cat = Data.UNITS[unit.type].category;
      var limit = Data.RULES.stackLimits[cat];
      var n = 0;
      for (var i = 0; i < state.units.length; i++) {
        var u = state.units[i];
        if (u !== unit && Data.UNITS[u.type].category === cat && Hex.index(u.q, u.r) === idx) n++;
      }
      return n < limit;
    },

    /** 이번 턴에 명령이 필요한 유닛인가 ('다음 유닛' 대상) */
    needsOrders: function (unit) {
      return unit.movesLeft > 0 && !unit.sentry && !unit.skipTurn && !unit.moveTarget;
    },

    countNeedingOrders: function (state, playerId) {
      return state.units.filter(function (u) { return u.owner === playerId && Units.needsOrders(u); }).length;
    },

    /** afterId 다음 순서로 명령이 필요한 유닛 (한 바퀴 돌아 처음으로) */
    nextNeedingOrders: function (state, playerId, afterId) {
      var list = state.units.filter(function (u) { return u.owner === playerId; });
      var start = 0;
      for (var i = 0; i < list.length; i++) if (list[i].id === afterId) { start = i + 1; break; }
      for (var k = 0; k < list.length; k++) {
        var u = list[(start + k) % list.length];
        if (Units.needsOrders(u)) return u;
      }
      return null;
    },

    /**
     * 이동 명령 지정
     * @param info {turn, estimate} 명령을 내린 턴과 예상 소요 턴 (너무 오래 헤매면 포기하는 기준)
     */
    setMoveTarget: function (unit, targetIdx, steps, info) {
      var c = Hex.coords(targetIdx);
      unit.moveTarget = {
        q: c.q, r: c.r,
        issuedTurn: info && info.turn != null ? info.turn : null,
        estimate: info && info.estimate ? info.estimate : null
      };
      unit.path = steps ? steps.map(function (s) { return Hex.coords(s.idx); }) : null;
      unit.sentry = false;
      unit.skipTurn = false;
    },

    pathEndsAt: function (unit, idx) {
      if (!unit.path || !unit.path.length) return false;
      var last = unit.path[unit.path.length - 1];
      return Hex.index(last.q, last.r) === idx;
    },

    clearOrders: function (unit) {
      unit.moveTarget = null;
      unit.path = null;
    },

    /** 턴 시작: 이동력 회복, '대기' 해제 */
    startTurn: function (state, playerId) {
      state.units.forEach(function (u) {
        if (u.owner !== playerId) return;
        u.movesLeft = Data.UNITS[u.type].moves;
        u.skipTurn = false;
      });
    },

    /**
     * 목적지(moveTarget)를 향해 이번 턴 이동력만큼 이동한다.
     * 새 땅이 보이면 경로를 다시 계산하고, 길이 막히면 명령을 지운다.
     * @returns {{unitId, steps: number[], arrived, blocked, waiting}} steps = 지나간 타일 번호(애니메이션용)
     */
    executeMove: function (state, unit) {
      var result = { unitId: unit.id, steps: [], arrived: false, blocked: false, waiting: false };
      if (!unit.moveTarget) return result;
      var tiles = state.map.tiles;
      var def = Data.UNITS[unit.type];
      var target = Hex.index(unit.moveTarget.q, unit.moveTarget.r);
      var lastValid = Hex.index(unit.q, unit.r);    // 겹치기 규칙을 지킨 마지막 위치

      // 미탐험 땅을 지나는 경로는 실제로 막혀 있을 수 있다 — 예상보다 너무 오래 걸리면 포기
      var mt = unit.moveTarget;
      if (mt.issuedTurn != null && mt.estimate) {
        var limit = Math.max(Data.RULES.moveGiveUpMinTurns, Math.ceil(mt.estimate * Data.RULES.moveGiveUpFactor));
        if (state.turn - mt.issuedTurn >= limit) {
          result.blocked = true;
          Units.clearOrders(unit);
          return result;
        }
      }
      var needPlan = true;            // 매번 최신 지식(탐험 상태·유닛 위치)으로 경로를 다시 계산
      var justPlanned = false;
      var guard = 0;

      while (unit.movesLeft > 0 && guard++ < 1000) {
        if (Hex.index(unit.q, unit.r) === target) break;
        if (needPlan) {
          var plan = Game.Path.findPath(state, unit, target);
          if (!plan) { result.blocked = true; break; }
          // 기억해 둔 경로가 여전히 최선이면 그대로 따라간다 (같은 점수의 다른 길로 흔들리지 않게)
          var kept = Units.pathEndsAt(unit, target) ? Game.Path.evaluatePath(state, unit, unit.path) : null;
          if (!kept || kept.g > plan.g) unit.path = plan.steps.map(function (s) { return Hex.coords(s.idx); });
          needPlan = false;
          justPlanned = true;
        }
        var next = Hex.index(unit.path[0].q, unit.path[0].r);
        var tile = next >= 0 ? tiles[next] : null;
        var passable = !!tile && Rules.isPassable(tile, def.domain);
        var cost = passable ? Rules.moveCost(tile) : Infinity;
        var after = Rules.movesAfterEnter(unit.movesLeft, cost);
        var stopsThere = next === target || after <= 0;
        if (!passable || (!Units.canStack(state, unit, next) && stopsThere)) {
          // 갓 계산한 경로도 안 되면 이번 턴은 멈춘다 (목적지가 막혔으면 명령 취소)
          if (justPlanned) {
            if (next === target || !passable) result.blocked = true;
            else result.waiting = true;
            break;
          }
          needPlan = true;
          continue;
        }
        if (!Rules.canEnterWithMoves(unit.movesLeft, cost)) { result.waiting = true; break; }

        unit.movesLeft = after;
        unit.q = unit.path[0].q;
        unit.r = unit.path[0].r;
        unit.path.shift();
        result.steps.push(next);
        justPlanned = false;
        if (Units.canStack(state, unit, next)) lastValid = next;
        if (Vision.update(state, unit.owner) > 0) needPlan = true;   // 새로 보인 땅 반영
        if (!unit.path.length && next !== target) needPlan = true;
      }

      var end = Hex.index(unit.q, unit.r);
      // 지나가던 칸(같은 종류 유닛이 있는 칸)에서 멈추게 되면 마지막 정상 위치로 되돌린다 (드문 경우)
      if (end !== lastValid && !Units.canStack(state, unit, end)) {
        var back = Hex.coords(lastValid);
        unit.q = back.q;
        unit.r = back.r;
        unit.movesLeft = 0;
        result.steps.push(lastValid);
        Vision.update(state, unit.owner);
        end = lastValid;
      }
      if (end === target) {
        result.arrived = true;
        Units.clearOrders(unit);
      } else if (result.blocked) {
        Units.clearOrders(unit);
      }
      return result;
    }
  };

  /* ===================================================================
   * Turn — 연도와 턴 처리
   * ================================================================= */
  var Turn = {
    /** 턴 번호 → 연도 (음수 = 기원전) */
    yearForTurn: function (turn) {
      var cal = Data.CALENDAR;
      var year = cal.startYear, remaining = turn - 1, last = null;
      for (var i = 0; i < cal.steps.length && remaining > 0; i++) {
        var st = cal.steps[i];
        var n = st.turns > 0 ? Math.min(st.turns, remaining) : remaining;
        year += n * st.years;
        remaining -= n;
        last = st;
      }
      if (remaining > 0 && last) year += remaining * last.years;
      return year;
    },

    formatYear: function (year) {
      return year < 0 ? '기원전 ' + (-year) + '년' : '서기 ' + Math.max(1, year) + '년';
    },

    /**
     * 턴 처리 — 턴 종료 버튼을 누르면 호출된다.
     * 이후 단계의 처리(도시·연구·AI 등)는 표시된 자리에 끼워 넣는다.
     * @returns {Array} UI·애니메이션에 넘길 이벤트 목록
     */
    processTurn: function (state) {
      var events = [];

      // ① 플레이어별 턴 마무리 — (2단계) 도시 성장·생산, (이후) 연구 진행, 금 수입 등
      state.players.forEach(function (p) { endPlayerTurn(state, p, events); });

      // ② (이후 단계) AI 문명 행동

      // ③ 턴 번호·연도 갱신
      state.turn += 1;
      state.year = Turn.yearForTurn(state.turn);

      // ④ 새 턴 시작: 유닛 이동력 회복, '대기' 해제
      state.players.forEach(function (p) { Units.startTurn(state, p.id); });

      // ⑤ 예약된 다중 턴 이동 진행
      state.units.forEach(function (u) {
        if (!u.moveTarget) return;
        var res = Units.executeMove(state, u);
        if (res.steps.length) events.push({ type: 'unitMoved', unitId: u.id, steps: res.steps });
        if (res.arrived) events.push({ type: 'unitArrived', unitId: u.id });
        if (res.blocked) events.push({ type: 'moveBlocked', unitId: u.id });
      });

      // ⑥ 시야 갱신
      state.players.forEach(function (p) { Vision.update(state, p.id); });

      return events;
    }
  };

  /** 플레이어 한 명의 턴 마무리 (이번 단계에서는 할 일이 없다 — 2단계에서 도시 처리를 여기에) */
  function endPlayerTurn(state, player, events) {
  }

  /* ===================================================================
   * State — 새 게임·현재 상태·직렬화
   * ================================================================= */

  /** center에서 가까운 곳 중 유닛이 설 수 있는 타일에 배치 */
  function placeUnit(state, type, owner, center) {
    var def = Data.UNITS[type];
    var probe = { type: type };
    var tiles = state.map.tiles;
    var seen = {};
    var queue = [center];
    seen[center] = true;
    for (var qi = 0; qi < queue.length; qi++) {
      var idx = queue[qi];
      if (Rules.isPassable(tiles[idx], def.domain) && Units.canStack(state, probe, idx)) {
        return Units.create(state, type, owner, idx);
      }
      if (Hex.distance(center, idx) >= 3) continue;
      Hex.neighbors(idx).forEach(function (n) {
        if (!seen[n] && Rules.isPassable(tiles[n], def.domain)) { seen[n] = true; queue.push(n); }
      });
    }
    return null;
  }

  /** 시작 위치를 못 찾은 경우를 위한 예비: 아무 통과 가능한 육지 */
  function anyLandTile(state) {
    for (var i = 0; i < state.map.tiles.length; i++) {
      if (Rules.isPassable(state.map.tiles[i], 'land')) return i;
    }
    return 0;
  }

  var State = {
    VERSION: 1,
    current: null,

    /**
     * 새 게임 상태 만들기
     * @param {{seed: number, sizeKey: string}} opts
     */
    createNewGame: function (opts) {
      var sizeKey = Data.MAP.sizes[opts.sizeKey] ? opts.sizeKey : Data.MAP.defaultSize;
      var size = Data.MAP.sizes[sizeKey];
      var seed = opts.seed >>> 0;
      var map = Game.MapGen.generate(seed, size.width, size.height);
      var N = map.tiles.length;

      var state = {
        version: State.VERSION,
        seed: seed,
        sizeKey: sizeKey,
        turn: 1,
        year: Turn.yearForTurn(1),
        rng: RNG.create((seed ^ 0x5bd1e995) >>> 0),
        map: map,
        players: Data.PLAYERS.map(function (p, i) {
          return {
            id: i, name: p.name, color: p.color, isHuman: !!p.isHuman,
            gold: 0, science: 0,
            explored: zeros(N), visible: zeros(N),
            startIdx: -1
          };
        }),
        currentPlayer: 0,
        units: [],
        nextUnitId: 1
      };

      var starts = Game.MapGen.findStartLocations(map, state.players.length, state.rng);
      state.players.forEach(function (p, i) {
        var idx = starts[i] !== undefined ? starts[i] : anyLandTile(state);
        p.startIdx = idx;
        Data.START.units.forEach(function (type) { placeUnit(state, type, p.id, idx); });
        Vision.update(state, p.id);
      });
      return state;
    },

    /** 상태를 현재 게임으로 지정 (좌표 계층 준비 + 시야 계산) */
    attach: function (state) {
      Hex.setGrid(state.map.width, state.map.height, state.map.wrapX);
      State.current = state;
      state.players.forEach(function (p) { Vision.update(state, p.id); });
      return state;
    },

    humanPlayer: function (state) {
      for (var i = 0; i < state.players.length; i++) if (state.players[i].isHuman) return state.players[i];
      return state.players[0];
    },

    /** 저장용 문자열 (나중에 저장/불러오기 UI에서 사용) */
    serialize: function (state) {
      return JSON.stringify(state);
    },

    deserialize: function (text) {
      var state = JSON.parse(text);
      if (!state || state.version !== State.VERSION) throw new Error('지원하지 않는 저장 데이터입니다.');
      return State.attach(state);
    }
  };

  Game.Rules = Rules;
  Game.Vision = Vision;
  Game.Units = Units;
  Game.Turn = Turn;
  Game.State = State;
})();
