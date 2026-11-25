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
  return {
    quote: (sym) => {
      if (!(sym in quotes)) throw new Error('시세 없음');
      return { symbol: sym, price: quotes[sym] };
    },
    accountSnapshot: () => { throw new Error('계좌 조회 미연결(그림자 선택 항목)'); },
  };
}

async function tick() {
  try {
    const providers = await buildProviders();
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
