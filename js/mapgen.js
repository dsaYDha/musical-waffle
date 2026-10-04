/* ==========================================================================
 * mapgen.js — 지도 생성
 *
 *  1) 대륙(여러 개의 타원 덩어리) + 섬 + 노이즈로 고도를 만들고,
 *     고도 순위로 바다 비율(약 60%)을 정확히 맞춘다.
 *  2) 대륙 2~3개·섬 몇 개 조건을 검사해서 맞지 않으면 다시 만든다.
 *  3) 위도(온도)·습도·노이즈로 지형과 특성(언덕·산·숲·정글·습지)을 정한다.
 *
 *  같은 시드 → 같은 지도: 난수는 rng.js의 시드 난수만 쓰고, 계산도 사칙연산·sqrt만
 *  사용한다(브라우저마다 결과가 미세하게 다를 수 있는 sin/exp 등은 쓰지 않음).
 *  ※ 동서 래핑을 넣을 때는 노이즈를 원통 좌표로 바꿔야 경계가 이어진다.
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});
  var Data = Game.Data, RNG = Game.RNG, Hex = Game.Hex;

  var ROW_H = 0.8660254037844386;   // 줄 간격 / 칸 간격 (√3/2) — 노이즈 좌표를 육각 배치에 맞춘다

  /* ---------------------------------------------------------------
   * 노이즈 (value noise + fBm)
   * ------------------------------------------------------------- */

  function hash2(ix, iy, seed) {
    var h = seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /** 격자점에 난수를 두고 부드럽게 보간하는 2D value noise → [0, 1) */
  function valueNoise(x, y, seed) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var u = fade(x - x0), v = fade(y - y0);
    var a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
    var c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
    var top = a + (b - a) * u, bottom = c + (d - c) * u;
    return top + (bottom - top) * v;
  }

  /** 여러 옥타브를 겹친 노이즈 (p: frequency, octaves, persistence) → 대략 [0, 1] */
  function fbm(x, y, seed, p) {
    var amp = 1, freq = p.frequency, sum = 0, norm = 0;
    for (var o = 0; o < p.octaves; o++) {
      var s = (seed + Math.imul(o + 1, 0x9E3779B1)) | 0;
      sum += amp * valueNoise(x * freq + o * 31.7, y * freq + o * 17.3, s);
      norm += amp;
      amp *= p.persistence;
      freq *= 2;
    }
    return sum / norm;
  }

  /** 능선 노이즈 — 값이 큰 곳이 가늘고 길게 이어져 산맥처럼 보인다 */
  function ridged(x, y, seed, p) {
    var amp = 1, freq = p.frequency, sum = 0, norm = 0;
    for (var o = 0; o < p.octaves; o++) {
      var s = (seed + Math.imul(o + 7, 0x85ebca6b)) | 0;
      var n = 1 - Math.abs(2 * valueNoise(x * freq + o * 11.1, y * freq + o * 23.9, s) - 1);
      sum += amp * n * n;
      norm += amp;
      amp *= p.persistence;
      freq *= 2;
    }
    return sum / norm;
  }

  /** 0에서 1, |t|≥1에서 0이 되는 부드러운 언덕 모양 (다항식) */
  function bump(t) {
    t = Math.abs(t);
    if (t >= 1) return 0;
    var u = 1 - t * t;
    return u * u;
  }

  /** 타원 덩어리들의 합집합 세기 (0~1) */
  function lobeField(lobes, x, y) {
    var best = 0;
    for (var i = 0; i < lobes.length; i++) {
      var L = lobes[i];
      var dx = (x - L.x) / L.rx, dy = (y - L.y) / L.ry;
      var v = bump(Math.sqrt(dx * dx + dy * dy));
      if (v > best) best = v;
    }
    return best;
  }

  /** 주어진 타일들의 값 순위를 0~1로 바꾼다 (분포와 상관없이 비율로 임계값을 정할 수 있게) */
  function rankNormalize(values, indices) {
    var out = new Float64Array(values.length);
    var order = indices.slice().sort(function (a, b) { return values[a] - values[b] || a - b; });
    var n = order.length;
    for (var i = 0; i < n; i++) out[order[i]] = n > 1 ? i / (n - 1) : 0.5;
    return out;
  }

  /** 육지 덩어리 번호 매기기 (mask: 1 = 육지) */
  function labelComponents(mask) {
    var N = mask.length;
    var labels = new Int32Array(N).fill(-1);
    var sizes = [];
    var stack = [];
    for (var i = 0; i < N; i++) {
      if (!mask[i] || labels[i] >= 0) continue;
      var id = sizes.length, size = 0;
      labels[i] = id;
      stack.push(i);
      while (stack.length) {
        var cur = stack.pop();
        size++;
        for (var d = 0; d < 6; d++) {
          var nb = Hex.grid.neighbors[cur * 6 + d];
          if (nb >= 0 && mask[nb] && labels[nb] < 0) {
            labels[nb] = id;
            stack.push(nb);
          }
        }
      }
      sizes.push(size);
    }
    return { labels: labels, sizes: sizes };
  }

  /* ---------------------------------------------------------------
   * 1단계: 땅 모양 만들기 (시도 1회)
   * ------------------------------------------------------------- */

  function shapeAttempt(rng, W, H) {
    var cfg = Data.MAPGEN, sh = cfg.shape, nz = cfg.noise;
    var N = W * H;
    var mapH = (H - 1) * ROW_H;

    // 노이즈마다 다른 시드
    var seeds = {};
    ['elev', 'warpX', 'warpY', 'ridge', 'moist', 'temp', 'veg', 'channel'].forEach(function (k) {
      seeds[k] = RNG.uint32(rng) | 0;
    });

    // 대륙: 지도를 가로로 나눈 구역마다 하나씩, 타원 3~5개를 겹쳐 모양을 만든다
    var nCont = RNG.int(rng, cfg.continents.min, cfg.continents.max);
    var sectionW = W / nCont;
    var lobes = [];
    for (var c = 0; c < nCont; c++) {
      var scale = RNG.float(rng, 0.88, 1.12);
      var cx = (c + 0.5 + RNG.float(rng, -0.1, 0.1)) * sectionW;
      var cy = mapH * (0.5 + RNG.float(rng, -0.1, 0.1));
      var rx = sectionW * RNG.float(rng, 0.42, 0.5) * scale;
      var ry = mapH * RNG.float(rng, 0.4, 0.5) * scale;
      var k = RNG.int(rng, 3, 5);
      for (var j = 0; j < k; j++) {
        lobes.push({
          x: cx + RNG.float(rng, -0.42, 0.42) * rx,
          y: cy + RNG.float(rng, -0.42, 0.42) * ry,
          rx: rx * RNG.float(rng, 0.6, 0.9),
          ry: ry * RNG.float(rng, 0.6, 0.9)
        });
      }
    }

    // 대륙 사이 바닷길 위치
    var channels = [];
    for (var b = 1; b < nCont; b++) channels.push(b * sectionW);

    // 섬: 대륙에서 떨어진 바다에 작은 덩어리
    var islands = [];
    var nIsl = RNG.int(rng, cfg.islands.min, cfg.islands.max);
    for (var i = 0; i < nIsl; i++) {
      for (var tries = 0; tries < 50; tries++) {
        var ix = RNG.float(rng, sh.edgeWidth + 1.5, W - sh.edgeWidth - 2);
        var iy = RNG.float(rng, mapH * 0.1, mapH * 0.9);
        if (lobeField(lobes, ix, iy) > 0.12) continue;
        var far = islands.every(function (o) {
          var dx = o.x - ix, dy = o.y - iy;
          return dx * dx + dy * dy > 49;
        });
        if (!far) continue;
        var rad = RNG.float(rng, sh.islandRadius.min, sh.islandRadius.max);
        islands.push({ x: ix, y: iy, rx: rad * RNG.float(rng, 0.8, 1.25), ry: rad * RNG.float(rng, 0.8, 1.25) });
        break;
      }
    }

    // 고도
    var elev = new Float64Array(N);
    for (var idx = 0; idx < N; idx++) {
      var row = Math.floor(idx / W), col = idx - row * W;
      var x = col + 0.5 * (row & 1), y = row * ROW_H;
      // 좌표를 노이즈로 비틀어서 해안선을 불규칙하게
      var wx = x + (fbm(x, y, seeds.warpX, nz.warp) - 0.5) * 2 * nz.warp.amount;
      var wy = y + (fbm(x, y, seeds.warpY, nz.warp) - 0.5) * 2 * nz.warp.amount;
      var cont = lobeField(lobes, wx, wy);
      for (var ch = 0; ch < channels.length; ch++) {
        var chx = channels[ch] + (valueNoise(y * 0.12, ch * 7.31, seeds.channel) - 0.5) * sectionW * 0.25;
        cont -= sh.channelDepth * bump((x - chx) / sh.channelHalfWidth);
      }
      var base = Math.max(cont, lobeField(islands, wx, wy));
      var e = base * sh.continentWeight + fbm(x, y, seeds.elev, nz.elevation) * sh.noiseWeight;
      e -= sh.edgeDepth * (bump(x / sh.edgeWidth) + bump((W - 0.5 - x) / sh.edgeWidth));
      e -= sh.poleDepth * (bump(row / sh.poleWidth) + bump((H - 1 - row) / sh.poleWidth));
      elev[idx] = e;
    }

    // 고도 순위로 바다 비율을 맞춘다
    var sorted = elev.slice().sort();
    var threshold = sorted[Math.min(N - 1, Math.floor(N * cfg.waterRatio))];
    var land = new Uint8Array(N);
    for (var t = 0; t < N; t++) land[t] = elev[t] >= threshold ? 1 : 0;

    // 검증: 대륙 수·섬 수
    var comps = labelComponents(land);
    var totalLand = 0;
    comps.sizes.forEach(function (s) { totalLand += s; });
    var continents = 0, islandCount = 0;
    comps.sizes.forEach(function (s) {
      if (s >= cfg.continentMinShare * totalLand) continents++;
      else islandCount++;
    });
    var valid = continents >= cfg.continents.min && continents <= cfg.continents.max &&
      islandCount >= cfg.minIslands;

    return {
      W: W, H: H, seeds: seeds, elev: elev, land: land, valid: valid,
      stats: { continents: continents, islands: islandCount, landTiles: totalLand, plannedContinents: nCont }
    };
  }

  /* ---------------------------------------------------------------
   * 2단계: 지형·특성 정하기
   * ------------------------------------------------------------- */

  function finalize(shape) {
    var cfg = Data.MAPGEN, nz = cfg.noise, cl = cfg.climate, vg = cfg.vegetation;
    var W = shape.W, H = shape.H, N = W * H;
    var land = shape.land, elev = shape.elev, seeds = shape.seeds;
    var NB = Hex.grid.neighbors;

    var landIdx = [];
    for (var i = 0; i < N; i++) if (land[i]) landIdx.push(i);

    // 해안까지 거리 (육지 → 가장 가까운 물)
    var coastDist = new Int32Array(N).fill(0);
    var queue = [];
    landIdx.forEach(function (k) {
      for (var d = 0; d < 6; d++) {
        var nb = NB[k * 6 + d];
        if (nb >= 0 && !land[nb]) { coastDist[k] = 1; queue.push(k); return; }
      }
    });
    for (var qi = 0; qi < queue.length; qi++) {
      var cur = queue[qi];
      for (var d2 = 0; d2 < 6; d2++) {
        var n2 = NB[cur * 6 + d2];
        if (n2 >= 0 && land[n2] && coastDist[n2] === 0) { coastDist[n2] = coastDist[cur] + 1; queue.push(n2); }
      }
    }
    // 바다와 닿지 않은 육지(지도 끝에 붙은 경우 등)는 먼 내륙으로 본다
    landIdx.forEach(function (k) { if (coastDist[k] === 0) coastDist[k] = 99; });

    var height = rankNormalize(elev, landIdx);   // 육지 안에서의 높이 순위 0~1

    // 노이즈 값 미리 계산
    var reliefRaw = new Float64Array(N), moistRaw = new Float64Array(N), vegRaw = new Float64Array(N);
    var tempNoise = new Float64Array(N);
    landIdx.forEach(function (k) {
      var row = Math.floor(k / W), col = k - row * W;
      var x = col + 0.5 * (row & 1), y = row * ROW_H;
      reliefRaw[k] = 0.3 * height[k] + 0.7 * ridged(x, y, seeds.ridge, nz.ridge);
      moistRaw[k] = fbm(x, y, seeds.moist, nz.moisture) * (1 - cl.coastMoisture) + cl.coastMoisture / coastDist[k];
      vegRaw[k] = fbm(x, y, seeds.veg, nz.vegetation);
      tempNoise[k] = fbm(x, y, seeds.temp, nz.temperature);
    });
    var relief = rankNormalize(reliefRaw, landIdx);
    var moisture = rankNormalize(moistRaw, landIdx);
    var vegetation = rankNormalize(vegRaw, landIdx);

    var mountainCut = 1 - cfg.relief.mountainRatio;
    var hillCut = mountainCut - cfg.relief.hillRatio;
    var half = (H - 1) / 2;

    var tiles = new Array(N);
    for (var idx = 0; idx < N; idx++) {
      if (!land[idx]) {
        var nearLand = false;
        for (var d3 = 0; d3 < 6; d3++) {
          var n3 = NB[idx * 6 + d3];
          if (n3 >= 0 && land[n3]) { nearLand = true; break; }
        }
        tiles[idx] = { terrain: nearLand ? 'coast' : 'ocean', features: [] };
        continue;
      }

      var row = Math.floor(idx / W);
      var lat = half > 0 ? Math.abs(row - half) / half : 0;          // 0 = 적도, 1 = 극
      var temp = 1 - lat + (tempNoise[idx] - 0.5) * 2 * nz.temperature.amount -
        height[idx] * cl.elevationCooling;
      var m = moisture[idx];

      var terrain;
      if (temp < cl.snowBelow) terrain = 'snow';
      else if (temp < cl.tundraBelow) terrain = 'tundra';
      else if (temp > cl.hotAbove) terrain = m < cl.hotDesertBelow ? 'desert' : (m > cl.hotWetAbove ? 'grassland' : 'plains');
      else terrain = m < cl.temperateDesertBelow ? 'desert' : (m < cl.temperatePlainsBelow ? 'plains' : 'grassland');

      var features = [];
      if (relief[idx] >= mountainCut) {
        features.push('mountains');
      } else {
        var isHill = relief[idx] >= hillCut;
        if (isHill) features.push('hills');
        var v = vegetation[idx];
        var green = terrain === 'grassland' || terrain === 'plains';
        if (green && temp > vg.jungleMinTemp && m > vg.jungleMinMoisture && v > vg.jungleNoise) {
          features.push('jungle');
          terrain = 'plains';                       // 정글 아래 땅은 평원
        } else if ((green || terrain === 'tundra') && temp >= vg.forestMinTemp && temp <= vg.forestMaxTemp &&
                   m > vg.forestMinMoisture && v > vg.forestNoise) {
          features.push('forest');
        } else if (!isHill && terrain === 'grassland' && temp > vg.marshMinTemp && m > vg.marshMinMoisture &&
                   height[idx] < vg.marshMaxHeight && (1 - v) > vg.marshNoise) {
          features.push('marsh');
        }
      }
      tiles[idx] = { terrain: terrain, features: features };
    }

    return tiles;
  }

  /* ---------------------------------------------------------------
   * 공개 함수
   * ------------------------------------------------------------- */

  /**
   * 지도 생성. 같은 (seed, width, height)면 항상 같은 결과
   * @returns {{width, height, wrapX, tiles, meta}}
   */
  function generate(seed, width, height) {
    var cfg = Data.MAPGEN;
    Hex.setGrid(width, height, Data.MAP.wrapX);
    var rng = RNG.create(seed);
    var chosen = null, attempts = 0;
    for (var a = 1; a <= cfg.maxAttempts; a++) {
      attempts = a;
      var shape = shapeAttempt(rng, width, height);
      if (!chosen || (shape.valid && !chosen.valid) || (!chosen.valid && score(shape) > score(chosen))) chosen = shape;
      if (shape.valid) break;
    }
    var tiles = finalize(chosen);
    return {
      width: width,
      height: height,
      wrapX: !!Data.MAP.wrapX,
      tiles: tiles,
      meta: {
        continents: chosen.stats.continents,
        islands: chosen.stats.islands,
        landTiles: chosen.stats.landTiles,
        attempts: attempts,
        valid: chosen.valid
      }
    };

    // 조건을 끝내 못 맞춘 경우 가장 가까운 시도를 고르는 점수
    function score(s) {
      var c = s.stats.continents;
      var off = c < cfg.continents.min ? cfg.continents.min - c : (c > cfg.continents.max ? c - cfg.continents.max : 0);
      return -off * 10 + Math.min(s.stats.islands, cfg.minIslands);
    }
  }

  /** 지도의 육지 덩어리 번호 (시작 위치·향후 AI용) */
  function labelLandmasses(map) {
    var mask = new Uint8Array(map.tiles.length);
    for (var i = 0; i < mask.length; i++) mask[i] = Data.TERRAINS[map.tiles[i].terrain].domain === 'land' ? 1 : 0;
    return labelComponents(mask);
  }

  /**
   * 살기 좋은 시작 위치 찾기: 주변(2칸)에 초원·평원이 많고 해안 근처인 넓은 땅
   * @returns {number[]} 타일 번호 목록 (count개 이하)
   */
  function findStartLocations(map, count, rng) {
    var S = Data.START, Rules = Game.Rules;
    var W = map.width, H = map.height, tiles = map.tiles;
    var masses = labelLandmasses(map);
    var isWater = function (t) { return Data.TERRAINS[t.terrain].domain === 'water'; };

    var candidates = [];
    for (var idx = 0; idx < tiles.length; idx++) {
      var tile = tiles[idx];
      var row = Hex.rowOf(idx), col = Hex.colOf(idx);
      if (isWater(tile) || !Rules.isPassable(tile, 'land')) continue;
      if (row < S.edgeMargin || row >= H - S.edgeMargin || col < S.edgeMargin || col >= W - S.edgeMargin) continue;
      if (S.badTerrainPenalty[tile.terrain] !== undefined) continue;
      if (tile.features.indexOf('marsh') >= 0 || tile.features.indexOf('jungle') >= 0) continue;
      if (masses.sizes[masses.labels[idx]] < S.minLandmassSize) continue;

      var score = 0, coastAdj = false, coastNear = false;
      Hex.range(idx, 2).forEach(function (j) {
        if (j === idx) return;
        var t = tiles[j], dist = Hex.distance(idx, j);
        var w = dist === 1 ? 1 : 0.6;
        var y = Rules.yields(t);
        var v = y.food * 1.3 + y.production + y.gold * 0.5;
        v += S.goodTerrainBonus[t.terrain] || 0;
        v += S.badTerrainPenalty[t.terrain] || 0;
        if (!Rules.isPassable(t, Data.TERRAINS[t.terrain].domain)) v -= 0.5;
        score += v * w;
        if (isWater(t)) { if (dist === 1) coastAdj = true; else coastNear = true; }
      });
      if (coastAdj) score += S.coastAdjacentBonus;
      else if (coastNear) score += S.coastNearBonus;
      if (tile.features.indexOf('hills') >= 0) score += 1;
      score += RNG.float(rng, 0, 0.5);              // 비슷한 곳 중에서 고르는 작은 흔들림
      candidates.push({ idx: idx, score: score });
    }

    candidates.sort(function (a, b) { return b.score - a.score || a.idx - b.idx; });
    var picked = [];
    for (var c = 0; c < candidates.length && picked.length < count; c++) {
      var ok = picked.every(function (p) { return Hex.distance(p, candidates[c].idx) >= S.minDistanceBetween; });
      if (ok) picked.push(candidates[c].idx);
    }
    return picked;
  }

  Game.MapGen = {
    generate: generate,
    findStartLocations: findStartLocations,
    labelLandmasses: labelLandmasses,
    // 다른 곳(향후 단계)에서도 쓸 수 있게 노이즈 함수 공개
    noise: { valueNoise: valueNoise, fbm: fbm, ridged: ridged }
  };
})();
