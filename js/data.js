/* ==========================================================================
 * data.js — 게임 데이터 정의
 *
 *  지형·특성·유닛·규칙 수치는 모두 이 파일에 모아 둔다.
 *  밸런스 조정은 이 파일의 숫자만 바꾸면 되도록, 다른 코드에는 수치를 적지 않는다.
 *  (이 파일에는 함수 없이 순수한 데이터만 둔다)
 * ========================================================================== */
(function () {
  'use strict';
  var Game = (window.Game = window.Game || {});

  Game.Data = {
    /* ---------------------------------------------------------------
     * 지도 크기와 좌표
     * ------------------------------------------------------------- */
    MAP: {
      hexSize: 32,             // 줌 1.0일 때 육각형 반지름(중심→꼭짓점, px)
      defaultSize: 'standard',
      sizes: {
        small:    { name: '작음', width: 44, height: 28 },
        standard: { name: '보통', width: 60, height: 40 },
        large:    { name: '큼',   width: 84, height: 56 }
      },
      wrapX: false             // 동서 래핑 (아직 미구현 — 켜면 hex.js 좌표 계층에서 처리하도록 준비됨)
    },

    /* ---------------------------------------------------------------
     * 지도 생성 매개변수
     *  - 노이즈 frequency는 '타일 1칸'을 1로 보는 좌표 기준
     *  - 비율(ratio) 값은 육지 타일 중 차지하는 비율
     * ------------------------------------------------------------- */
    MAPGEN: {
      waterRatio: 0.6,                    // 바다 비율
      continents: { min: 2, max: 3 },     // 대륙 수
      islands: { min: 3, max: 6 },        // 따로 배치하는 섬 수
      minIslands: 2,                      // 검증: 최소 섬(작은 육지 덩어리) 수
      continentMinShare: 0.1,             // 전체 육지의 이 비율 이상인 덩어리를 '대륙'으로 본다
      maxAttempts: 12,                    // 조건을 만족할 때까지 다시 생성하는 최대 횟수

      shape: {
        continentWeight: 0.62,            // 대륙/섬 모양이 고도에 주는 비중
        noiseWeight: 0.38,                // 노이즈가 고도에 주는 비중
        channelDepth: 0.75,               // 대륙 사이 바닷길 깊이
        channelHalfWidth: 2.4,            // 대륙 사이 바닷길 반폭(타일)
        edgeDepth: 0.7,                   // 지도 좌우 끝을 바다로 만드는 정도
        edgeWidth: 3.5,                   // 좌우 끝 바다 폭(타일)
        poleDepth: 0.55,                  // 지도 위아래 끝을 바다로 만드는 정도
        poleWidth: 2.5,                   // 위아래 끝 바다 폭(타일)
        islandRadius: { min: 2.0, max: 3.4 }
      },

      noise: {
        elevation:   { frequency: 0.075, octaves: 5, persistence: 0.5 },
        warp:        { frequency: 0.05, octaves: 2, persistence: 0.5, amount: 5 },
        ridge:       { frequency: 0.1, octaves: 2, persistence: 0.35 },
        moisture:    { frequency: 0.085, octaves: 4, persistence: 0.55 },
        temperature: { frequency: 0.06, octaves: 3, persistence: 0.5, amount: 0.12 },
        vegetation:  { frequency: 0.17, octaves: 3, persistence: 0.5 }
      },

      relief: {
        mountainRatio: 0.07,              // 산 비율
        hillRatio: 0.16                   // 언덕 비율
      },

      climate: {
        // 온도: 적도 1 → 극지 0 (위도) + 노이즈 − 고도 냉각
        elevationCooling: 0.1,
        snowBelow: 0.17,                  // 이 온도 미만은 설원
        tundraBelow: 0.31,                // 이 온도 미만은 툰드라
        hotAbove: 0.7,                    // 이 온도 초과는 열대(적도 부근)
        coastMoisture: 0.25,              // 해안 가까울수록 습해지는 정도
        hotDesertBelow: 0.26,             // 열대에서 습도가 이보다 낮으면 사막
        hotWetAbove: 0.6,                 // 열대에서 습도가 이보다 높으면 정글 후보
        temperateDesertBelow: 0.12,       // 온대에서 습도가 이보다 낮으면 사막
        temperatePlainsBelow: 0.48        // 온대에서 습도가 이보다 낮으면 평원(높으면 초원)
      },

      vegetation: {
        jungleMinTemp: 0.66, jungleMinMoisture: 0.56, jungleNoise: 0.32,
        forestMinTemp: 0.16, forestMaxTemp: 0.8, forestMinMoisture: 0.4, forestNoise: 0.52,
        marshMinTemp: 0.3, marshMinMoisture: 0.8, marshMaxHeight: 0.3, marshNoise: 0.6
      }
    },

    /* ---------------------------------------------------------------
     * 산출 종류
     * ------------------------------------------------------------- */
    YIELDS: {
      food:       { name: '식량',   color: '#9ad46b' },
      production: { name: '생산력', color: '#e0a35a' },
      gold:       { name: '금',     color: '#f3d250' }
    },

    /* ---------------------------------------------------------------
     * 기본 지형 (타일마다 하나)
     *  domain   : 'land' | 'water' — 유닛의 domain과 같아야 들어갈 수 있다
     *  passable : false면 어떤 유닛도 통과 불가
     *  defense  : 방어 보너스(%) — 이번 단계에서는 표시만
     * ------------------------------------------------------------- */
    TERRAINS: {
      ocean: {
        name: '대양', color: '#1d4672',
        yields: { food: 1, production: 0, gold: 0 },
        moveCost: 1, domain: 'water', passable: true, defense: 0
      },
      coast: {
        name: '해안', color: '#3577ad',
        yields: { food: 1, production: 0, gold: 1 },
        moveCost: 1, domain: 'water', passable: true, defense: 0
      },
      grassland: {
        name: '초원', color: '#5f9b3d',
        yields: { food: 2, production: 0, gold: 0 },
        moveCost: 1, domain: 'land', passable: true, defense: 0
      },
      plains: {
        name: '평원', color: '#a5a24c',
        yields: { food: 1, production: 1, gold: 0 },
        moveCost: 1, domain: 'land', passable: true, defense: 0
      },
      desert: {
        name: '사막', color: '#dcc47e',
        yields: { food: 0, production: 0, gold: 0 },
        moveCost: 1, domain: 'land', passable: true, defense: 0
      },
      tundra: {
        name: '툰드라', color: '#8b8f78',
        yields: { food: 1, production: 0, gold: 0 },
        moveCost: 1, domain: 'land', passable: true, defense: 0
      },
      snow: {
        name: '설원', color: '#e4ecef',
        yields: { food: 0, production: 0, gold: 0 },
        moveCost: 1, domain: 'land', passable: true, defense: 0
      }
    },

    /* ---------------------------------------------------------------
     * 지형 위 특성 (타일마다 0개 이상, 예: 언덕 + 숲)
     *  yields      : 기본 지형 산출에 더하는 값 (yieldMode 'replace'면 대체)
     *  moveCost    : 이동 비용 — 타일 비용은 지형·특성 중 가장 큰 값
     *  sightBonus  : 이 타일 위 유닛의 시야 반경 보너스
     *  sightHeight : 이 타일 위에서 보는 높이 (sightBlock이 이보다 큰 타일만 시야를 가림)
     *  sightBlock  : 이 타일 뒤쪽 시야를 가리는 높이 (0 = 가리지 않음)
     *  color/color2: 그리기 색
     * ------------------------------------------------------------- */
    FEATURES: {
      hills: {
        name: '언덕', color: '#7b6137', color2: '#4e3b1f',
        yields: { food: 0, production: 1, gold: 0 },
        moveCost: 2, passable: true, defense: 25,
        sightBonus: 1, sightHeight: 1, sightBlock: 0
      },
      mountains: {
        name: '산', color: '#8e8e8e', color2: '#666a6e',
        yields: { food: 0, production: 0, gold: 0 }, yieldMode: 'replace',
        moveCost: 1, passable: false, defense: 0,
        sightBonus: 0, sightHeight: 0, sightBlock: 2
      },
      forest: {
        name: '숲', color: '#2e5d29', color2: '#5b3d1f',
        yields: { food: 0, production: 1, gold: 0 },
        moveCost: 2, passable: true, defense: 25,
        sightBonus: 0, sightHeight: 0, sightBlock: 1
      },
      jungle: {
        name: '정글', color: '#1e5426', color2: '#3a8a3c',
        yields: { food: 1, production: 0, gold: 0 },
        moveCost: 2, passable: true, defense: 25,
        sightBonus: 0, sightHeight: 0, sightBlock: 1
      },
      marsh: {
        name: '습지', color: '#4b8088', color2: '#3f6230',
        yields: { food: -1, production: 0, gold: 0 },
        moveCost: 2, passable: true, defense: -15,
        sightBonus: 0, sightHeight: 0, sightBlock: 0
      }
    },

    // 특성을 그리는 순서 (아래에 깔리는 것부터)
    FEATURE_DRAW_ORDER: ['hills', 'marsh', 'forest', 'jungle', 'mountains'],

    /* ---------------------------------------------------------------
     * 유닛
     *  category : 'military' | 'civilian' — 한 타일에 종류별로 stackLimits까지 겹칠 수 있다
     *  moves    : 턴당 이동력
     *  sightBonus : 기본 시야(RULES.baseSight)에 더하는 값
     *  abilities  : 특수 능력 (foundCity = 도시 건설, 2단계에서 구현)
     * ------------------------------------------------------------- */
    UNITS: {
      settler: {
        name: '개척자', category: 'civilian', domain: 'land',
        moves: 2, sightBonus: 0, icon: 'settler',
        abilities: ['foundCity'],
        description: '새 도시를 세울 수 있는 민간 유닛'
      },
      warrior: {
        name: '전사', category: 'military', domain: 'land',
        moves: 2, sightBonus: 0, icon: 'warrior',
        abilities: [],
        description: '고대의 기본 군사 유닛'
      },
      scout: {
        name: '정찰병', category: 'military', domain: 'land',
        moves: 3, sightBonus: 1, icon: 'scout',
        abilities: [],
        description: '빠르고 멀리 보는 탐험 유닛'
      }
    },

    /* ---------------------------------------------------------------
     * 공통 규칙
     * ------------------------------------------------------------- */
    RULES: {
      baseSight: 2,                // 유닛 기본 시야 반경
      minMovesToEnter: 1,          // 남은 이동력이 지형 비용보다 적어도 이 값 이상이면 한 칸 진입 가능
      unexploredMoveCost: 1,       // 길찾기에서 미탐험 타일은 이 비용의 통과 가능한 타일로 가정
      moveGiveUpFactor: 5,         // 이동 명령이 예상 턴 수의 이 배수만큼 지나도 도착 못 하면 취소
      moveGiveUpMinTurns: 20,      // (단, 최소 이 턴 수까지는 계속 시도 — 미탐험 땅을 돌아가는 경우)
      stackLimits: { military: 1, civilian: 1 }
    },

    /* ---------------------------------------------------------------
     * 시작 위치와 시작 유닛
     * ------------------------------------------------------------- */
    START: {
      units: ['settler', 'warrior', 'scout'],
      minLandmassSize: 30,         // 이보다 작은 섬에서는 시작하지 않는다
      edgeMargin: 3,               // 지도 끝에서 이만큼 떨어진 곳에서 시작
      minDistanceBetween: 12,      // (여러 문명일 때) 시작 위치 사이 최소 거리
      goodTerrainBonus: { grassland: 1.2, plains: 1.0 },
      badTerrainPenalty: { desert: -1.0, tundra: -0.8, snow: -1.5 },
      coastAdjacentBonus: 4,       // 바로 옆이 바다(해안)이면
      coastNearBonus: 2            // 2칸 안에 바다가 있으면
    },

    /* ---------------------------------------------------------------
     * 플레이어 (이번 단계는 인간 플레이어 1명)
     * ------------------------------------------------------------- */
    PLAYERS: [
      { name: '나의 문명', color: '#e9c54a', borderColor: '#3b2f0b', isHuman: true }
    ],

    /* ---------------------------------------------------------------
     * 달력: 기원전 4000년 시작, 후반으로 갈수록 1턴당 햇수가 줄어든다
     *  turns: 이 구간의 턴 수 (0 = 이후 계속)
     * ------------------------------------------------------------- */
    CALENDAR: {
      startYear: -4000,
      steps: [
        { turns: 75, years: 40 },
        { turns: 60, years: 25 },
        { turns: 25, years: 20 },
        { turns: 50, years: 10 },
        { turns: 60, years: 5 },
        { turns: 50, years: 2 },
        { turns: 0,  years: 1 }
      ]
    },

    /* ---------------------------------------------------------------
     * 카메라·연출
     * ------------------------------------------------------------- */
    CAMERA: {
      minZoom: 0.25,
      maxZoom: 2.2,
      defaultZoom: 1.0,
      wheelZoomStep: 1.15,         // 휠 한 칸당 배율
      keyPanSpeed: 900,            // 키보드 이동 속도 (화면 px/초)
      zoomSmoothing: 14,           // 줌 부드러움 (클수록 빨리 따라감)
      panDurationMs: 380,          // 유닛으로 이동할 때 카메라 이동 시간
      dragThresholdPx: 6,          // 이만큼 움직이면 클릭이 아니라 드래그
      longPressMs: 520             // 터치 길게 누르기 = 우클릭
    },

    ANIMATION: {
      unitStepMs: 150              // 유닛이 한 칸 이동하는 시간
    }
  };
})();
