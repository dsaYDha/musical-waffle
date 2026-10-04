/* ==========================================================================
 * hex.js — 육각 좌표 계산 (포인티톱, 축 좌표 q·r)
 *
 *  두 계층으로 나뉜다.
 *   1) 순수 육각 수학: 축 좌표 ↔ 화면(월드) 좌표, 반올림, 거리, 직선
 *   2) 지도 좌표 계층(grid): 지도 범위·타일 번호(index)·이웃·거리
 *      → 동서 래핑을 넣을 때는 이 계층(index / distance / line / 그리기 범위)만 고치면 된다.
 *      다른 파일은 좌표를 직접 계산하지 말고 반드시 이 계층을 거친다.
 *
 *  저장 배치는 'odd-r' (홀수 줄이 반 칸 오른쪽으로 밀림), 타일 번호 = row * width + col
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});

  var SQRT3 = Math.sqrt(3);

  // 이웃 방향 (화면 y는 아래가 +). 순서: 동, 남동, 남서, 서, 북서, 북동
  // → 방향 d의 이웃과 맞닿은 변은 꼭짓점 d와 d+1 사이
  var DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

  // 반지름 1인 육각형의 꼭짓점 (각도 -30°, 30°, 90°, 150°, 210°, 270°)
  var CORNERS = [
    { x: SQRT3 / 2, y: -0.5 }, { x: SQRT3 / 2, y: 0.5 }, { x: 0, y: 1 },
    { x: -SQRT3 / 2, y: 0.5 }, { x: -SQRT3 / 2, y: -0.5 }, { x: 0, y: -1 }
  ];

  /* ---------------------------------------------------------------
   * 1) 순수 육각 수학
   * ------------------------------------------------------------- */

  function axialToPixel(q, r, size) {
    return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
  }

  /** 실수 축 좌표 → 가장 가까운 육각형 */
  function round(fq, fr) {
    var fs = -fq - fr;
    var q = Math.round(fq), r = Math.round(fr), s = Math.round(fs);
    var dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return { q: q, r: r };
  }

  function pixelToAxial(x, y, size) {
    var fq = (SQRT3 / 3 * x - y / 3) / size;
    var fr = (2 / 3 * y) / size;
    return round(fq, fr);
  }

  function distanceAxial(aq, ar, bq, br) {
    var dq = aq - bq, dr = ar - br;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  /** 두 육각형 사이 직선 위의 축 좌표 목록 (양 끝 포함) */
  function lineAxial(aq, ar, bq, br) {
    var n = distanceAxial(aq, ar, bq, br);
    var out = [];
    // 경계에 정확히 걸치는 경우를 피하려고 살짝 밀어 준다
    var aqe = aq + 1e-6, are = ar + 2e-6, bqe = bq + 1e-6, bre = br + 2e-6;
    for (var i = 0; i <= n; i++) {
      var t = n === 0 ? 0 : i / n;
      out.push(round(aqe + (bqe - aqe) * t, are + (bre - are) * t));
    }
    return out;
  }

  function offsetToAxial(col, row) {
    return { q: col - ((row - (row & 1)) >> 1), r: row };
  }

  function axialToOffset(q, r) {
    return { col: q + ((r - (r & 1)) >> 1), row: r };
  }

  /* ---------------------------------------------------------------
   * 2) 지도 좌표 계층
   * ------------------------------------------------------------- */

  var grid = {
    width: 0, height: 0, size: 0, wrapX: false,
    qs: null, rs: null,          // 타일 번호 → 축 좌표 캐시
    neighbors: null              // 타일 번호 * 6 + 방향 → 이웃 타일 번호 (-1 = 없음)
  };

  /** 지도 크기를 정한다 (새 지도 생성·불러오기 때 한 번 호출) */
  function setGrid(width, height, wrapX) {
    grid.width = width;
    grid.height = height;
    grid.size = width * height;
    grid.wrapX = !!wrapX;
    grid.qs = new Int32Array(grid.size);
    grid.rs = new Int32Array(grid.size);
    for (var i = 0; i < grid.size; i++) {
      var row = Math.floor(i / width), col = i - row * width;
      var a = offsetToAxial(col, row);
      grid.qs[i] = a.q;
      grid.rs[i] = a.r;
    }
    grid.neighbors = new Int32Array(grid.size * 6);
    for (var j = 0; j < grid.size; j++) {
      for (var d = 0; d < 6; d++) {
        grid.neighbors[j * 6 + d] = index(grid.qs[j] + DIRS[d][0], grid.rs[j] + DIRS[d][1]);
      }
    }
  }

  /** 축 좌표 → 타일 번호 (지도 밖이면 -1). 래핑은 여기서 처리 */
  function index(q, r) {
    if (r < 0 || r >= grid.height) return -1;
    var col = q + ((r - (r & 1)) >> 1);
    if (col < 0 || col >= grid.width) {
      if (!grid.wrapX) return -1;
      col = ((col % grid.width) + grid.width) % grid.width;
    }
    return r * grid.width + col;
  }

  function coords(idx) {
    return { q: grid.qs[idx], r: grid.rs[idx] };
  }

  function colOf(idx) { return idx % grid.width; }
  function rowOf(idx) { return Math.floor(idx / grid.width); }

  /** 이웃 타일 번호 배열 (지도 밖 제외) */
  function neighbors(idx) {
    var out = [];
    for (var d = 0; d < 6; d++) {
      var n = grid.neighbors[idx * 6 + d];
      if (n >= 0) out.push(n);
    }
    return out;
  }

  /** 래핑을 고려한 b의 가장 가까운 축 좌표 사본 */
  function nearestCopy(aq, ar, bq, br) {
    if (!grid.wrapX) return { q: bq, r: br };
    var best = { q: bq, r: br }, bestD = distanceAxial(aq, ar, bq, br);
    [bq - grid.width, bq + grid.width].forEach(function (q) {
      var d = distanceAxial(aq, ar, q, br);
      if (d < bestD) { bestD = d; best = { q: q, r: br }; }
    });
    return best;
  }

  /** 두 타일 사이 거리 (칸 수) */
  function distance(a, b) {
    var aq = grid.qs[a], ar = grid.rs[a];
    var nb = nearestCopy(aq, ar, grid.qs[b], grid.rs[b]);
    return distanceAxial(aq, ar, nb.q, nb.r);
  }

  /** 두 타일 사이 직선 위 타일 번호 목록 (양 끝 포함) */
  function line(a, b) {
    var aq = grid.qs[a], ar = grid.rs[a];
    var nb = nearestCopy(aq, ar, grid.qs[b], grid.rs[b]);
    var pts = lineAxial(aq, ar, nb.q, nb.r);
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var k = index(pts[i].q, pts[i].r);
      if (k >= 0) out.push(k);
    }
    return out;
  }

  /** 중심에서 radius 칸 안의 모든 타일 번호 (중심 포함) */
  function range(idx, radius) {
    var q0 = grid.qs[idx], r0 = grid.rs[idx];
    var out = [];
    for (var dq = -radius; dq <= radius; dq++) {
      var rMin = Math.max(-radius, -dq - radius), rMax = Math.min(radius, -dq + radius);
      for (var dr = rMin; dr <= rMax; dr++) {
        var k = index(q0 + dq, r0 + dr);
        if (k >= 0) out.push(k);
      }
    }
    return out;
  }

  /** 타일 중심의 월드 좌표 (px, 줌 1 기준) */
  function tileCenter(idx, size) {
    var row = rowOf(idx), col = idx - row * grid.width;
    return { x: size * SQRT3 * (col + 0.5 * (row & 1)), y: size * 1.5 * row };
  }

  /** 월드 좌표 → 타일 번호 (지도 밖이면 -1) */
  function pixelToIndex(x, y, size) {
    var a = pixelToAxial(x, y, size);
    return index(a.q, a.r);
  }

  /** 지도 전체의 월드 좌표 범위 */
  function worldBounds(size) {
    return {
      minX: -SQRT3 / 2 * size,
      minY: -size,
      maxX: SQRT3 * size * grid.width,
      maxY: 1.5 * size * (grid.height - 1) + size
    };
  }

  /**
   * 월드 사각형과 겹치는 행·열 범위 (그리기용). 여유 1칸 포함
   * 래핑이 생기면 열 범위가 지도 폭을 넘을 수 있으므로 여기서 처리한다.
   */
  function visibleRange(minX, minY, maxX, maxY, size) {
    var w = SQRT3 * size, h = 1.5 * size;
    return {
      row0: Math.max(0, Math.floor((minY - size) / h)),
      row1: Math.min(grid.height - 1, Math.ceil((maxY + size) / h)),
      col0: Math.max(0, Math.floor(minX / w) - 1),
      col1: Math.min(grid.width - 1, Math.ceil(maxX / w) + 1)
    };
  }

  Game.Hex = {
    SQRT3: SQRT3,
    DIRS: DIRS,
    CORNERS: CORNERS,
    // 순수 수학
    axialToPixel: axialToPixel,
    pixelToAxial: pixelToAxial,
    round: round,
    distanceAxial: distanceAxial,
    lineAxial: lineAxial,
    offsetToAxial: offsetToAxial,
    axialToOffset: axialToOffset,
    // 지도 좌표 계층
    grid: grid,
    setGrid: setGrid,
    index: index,
    coords: coords,
    colOf: colOf,
    rowOf: rowOf,
    neighbors: neighbors,
    distance: distance,
    line: line,
    range: range,
    tileCenter: tileCenter,
    pixelToIndex: pixelToIndex,
    worldBounds: worldBounds,
    visibleRange: visibleRange
  };
})();
