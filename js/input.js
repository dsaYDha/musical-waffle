/* ==========================================================================
 * input.js — 마우스·키보드·터치 입력
 *
 *  마우스:  왼쪽 클릭 = 선택, 오른쪽 클릭 = 경로 미리보기 → 한 번 더 = 이동 확정,
 *          드래그 = 카메라 이동, 휠 = 줌
 *  터치:   탭 = 선택(유닛 선택 중이면 목적지 미리보기 → 한 번 더 탭 = 확정),
 *          길게 누르기 = 우클릭과 같음, 한 손가락 드래그 = 이동, 두 손가락 = 핀치 줌
 *  키보드: WASD/방향키 = 카메라, Enter = 다음 유닛/턴 종료, Space = 대기, F = 경계,
 *          Esc = 취소, +/- = 줌, F2 = 안개 디버그
 *
 *  입력은 해석만 하고, 실제 동작은 Game.Main(main.js)의 함수를 부른다.
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});
  var Data = Game.Data;

  var Input = { keys: {} };
  var canvas = null, minimap = null;
  var pointers = {};            // 누르고 있는 포인터들
  var pinch = null;
  var longPressTimer = null;
  var minimapPointer = null;

  // 키 코드 기준 (한글 자판 상태에서도 동작하도록 e.code 사용)
  var PAN_KEYS = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    KeyA: [-1, 0], KeyD: [1, 0], KeyW: [0, -1], KeyS: [0, 1]
  };

  function M() { return Game.Main; }
  function R() { return Game.Render; }

  function blocked() {
    return !Game.State.current || (Game.UI && Game.UI.isModalOpen());
  }

  function localPos(e, el) {
    var rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function pointerList() {
    return Object.keys(pointers).map(function (k) { return pointers[k]; });
  }

  /* ---------------------------------------------------------------
   * 지도 캔버스 포인터
   * ------------------------------------------------------------- */

  function onPointerDown(e) {
    if (blocked()) return;
    var p = localPos(e, canvas);
    try { canvas.setPointerCapture(e.pointerId); } catch (ignore) { /* 무시 */ }
    pointers[e.pointerId] = {
      id: e.pointerId, type: e.pointerType, button: e.button,
      x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, handled: false
    };
    var list = pointerList();
    if (e.pointerType === 'touch' && list.length === 2) startPinch();
    else if (e.pointerType === 'touch' && list.length === 1) startLongPress(pointers[e.pointerId]);
    e.preventDefault();
  }

  function onPointerMove(e) {
    var p = localPos(e, canvas);
    var info = pointers[e.pointerId];
    if (!info) {
      if (e.pointerType === 'mouse' && !blocked()) M().onHover(R().screenToTile(p.x, p.y));
      return;
    }
    if (pinch) {
      info.x = p.x;
      info.y = p.y;
      updatePinch();
      return;
    }
    var dx = p.x - info.x, dy = p.y - info.y;
    info.x = p.x;
    info.y = p.y;
    if (!info.moved) {
      var tx = p.x - info.sx, ty = p.y - info.sy;
      var th = Data.CAMERA.dragThresholdPx * (info.type === 'touch' ? 1.8 : 1);
      if (tx * tx + ty * ty < th * th) return;
      info.moved = true;
      cancelLongPress();
      dx = tx;
      dy = ty;
    }
    if (info.button === 2) return;                // 우클릭 드래그는 무시
    R().panBy(dx, dy);
    if (info.type === 'mouse') M().onHover(R().screenToTile(p.x, p.y));
  }

  function onPointerUp(e) {
    var info = pointers[e.pointerId];
    if (!info) return;
    delete pointers[e.pointerId];
    cancelLongPress();
    if (pinch) {
      if (pointerList().length < 2) {
        pinch = null;
        pointerList().forEach(function (q) { q.moved = true; });   // 남은 손가락은 탭이 아님
      }
      return;
    }
    if (info.moved || info.handled || blocked()) return;
    var idx = R().screenToTile(info.x, info.y);
    if (info.type === 'mouse' && info.button === 2) M().onRightClick(idx);
    else if (info.type !== 'mouse' || info.button === 0) M().onTap(idx, info.type !== 'mouse');
  }

  function onPointerCancel(e) {
    delete pointers[e.pointerId];
    cancelLongPress();
    if (pointerList().length < 2) pinch = null;
  }

  /* --- 핀치 줌 --- */

  function startPinch() {
    cancelLongPress();
    var list = pointerList();
    list.forEach(function (q) { q.moved = true; });
    var a = list[0], b = list[1];
    var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = {
      startDist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      startZoom: R().camera.zoom,
      world: R().screenToWorld(mid.x, mid.y)
    };
  }

  function updatePinch() {
    var list = pointerList();
    if (list.length < 2) return;
    var a = list[0], b = list[1];
    var cam = R().camera;
    var d = Math.hypot(a.x - b.x, a.y - b.y);
    var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    cam.zoom = Math.max(Data.CAMERA.minZoom, Math.min(Data.CAMERA.maxZoom, pinch.startZoom * d / pinch.startDist));
    R().syncZoomTarget();
    // 처음 손가락 사이에 있던 지점이 계속 손가락 사이에 있도록
    R().centerOn(pinch.world.x - (mid.x - R().width / 2) / cam.zoom,
                 pinch.world.y - (mid.y - R().height / 2) / cam.zoom, false);
  }

  /* --- 길게 누르기 (터치의 우클릭) --- */

  function startLongPress(info) {
    cancelLongPress();
    longPressTimer = setTimeout(function () {
      longPressTimer = null;
      if (!pointers[info.id] || info.moved || pinch || blocked()) return;
      info.handled = true;
      M().onRightClick(R().screenToTile(info.x, info.y));
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (ignore) { /* 무시 */ } }
    }, Data.CAMERA.longPressMs);
  }

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  /* --- 휠 줌 --- */

  function onWheel(e) {
    if (blocked()) return;
    e.preventDefault();
    var p = localPos(e, canvas);
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1));
    var factor = Math.pow(Data.CAMERA.wheelZoomStep, -dy / 100);
    R().zoomBy(Math.max(0.5, Math.min(2, factor)), p.x, p.y);
  }

  /* ---------------------------------------------------------------
   * 미니맵: 클릭·드래그로 카메라 이동
   * ------------------------------------------------------------- */

  function minimapJump(e, smooth) {
    var p = localPos(e, minimap);
    var w = R().minimapToWorld(p.x, p.y);
    R().centerOn(w.x, w.y, smooth);
  }

  function onMinimapDown(e) {
    if (blocked()) return;
    e.preventDefault();
    e.stopPropagation();
    try { minimap.setPointerCapture(e.pointerId); } catch (ignore) { /* 무시 */ }
    minimapPointer = e.pointerId;
    minimapJump(e, true);
  }

  function onMinimapMove(e) {
    if (minimapPointer !== e.pointerId) return;
    minimapJump(e, false);
  }

  function onMinimapUp(e) {
    if (minimapPointer === e.pointerId) minimapPointer = null;
  }

  /* ---------------------------------------------------------------
   * 키보드
   * ------------------------------------------------------------- */

  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (e.key === 'F2') {
      e.preventDefault();
      if (!blocked()) M().toggleRevealAll();
      return;
    }
    if (isTyping(e.target) || blocked() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (PAN_KEYS[e.code]) {
      Input.keys[e.code] = true;
      e.preventDefault();
      return;
    }
    var handled = true;
    if (e.key === 'Enter') { if (!e.repeat) M().endTurnOrNextUnit(); }
    else if (e.code === 'Space') { if (!e.repeat) M().skipSelected(); }
    else if (e.code === 'KeyF') { if (!e.repeat) M().toggleSentrySelected(); }
    else if (e.key === 'Escape') M().cancelOrDeselect();
    else if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') R().zoomBy(1.25, R().width / 2, R().height / 2);
    else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') R().zoomBy(0.8, R().width / 2, R().height / 2);
    else handled = false;
    if (handled) e.preventDefault();
  }

  function onKeyUp(e) {
    if (PAN_KEYS[e.code]) Input.keys[e.code] = false;
  }

  /** 매 프레임: 누르고 있는 방향키로 카메라 이동. 움직였으면 true */
  Input.update = function (dt) {
    if (blocked()) return false;
    var dx = 0, dy = 0;
    Object.keys(Input.keys).forEach(function (k) {
      if (Input.keys[k]) { dx += PAN_KEYS[k][0]; dy += PAN_KEYS[k][1]; }
    });
    if (!dx && !dy) return false;
    var len = Math.sqrt(dx * dx + dy * dy);
    var sp = Data.CAMERA.keyPanSpeed * dt;
    R().panBy(-dx / len * sp, -dy / len * sp);
    return true;
  };

  Input.init = function (mapCanvas, minimapCanvas) {
    canvas = mapCanvas;
    minimap = minimapCanvas;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse' && !pointers[e.pointerId] && Game.Main) M().onHover(-1);
    });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    minimap.addEventListener('pointerdown', onMinimapDown);
    minimap.addEventListener('pointermove', onMinimapMove);
    minimap.addEventListener('pointerup', onMinimapUp);
    minimap.addEventListener('pointercancel', onMinimapUp);
    minimap.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', function () { Input.keys = {}; });
    // iOS 사파리의 페이지 확대 제스처 막기
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  };

  Game.Input = Input;
})();
