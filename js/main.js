/* ==========================================================================
 * main.js — 초기화·게임 루프·플레이어 행동
 *
 *  Game.Session : 화면·조작 상태 (선택한 유닛, 경로 미리보기 등 — 저장하지 않음)
 *  Game.Main    : 입력(input.js)·버튼(ui.js)이 부르는 플레이어 행동, 새 게임, 프레임 루프
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});
  var Data = Game.Data, Hex = Game.Hex;

  var Session = Game.Session = {
    selectedUnitId: null,
    route: null,          // { unitId, kind: 'preview'|'orders', target, steps: [{idx, turn, movesLeft}], turns }
    reachable: null,      // { 타일번호: 남은 이동력 } — 선택 유닛이 이번 턴에 갈 수 있는 곳
    hoverIdx: -1,         // 마우스가 올라간 타일
    inspectIdx: -1        // 터치로 누른 타일 (정보 패널용)
  };

  var Main = {};

  function state() { return Game.State.current; }
  function human() { return Game.State.humanPlayer(state()); }
  function unitName(u) { return Data.UNITS[u.type].name; }

  function selectedUnit() {
    var s = state();
    return s && Session.selectedUnitId != null ? Game.Units.get(s, Session.selectedUnitId) : null;
  }

  function ownUnitsAt(idx) {
    var pid = human().id;
    return Game.Units.at(state(), idx).filter(function (u) { return u.owner === pid; });
  }

  /** 받침에 따라 조사 고르기 (산은 / 바다는) */
  function josa(word, withBatchim, without) {
    var c = word.charCodeAt(word.length - 1);
    if (c < 0xAC00 || c > 0xD7A3) return word + without;
    return word + ((c - 0xAC00) % 28 ? withBatchim : without);
  }

  /** 선택 관련 화면 정보 다시 계산 (이동 가능 범위, 이동 명령 경로) + 화면 갱신 */
  function refreshSelection() {
    var s = state();
    var u = selectedUnit();
    if (!u) {
      Session.selectedUnitId = null;
      Session.reachable = null;
      Session.route = null;
    } else {
      Session.reachable = u.movesLeft > 0 ? Game.Path.reachableThisTurn(s, u) : null;
      var keepPreview = Session.route && Session.route.kind === 'preview' && Session.route.unitId === u.id;
      if (!keepPreview) {
        Session.route = null;
        if (u.moveTarget) {
          var r = Game.Path.evaluatePath(s, u, u.path) ||
            Game.Path.findPath(s, u, Hex.index(u.moveTarget.q, u.moveTarget.r));
          if (r) Session.route = { unitId: u.id, kind: 'orders', target: r.target, steps: r.steps, turns: r.turns };
        }
      }
    }
    Game.Render.invalidate();
    Game.UI.refresh();
  }

  /* ---------------------------------------------------------------
   * 선택
   * ------------------------------------------------------------- */

  Main.selectUnit = function (id, opts) {
    var u = Game.Units.get(state(), id);
    if (!u) return;
    if (Session.selectedUnitId !== id) Session.route = null;
    Session.selectedUnitId = id;
    refreshSelection();
    // 패널이 갱신된 뒤에 HUD에 가리지 않는 곳으로 카메라 이동
    if (opts && opts.center) Game.Render.centerOnTile(Hex.index(u.q, u.r), true, Game.UI.focusPoint());
  };

  Main.deselect = function () {
    Session.selectedUnitId = null;
    refreshSelection();
  };

  /** 같은 타일의 유닛 중 고르기: 명령이 필요한 유닛 → 군사 → 처음 */
  function pickUnit(units) {
    var need = units.filter(Game.Units.needsOrders);
    var pool = need.length ? need : units;
    var mil = pool.filter(function (u) { return Data.UNITS[u.type].category === 'military'; });
    return mil[0] || pool[0];
  }

  Main.cycleUnitOnTile = function () {
    var u = selectedUnit();
    if (!u) return;
    var others = ownUnitsAt(Hex.index(u.q, u.r)).filter(function (x) { return x !== u; });
    if (others.length) Main.selectUnit(others[0].id);
  };

  /* ---------------------------------------------------------------
   * 지도 입력
   * ------------------------------------------------------------- */

  Main.onHover = function (idx) {
    if (Session.hoverIdx === idx) return;
    Session.hoverIdx = idx;
    Game.UI.showTileInfo(idx >= 0 ? idx : Session.inspectIdx);
    Game.Render.invalidate();
  };

  /** 왼쪽 클릭 / 탭 */
  Main.onTap = function (idx, isTouch) {
    if (!state()) return;
    if (isTouch) {
      Session.inspectIdx = idx;
      Game.UI.showTileInfo(idx);
      Game.Render.invalidate();
    }
    if (idx < 0) {
      if (!isTouch) Main.deselect();
      return;
    }
    var sel = selectedUnit();
    var preview = Session.route && Session.route.kind === 'preview' ? Session.route : null;

    // 모바일: 미리보기한 목적지를 한 번 더 탭하면 이동 확정
    if (isTouch && sel && preview && preview.target === idx) {
      confirmMove();
      return;
    }

    var own = ownUnitsAt(idx);
    if (own.length) {
      if (sel && own.indexOf(sel) >= 0) {
        if (own.length > 1) Main.selectUnit(pickUnit(own.filter(function (u) { return u !== sel; })).id);
        else if (preview) { Session.route = null; refreshSelection(); }
        return;
      }
      Main.selectUnit(pickUnit(own).id);
      return;
    }
    if (isTouch) {
      if (sel) requestMove(idx);
      return;
    }
    Main.deselect();
  };

  /** 오른쪽 클릭 / 길게 누르기: 경로 미리보기 → 같은 곳을 한 번 더 = 이동 확정 */
  Main.onRightClick = function (idx) {
    var sel = selectedUnit();
    if (!sel || idx < 0) return;
    var preview = Session.route && Session.route.kind === 'preview' ? Session.route : null;
    if (preview && preview.target === idx) {
      confirmMove();
      return;
    }
    requestMove(idx);
  };

  function unreachableReason(s, u, idx) {
    var tile = s.map.tiles[idx];
    var known = Game.Debug.revealAll || human().explored[idx];
    if (known && !Game.Rules.isPassable(tile, Data.UNITS[u.type].domain)) {
      if (Game.Rules.isWater(tile)) return '육지 유닛은 바다로 갈 수 없습니다.';
      var block = tile.features.filter(function (f) { return !Data.FEATURES[f].passable; })[0];
      var name = block ? Data.FEATURES[block].name : Data.TERRAINS[tile.terrain].name;
      return josa(name, '은', '는') + ' 지나갈 수 없습니다.';
    }
    if (!Game.Units.canStack(s, u, idx)) return '그 타일에는 같은 종류의 유닛이 이미 있습니다.';
    return '그곳으로 가는 길을 찾을 수 없습니다.';
  }

  function requestMove(idx) {
    var s = state(), u = selectedUnit();
    if (!u) return;
    if (idx === Hex.index(u.q, u.r)) {
      if (Session.route && Session.route.kind === 'preview') {
        Session.route = null;
        refreshSelection();
      }
      return;
    }
    var path = Game.Path.findPath(s, u, idx);
    if (!path) {
      if (Session.route && Session.route.kind === 'preview') Session.route = null;
      refreshSelection();
      Game.UI.toast(unreachableReason(s, u, idx), 'warn');
      return;
    }
    Session.route = { unitId: u.id, kind: 'preview', target: idx, steps: path.steps, turns: path.turns };
    refreshSelection();
  }

  function confirmMove() {
    var s = state(), u = selectedUnit(), route = Session.route;
    if (!u || !route || route.kind !== 'preview') return;
    Game.Units.setMoveTarget(u, route.target, route.steps, { turn: s.turn, estimate: route.turns });
    Session.route = null;
    var res = Game.Units.executeMove(s, u);
    if (res.steps.length) Game.Render.animateUnitSteps(u.id, res.steps);
    if (res.blocked) Game.UI.toast(unitName(u) + ': 길이 막혀 이동을 멈췄습니다.', 'warn');
    Game.Render.invalidateFog();
    refreshSelection();
  }

  /* ---------------------------------------------------------------
   * 유닛 명령
   * ------------------------------------------------------------- */

  /** 다음으로 명령이 필요한 유닛을 고르고, 없으면 선택 해제 */
  function selectNextOrNone(afterId) {
    var next = Game.Units.nextNeedingOrders(state(), human().id, afterId);
    if (next) Main.selectUnit(next.id, { center: true });
    else Main.deselect();
  }

  /** 대기: 이번 턴만 건너뛰기 */
  Main.skipSelected = function () {
    var u = selectedUnit();
    if (!u || u.movesLeft <= 0 || u.skipTurn) return;
    u.skipTurn = true;
    Session.route = null;
    selectNextOrNone(u.id);
  };

  /** 경계: 직접 깨울 때까지 건너뛰기 (경계 중이면 깨우기) */
  Main.toggleSentrySelected = function () {
    var u = selectedUnit();
    if (!u) return;
    if (u.sentry) {
      u.sentry = false;
      Game.UI.toast(josa(unitName(u), '이', '가') + ' 경계를 풀었습니다.');
      refreshSelection();
      return;
    }
    u.sentry = true;
    Game.Units.clearOrders(u);
    Session.route = null;
    selectNextOrNone(u.id);
  };

  /** 이동 취소: 미리보기 → 이동 명령 순으로 취소 */
  Main.cancelMoveSelected = function () {
    var u = selectedUnit();
    if (!u) return;
    if (Session.route && Session.route.kind === 'preview') {
      Session.route = null;
      refreshSelection();
      return;
    }
    if (u.moveTarget) {
      Game.Units.clearOrders(u);
      refreshSelection();
      Game.UI.toast(unitName(u) + ' 이동 명령을 취소했습니다.');
    }
  };

  /** Esc: 미리보기 취소 → 선택 해제 */
  Main.cancelOrDeselect = function () {
    if (Session.route && Session.route.kind === 'preview') {
      Session.route = null;
      refreshSelection();
    } else if (Session.selectedUnitId != null) {
      Main.deselect();
    }
  };

  /* ---------------------------------------------------------------
   * 턴
   * ------------------------------------------------------------- */

  /** 턴 종료 버튼 / Enter: 명령이 필요한 유닛이 있으면 그 유닛으로, 없으면 턴 종료 */
  Main.endTurnOrNextUnit = function () {
    var s = state();
    if (!s || Game.UI.isModalOpen()) return;
    var next = Game.Units.nextNeedingOrders(s, human().id, Session.selectedUnitId);
    if (next) Main.selectUnit(next.id, { center: true });
    else Main.endTurn();
  };

  Main.endTurn = function () {
    var s = state();
    if (!s) return;
    Session.route = null;
    var events = Game.Turn.processTurn(s);
    events.forEach(function (e) {
      var u = Game.Units.get(s, e.unitId);
      if (e.type === 'unitMoved') Game.Render.animateUnitSteps(e.unitId, e.steps);
      else if (e.type === 'moveBlocked' && u) Game.UI.toast(unitName(u) + ': 목적지로 가는 길을 찾지 못해 이동 명령을 취소했습니다.', 'warn');
      else if (e.type === 'unitArrived' && u) Game.UI.toast(josa(unitName(u), '이', '가') + ' 목적지에 도착했습니다.');
    });
    Game.Render.invalidateFog();
    Game.UI.toast('턴 ' + s.turn + ' · ' + Game.Turn.formatYear(s.year));
    // 새 턴: 명령이 필요한 첫 유닛을 선택
    var first = Game.Units.nextNeedingOrders(s, human().id, null);
    if (first) Main.selectUnit(first.id, { center: true });
    else Main.deselect();
  };

  /* ---------------------------------------------------------------
   * 디버그
   * ------------------------------------------------------------- */

  Main.toggleRevealAll = function () {
    Game.Debug.revealAll = !Game.Debug.revealAll;
    if (Session.route && Session.route.kind === 'preview') Session.route = null;   // 아는 정보가 바뀌었으니
    Game.UI.toast(Game.Debug.revealAll ? '디버그: 안개 전체 해제' : '디버그: 안개 복구');
    Game.Render.invalidateFog();
    refreshSelection();
  };

  /* ---------------------------------------------------------------
   * 새 게임
   * ------------------------------------------------------------- */

  /** @param {{seedText?: string, seed?: number, sizeKey?: string}} opts */
  Main.newGame = function (opts) {
    opts = opts || {};
    var seed = opts.seed != null ? opts.seed >>> 0 : Game.RNG.parseSeed(opts.seedText);
    var s = Game.State.createNewGame({ seed: seed, sizeKey: opts.sizeKey });
    Game.State.attach(s);
    Session.selectedUnitId = null;
    Session.route = null;
    Session.reachable = null;
    Session.hoverIdx = -1;
    Session.inspectIdx = -1;
    Game.Render.onNewState(s, human().startIdx);
    Game.UI.hideNewGame();
    var first = Game.Units.nextNeedingOrders(s, human().id, null);
    if (first) Main.selectUnit(first.id);
    else refreshSelection();
    Game.Render.centerOnTile(human().startIdx, false, Game.UI.focusPoint());
    Game.UI.toast('새 게임 · 시드 ' + seed + ' · ' + Data.MAP.sizes[s.sizeKey].name + ' 지도');
    return s;
  };

  /* ---------------------------------------------------------------
   * 게임 루프
   * ------------------------------------------------------------- */

  var lastTime = 0;

  function frame(now) {
    var dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 1 / 60;
    lastTime = now;
    Game.Input.update(dt);
    Game.Render.update(dt);
    if (Game.Render.dirty) Game.Render.draw();
    requestAnimationFrame(frame);
  }

  Main.init = function () {
    var canvas = document.getElementById('map-canvas');
    var minimap = document.getElementById('minimap');
    Game.Render.init(canvas, minimap);
    Game.Input.init(canvas, minimap);
    Game.UI.init();
    var onResize = function () { Game.Render.resize(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    Game.UI.showNewGame(false);
    requestAnimationFrame(frame);
  };

  Game.Main = Main;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', Main.init);
  else Main.init();
})();
