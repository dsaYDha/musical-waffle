/* ==========================================================================
 * ui.js — HUD·패널 (DOM)
 *
 *  상단 바(턴·연도·금·과학), 타일 정보, 유닛 패널·명령 버튼, 턴 종료 버튼,
 *  알림(토스트), 새 게임 화면. 화면 표시만 맡고 동작은 Game.Main에 넘긴다.
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});
  var Data = Game.Data;

  var UI = {};
  var el = {};

  var IDS = [
    'tb-turn', 'tb-year', 'tb-gold', 'tb-science', 'tb-seed', 'debug-badge', 'btn-new-game',
    'tile-panel', 'tile-name', 'tile-coord', 'tile-body',
    'unit-panel', 'unit-icon', 'unit-name', 'unit-moves', 'unit-status', 'btn-swap-unit',
    'btn-skip', 'btn-sentry', 'btn-cancel-move', 'btn-found-city', 'found-city-wrap',
    'btn-end-turn', 'end-turn-label', 'end-turn-sub', 'toasts',
    'new-game', 'new-game-form', 'ng-seed', 'ng-size', 'ng-cancel', 'ng-current'
  ];

  function camel(id) {
    return id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function M() { return Game.Main; }

  /** 버튼 클릭 → 동작 (누른 뒤 포커스를 풀어서 Enter/Space가 버튼을 다시 누르지 않게) */
  function onClick(button, fn) {
    button.addEventListener('click', function (e) {
      fn(e);
      button.blur();
    });
  }

  UI.init = function () {
    IDS.forEach(function (id) { el[camel(id)] = document.getElementById(id); });

    // 지도 크기 선택지는 data.js에서 만든다
    Object.keys(Data.MAP.sizes).forEach(function (k) {
      var z = Data.MAP.sizes[k];
      var o = document.createElement('option');
      o.value = k;
      o.textContent = z.name + ' (' + z.width + '×' + z.height + ')';
      if (k === Data.MAP.defaultSize) o.selected = true;
      el.ngSize.appendChild(o);
    });

    el.newGameForm.addEventListener('submit', function (e) {
      e.preventDefault();
      M().newGame({ seedText: el.ngSeed.value, sizeKey: el.ngSize.value });
    });
    onClick(el.ngCancel, function () { UI.hideNewGame(); });
    el.newGame.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.ngCancel.classList.contains('hidden')) UI.hideNewGame();
    });

    onClick(el.btnNewGame, function () { UI.showNewGame(true); });
    onClick(el.btnEndTurn, function () { M().endTurnOrNextUnit(); });
    onClick(el.btnSkip, function () { M().skipSelected(); });
    onClick(el.btnSentry, function () { M().toggleSentrySelected(); });
    onClick(el.btnCancelMove, function () { M().cancelMoveSelected(); });
    onClick(el.btnSwapUnit, function () { M().cycleUnitOnTile(); });

    // '도시 건설'은 비활성 — 눌러도(터치) 안내를 보여 준다
    el.foundCityWrap.addEventListener('click', function () {
      el.foundCityWrap.classList.add('show-tip');
      setTimeout(function () { el.foundCityWrap.classList.remove('show-tip'); }, 1600);
    });
  };

  /* ---------------------------------------------------------------
   * 새 게임 화면
   * ------------------------------------------------------------- */

  UI.showNewGame = function (allowCancel) {
    var state = Game.State.current;
    el.ngCancel.classList.toggle('hidden', !allowCancel);
    if (state) el.ngSize.value = state.sizeKey;
    el.ngCurrent.classList.toggle('hidden', !state);
    if (state) el.ngCurrent.textContent = '지금 게임의 시드: ' + state.seed + ' (같은 시드를 넣으면 같은 지도)';
    el.newGame.classList.remove('hidden');
    // 터치 기기에서는 자판이 갑자기 올라오지 않도록 자동 포커스하지 않는다
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
      setTimeout(function () { el.ngSeed.focus(); }, 30);
    }
  };

  UI.hideNewGame = function () {
    el.newGame.classList.add('hidden');
    // 시작 버튼에 포커스가 남아 있으면 Space/Enter가 다시 새 게임을 시작하므로 풀어 준다
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  };

  UI.isModalOpen = function () {
    return !!el.newGame && !el.newGame.classList.contains('hidden');
  };

  /* ---------------------------------------------------------------
   * 알림
   * ------------------------------------------------------------- */

  UI.toast = function (message, kind, ms) {
    var d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
    d.textContent = message;
    el.toasts.appendChild(d);
    while (el.toasts.children.length > 4) el.toasts.removeChild(el.toasts.firstChild);
    var life = ms || 2200;
    setTimeout(function () { d.classList.add('fade'); }, life);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, life + 350);
  };

  /* ---------------------------------------------------------------
   * 상단 바·턴 종료 버튼
   * ------------------------------------------------------------- */

  UI.refreshTopBar = function () {
    var state = Game.State.current;
    if (!state) return;
    var p = Game.State.humanPlayer(state);
    el.tbTurn.textContent = state.turn;
    el.tbYear.textContent = Game.Turn.formatYear(state.year);
    el.tbGold.textContent = p.gold;
    el.tbScience.textContent = p.science;
    el.tbSeed.textContent = state.seed;
    el.debugBadge.classList.toggle('hidden', !Game.Debug.revealAll);
  };

  UI.refreshEndTurn = function () {
    var state = Game.State.current;
    if (!state) return;
    var count = Game.Units.countNeedingOrders(state, Game.State.humanPlayer(state).id);
    var next = count > 0;
    var key = isTouch() ? '' : 'Enter';
    el.endTurnLabel.textContent = next ? '다음 유닛' : '턴 종료';
    el.endTurnSub.textContent = next ? '명령 대기 ' + count + '개' + (key ? ' · ' + key : '') : key;
    el.btnEndTurn.classList.toggle('next-unit', next);
  };

  /* ---------------------------------------------------------------
   * 타일 정보
   * ------------------------------------------------------------- */

  function row(label, valueHtml) {
    return '<div class="info-row"><span>' + esc(label) + '</span><span>' + valueHtml + '</span></div>';
  }

  UI.showTileInfo = function (idx) {
    var state = Game.State.current;
    if (!state || idx == null || idx < 0) {
      el.tilePanel.classList.add('hidden');
      return;
    }
    var Rules = Game.Rules;
    var player = Game.State.humanPlayer(state);
    var reveal = Game.Debug.revealAll;
    var explored = reveal || !!player.explored[idx];
    var visible = reveal || !!player.visible[idx];
    var c = Game.Hex.coords(idx);
    el.tileCoord.textContent = '(' + c.q + ', ' + c.r + ')';
    el.tilePanel.classList.remove('hidden');

    if (!explored) {
      el.tileName.textContent = '미탐험 지역';
      el.tileBody.innerHTML = '<div class="info-note">아직 탐험하지 않은 곳입니다.</div>';
      return;
    }

    var tile = state.map.tiles[idx];
    var t = Data.TERRAINS[tile.terrain];
    el.tileName.textContent = t.name;

    var feats = tile.features.map(function (f) { return Data.FEATURES[f].name; }).join(', ') || '없음';
    var y = Rules.yields(tile);
    var yields = Object.keys(Data.YIELDS).map(function (k) {
      return '<span class="yield yield-' + esc(k) + '">' + esc(Data.YIELDS[k].name) + ' ' + y[k] + '</span>';
    }).join(' ');

    var move;
    if (Rules.isPassable(tile, 'land')) move = String(Rules.moveCost(tile));
    else if (Rules.isPassable(tile) && t.domain === 'water') move = '<span class="bad">육지 유닛 통과 불가</span>';
    else move = '<span class="bad">통과 불가</span>';

    var def = Rules.defense(tile);
    var defense = !Rules.isPassable(tile) ? '—' : (def > 0 ? '+' + def + '%' : (def < 0 ? def + '%' : '없음'));

    var html = row('특성', esc(feats)) + row('산출', yields) + row('이동 비용', move) +
      row('방어 보너스', esc(defense));
    if (visible) {
      var units = Game.Units.at(state, idx).map(function (u) { return Data.UNITS[u.type].name; });
      if (units.length) html += row('유닛', esc(units.join(', ')));
    } else {
      html += '<div class="info-note">지금은 보이지 않음 — 마지막으로 본 모습</div>';
    }
    el.tileBody.innerHTML = html;
  };

  /* ---------------------------------------------------------------
   * 유닛 패널
   * ------------------------------------------------------------- */

  function isTouch() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  function turnsText(turns) {
    return turns <= 1 ? '이번 턴에 도착' : '도착까지 ' + turns + '턴';
  }

  UI.refreshUnitPanel = function () {
    var state = Game.State.current;
    var S = Game.Session;
    var unit = state && S.selectedUnitId != null ? Game.Units.get(state, S.selectedUnitId) : null;
    if (!unit) {
      el.unitPanel.classList.add('hidden');
      return;
    }
    el.unitPanel.classList.remove('hidden');
    var def = Data.UNITS[unit.type];
    var idx = Game.Hex.index(unit.q, unit.r);
    var tile = state.map.tiles[idx];

    el.unitIcon.style.background = state.players[unit.owner].color;
    el.unitIcon.classList.toggle('civilian', def.category === 'civilian');
    el.unitName.textContent = def.name;
    el.unitMoves.textContent = (def.category === 'civilian' ? '민간' : '군사') +
      ' · 이동력 ' + unit.movesLeft + ' / ' + def.moves + ' · 시야 ' + Game.Vision.sightRadius(unit, tile);

    var route = S.route && S.route.unitId === unit.id ? S.route : null;
    var status;
    if (route && route.kind === 'preview') {
      status = '경로 미리보기 · ' + turnsText(route.turns) + ' — 한 번 더 누르면 이동';
    } else if (unit.moveTarget) {
      status = '이동 중 · ' + (route ? turnsText(route.turns) : '경로 다시 찾는 중');
    } else if (unit.sentry) {
      status = '경계 중 — [깨우기]를 누를 때까지 건너뜀';
    } else if (unit.skipTurn) {
      status = '이번 턴 대기';
    } else if (unit.movesLeft <= 0) {
      status = '이번 턴 이동 끝';
    } else {
      status = isTouch() ? '명령 대기 중 — 목적지를 탭하세요' : '명령 대기 중 — 목적지를 우클릭하세요';
    }
    el.unitStatus.textContent = status;

    el.btnSkip.disabled = unit.movesLeft <= 0 || unit.skipTurn;
    el.btnSentry.textContent = unit.sentry ? '깨우기' : '경계';
    el.btnSentry.title = unit.sentry ? '경계를 풀고 다시 명령 받기 (F)' : '직접 깨울 때까지 건너뛰기 (F)';
    el.btnSentry.classList.toggle('active', !!unit.sentry);
    el.btnCancelMove.disabled = !(unit.moveTarget || (route && route.kind === 'preview'));
    el.foundCityWrap.classList.toggle('hidden', (def.abilities || []).indexOf('foundCity') < 0);

    var others = Game.Units.at(state, idx).filter(function (u) { return u !== unit && u.owner === unit.owner; });
    el.btnSwapUnit.classList.toggle('hidden', others.length === 0);
    if (others.length) el.btnSwapUnit.textContent = Data.UNITS[others[0].type].name + ' 선택';
  };

  /** HUD 패널에 가리지 않는 지도 영역의 중심 (화면 좌표) — 유닛으로 카메라를 옮길 때 사용 */
  UI.focusPoint = function () {
    var top = el.tbTurn ? document.getElementById('top-bar').getBoundingClientRect().bottom : 0;
    var bottom = window.innerHeight;
    [el.unitPanel, document.getElementById('corner')].forEach(function (node) {
      if (node && !node.classList.contains('hidden')) bottom = Math.min(bottom, node.getBoundingClientRect().top);
    });
    if (bottom - top < 120) { top = 0; bottom = window.innerHeight; }   // 너무 좁으면 화면 중앙
    return { x: window.innerWidth / 2, y: (top + bottom) / 2 };
  };

  /** 전체 갱신 */
  UI.refresh = function () {
    UI.refreshTopBar();
    UI.refreshEndTurn();
    UI.refreshUnitPanel();
    var S = Game.Session;
    UI.showTileInfo(S.hoverIdx >= 0 ? S.hoverIdx : S.inspectIdx);
  };

  Game.UI = UI;
})();
