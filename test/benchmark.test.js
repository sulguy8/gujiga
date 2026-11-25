'use strict';

// TST-021 — 비교 기준선 KODEX 200(TSK-022 / REQ-027)
// 실행: node --test — 순수 함수 단위(계좌·주문 무관). 실서버 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const bm = require('../src/benchmark');
const state = require('../src/state');
const ledger = require('../src/ledger');
const web = require('../src/web');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst021-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function rows(dir, name) {
  const d = paths.ledgerDir(dir, name);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

// ===== 시나리오 1: 시작 10,000·50만 → 종가 11,000 = +10.0% =====
test('시나리오1: 기준선 수익률 +10.0% (수기 검산)', () => {
  const r = bm.computeSeries({
    startAmount: 500000,
    entries: [
      { date: '2026-11-24', close: 10000, source: 'krx_official' },
      { date: '2026-11-25', close: 11000, source: 'krx_official' },
    ],
    flows: [],
  });
  assert.equal(r.finalValue, 550000);
  assert.equal(r.returnPct, 10.0, '+10.0%');
  assert.equal(r.invested, 500000);
});

// ===== 시나리오 2: 우리 +4% → 초과 -6.0%p =====
test('시나리오2: 초과수익 -6.0%p 정확', () => {
  assert.equal(bm.excessPp(4.0, 10.0), -6.0);
  assert.equal(bm.excessPp(12.5, 10.0), 2.5);
});

// ===== 시나리오 3 + 에지(출금): 현금흐름 — 그날 종가 매매 가정 =====
test('시나리오3: 입금 20만(종가 10,500) 반영 기준선 수기 검산 일치·출금은 매도 가정', () => {
  const r = bm.computeSeries({
    startAmount: 500000,
    entries: [
      { date: '2026-11-24', close: 10000, source: 'krx_official' },
      { date: '2026-11-25', close: 10500, source: 'krx_official' },
      { date: '2026-11-26', close: 11000, source: 'krx_official' },
    ],
    flows: [{ date: '2026-11-25', amount: 200000 }],
  });
  // 수기: 50 + 200000/10500 = 69.047619 유닛 → ×11000 = 759,523.8…
  assert.ok(Math.abs(r.finalValue - 759523.81) < 0.5, `수기 검산(${r.finalValue})`);
  assert.equal(r.invested, 700000);
  assert.ok(Math.abs(r.returnPct - 8.5) < 0.01, '+8.50%');

  // 출금: 그날 종가 매도 가정
  const w = bm.computeSeries({
    startAmount: 500000,
    entries: [
      { date: '2026-11-24', close: 10000, source: 'krx_official' },
      { date: '2026-11-25', close: 10500, source: 'krx_official' },
    ],
    flows: [{ date: '2026-11-25', amount: -105000 }], // 10유닛 매도
  });
  assert.ok(Math.abs(w.units - 40) < 1e-9, '유닛 50→40');
  assert.equal(w.finalValue, 420000);
});

// ===== 시나리오 4: 최대 낙폭(수기) =====
test('시나리오4: 최대 낙폭 — 10,000→11,000→9,500→10,200 = -13.64%', () => {
  const mdd = bm.maxDrawdownPct([10000, 11000, 9500, 10200]);
  assert.ok(Math.abs(mdd - -13.64) < 0.01, `수기: (9500-11000)/11000 = -13.64% (got ${mdd})`);
  assert.equal(bm.maxDrawdownPct([10000]), 0, '시작일 당일 낙폭 0');
});

// ===== 시나리오 5: 결측일 — 직전 종가 유지 + 결측 표시 =====
test('시나리오5: 결측일은 직전 종가 유지·missing 표시', () => {
  const r = bm.computeSeries({
    startAmount: 500000,
    entries: [
      { date: '2026-11-24', close: 10000, source: 'krx_official' },
      { date: '2026-11-25', close: null, source: null, missing: true },
      { date: '2026-11-26', close: 11000, source: 'krx_official' },
    ],
    flows: [],
  });
  assert.equal(r.returnPct, 10.0, '결측 무시하고 직전 유지 계산');
  assert.deepEqual(r.missingDates, ['2026-11-25'], '결측 표시');
  assert.equal(r.values[1], 500000, '결측일 값 = 직전 종가 기준');
});

// ===== 시나리오 6: 출처 태그 검증 — krx_official만 =====
test('시나리오6: naver_mstock 가격 주입 → 계산 거부', () => {
  assert.throws(() => bm.computeSeries({
    startAmount: 500000,
    entries: [
      { date: '2026-11-24', close: 10000, source: 'krx_official' },
      { date: '2026-11-25', close: 11000, source: 'naver_mstock' },
    ],
    flows: [],
  }), /krx_official|출처/);
});

// ===== 시나리오 7: 4주 연속 마이너스 경고 =====
test('시나리오7: 주간 초과 [-,-,-,-] 경고·3주+회복은 미표시', () => {
  assert.equal(bm.trailingNegativeWeeks([-1, -0.5, -2, -0.1]), 4);
  assert.equal(bm.warn4Weeks([-1, -0.5, -2, -0.1]), true, '4주 연속 경고');
  assert.equal(bm.warn4Weeks([-1, -0.5, -2, 0.3]), false, '마지막 주 회복 — 미표시');
  assert.equal(bm.warn4Weeks([0.2, -1, -0.5, -2]), false, '연속 3주는 미달');
});

// ===== 시나리오 8: 나라별 기준선(촉 100만·11-23 시작) =====
test('시나리오8: 나라별 — 촉 100만/위 50만/오 50만 각자 배정액 기준', () => {
  const entries = [
    { date: '2026-11-23', close: 10000, source: 'krx_official' },
    { date: '2026-11-24', close: 10500, source: 'krx_official' },
  ];
  const chok = bm.computeSeries({ startAmount: 1000000, entries, flows: [] });
  const wi = bm.computeSeries({ startAmount: 500000, entries, flows: [] });
  assert.equal(chok.finalValue, 1050000);
  assert.equal(wi.finalValue, 525000);
  assert.equal(chok.returnPct, 5.0);
});

// ===== 순수성: 동일 입력 2회 동일 출력 =====
test('에지: 같은 입력 2회 → 동일 출력(순수)', () => {
  const input = {
    startAmount: 500000,
    entries: [
      { date: '2026-11-24', close: 10000, source: 'krx_official' },
      { date: '2026-11-25', close: 10200, source: 'krx_official' },
    ],
    flows: [{ date: '2026-11-25', amount: 100000 }],
  };
  assert.deepEqual(bm.computeSeries(input), bm.computeSeries(input));
});

// ===== 원장: 거래일 1행 적립(recordDay)·결측 전파 =====
test('원장: recordDay — 실전·나라별 평가액 1행/일, 결측일 직전 종가 유지', () => {
  const dir = makeTmpDir();
  try {
    bm.recordDay({ date: '2026-11-24', close: 10000, source: 'krx_official' }, { dataDir: dir });
    bm.recordDay({ date: '2026-11-25', close: null, missing: true }, { dataDir: dir });
    bm.recordDay({ date: '2026-11-26', close: 11000, source: 'krx_official' }, { dataDir: dir });
    const r = rows(dir, 'benchmark');
    assert.equal(r.length, 3);
    assert.equal(r[0].real_value, 500000, '실전 시작 50만(11-24 기준)');
    assert.equal(r[1].missing, true, '결측 표시');
    assert.equal(r[1].kodex_close, 10000, '직전 종가 유지');
    assert.equal(r[2].real_value, 550000, '+10%');
    // 나라별: 시작일(11-23) 이전 가격이 없으므로 첫 가용 종가 기준 — 촉 100만
    assert.equal(r[2].nations.chok.value, 1100000, '촉 100만 +10%');
    assert.equal(r[2].nations.wi.value, 550000);
    // 같은 날 재기록 금지(멱등)
    bm.recordDay({ date: '2026-11-26', close: 11000, source: 'krx_official' }, { dataDir: dir });
    assert.equal(rows(dir, 'benchmark').length, 3, '중복 0');
  } finally {
    rm(dir);
  }
});

// ===== 화면: 논공행상·현황판 4종 지표 + 경고 + 결측 표시 =====
test('화면: /merit·현황판에 우리/기준선/초과/낙폭 표시·4주 경고·결측 표시', async () => {
  const dir = makeTmpDir();
  try {
    // 기준선 원장 3일 + 우리 평가(스냅샷) 2일
    bm.recordDay({ date: '2026-11-24', close: 10000, source: 'krx_official' }, { dataDir: dir });
    bm.recordDay({ date: '2026-11-25', close: null, missing: true }, { dataDir: dir });
    bm.recordDay({ date: '2026-11-26', close: 11000, source: 'krx_official' }, { dataDir: dir });
    ledger.append('daily_account_snapshot', { id: 's1', snapshot_date: '2026-11-24', account_type: 'real', start_total_eval: 500000, start_cash: 500000, created_at: '2026-11-24T08:30:00+09:00' }, { dataDir: dir });
    ledger.append('daily_account_snapshot', { id: 's2', snapshot_date: '2026-11-26', account_type: 'real', start_total_eval: 520000, start_cash: 300000, created_at: '2026-11-26T08:30:00+09:00' }, { dataDir: dir });
    state.write('weekly_excess', { values: [-1.2, -0.4, -2.0, -0.6] }, { dataDir: dir }); // 4주 연속 마이너스

    const s = bm.summary({ dataDir: dir });
    assert.equal(s.bench.returnPct, 10.0);
    assert.equal(s.ours.returnPct, 4.0, '우리 50만→52만 = +4%');
    assert.equal(s.excessPp, -6.0);
    assert.equal(s.warn4w, true);
    assert.equal(s.missingDays, 1);

    const srv = await web.start({ dataDir: dir, port: 0, today: '2026-11-26' });
    try {
      const meritPage = await get(srv.port, '/merit');
      assert.match(meritPage.body, /기준선|KODEX/, '기준선 섹션');
      assert.match(meritPage.body, /10\.0\s*%|10%/, '기준선 수익률');
      assert.match(meritPage.body, /-6\.0\s*%p|-6%p/, '초과수익 %p');
      assert.match(meritPage.body, /낙폭/, '최대 낙폭');
      assert.match(meritPage.body, /지수 보유보다 못함/, '4주 경고');
      assert.match(meritPage.body, /결측 1일|결측/, '결측 표시');

      const board = await get(srv.port, '/');
      assert.match(board.body, /기준선|초과/, '현황판 요약 1줄');
    } finally {
      await srv.close();
    }
  } finally {
    rm(dir);
  }
});
