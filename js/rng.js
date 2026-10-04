/* ==========================================================================
 * rng.js — 시드 기반 난수 (mulberry32)
 *
 *  난수 상태는 { s: 정수 } 형태의 순수 데이터라서 게임 상태 안에 넣어
 *  JSON으로 저장/복원할 수 있다. (함수 클로저에 상태를 숨기지 않는다)
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});

  var UINT32 = 4294967296;

  var RNG = {
    /** 새 난수 상태 */
    create: function (seed) {
      return { s: seed | 0 };
    },

    /** [0, 1) 실수 — mulberry32 한 단계 */
    next: function (rng) {
      rng.s = (rng.s + 0x6D2B79F5) | 0;
      var t = rng.s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32;
    },

    /** 32비트 부호 없는 정수 (다른 시드를 파생할 때 사용) */
    uint32: function (rng) {
      return (RNG.next(rng) * UINT32) >>> 0;
    },

    /** [min, max] 정수 */
    int: function (rng, min, max) {
      return min + Math.floor(RNG.next(rng) * (max - min + 1));
    },

    /** [min, max) 실수 */
    float: function (rng, min, max) {
      return min + RNG.next(rng) * (max - min);
    },

    chance: function (rng, p) {
      return RNG.next(rng) < p;
    },

    pick: function (rng, arr) {
      return arr[Math.floor(RNG.next(rng) * arr.length)];
    },

    /** 문자열 → 32비트 해시 (FNV-1a + 섞기) */
    hashString: function (str) {
      var h = 2166136261;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      h ^= h >>> 15;
      h = Math.imul(h, 0x2c1b3c6d);
      h ^= h >>> 12;
      return h >>> 0;
    },

    /** 시드 없이 시작할 때 쓰는 무작위 시드 (화면에 보여 주고 다시 입력할 수 있게 9자리 이하) */
    randomSeed: function () {
      var v;
      if (window.crypto && window.crypto.getRandomValues) {
        var a = new Uint32Array(1);
        window.crypto.getRandomValues(a);
        v = a[0];
      } else {
        v = Math.floor(Math.random() * UINT32);
      }
      return 1 + (v % 999999999);
    },

    /**
     * 입력칸 문자열 → 시드 숫자
     *  - 비어 있으면 무작위
     *  - 0~4294967295 사이 숫자면 그대로 사용 (화면에 표시된 시드를 다시 넣으면 같은 지도)
     *  - 그 밖의 글자는 해시해서 사용
     */
    parseSeed: function (text) {
      var t = String(text == null ? '' : text).trim();
      if (t === '') return RNG.randomSeed();
      if (/^\d{1,10}$/.test(t)) {
        var n = Number(t);
        if (n <= 4294967295) return n;
      }
      return RNG.hashString(t);
    }
  };

  Game.RNG = RNG;
})();
