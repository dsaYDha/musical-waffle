/* ==========================================================================
 * render.js — 그리기 (Canvas 2D)
 *
 *  - 카메라: 월드 좌표(줌 1 기준 px)의 화면 중심 위치 + 줌
 *  - 화면에 보이는 타일만 그린다. 같은 색·같은 모양은 Path2D 하나로 모아 한 번에 칠해서
 *    큰 지도에서도 그리기 호출 수가 일정하게 유지된다.
 *  - 바뀐 것이 있을 때만 다시 그린다 (dirty 플래그)
 *  - 이미지 파일 없이 색과 간단한 도형만 사용
 *
 *  이 파일 앞부분: 카메라·지도(지형/특성/안개) / 뒷부분: 강조·경로·유닛·미니맵
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});
  var Data = Game.Data, Hex = Game.Hex;
  var CORNERS = Hex.CORNERS;
  var S = Data.MAP.hexSize;          // 월드 기준 육각형 반지름
  var HW = Hex.SQRT3 * S;            // 육각형 가로 폭
  var TAU = Math.PI * 2;

  var R = {
    canvas: null,
    ctx: null,
    dpr: 1,
    width: 0,                        // 캔버스 CSS 크기
    height: 0,
    dirty: true,                     // 다시 그려야 하는가
    minimapDirty: true,              // 미니맵 바탕을 다시 만들어야 하는가
    camera: { x: 0, y: 0, zoom: 1, targetZoom: 1, anchorX: 0, anchorY: 0, tween: null },
    HEX: S,
    HEX_W: HW
  };
  var cam = R.camera;

  /* ---------------------------------------------------------------
   * 공용 도우미
   * ------------------------------------------------------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** 색을 밝게(f>0) 또는 어둡게(f<0) */
  function shade(hex, f) {
    var c = hexToRgb(hex).map(function (v) {
      return Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f));
    });
    return 'rgb(' + c.join(',') + ')';
  }

  function rgba(hex, a) {
    return 'rgba(' + hexToRgb(hex).join(',') + ',' + a + ')';
  }

  /** 타일마다 고정된 의사 난수 (그림 흔들림용 — 게임 난수와 무관) */
  function tileRand(idx, k) {
    var h = Math.imul(idx + 1, 0x9E3779B1) ^ Math.imul(k + 1, 0x85ebca6b);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return (h >>> 0) / 4294967296;
  }

  function addHex(p, x, y, r) {
    p.moveTo(x + CORNERS[0].x * r, y + CORNERS[0].y * r);
    for (var i = 1; i < 6; i++) p.lineTo(x + CORNERS[i].x * r, y + CORNERS[i].y * r);
    p.closePath();
  }

  /** 육각형의 d번째 변 (방향 d의 이웃과 맞닿은 변) */
  function addEdge(p, x, y, d, r) {
    var a = CORNERS[d], b = CORNERS[(d + 1) % 6];
    p.moveTo(x + a.x * r, y + a.y * r);
    p.lineTo(x + b.x * r, y + b.y * r);
  }

  function viewer(state) {
    return Game.State.humanPlayer(state);
  }

  R.util = { clamp: clamp, shade: shade, rgba: rgba, addHex: addHex, addEdge: addEdge, tileRand: tileRand };

  /* ---------------------------------------------------------------
   * 카메라
   * ------------------------------------------------------------- */

  function clampZoom(z) {
    return clamp(z, Data.CAMERA.minZoom, Data.CAMERA.maxZoom);
  }

  function clampCamera() {
    if (!Hex.grid.size) return;
    var b = Hex.worldBounds(S);
    cam.x = clamp(cam.x, b.minX, b.maxX);
    cam.y = clamp(cam.y, b.minY, b.maxY);
  }

  R.screenToWorld = function (sx, sy) {
    return { x: cam.x + (sx - R.width / 2) / cam.zoom, y: cam.y + (sy - R.height / 2) / cam.zoom };
  };

  R.worldToScreen = function (wx, wy) {
    return { x: (wx - cam.x) * cam.zoom + R.width / 2, y: (wy - cam.y) * cam.zoom + R.height / 2 };
  };

  /** 화면 좌표 → 타일 번호 (지도 밖 -1) */
  R.screenToTile = function (sx, sy) {
    var w = R.screenToWorld(sx, sy);
    return Hex.pixelToIndex(w.x, w.y, S);
  };

  R.tileCenter = function (idx) {
    return Hex.tileCenter(idx, S);
  };

  /** 화면 픽셀만큼 카메라 이동 (드래그) */
  R.panBy = function (dx, dy) {
    cam.x -= dx / cam.zoom;
    cam.y -= dy / cam.zoom;
    cam.tween = null;
    clampCamera();
    R.dirty = true;
  };

  /** 화면 점(sx, sy)을 고정한 채 바로 줌 */
  R.setZoomAt = function (z, sx, sy) {
    var before = R.screenToWorld(sx, sy);
    var nz = clampZoom(z);
    if (nz !== cam.zoom) R._markZoomChange();
    cam.zoom = nz;
    var after = R.screenToWorld(sx, sy);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    clampCamera();
    R.dirty = true;
  };

  /** 부드러운 줌 (휠·키보드) */
  R.zoomBy = function (factor, sx, sy) {
    cam.targetZoom = clampZoom(cam.targetZoom * factor);
    cam.anchorX = sx;
    cam.anchorY = sy;
    R.dirty = true;
  };

  /** 핀치처럼 직접 줌할 때 목표 줌도 맞춰 둔다 */
  R.syncZoomTarget = function () {
    cam.targetZoom = cam.zoom;
    R._markZoomChange();
  };

  R.centerOn = function (wx, wy, smooth) {
    if (!smooth) {
      cam.x = wx;
      cam.y = wy;
      cam.tween = null;
      clampCamera();
    } else {
      cam.tween = { fx: cam.x, fy: cam.y, tx: wx, ty: wy, t: 0, dur: Data.CAMERA.panDurationMs / 1000 };
    }
    R.dirty = true;
  };

  /**
   * 타일을 화면의 focus 점(생략하면 화면 중앙)에 오도록 카메라 이동
   * focus: HUD에 가리지 않는 빈 영역의 중심 (ui.js의 UI.focusPoint)
   */
  R.centerOnTile = function (idx, smooth, focus) {
    var p = Hex.tileCenter(idx, S);
    var dx = focus ? focus.x - R.width / 2 : 0, dy = focus ? focus.y - R.height / 2 : 0;
    R.centerOn(p.x - dx / cam.zoom, p.y - dy / cam.zoom, smooth);
  };

  /** 타일이 화면 가장자리 여백 안쪽에 보이는가 */
  R.isTileOnScreen = function (idx, marginPx) {
    var c = Hex.tileCenter(idx, S);
    var p = R.worldToScreen(c.x, c.y);
    var m = marginPx || 0;
    return p.x >= m && p.y >= m && p.x <= R.width - m && p.y <= R.height - m;
  };

  function updateCamera(dt) {
    var moving = false;
    if (cam.tween) {
      var tw = cam.tween;
      tw.t += dt;
      var k = Math.min(1, tw.t / tw.dur);
      var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // ease-in-out
      cam.x = tw.fx + (tw.tx - tw.fx) * e;
      cam.y = tw.fy + (tw.ty - tw.fy) * e;
      clampCamera();
      if (k >= 1) cam.tween = null;
      moving = true;
    }
    if (Math.abs(cam.targetZoom - cam.zoom) > 1e-4) {
      var a = 1 - Math.exp(-Data.CAMERA.zoomSmoothing * dt);
      var z = cam.zoom + (cam.targetZoom - cam.zoom) * a;
      if (Math.abs(cam.targetZoom - z) < 1e-3) z = cam.targetZoom;
      R.setZoomAt(z, cam.anchorX, cam.anchorY);
      moving = true;
    }
    return moving;
  }

  /* ---------------------------------------------------------------
   * 지형 색 (타일마다 3가지 명암 중 하나 — 같은 색끼리 모아 칠한다)
   * ------------------------------------------------------------- */

  var VARIANT_SHIFT = [-0.06, 0, 0.05];
  var terrainColors = {};

  function buildPalette() {
    terrainColors = {};
    Object.keys(Data.TERRAINS).forEach(function (k) {
      terrainColors[k] = VARIANT_SHIFT.map(function (f) { return shade(Data.TERRAINS[k].color, f); });
    });
  }

  /* ---------------------------------------------------------------
   * 지형 특성 모양 — 특성마다 Path2D 묶음에 도형을 더하고, 마지막에 한 번에 칠한다
   *  lod: 2 = 자세히, 1 = 간단히, 0 = 아주 간단히 (멀리서 볼 때)
   * ------------------------------------------------------------- */

  function addBump(p, x, y, w, h) {
    p.moveTo(x - w, y);
    p.quadraticCurveTo(x, y - 2 * h, x + w, y);
    p.closePath();
  }

  function addBumpLine(p, x, y, w, h) {
    p.moveTo(x - w, y);
    p.quadraticCurveTo(x, y - 2 * h, x + w, y);
  }

  function addTree(B, tx, ty, k) {
    var h = 0.34 * S * k, w = 0.16 * S * k;
    B.tree.moveTo(tx, ty - h);
    B.tree.lineTo(tx + w, ty - h * 0.15);
    B.tree.lineTo(tx - w, ty - h * 0.15);
    B.tree.closePath();
    B.tree.moveTo(tx, ty - h * 0.62);
    B.tree.lineTo(tx + w * 1.25, ty + h * 0.32);
    B.tree.lineTo(tx - w * 1.25, ty + h * 0.32);
    B.tree.closePath();
    B.trunk.rect(tx - 0.03 * S * k, ty + h * 0.3, 0.06 * S * k, 0.1 * S * k);
  }

  function addCircle(p, x, y, r) {
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, TAU);
  }

  var TREE_SPOTS = [[-0.33, 0.12], [0.02, -0.18], [0.33, 0.08], [-0.02, 0.36]];
  var JUNGLE_SPOTS = [[-0.34, 0.02], [-0.06, -0.26], [0.26, -0.12], [0.34, 0.22], [-0.12, 0.3], [0.06, 0.04]];

  // 특성별 그리기: add = 도형 모으기, paint = 한 번에 칠하기
  var FEATURE_ART = {
    hills: {
      paths: ['fill', 'line'],
      add: function (B, x, y, idx, lod) {
        if (lod === 0) {
          addBump(B.fill, x, y + 0.25 * S, 0.5 * S, 0.34 * S);
          return;
        }
        addBump(B.fill, x - 0.28 * S, y + 0.3 * S, 0.36 * S, 0.28 * S);
        addBump(B.fill, x + 0.22 * S, y + 0.16 * S, 0.42 * S, 0.36 * S);
        addBumpLine(B.line, x - 0.28 * S, y + 0.3 * S, 0.36 * S, 0.28 * S);
        addBumpLine(B.line, x + 0.22 * S, y + 0.16 * S, 0.42 * S, 0.36 * S);
      },
      paint: function (ctx, B, f, lw) {
        ctx.fillStyle = rgba(f.color, 0.42);
        ctx.fill(B.fill);
        ctx.strokeStyle = rgba(f.color2, 0.75);
        ctx.lineWidth = 1.6 * lw;
        ctx.stroke(B.line);
      }
    },
    marsh: {
      paths: ['water', 'reed'],
      add: function (B, x, y, idx, lod) {
        var n = lod === 0 ? 1 : 3;
        for (var j = 0; j < n; j++) {
          var lx = x + (n === 1 ? 0 : (-0.3 + 0.3 * j)) * S;
          var ly = y + (n === 1 ? 0.05 : (-0.08 + 0.2 * (j % 2))) * S;
          B.water.moveTo(lx - 0.17 * S, ly);
          B.water.lineTo(lx + 0.17 * S, ly);
          if (lod > 0) {
            B.reed.moveTo(lx - 0.04 * S, ly - 0.02 * S);
            B.reed.lineTo(lx - 0.07 * S, ly - 0.24 * S);
            B.reed.moveTo(lx + 0.04 * S, ly - 0.02 * S);
            B.reed.lineTo(lx + 0.07 * S, ly - 0.2 * S);
          }
        }
      },
      paint: function (ctx, B, f, lw) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(160, 214, 222, 0.85)';
        ctx.lineWidth = 2 * lw;
        ctx.stroke(B.water);
        ctx.strokeStyle = f.color2;
        ctx.lineWidth = 1.4 * lw;
        ctx.stroke(B.reed);
        ctx.lineCap = 'butt';
      }
    },
    forest: {
      paths: ['tint', 'tree', 'trunk'],
      add: function (B, x, y, idx, lod) {
        addHex(B.tint, x, y, S);
        var n = lod === 2 ? 4 : (lod === 1 ? 2 : 1);
        for (var j = 0; j < n; j++) {
          var spot = n === 1 ? [0, 0.05] : TREE_SPOTS[j];
          var jx = (tileRand(idx, 10 + j) - 0.5) * 0.12 * S, jy = (tileRand(idx, 20 + j) - 0.5) * 0.1 * S;
          addTree(B, x + spot[0] * S + jx, y + spot[1] * S + jy, n === 1 ? 1.25 : 0.85 + tileRand(idx, 30 + j) * 0.25);
        }
      },
      paint: function (ctx, B, f) {
        ctx.fillStyle = 'rgba(14, 54, 16, 0.24)';
        ctx.fill(B.tint);
        ctx.fillStyle = f.color2;
        ctx.fill(B.trunk);
        ctx.fillStyle = f.color;
        ctx.fill(B.tree);
      }
    },
    jungle: {
      paths: ['tint', 'dark', 'light'],
      add: function (B, x, y, idx, lod) {
        addHex(B.tint, x, y, S);
        var n = lod === 2 ? 6 : (lod === 1 ? 3 : 2);
        for (var j = 0; j < n; j++) {
          var spot = JUNGLE_SPOTS[j];
          var r = (0.15 + tileRand(idx, 40 + j) * 0.05) * S * (lod === 0 ? 1.4 : 1);
          var cx = x + spot[0] * S, cy = y + spot[1] * S;
          addCircle(B.dark, cx, cy, r);
          if (lod === 2) addCircle(B.light, cx - r * 0.3, cy - r * 0.3, r * 0.45);
        }
      },
      paint: function (ctx, B, f) {
        ctx.fillStyle = 'rgba(8, 46, 14, 0.38)';
        ctx.fill(B.tint);
        ctx.fillStyle = f.color;
        ctx.fill(B.dark);
        ctx.fillStyle = f.color2;
        ctx.fill(B.light);
      }
    },
    mountains: {
      paths: ['body', 'shade', 'snow', 'line'],
      add: function (B, x, y, idx, lod) {
        var base = y + 0.42 * S;
        var px = x - 0.02 * S, py = y - 0.62 * S;
        if (lod > 0) {
          // 뒤쪽 작은 봉우리
          B.body.moveTo(x - 0.8 * S, base);
          B.body.lineTo(x - 0.42 * S, y - 0.22 * S);
          B.body.lineTo(x - 0.04 * S, base);
          B.body.closePath();
          B.line.moveTo(x - 0.8 * S, base);
          B.line.lineTo(x - 0.42 * S, y - 0.22 * S);
          B.line.lineTo(x - 0.25 * S, y + 0.05 * S);
        }
        // 큰 봉우리
        B.body.moveTo(x - 0.6 * S, base);
        B.body.lineTo(px, py);
        B.body.lineTo(x + 0.62 * S, base);
        B.body.closePath();
        B.shade.moveTo(px, py);
        B.shade.lineTo(x + 0.62 * S, base);
        B.shade.lineTo(x + 0.12 * S, base);
        B.shade.closePath();
        // 눈 덮인 꼭대기
        B.snow.moveTo(px, py);
        B.snow.lineTo(x + 0.16 * S, y - 0.32 * S);
        B.snow.lineTo(x + 0.06 * S, y - 0.36 * S);
        B.snow.lineTo(x - 0.03 * S, y - 0.28 * S);
        B.snow.lineTo(x - 0.11 * S, y - 0.36 * S);
        B.snow.lineTo(x - 0.2 * S, y - 0.32 * S);
        B.snow.closePath();
        if (lod > 0) {
          B.line.moveTo(x - 0.6 * S, base);
          B.line.lineTo(px, py);
          B.line.lineTo(x + 0.62 * S, base);
        }
      },
      paint: function (ctx, B, f, lw) {
        ctx.fillStyle = f.color;
        ctx.fill(B.body);
        ctx.fillStyle = f.color2;
        ctx.fill(B.shade);
        ctx.fillStyle = '#f2f5f7';
        ctx.fill(B.snow);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(38, 38, 44, 0.7)';
        ctx.lineWidth = 1.3 * lw;
        ctx.stroke(B.line);
      }
    }
  };

  function newBatches() {
    var batches = {};
    Object.keys(FEATURE_ART).forEach(function (k) {
      var b = {};
      FEATURE_ART[k].paths.forEach(function (name) { b[name] = new Path2D(); });
      batches[k] = b;
    });
    return batches;
  }

  /* ---------------------------------------------------------------
   * 지도 그리기
   *  drawTiles: 타일 범위를 그린다 (부르는 쪽이 월드→픽셀 변환을 걸어 둔다)
   *  drawMap  : 타일이 작게 보일 때(멀리서 볼 때)는 8×8 타일 덩어리를 미리 그려 둔 그림을
   *             붙이기만 해서 큰 지도에서도 빠르다. 안개가 바뀐 덩어리만 다시 그린다.
   *             가까이서 볼 때는 보이는 타일이 적으므로 바로 그린다.
   * ------------------------------------------------------------- */

  /**
   * @param cssPx 화면 1px(CSS)에 해당하는 월드 길이
   * @param prCss 화면상 육각형 반지름(CSS px) — 세부 묘사 수준(LOD)을 정한다
   * @param grow  이웃 육각형 사이 틈을 메우려고 키우는 양(CSS px)
   */
  function drawTiles(ctx, state, row0, row1, col0, col1, cssPx, prCss, grow) {
    var tiles = state.map.tiles, W = state.map.width;
    var player = viewer(state);
    var reveal = Game.Debug.revealAll;
    var explored = player.explored, visible = player.visible;
    var lod = prCss >= 22 ? 2 : (prCss >= 12 ? 1 : 0);
    var g = grow * cssPx;
    var NB = Hex.grid.neighbors;
    var isWater = Game.Rules.isWater;

    var fills = {};
    var fog = new Path2D(), shore = new Path2D(), grid = new Path2D(), waves = new Path2D();
    var batches = newBatches();

    for (var row = row0; row <= row1; row++) {
      for (var col = col0; col <= col1; col++) {
        var idx = row * W + col;
        if (!reveal && !explored[idx]) continue;          // 미탐험: 검정(배경) 그대로
        var tile = tiles[idx];
        var x = HW * (col + 0.5 * (row & 1)), y = 1.5 * S * row;

        var color = terrainColors[tile.terrain][Math.floor(tileRand(idx, 0) * 3)];
        addHex(fills[color] || (fills[color] = new Path2D()), x, y, S + g);
        if (lod === 2) addHex(grid, x, y, S);

        if (!isWater(tile)) {
          // 바다와 맞닿은 변에 모래빛 해안선 (안 본 바다 쪽은 그리지 않음 — 정보 노출 방지)
          for (var d = 0; d < 6; d++) {
            var nb = NB[idx * 6 + d];
            if (nb >= 0 && isWater(tiles[nb]) && (reveal || explored[nb])) addEdge(shore, x, y, d, S);
          }
        } else if (lod === 2 && tileRand(idx, 5) > 0.55) {
          var wx = x + (tileRand(idx, 6) - 0.5) * 0.6 * S, wy = y + (tileRand(idx, 7) - 0.5) * 0.6 * S;
          waves.moveTo(wx - 0.2 * S, wy);
          waves.quadraticCurveTo(wx - 0.1 * S, wy - 0.1 * S, wx, wy);
          waves.quadraticCurveTo(wx + 0.1 * S, wy - 0.1 * S, wx + 0.2 * S, wy);
        }

        for (var f = 0; f < tile.features.length; f++) {
          var art = FEATURE_ART[tile.features[f]];
          if (art) art.add(batches[tile.features[f]], x, y, idx, lod);
        }

        if (!reveal && !visible[idx]) addHex(fog, x, y, S);
      }
    }

    Object.keys(fills).forEach(function (c) {
      ctx.fillStyle = c;
      ctx.fill(fills[c]);
    });

    if (lod === 2) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
      ctx.lineWidth = 1.2 * cssPx;
      ctx.stroke(waves);
    }

    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(238, 224, 168, 0.62)';
    ctx.lineWidth = Math.max(1.4, Math.min(3, prCss * 0.075)) * cssPx;
    ctx.stroke(shore);
    ctx.lineCap = 'butt';

    Data.FEATURE_DRAW_ORDER.forEach(function (k) {
      if (FEATURE_ART[k] && Data.FEATURES[k]) FEATURE_ART[k].paint(ctx, batches[k], Data.FEATURES[k], cssPx);
    });

    if (lod === 2) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
      ctx.lineWidth = cssPx;
      ctx.stroke(grid);
    }

    // 탐험했지만 지금 안 보이는 곳: 마지막으로 본 모습 위에 어둡게
    ctx.fillStyle = 'rgba(3, 6, 12, 0.55)';
    ctx.fill(fog);
  }

  /* --- 덩어리(chunk) 그림 캐시 --- */

  var CHUNK = 8;                 // 덩어리 한 변의 타일 수
  var CACHE_MAX_PX = 26;         // 육각형 반지름이 기기 픽셀로 이 이하일 때 캐시 사용
  var ZOOM_SETTLE_MS = 160;      // 줌이 멈춘 뒤 이만큼 지나면 해상도에 맞춰 다시 그림
  var cache = { bucket: 0, chunks: {}, exp: null, vis: null, reveal: false };
  var lastZoomChange = 0;

  /** 캐시 해상도 단계 (2^(1/4)배 간격, 실제보다 조금 크게 그려 두고 줄여서 붙인다) */
  function bucketFor(px) {
    return Math.pow(2, Math.ceil(Math.log2(px) * 4 - 1e-9) / 4);
  }

  function clearMapCache() {
    cache.bucket = 0;
    cache.chunks = {};
    cache.exp = null;
    cache.vis = null;
  }

  function dropChunkOf(idx, W) {
    var row = Math.floor(idx / W), col = idx - row * W;
    delete cache.chunks[Math.floor(col / CHUNK) + ',' + Math.floor(row / CHUNK)];
  }

  /** 안개 상태가 바뀐 타일(과 이웃)이 들어 있는 덩어리만 지운다 → 보일 때 다시 그림 */
  function syncFogCache(state) {
    var player = viewer(state), reveal = Game.Debug.revealAll;
    var N = state.map.tiles.length, W = state.map.width;
    var NB = Hex.grid.neighbors;
    var i;
    if (!cache.exp || cache.exp.length !== N || cache.reveal !== reveal) {
      cache.chunks = {};
      cache.exp = new Uint8Array(N);
      cache.vis = new Uint8Array(N);
      for (i = 0; i < N; i++) { cache.exp[i] = player.explored[i]; cache.vis[i] = player.visible[i]; }
      cache.reveal = reveal;
      return;
    }
    for (i = 0; i < N; i++) {
      var e = player.explored[i] ? 1 : 0, v = player.visible[i] ? 1 : 0;
      if (e === cache.exp[i] && v === cache.vis[i]) continue;
      cache.exp[i] = e;
      cache.vis[i] = v;
      dropChunkOf(i, W);
      for (var d = 0; d < 6; d++) {
        var nb = NB[i * 6 + d];
        if (nb >= 0) dropChunkOf(nb, W);
      }
    }
  }

  function getChunk(state, cx, cy) {
    var key = cx + ',' + cy;
    var ch = cache.chunks[key];
    if (ch) return ch;
    var W = state.map.width, H = state.map.height;
    var col0 = cx * CHUNK, col1 = Math.min(W - 1, col0 + CHUNK - 1);
    var row0 = cy * CHUNK, row1 = Math.min(H - 1, row0 + CHUNK - 1);
    var k = cache.bucket / S;                       // 월드 → 덩어리 픽셀
    var pad = 3 * R.dpr / k;
    var minX = HW * col0 - HW / 2 - pad, maxX = HW * (col1 + 0.5) + HW / 2 + pad;
    var minY = 1.5 * S * row0 - S - pad, maxY = 1.5 * S * row1 + S + pad;
    var canvas = document.createElement('canvas');
    canvas.width = Math.ceil((maxX - minX) * k);
    canvas.height = Math.ceil((maxY - minY) * k);
    var c = canvas.getContext('2d');
    c.setTransform(k, 0, 0, k, -minX * k, -minY * k);
    drawTiles(c, state, row0, row1, col0, col1, R.dpr / k, cache.bucket / R.dpr, 0.8);
    ch = { canvas: canvas, x: minX, y: minY, w: canvas.width / k, h: canvas.height / k };
    cache.chunks[key] = ch;
    return ch;
  }

  /** 지도 그리기 (월드 좌표 변환이 걸린 상태에서 호출) */
  function drawMap(ctx, state, view) {
    var rg = Hex.visibleRange(view.minX, view.minY, view.maxX, view.maxY, S);
    var pxR = S * cam.zoom * R.dpr;
    if (pxR > CACHE_MAX_PX) {
      if (cache.bucket) clearMapCache();
      drawTiles(ctx, state, rg.row0, rg.row1, rg.col0, rg.col1, 1 / cam.zoom, S * cam.zoom, 0.6);
      return;
    }
    syncFogCache(state);
    var want = bucketFor(pxR);
    if (cache.bucket !== want) {
      var ratio = cache.bucket ? pxR / cache.bucket : 0;
      var zooming = performance.now() - lastZoomChange < ZOOM_SETTLE_MS;
      // 줌 애니메이션 중에는 비슷한 해상도의 그림을 늘려 쓰고, 멈춘 뒤에 다시 그린다
      if (!zooming || ratio < 0.6 || ratio > 1.3) {
        cache.bucket = want;
        cache.chunks = {};
      }
    }
    var cx0 = Math.floor(rg.col0 / CHUNK), cx1 = Math.floor(rg.col1 / CHUNK);
    var cy0 = Math.floor(rg.row0 / CHUNK), cy1 = Math.floor(rg.row1 / CHUNK);
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var ch = getChunk(state, cx, cy);
        ctx.drawImage(ch.canvas, ch.x, ch.y, ch.w, ch.h);
      }
    }
  }

  /** 줌이 멈췄는데 캐시 해상도가 맞지 않으면 다시 그려야 한다 */
  function cacheNeedsRefresh() {
    var pxR = S * cam.zoom * R.dpr;
    return cache.bucket && pxR <= CACHE_MAX_PX && bucketFor(pxR) !== cache.bucket &&
      performance.now() - lastZoomChange >= ZOOM_SETTLE_MS;
  }

  R._cacheNeedsRefresh = cacheNeedsRefresh;
  R.clearMapCache = clearMapCache;
  R._markZoomChange = function () { lastZoomChange = performance.now(); };

  R._drawMap = drawMap;
  R._buildPalette = buildPalette;
  R._updateCamera = updateCamera;
  R._clampCamera = clampCamera;

  Game.Render = R;
})();

/* ==========================================================================
 * render.js (뒷부분) — 강조 표시·경로·유닛·미니맵, 그리고 프레임 그리기
 * ========================================================================== */
(function () {
  'use strict';
  var Game = window.Game;
  var Data = Game.Data, Hex = Game.Hex, R = Game.Render;
  var S = R.HEX, HW = R.HEX_W, TAU = Math.PI * 2;
  var U = R.util, cam = R.camera;

  function viewer(state) {
    return Game.State.humanPlayer(state);
  }

  function session() {
    return Game.Session || {};
  }

  /* ---------------------------------------------------------------
   * 이동 가능 범위·마우스 강조·경로 (월드 좌표)
   * ------------------------------------------------------------- */

  function drawReachable(ctx, state) {
    var sel = session().selectedUnitId;
    var reach = session().reachable;
    var unit = sel != null ? Game.Units.get(state, sel) : null;
    if (!unit || !reach) return;
    var player = viewer(state), reveal = Game.Debug.revealAll;
    var startIdx = Hex.index(unit.q, unit.r);
    var NB = Hex.grid.neighbors;
    var fill = new Path2D(), edge = new Path2D();
    var inside = function (i) { return i === startIdx || (reach[i] !== undefined && (reveal || player.explored[i])); };
    Object.keys(reach).forEach(function (k) {
      var idx = +k;
      if (!inside(idx)) return;
      var c = Hex.tileCenter(idx, S);
      U.addHex(fill, c.x, c.y, S);
      for (var d = 0; d < 6; d++) {
        var nb = NB[idx * 6 + d];
        if (nb < 0 || !inside(nb)) U.addEdge(edge, c.x, c.y, d, S * 0.97);
      }
    });
    // 유닛이 서 있는 칸 둘레
    var sc = Hex.tileCenter(startIdx, S);
    for (var d2 = 0; d2 < 6; d2++) {
      var n2 = NB[startIdx * 6 + d2];
      if (n2 < 0 || !inside(n2)) U.addEdge(edge, sc.x, sc.y, d2, S * 0.97);
    }
    ctx.fillStyle = 'rgba(120, 196, 255, 0.17)';
    ctx.fill(fill);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(150, 214, 255, 0.92)';
    ctx.lineWidth = 2.5 / cam.zoom;
    ctx.stroke(edge);
    ctx.lineCap = 'butt';
  }

  function drawHover(ctx, state) {
    var idx = session().hoverIdx;
    if (idx == null || idx < 0) return;
    var c = Hex.tileCenter(idx, S);
    var p = new Path2D();
    U.addHex(p, c.x, c.y, S * 0.94);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 4.5 / cam.zoom;
    ctx.stroke(p);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 2 / cam.zoom;
    ctx.stroke(p);
  }

  /** 경로 선: 이번 턴 구간은 실선, 다음 턴부터는 점선 */
  function drawRoute(ctx, state, route) {
    var unit = Game.Units.get(state, route.unitId);
    if (!unit || !route.steps.length) return;
    var preview = route.kind === 'preview';
    var color = preview ? '#ffffff' : '#7fd3ff';
    var start = Hex.tileCenter(Hex.index(unit.q, unit.r), S);
    var all = new Path2D(), now = new Path2D(), later = new Path2D();
    all.moveTo(start.x, start.y);
    var prev = start;
    route.steps.forEach(function (st) {
      var c = Hex.tileCenter(st.idx, S);
      all.lineTo(c.x, c.y);
      var p = st.turn === 0 ? now : later;
      p.moveTo(prev.x, prev.y);
      p.lineTo(c.x, c.y);
      prev = c;
    });
    var z = cam.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 7 / z;
    ctx.stroke(all);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.5 / z;
    ctx.stroke(now);
    ctx.setLineDash([9 / z, 7 / z]);
    ctx.stroke(later);
    ctx.setLineDash([]);
    // 목적지 테두리
    var t = Hex.tileCenter(route.steps[route.steps.length - 1].idx, S);
    var ring = new Path2D();
    U.addHex(ring, t.x, t.y, S * 0.86);
    ctx.strokeStyle = preview ? '#ffe36b' : '#7fd3ff';
    ctx.lineWidth = 3 / z;
    ctx.stroke(ring);
    ctx.lineCap = 'butt';
  }

  /** 경로의 각 턴 끝 지점에 '몇 번째 턴에 도착하는지' 숫자 (화면 좌표) */
  function drawRouteBadges(ctx, state, route) {
    var steps = route.steps;
    for (var i = 0; i < steps.length; i++) {
      var last = i === steps.length - 1;
      if (!last && steps[i + 1].turn === steps[i].turn) continue;
      var c = Hex.tileCenter(steps[i].idx, S);
      var p = R.worldToScreen(c.x, c.y);
      drawBadge(ctx, p.x, p.y, String(steps[i].turn + 1), last);
    }
  }

  function drawBadge(ctx, x, y, text, final) {
    var r = final ? 12 : 10;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = final ? '#ffe36b' : 'rgba(18, 24, 34, 0.92)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = final ? '#3a2f08' : '#cfe6ff';
    ctx.stroke();
    ctx.fillStyle = final ? '#241c02' : '#ffffff';
    ctx.font = 'bold ' + (final ? 13 : 11) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }

  /* ---------------------------------------------------------------
   * 유닛 — 화면에 그리는 위치(visual)는 실제 위치를 따라 짧게 미끄러진다
   * ------------------------------------------------------------- */

  var visuals = {};       // 유닛 id → { x, y, queue: [{x, y}] } (월드 좌표)

  R.resetUnitVisuals = function () {
    visuals = {};
  };

  /** 유닛이 지나간 타일들을 차례로 따라가는 애니메이션 */
  R.animateUnitSteps = function (unitId, steps) {
    var v = visuals[unitId];
    if (!v || !steps || !steps.length) return;
    steps.forEach(function (idx) {
      var c = Hex.tileCenter(idx, S);
      v.queue.push({ x: c.x, y: c.y });
    });
    R.dirty = true;
  };

  R.isAnimating = function () {
    for (var id in visuals) if (visuals[id].queue.length) return true;
    return false;
  };

  function syncVisuals(state) {
    var alive = {};
    state.units.forEach(function (u) {
      alive[u.id] = true;
      var c = Hex.tileCenter(Hex.index(u.q, u.r), S);
      var v = visuals[u.id];
      if (!v) visuals[u.id] = { x: c.x, y: c.y, queue: [] };
      else if (!v.queue.length) { v.x = c.x; v.y = c.y; }
    });
    Object.keys(visuals).forEach(function (id) { if (!alive[id]) delete visuals[id]; });
  }

  function updateVisuals(dt) {
    var speed = HW / (Data.ANIMATION.unitStepMs / 1000);
    var moving = false;
    Object.keys(visuals).forEach(function (id) {
      var v = visuals[id];
      var budget = speed * dt;
      while (v.queue.length && budget > 0) {
        var t = v.queue[0];
        var dx = t.x - v.x, dy = t.y - v.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d <= budget) {
          v.x = t.x; v.y = t.y;
          v.queue.shift();
          budget -= d;
        } else {
          v.x += dx / d * budget;
          v.y += dy / d * budget;
          budget = 0;
        }
      }
      if (v.queue.length) moving = true;
    });
    return moving;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 유닛 아이콘 (도형만 사용)
  var ICONS = {
    settler: function (ctx, x, y, r, ink, paper) {     // 집
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(x - 0.58 * r, y - 0.02 * r);
      ctx.lineTo(x, y - 0.58 * r);
      ctx.lineTo(x + 0.58 * r, y - 0.02 * r);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - 0.4 * r, y - 0.06 * r, 0.8 * r, 0.56 * r);
      ctx.fillStyle = paper;
      ctx.fillRect(x - 0.11 * r, y + 0.16 * r, 0.22 * r, 0.34 * r);
    },
    warrior: function (ctx, x, y, r, ink) {           // 칼
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(0, -0.7 * r);
      ctx.lineTo(0.12 * r, -0.52 * r);
      ctx.lineTo(0.12 * r, 0.18 * r);
      ctx.lineTo(-0.12 * r, 0.18 * r);
      ctx.lineTo(-0.12 * r, -0.52 * r);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-0.36 * r, 0.16 * r, 0.72 * r, 0.14 * r);
      ctx.fillRect(-0.07 * r, 0.28 * r, 0.14 * r, 0.3 * r);
      ctx.beginPath();
      ctx.arc(0, 0.62 * r, 0.11 * r, 0, TAU);
      ctx.fill();
      ctx.restore();
    },
    scout: function (ctx, x, y, r, ink) {             // 눈
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = Math.max(1.5, 0.13 * r);
      ctx.beginPath();
      ctx.moveTo(x - 0.62 * r, y);
      ctx.quadraticCurveTo(x, y - 0.66 * r, x + 0.62 * r, y);
      ctx.quadraticCurveTo(x, y + 0.66 * r, x - 0.62 * r, y);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 0.21 * r, 0, TAU);
      ctx.fill();
    }
  };

  function unitStatusColor(u) {
    if (Game.Units.needsOrders(u)) return '#5be36a';     // 명령 필요
    if (u.moveTarget) return '#5cc8ff';                   // 이동 명령 진행 중
    if (u.sentry) return '#c79bff';                       // 경계
    return '#8a909a';                                     // 이번 턴 끝
  }

  function drawUnitToken(ctx, state, u, x, y, r, selected) {
    var def = Data.UNITS[u.type];
    var owner = state.players[u.owner];
    var ink = (Data.PLAYERS[u.owner] && Data.PLAYERS[u.owner].borderColor) || '#222';
    var civilian = def.category === 'civilian';

    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y, r + 5.5, 0, TAU);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.stroke();
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    // 그림자
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.92, r * 0.85, r * 0.3, 0, 0, TAU);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.fill();
    // 몸체: 군사 = 원, 민간 = 둥근 사각형
    ctx.beginPath();
    if (civilian) roundRectPath(ctx, x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8, r * 0.42);
    else ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = owner.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ink;
    ctx.stroke();
    // 아이콘
    var icon = ICONS[def.icon];
    if (icon) icon(ctx, x, y, r, ink, owner.color);
    else {
      ctx.fillStyle = ink;
      ctx.font = 'bold ' + Math.round(r) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.name.charAt(0), x, y);
    }
    // 상태 점
    ctx.beginPath();
    ctx.arc(x + r * 0.74, y - r * 0.74, Math.max(3, r * 0.27), 0, TAU);
    ctx.fillStyle = unitStatusColor(u);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#111';
    ctx.stroke();
  }

  function drawUnits(ctx, state) {
    var player = viewer(state), reveal = Game.Debug.revealAll;
    var pr = S * cam.zoom;
    var r = U.clamp(pr * 0.36, 7, 22);
    var sel = session().selectedUnitId;
    var countAt = {};
    state.units.forEach(function (u) {
      var k = Hex.index(u.q, u.r);
      countAt[k] = (countAt[k] || 0) + 1;
    });
    // 선택한 유닛을 맨 위에
    var list = state.units.slice().sort(function (a, b) { return (a.id === sel) - (b.id === sel); });
    list.forEach(function (u) {
      var idx = Hex.index(u.q, u.r);
      if (u.owner !== player.id && !reveal && !player.visible[idx]) return;   // 안 보이는 남의 유닛
      var v = visuals[u.id];
      if (!v) return;
      var ox = 0, oy = 0;
      if (countAt[idx] > 1) {        // 군사 + 민간이 겹치면 살짝 비켜서 둘 다 보이게
        var o = Math.max(r * 1.05, pr * 0.34);
        var mil = Data.UNITS[u.type].category === 'military';
        ox = mil ? -o * 0.82 : o * 0.82;
        oy = mil ? -o * 0.5 : o * 0.5;
      }
      var p = R.worldToScreen(v.x, v.y);
      var x = p.x + ox, y = p.y + oy;
      if (x < -40 || y < -40 || x > R.width + 40 || y > R.height + 40) return;
      drawUnitToken(ctx, state, u, x, y, r, u.id === sel);
    });
  }

  /* ---------------------------------------------------------------
   * 미니맵 — 탐험한 곳만, 현재 화면 범위는 사각형
   * ------------------------------------------------------------- */

  var mm = { canvas: null, ctx: null, base: null, bctx: null, scale: 1, cssW: 0, cssH: 0, dpr: 1 };
  var mmColorCache = {};

  function minimapColor(tile, visible) {
    var key = tile.terrain + '|' + tile.features.join(',') + '|' + (visible ? 1 : 0);
    var c = mmColorCache[key];
    if (c) return c;
    var hex = Data.TERRAINS[tile.terrain].color;
    if (Game.Rules.hasFeature(tile, 'mountains')) hex = '#9b9b9b';
    else if (Game.Rules.hasFeature(tile, 'jungle')) hex = Data.FEATURES.jungle.color;
    else if (Game.Rules.hasFeature(tile, 'forest')) hex = Data.FEATURES.forest.color;
    else if (Game.Rules.hasFeature(tile, 'marsh')) hex = Data.FEATURES.marsh.color;
    var f = Game.Rules.hasFeature(tile, 'hills') ? -0.12 : 0;
    c = U.shade(hex, visible ? f : f - 0.45);
    mmColorCache[key] = c;
    return c;
  }

  R.layoutMinimap = function () {
    var state = Game.State.current;
    if (!mm.canvas || !state) return;
    var b = Hex.worldBounds(S);
    var box = mm.canvas.parentElement;
    var cssW = Math.max(60, box.clientWidth - 2 * (parseFloat(getComputedStyle(box).paddingLeft) || 0));
    var cssH = Math.round(cssW * (b.maxY - b.minY) / (b.maxX - b.minX));
    mm.dpr = R.dpr;
    mm.cssW = cssW;
    mm.cssH = cssH;
    mm.scale = cssW / (b.maxX - b.minX);
    mm.canvas.style.width = cssW + 'px';
    mm.canvas.style.height = cssH + 'px';
    mm.canvas.width = Math.round(cssW * mm.dpr);
    mm.canvas.height = Math.round(cssH * mm.dpr);
    mm.base.width = mm.canvas.width;
    mm.base.height = mm.canvas.height;
    R.minimapDirty = true;
  };

  function renderMinimapBase(state) {
    var ctx = mm.bctx;
    var b = Hex.worldBounds(S);
    var s = mm.scale * mm.dpr;
    var tiles = state.map.tiles, player = viewer(state), reveal = Game.Debug.revealAll;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#020407';
    ctx.fillRect(0, 0, mm.base.width, mm.base.height);
    var cw = HW * s + 0.6, ch = 1.5 * S * s + 0.6;
    for (var i = 0; i < tiles.length; i++) {
      if (!reveal && !player.explored[i]) continue;
      var c = Hex.tileCenter(i, S);
      ctx.fillStyle = minimapColor(tiles[i], reveal || player.visible[i]);
      ctx.fillRect((c.x - b.minX) * s - cw / 2, (c.y - b.minY) * s - ch / 2, cw, ch);
    }
  }

  function drawMinimap(state) {
    if (!mm.canvas || !mm.cssW) return;
    if (R.minimapDirty) {
      renderMinimapBase(state);
      R.minimapDirty = false;
    }
    var ctx = mm.ctx;
    var b = Hex.worldBounds(S);
    var s = mm.scale * mm.dpr;
    var player = viewer(state), reveal = Game.Debug.revealAll;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(mm.base, 0, 0);
    // 유닛 점
    state.units.forEach(function (u) {
      var idx = Hex.index(u.q, u.r);
      if (u.owner !== player.id && !reveal && !player.visible[idx]) return;
      var c = Hex.tileCenter(idx, S);
      ctx.beginPath();
      ctx.arc((c.x - b.minX) * s, (c.y - b.minY) * s, Math.max(2, 2.2 * mm.dpr), 0, TAU);
      ctx.fillStyle = state.players[u.owner].color;
      ctx.fill();
      ctx.lineWidth = mm.dpr;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    });
    // 현재 화면 범위
    var tl = R.screenToWorld(0, 0), br = R.screenToWorld(R.width, R.height);
    ctx.lineWidth = 1.5 * mm.dpr;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeRect((tl.x - b.minX) * s, (tl.y - b.minY) * s, (br.x - tl.x) * s, (br.y - tl.y) * s);
  }

  /** 미니맵 CSS 좌표 → 월드 좌표 */
  R.minimapToWorld = function (mx, my) {
    var b = Hex.worldBounds(S);
    return { x: b.minX + mx / mm.scale, y: b.minY + my / mm.scale };
  };

  /* ---------------------------------------------------------------
   * 초기화·크기 조절·프레임
   * ------------------------------------------------------------- */

  R.init = function (canvas, minimapCanvas) {
    R.canvas = canvas;
    R.ctx = canvas.getContext('2d');
    mm.canvas = minimapCanvas;
    mm.ctx = minimapCanvas.getContext('2d');
    mm.base = document.createElement('canvas');
    mm.bctx = mm.base.getContext('2d');
    R._buildPalette();
    R.resize();
  };

  R.resize = function () {
    R.dpr = Math.min(window.devicePixelRatio || 1, 2);
    R.width = window.innerWidth;
    R.height = window.innerHeight;
    R.canvas.width = Math.round(R.width * R.dpr);
    R.canvas.height = Math.round(R.height * R.dpr);
    R.canvas.style.width = R.width + 'px';
    R.canvas.style.height = R.height + 'px';
    R.layoutMinimap();
    R._clampCamera();
    R.dirty = true;
  };

  /** 새 게임·불러오기 직후 */
  R.onNewState = function (state, focusIdx) {
    R.resetUnitVisuals();
    R.clearMapCache();
    mmColorCache = {};
    cam.zoom = cam.targetZoom = Data.CAMERA.defaultZoom;
    cam.tween = null;
    R.layoutMinimap();
    if (focusIdx != null && focusIdx >= 0) R.centerOnTile(focusIdx, false);
    R.minimapDirty = true;
    R.dirty = true;
  };

  R.invalidate = function () {
    R.dirty = true;
  };

  /** 안개·탐험 상태가 바뀌었을 때 (미니맵 바탕까지 다시) */
  R.invalidateFog = function () {
    R.dirty = true;
    R.minimapDirty = true;
  };

  /** 매 프레임: 카메라·유닛 애니메이션 진행. 움직이는 중이면 true */
  R.update = function (dt) {
    var a = R._updateCamera(dt);
    var b = updateVisuals(dt);
    if (a || b || R._cacheNeedsRefresh()) R.dirty = true;
    return a || b;
  };

  R.draw = function () {
    var ctx = R.ctx, state = Game.State.current;
    R.dirty = false;
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    ctx.fillStyle = '#04070b';
    ctx.fillRect(0, 0, R.width, R.height);
    if (!state) return;
    syncVisuals(state);

    var z = cam.zoom;
    var tl = R.screenToWorld(0, 0), br = R.screenToWorld(R.width, R.height);
    ctx.setTransform(R.dpr * z, 0, 0, R.dpr * z, R.dpr * (R.width / 2 - cam.x * z), R.dpr * (R.height / 2 - cam.y * z));
    R._drawMap(ctx, state, { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y });
    drawReachable(ctx, state);
    var route = session().route;
    if (route) drawRoute(ctx, state, route);
    drawHover(ctx, state);

    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    drawUnits(ctx, state);
    if (route) drawRouteBadges(ctx, state, route);
    drawMinimap(state);
  };
})();
