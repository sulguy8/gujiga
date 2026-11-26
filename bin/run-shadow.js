#!/usr/bin/env node
'use strict';

// 그림자 운용 데몬 실행 (TSK-018) — 주문 0건, 산출·판정·대조만.
//
// 사용: node bin/run-shadow.js
//  - 1분 간격으로 shadow.runOnce를 수행(정시 회차는 캘린더·시각표가 결정).
//  - 시세·계좌 조회는 gate.query(조회 전용 — 주문 아님) 경유. 키는 GUJIGA_KIS_KEYS(.enc).
//  - 알림은 config/notify.json(그림자 기본: PC OS만, 텔레그램 off).
//  - Aside trading 폴더는 대조용 읽기만(config/shadow.json의 aside_root).
//  - 상주 등록: bin/shadow-task-register.ps1 — 실행은 군주가 직접.

const fs = require('node:fs');
const path = require('node:path');
const shadow = require('../src/shadow');
const gate = require('../src/gate'); // 조회 전용(price/balance) — 주문은 그림자에서 호출하지 않는다
const state = require('../src/state');

const cfgPath = path.join(__dirname, '..', 'config', 'shadow.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};

const gateOpts = { keysPath: process.env.GUJIGA_KIS_KEYS };

// 시세는 틱마다 선조회해 동기 공급자 맵으로 만든다(조회 전용).
async function buildProviders() {
  const positions = (state.read('positions', {}) || []).filter((p) => p.status === 'open');
  const quotes = {};
  for (const p of positions) {
    try {
      const q = await gate.query('real', 'price', [p.symbol], gateOpts);
      quotes[p.symbol] = q.price;
    } catch (e) { /* 결측 — scout이 실패 처리 */ }
  }
  // 최근 시세 캐시(지령 015): 현황판이 '읽기 전용'으로 평가·성벽 거리를 계산할 수 있게
  // 그림자가 방금 조회한 시세를 기준 시각과 함께 남긴다(쓰는 쪽은 그림자뿐).
  if (Object.keys(quotes).length > 0) {
    try {
      const paths = require('../src/paths');
      const dir = path.join(paths.resolveDataDir({}), 'market_cache');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'quotes_latest.json'),
        JSON.stringify({ updated_at: new Date().toISOString(), quotes }, null, 2) + '\n', 'utf8');
    } catch (e) { /* 캐시 실패는 치명 아님 */ }
  }
  // KODEX 200 전일 종가(기준선 적립 — 출사표 002). 실패 시 provider가 던지고 데몬은 결측 기록.
  let kodexBar = null;
  try {
    const bars = await gate.query('real', 'dailyCandle', ['069500', 10], gateOpts);
    kodexBar = bars[bars.length - 1]; // {date, close, source:'krx_official'}
  } catch (e) { /* 결측 */ }

  // 체결조회(모의) — 회군 감지용. pdno(종목코드)로 직접 매칭(출사표 003 — 역변환 제거).
  // pdno가 비면 shadow가 그 행을 회군 감지에서 건너뛰고 기록한다.
  async function fetchFills(ymd, env) {
    const f = await gate.query(env || 'mock', 'fills', [ymd], gateOpts);
    return (f.rows || []).map((r) => ({
      odno: r.odno,
      symbol: r.symbol || null, // 어댑터가 pdno를 실어 준다
      side: /매도/.test(r.side) ? 'sell' : 'buy',
      filled: r.filled, avgFill: r.avgFill, remain: r.remain,
    }));
  }
  let todayFills = null;
  let todayFillsReal = null;

  return {
    quote: (sym) => {
      if (!(sym in quotes)) throw new Error('시세 없음');
      return { symbol: sym, price: quotes[sym] };
    },
    accountSnapshot: () => { throw new Error('계좌 조회 미연결(그림자 선택 항목)'); },
    kodexClose: () => {
      if (!kodexBar) throw new Error('KODEX 종가 결측');
      return kodexBar;
    },
    fills: (ymd) => {
      // 동기 인터페이스 유지: 틱 시작 때 선조회한 결과 반환(아래 tick에서 채움)
      if (todayFills == null) throw new Error('체결조회 미선행');
      return todayFills;
    },
    // 책사단 안건 입력용 일봉(곽가 이동평균·법정 추세 — 조회 전용)
    dailyBars: async (symbol) => gate.query('real', 'dailyCandle', [symbol, 60], gateOpts),
    // 책사단 채점용 종가 조회(일봉 J — krx_official 태그 포함, 조회 전용). 심볼당 1회 캐시.
    closes: (() => {
      const cache = new Map();
      return async (symbol, dateStr) => {
        if (!cache.has(symbol)) {
          try {
            cache.set(symbol, await gate.query('real', 'dailyCandle', [symbol, 160], gateOpts));
          } catch (e) {
            cache.set(symbol, []);
          }
        }
        const bar = (cache.get(symbol) || []).find((b) => b.date === dateStr);
        return bar ? { close: bar.close, source: bar.source } : null;
      };
    })(),
    fillsReal: (ymd) => {
      // 실전 체결조회(조회 전용 — 주문 아님). 매수 자동 반영(watchSorties)용.
      if (todayFillsReal == null) throw new Error('실전 체결조회 미선행');
      return todayFillsReal;
    },
    _prefetchFills: async (ymd) => {
      todayFills = await fetchFills(ymd, 'mock');
      try {
        todayFillsReal = await fetchFills(ymd, 'real');
      } catch (e) { /* 실전 체결조회 실패 — 실전 감지만 생략(다음 틱 재시도) */ }
    },
  };
}

async function tick() {
  try {
    const providers = await buildProviders();
    try {
      const ymd = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(/-/g, '');
      await providers._prefetchFills(ymd); // 회군 감지용 체결 선조회(실패 시 fills가 던짐 → 감지 생략)
    } catch (e) { /* 체결조회 실패 — 회군 감지만 생략 */ }
    const r = await shadow.runOnce({
      now: new Date(),
      providers,
      asideRoot: cfg.aside_root,
      keysPath: process.env.GUJIGA_KIS_KEYS,
      strategistOpts: { },
    });
    if (r.ran.length) console.log(`[shadow] ${new Date().toLocaleTimeString('ko-KR')} 실행: ${r.ran.join(', ')}`);
    if (r.missed.length) console.log(`[shadow] 미실행 감지(기록만): ${r.missed.map((m) => m.date + ' ' + m.job).join(', ')}`);
  } catch (e) {
    console.error(`[shadow] 틱 오류: ${e.message}`);
  }
}

console.log('[shadow] 그림자 운용 시작 — 주문 0건 모드. Ctrl+C로 종료');
tick();
setInterval(tick, 60 * 1000);
