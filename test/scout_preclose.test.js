'use strict';

// TST-007 — 5분 척후(REQ-006)·15:05 점검(REQ-007)·종가 손절 판정·급락일 분기(REQ-008)
// 상위: TSK-008 / ARC-004 / DAT-006
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 군사 지시 반영:
//  1) 시세·종가는 공급자 주입. 종가 판정은 'krx_official' 출처 태그만 수용(NXT 등은 거부)
//  2) 마감 시각은 캘린더 closeTime(수능일 16:30) — 15:30 고정 금지
//  3) 판정은 장 마감 후에만. 장중 이탈은 기록만
//  4) 매도 출사표는 created_by='system'·user_confirmed=false, 전송 경로 0
//  5) 척후 중복 억제·연속 3회 실패 두절 경고. 알림은 훅 자리만

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scout = require('../src/scout');
const preclose = require('../src/preclose');
const judgment = require('../src/stop_judgment');
const state = require('../src/state');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst007-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function rows(dir, name) {
  const d = paths.ledgerDir(dir, name);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

// 기준 포지션: 성벽 10,000원·목표 12,000원 (REQ 숫자 예시 재사용)
function seedPositions(dir, extra) {
  state.write('positions', extra || [
    { id: 'p1', account_type: 'paper', nation: 'chok', symbol: '005930', name: '삼성전자', qty: 10, avg_price: 10500, stop_price: 10000, target_price: 12000, deadline: '2026-12-10', status: 'open' },
  ], { dataDir: dir });
}

function quoteOf(map) {
  return (symbol) => {
    if (!(symbol in map)) throw new Error('시세 없음');
    const v = map[symbol];
    if (v instanceof Error) throw v;
    return { symbol, price: v };
  };
}

// ============================ 5분 척후 ============================

// ===== 시나리오 1: 조건 미충족 → 알림 0건(조용한 척후) =====
test('시나리오1: 조건 미충족 시세 → 보고 0건', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    const res = scout.runScout({ dataDir: dir, now: '2026-11-25T10:00:00+09:00', providers: { quote: quoteOf({ '005930': 11000 }) } });
    assert.equal(res.ran, true);
    assert.equal(rows(dir, 'scout_log').filter((r) => r.type === 'report').length, 0, '보고 0건');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 2: 성벽 접근 충족 → 보고 1건 + 연속 충족 중복 0 + 해제 후 재충족 재보고 =====
test('시나리오2: 성벽 접근 보고 1건, 연속 중복 0, 해제 후 재보고', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    const notifies = [];
    const notify = (e) => notifies.push(e);
    const base = { dataDir: dir, notify };

    // 10,250원 = 성벽까지 2.5% 접근 → 보고
    scout.runScout({ ...base, now: '2026-11-25T10:00:00+09:00', providers: { quote: quoteOf({ '005930': 10250 }) } });
    let reports = rows(dir, 'scout_log').filter((r) => r.type === 'report');
    assert.equal(reports.length, 1, '보고 1건');
    assert.equal(reports[0].symbol, '005930', '종목 포함');
    assert.match(reports[0].condition, /stop_approach/, '조건 포함');
    assert.equal(reports[0].price, 10250, '수치 포함');
    assert.equal(notifies.length, 1, '알림 훅 1회');

    // 같은 조건 연속 충족 → 중복 보고 없음
    scout.runScout({ ...base, now: '2026-11-25T10:05:00+09:00', providers: { quote: quoteOf({ '005930': 10200 }) } });
    reports = rows(dir, 'scout_log').filter((r) => r.type === 'report');
    assert.equal(reports.length, 1, '연속 충족 중복 0');

    // 해제(11,000원) 후 재충족(10,250원) → 재보고
    scout.runScout({ ...base, now: '2026-11-25T10:10:00+09:00', providers: { quote: quoteOf({ '005930': 11000 }) } });
    scout.runScout({ ...base, now: '2026-11-25T10:15:00+09:00', providers: { quote: quoteOf({ '005930': 10250 }) } });
    reports = rows(dir, 'scout_log').filter((r) => r.type === 'report');
    assert.equal(reports.length, 2, '해제 후 재충족 재보고');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 3: 연속 3회 실패 → 두절 경고 1회(4회째도 중복 없음) =====
test('시나리오3: 시세 연속 3회 실패 시 두절 경고 1회', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    const notifies = [];
    const failing = { quote: () => { throw new Error('시세 응답 없음'); } };
    const base = { dataDir: dir, notify: (e) => notifies.push(e), providers: failing };

    scout.runScout({ ...base, now: '2026-11-25T10:00:00+09:00' });
    scout.runScout({ ...base, now: '2026-11-25T10:05:00+09:00' });
    let alerts = rows(dir, 'scout_log').filter((r) => r.type === 'alert_lost');
    assert.equal(alerts.length, 0, '2회까지는 경고 없음');

    scout.runScout({ ...base, now: '2026-11-25T10:10:00+09:00' });
    alerts = rows(dir, 'scout_log').filter((r) => r.type === 'alert_lost');
    assert.equal(alerts.length, 1, '3회째 두절 경고 1회');

    scout.runScout({ ...base, now: '2026-11-25T10:15:00+09:00' });
    alerts = rows(dir, 'scout_log').filter((r) => r.type === 'alert_lost');
    assert.equal(alerts.length, 1, '4회째에도 중복 경고 없음');

    // 실패 회차는 fail 기록으로 남는다
    assert.ok(rows(dir, 'scout_log').filter((r) => r.type === 'tick' && r.fail).length >= 4, '실패 기록');
    assert.equal(notifies.filter((e) => e.kind === 'alert_lost').length, 1, '알림 훅도 1회');
  } finally {
    rm(dir);
  }
});

// ===== 경계: 장외·휴장일·수능일 연장 =====
test('경계: 개장 전·마감 후·휴장일 미실행, 수능일은 16:30까지 실행', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    const q = { quote: quoteOf({ '005930': 11000 }) };
    assert.equal(scout.runScout({ dataDir: dir, now: '2026-11-25T08:50:00+09:00', providers: q }).ran, false, '개장 전');
    assert.equal(scout.runScout({ dataDir: dir, now: '2026-11-25T15:35:00+09:00', providers: q }).ran, false, '마감 후');
    assert.equal(scout.runScout({ dataDir: dir, now: '2026-11-28T10:00:00+09:00', providers: q }).ran, false, '휴장일(토)');
    // 수능일(2026-11-19): 10:00 개장·16:30 폐장 — 16:00 실행 가능, 09:30 불가
    assert.equal(scout.runScout({ dataDir: dir, now: '2026-11-19T16:00:00+09:00', providers: q }).ran, true, '수능일 16:00 실행(closeTime 16:30)');
    assert.equal(scout.runScout({ dataDir: dir, now: '2026-11-19T09:30:00+09:00', providers: q }).ran, false, '수능일 09:30은 개장 전');
  } finally {
    rm(dir);
  }
});

// ============================ 15:05 점검 ============================

// ===== 시나리오 4·5 + AC1 + 경계: 거리 판정 =====
test('시나리오4·5: 15:05 점검 — 2.5% 판정 필요 / 0.4% 동시호가 경고 / 경계 3.0%·0.5% / 3% 초과 침묵', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir, [
      { id: 'p1', account_type: 'paper', symbol: 'A1', name: '판정', qty: 1, avg_price: 10500, stop_price: 10000, target_price: 99000, deadline: '2026-12-10', status: 'open' },
      { id: 'p2', account_type: 'paper', symbol: 'A2', name: '동시호가', qty: 1, avg_price: 10500, stop_price: 10000, target_price: 99000, deadline: '2026-12-10', status: 'open' },
      { id: 'p3', account_type: 'paper', symbol: 'A3', name: '경계3', qty: 1, avg_price: 10500, stop_price: 10000, target_price: 99000, deadline: '2026-12-10', status: 'open' },
      { id: 'p4', account_type: 'paper', symbol: 'A4', name: '경계05', qty: 1, avg_price: 10500, stop_price: 10000, target_price: 99000, deadline: '2026-12-10', status: 'open' },
      { id: 'p5', account_type: 'paper', symbol: 'A5', name: '침묵', qty: 1, avg_price: 10500, stop_price: 10000, target_price: 99000, deadline: '2026-12-10', status: 'open' },
      { id: 'p6', account_type: 'paper', symbol: 'A6', name: '누락', qty: 1, avg_price: 10500, stop_price: null, target_price: null, deadline: '2026-12-10', status: 'open' },
    ]);
    const quotes = quoteOf({ A1: 10250, A2: 10040, A3: 10300, A4: 10050, A5: 10310, A6: 10000 });
    const res = preclose.check({ dataDir: dir, now: '2026-11-25T15:05:00+09:00', providers: { quote: quotes } });

    const by = (s) => res.items.find((i) => i.symbol === s);
    // AC1·시나리오4: 10,250원 → 거리 2.5% → 판정 필요
    assert.equal(by('A1').needJudgment, true, '2.5% 판정 필요');
    assert.equal(by('A1').auctionWarning, false);
    // 시나리오5: 10,040원 → 0.4% → 판정 필요 + 동시호가 경고
    assert.equal(by('A2').needJudgment, true);
    assert.equal(by('A2').auctionWarning, true, '0.4% 동시호가 경고');
    // 경계: 정확 3.0% → 판정 필요(이하 기준)
    assert.equal(by('A3').needJudgment, true, '정확 3.0% 포함');
    // 경계: 정확 0.5% → 동시호가 경고(이하 기준)
    assert.equal(by('A4').auctionWarning, true, '정확 0.5% 포함');
    // 3% 초과 → 아무 표시 없음
    assert.equal(by('A5'), undefined, '3.1%는 침묵');
    // 기준선 누락 경고
    assert.equal(by('A6').missingLine, true, '기준선 누락');

    // 장부 기록 1건(한 메시지로 모음)
    assert.equal(rows(dir, 'preclose_log').length, 1);
  } finally {
    rm(dir);
  }
});

// ============================ 종가 손절 판정 ============================

function candleProvider(map) {
  return { dailyCandle: (symbol) => map[symbol] };
}

// ===== 시나리오 6 + AC2/지시3: 장중 이탈·종가 회복 → 판정 없음 =====
test('시나리오6: 장중 9,900원 이탈 후 종가 10,100원 → 판정 없음', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    const res = judgment.judgeClose({
      dataDir: dir, now: '2026-11-25T15:40:00+09:00',
      providers: candleProvider({ '005930': { date: '2026-11-25', open: 10200, high: 10300, low: 9900, close: 10100, source: 'krx_official' } }),
    });
    assert.equal(res.judged, true);
    assert.equal(rows(dir, 'stop_judgment').filter((r) => r.type === 'breach').length, 0, '판정 없음(종가 기준)');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 7: 종가 이탈 → 판정 기록(1회만) + 익일 매도 출사표(system·false) =====
test('시나리오7: 종가 9,900원 → 판정 기록 + 익일 매도 출사표 자동 생성', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    const candles = candleProvider({ '005930': { date: '2026-11-25', open: 10200, high: 10300, low: 9800, close: 9900, source: 'krx_official' } });

    judgment.judgeClose({ dataDir: dir, now: '2026-11-25T15:40:00+09:00', providers: candles });
    let breaches = rows(dir, 'stop_judgment').filter((r) => r.type === 'breach');
    assert.equal(breaches.length, 1, '판정 기록');
    assert.equal(breaches[0].symbol, '005930');

    // 중복 판정 방지(비기능): 재실행에도 1건
    judgment.judgeClose({ dataDir: dir, now: '2026-11-25T15:50:00+09:00', providers: candles });
    breaches = rows(dir, 'stop_judgment').filter((r) => r.type === 'breach');
    assert.equal(breaches.length, 1, '중복 판정 0');

    // 포지션에 판정일 기록
    const pos = state.read('positions', { dataDir: dir });
    assert.equal(pos[0].stop_breached_date, '2026-11-25');

    // 익일(2026-11-26) 오전: 매도 출사표 생성 — 평시(급락 아님)
    const drafts = judgment.generateSellDrafts({
      dataDir: dir, now: '2026-11-26T09:01:00+09:00',
      providers: { morning: () => ({ open: 9950, low: 9900, price: 9950 }) },
    });
    assert.equal(drafts.created.length, 1, '매도 출사표 1건');
    const saved = rows(dir, 'order_draft');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].side, 'sell');
    assert.equal(saved[0].created_by, 'system', 'created_by=system(지시4)');
    assert.equal(saved[0].user_confirmed, false, 'user_confirmed=false(AC4)');

    // 멱등: 다시 호출해도 중복 생성 없음
    const again = judgment.generateSellDrafts({
      dataDir: dir, now: '2026-11-26T09:05:00+09:00',
      providers: { morning: () => ({ open: 9950, low: 9900, price: 9950 }) },
    });
    assert.equal(again.created.length, 0, '중복 출사표 0');
  } finally {
    rm(dir);
  }
});

// ===== 지시1: 종가 출처 태그 검증 — krx_official 아니면 판정 거부 =====
test('지시1: NXT 등 비공식 출처 종가는 판정 거부·기록', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    judgment.judgeClose({
      dataDir: dir, now: '2026-11-25T15:40:00+09:00',
      providers: candleProvider({ '005930': { date: '2026-11-25', open: 10200, high: 10300, low: 9800, close: 9900, source: 'nxt' } }),
    });
    const log = rows(dir, 'stop_judgment');
    assert.equal(log.filter((r) => r.type === 'breach').length, 0, '비공식 출처로는 판정하지 않는다');
    const refused = log.filter((r) => r.type === 'refused');
    assert.equal(refused.length, 1, '거부 기록');
    assert.match(refused[0].reason, /source|출처/i);
    // 출처 태그 자체가 없어도 거부
    judgment.judgeClose({
      dataDir: dir, now: '2026-11-25T15:45:00+09:00',
      providers: candleProvider({ '005930': { date: '2026-11-25', open: 10200, high: 10300, low: 9800, close: 9900 } }),
    });
    assert.equal(rows(dir, 'stop_judgment').filter((r) => r.type === 'refused').length, 2, '태그 부재도 거부');
  } finally {
    rm(dir);
  }
});

// ===== 지시3: 장 마감 전에는 판정하지 않는다(수능일은 16:30 이후) =====
test('지시3: 마감 전 판정 거부 — 평일 15:00 거부, 수능일 15:40도 거부·16:40 허용', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    const candles = candleProvider({ '005930': { date: '2026-11-25', open: 10200, high: 10300, low: 9800, close: 9900, source: 'krx_official' } });
    // 평일 15:00(마감 전) → 거부
    const r1 = judgment.judgeClose({ dataDir: dir, now: '2026-11-25T15:00:00+09:00', providers: candles });
    assert.equal(r1.judged, false, '마감 전 거부');
    assert.equal(rows(dir, 'stop_judgment').filter((r) => r.type === 'breach').length, 0);
    // 수능일(폐장 16:30): 15:40 거부, 16:40 허용
    const candles19 = candleProvider({ '005930': { date: '2026-11-19', open: 10200, high: 10300, low: 9800, close: 9900, source: 'krx_official' } });
    const r2 = judgment.judgeClose({ dataDir: dir, now: '2026-11-19T15:40:00+09:00', providers: candles19 });
    assert.equal(r2.judged, false, '수능일 15:40은 아직 장중');
    const r3 = judgment.judgeClose({ dataDir: dir, now: '2026-11-19T16:40:00+09:00', providers: candles19 });
    assert.equal(r3.judged, true, '수능일 16:40 허용');
  } finally {
    rm(dir);
  }
});

// ============================ 급락일 분기 ============================

// ===== 시나리오 8 + 경계: 급락일 분류 =====
test('시나리오8: 전일 종가 10,000·시가 9,650 → 급락일. 경계 9,700 급락·9,710 아님', () => {
  assert.equal(judgment.isCrashOpen(10000, 9650), true, '-3.5% 급락일');
  assert.equal(judgment.isCrashOpen(10000, 9700), true, '정확 -3.0%도 급락일(이상 기준)');
  assert.equal(judgment.isCrashOpen(10000, 9710), false, '-2.9%는 아님');
});

// ===== 시나리오 9: 급락일 저가 9,500 → 9,690 회복 = 첫 반등 → 실행 대상 =====
test('시나리오9: 급락일 첫 반등(저가+2%) 판정 → 매도 실행 대상', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    // 전일 판정(종가 9,900 < 성벽 10,000)
    judgment.judgeClose({
      dataDir: dir, now: '2026-11-25T15:40:00+09:00',
      providers: candleProvider({ '005930': { date: '2026-11-25', open: 10000, high: 10100, low: 9800, close: 9900, source: 'krx_official' } }),
    });
    // 익일 아침: 시가 9,650(전일 종가 9,900 대비 -2.5%... 급락 기준은 전일 종가 대비)
    // REQ-008 숫자 예시 그대로: 전일 종가 10,000 기준 시가 9,650 — prevClose를 주입해 재현
    const gen = judgment.generateSellDrafts({
      dataDir: dir, now: '2026-11-26T09:01:00+09:00',
      providers: { morning: () => ({ open: 9650, low: 9600, price: 9650, prevClose: 10000 }) },
    });
    assert.equal(gen.created.length, 1);
    assert.equal(gen.created[0].exitPlan.mode, 'crash', '급락일 분기');
    // 생성 직후에는 실행 대기(반등 전)
    let plans = rows(dir, 'exit_plan');
    assert.equal(plans[plans.length - 1].execute_ready, false, '반등 전 대기');

    // 저가 9,500 갱신 후 9,690(저가+2%) 회복 → 첫 반등 → 실행 대상
    judgment.checkCrashExit({ dataDir: dir, now: '2026-11-26T09:40:00+09:00', providers: { morning: () => ({ open: 9650, low: 9500, price: 9550 }) } });
    plans = rows(dir, 'exit_plan');
    assert.equal(plans[plans.length - 1].execute_ready, false, '9,550은 아직 반등 아님');

    const r = judgment.checkCrashExit({ dataDir: dir, now: '2026-11-26T09:45:00+09:00', providers: { morning: () => ({ open: 9650, low: 9500, price: 9690 }) } });
    plans = rows(dir, 'exit_plan');
    const last = plans[plans.length - 1];
    assert.equal(last.execute_ready, true, '9,690 회복 = 첫 반등 → 실행 대상');
    assert.equal(last.trigger, 'rebound');
    assert.equal(last.rebound_price, 9690);

    // 실행 대상이어도 출사표는 여전히 user_confirmed=false(전송 수단 0 — AC4)
    const drafts = rows(dir, 'order_draft');
    assert.equal(drafts[0].user_confirmed, false);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 10: 급락일 10:30까지 반등 없음 → 10:30 실행 대상 =====
test('시나리오10: 급락일 반등 없이 10:30 → 실행 대상(trigger=time)', () => {
  const dir = makeTmpDir();
  try {
    seedPositions(dir);
    judgment.judgeClose({
      dataDir: dir, now: '2026-11-25T15:40:00+09:00',
      providers: candleProvider({ '005930': { date: '2026-11-25', open: 10000, high: 10100, low: 9800, close: 9900, source: 'krx_official' } }),
    });
    judgment.generateSellDrafts({
      dataDir: dir, now: '2026-11-26T09:01:00+09:00',
      providers: { morning: () => ({ open: 9650, low: 9600, price: 9620, prevClose: 10000 }) },
    });
    // 10:29 반등 없음 → 대기
    judgment.checkCrashExit({ dataDir: dir, now: '2026-11-26T10:29:00+09:00', providers: { morning: () => ({ open: 9650, low: 9500, price: 9640 }) } });
    let plans = rows(dir, 'exit_plan');
    assert.equal(plans[plans.length - 1].execute_ready, false, '10:29 대기');
    // 10:30 도달 → 실행 대상
    judgment.checkCrashExit({ dataDir: dir, now: '2026-11-26T10:30:00+09:00', providers: { morning: () => ({ open: 9650, low: 9500, price: 9640 }) } });
    plans = rows(dir, 'exit_plan');
    const last = plans[plans.length - 1];
    assert.equal(last.execute_ready, true, '10:30 실행 대상');
    assert.equal(last.trigger, 'time_1030');
  } finally {
    rm(dir);
  }
});

// ===== AC4/지시4: 전송 경로 0 — 모듈 공개 API에 send/전송 함수 부재 =====
test('AC4: scout·preclose·judgment 어디에도 전송 경로가 없다', () => {
  const forbidden = /send|transmit|submit.?order|broker|kis/i;
  for (const [name, mod] of [['scout', scout], ['preclose', preclose], ['stop_judgment', judgment]]) {
    for (const k of Object.keys(mod)) {
      assert.ok(!forbidden.test(k), `${name}.${k} — 전송류 금지`);
    }
  }
  const od = require('../src/order_draft');
  for (const k of Object.keys(od)) {
    assert.ok(!forbidden.test(k), `order_draft.${k} — 전송류 금지`);
  }
});
