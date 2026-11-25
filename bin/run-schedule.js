#!/usr/bin/env node
'use strict';

// 정시 엔진 1회 실행 명령 (TSK-007, 지시5 — 상주·서비스 등록 없음)
//
// 사용: node bin/run-schedule.js
// 현재 시각(KST)으로 runOnce를 1회 수행하고 결과를 출력한다.
// 데이터 공급자는 아직 미연결(TSK-003에서 증권사 어댑터 장착) — 그 전까지
// 계좌·시세는 '조회 실패'로 표시되고, 관심 종목은 빈 목록으로 동작한다.

const schedule = require('../src/schedule');

const notConnected = (what) => () => {
  throw new Error(`${what} 미연결(TSK-003 예정)`);
};

const providers = {
  watchlist: () => [], // TSK-003 전까지 빈 목록
  quote: notConnected('시세'),
  accountSnapshot: notConnected('계좌'),
};

const res = schedule.runOnce({ now: new Date(), providers });

console.log(`[run-schedule] ${res.date} ${res.trading ? '거래일' : '휴장일'}`);
console.log(`  실행: ${res.ran.join(', ') || '없음'}`);
console.log(`  건너뜀: ${res.skipped.join(', ') || '없음'}`);
if (res.missed.length) {
  console.log(`  미실행 감지(기록만, 자동 따라잡기 없음):`);
  for (const m of res.missed) console.log(`    - ${m.date} ${m.job}`);
}
