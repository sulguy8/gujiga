'use strict';

// 세력전 1회 이관 + 장부 저장 + 정합성 점검 (TSK-023)
// 사용: node bin/migrate-nations.js [mock_portfolio.md 경로]
// 원본은 읽기만 한다(쓰기 0). 재실행 시 멱등(재이관 방지 마커).

const path = require('node:path');
const os = require('node:os');
const nation = require('../src/nation');

const src = process.argv[2] || path.join(os.homedir(), '.aside', 'u', '1', 'trading', 'mock_portfolio.md');

const rpt = nation.migrateMockPortfolio(src, {});
if (rpt.skipped) {
  console.log('이미 이관됨(멱등) — 건너뜀:', JSON.stringify(rpt));
} else {
  console.log('이관 완료:', JSON.stringify(rpt));
}

const saved = nation.saveLedger({});
for (const n of nation.NATIONS) {
  const L = saved[n];
  console.log(`${n}: 배정 ${L.allocated} · 현금 ${L.cash} · 평가 ${L.position_value} · 실현 ${L.realized_pnl} · 수익률 ${(L.return_rate * 100).toFixed(2)}%`);
}

const integ = nation.checkIntegrity({});
console.log(integ.ok ? '정합성: 통과' : `정합성: 경고 ${integ.warnings.length}건`);
