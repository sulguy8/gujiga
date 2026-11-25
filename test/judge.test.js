'use strict';

// TST-015 — 날씨·신호등·단계 판정 엔진(TSK-016) 자동 테스트
// 상위: REQ-020·REQ-021 / DAT-013 / refs/ops/spec_morning.md 22~23행(정의 정본)
// 실행: node --test — 순수 함수(외부 호출 0)
//
// 결측은 보수 판정: 날씨=방어, 해당 신호=꺼짐.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const judge = require('../src/judge');
const market = require('../src/market');
const state = require('../src/state');

// 기본 입력(전부 정상·중립권)
function inp(over) {
  return Object.assign({
    night_future_pct: 0,
    kospi_close: 5100, kospi_ma20: 5000, // 20일선 위
    foreign_net_days: 1,                 // 1일째 순매수
    us_summary: { sp500: 0.1, nasdaq: 0.2, sox: 8800, vix: 25 },
    sox_recent3_low: 8700,
    sox_base_low: 8408.59, sox_base_low_date: '2026-11-10',
    event_within_2d: false, post_event_drop_pct: -0.3,
    bad_news_resilient: false,
  }, over || {});
}

// ============================ 날씨 (REQ-020) ============================

// 시나리오 1: 야간선물 -2.0% → 방어
test('시나리오1: 야간선물 -2.0% → 방어', () => {
  assert.equal(judge.judgeWeather(inp({ night_future_pct: -2.0 })).weather, 'defense');
});

// 시나리오 2: -1.9%·20일선 위·외국인 순매수 → 중립
test('시나리오2: -1.9%·20일선 위·순매수 → 중립', () => {
  const r = judge.judgeWeather(inp({ night_future_pct: -1.9, foreign_net_days: 1 }));
  assert.equal(r.weather, 'neutral');
});

// 시나리오 3: 0%·20일선 아래·외국인 순매도 → 방어
test('시나리오3: 20일선 아래 + 순매도 → 방어', () => {
  const r = judge.judgeWeather(inp({ night_future_pct: 0, kospi_close: 4900, kospi_ma20: 5000, foreign_net_days: -1 }));
  assert.equal(r.weather, 'defense');
});

// 시나리오 4: +1.0%·20일선 위 → 공격 / +1.0%·아래 → 중립
test('시나리오4: +1.0% 분기 — 20일선 위 공격·아래 중립', () => {
  assert.equal(judge.judgeWeather(inp({ night_future_pct: 1.0 })).weather, 'attack');
  assert.equal(judge.judgeWeather(inp({ night_future_pct: 1.0, kospi_close: 4900, kospi_ma20: 5000 })).weather, 'neutral');
});

// 시나리오 5: 야간선물 결측 → 방어 + 결측 표시
test('시나리오5: 야간선물 결측 → 방어·결측 표시', () => {
  const r = judge.judgeWeather(inp({ night_future_pct: null }));
  assert.equal(r.weather, 'defense');
  assert.ok(r.missing.includes('night_future_pct'));
});

// 보수: 20일선·외국인 결측도 방어
test('결측 보수: 20일선 결측 → 방어', () => {
  const r = judge.judgeWeather(inp({ kospi_ma20: null }));
  assert.equal(r.weather, 'defense');
  assert.ok(r.missing.includes('kospi_ma20'));
});

// ============================ 신호등 (REQ-021) ============================

function signalNo(r, no) {
  const list = Array.isArray(r) ? r : r.signals;
  return list.find((s) => s.no === no);
}

// 시나리오 6 + AC1: VIX 29.9 켜짐 / 30.0 꺼짐(경계)
test('시나리오6: VIX 29.9 → 2번 켜짐, 30.0 → 꺼짐', () => {
  const on = judge.judgeSignals(inp({ us_summary: { vix: 29.9, sox: 8800 } }));
  assert.equal(signalNo(on, 2).on, true);
  const off = judge.judgeSignals(inp({ us_summary: { vix: 30.0, sox: 8800 } }));
  assert.equal(signalNo(off, 2).on, false);
  // 근거 수치 기록(AC5)
  assert.match(signalNo(on, 2).basis, /29\.9/);
});

// 3번: SOX 기준 저점을 최근 3거래일 안 깨고 반등
test('3번: 최근 3일 최저 > 기준 저점 + 종가 반등 → 켜짐 / 저점 이탈 → 꺼짐', () => {
  const on = judge.judgeSignals(inp());
  assert.equal(signalNo(on, 3).on, true);
  const off = judge.judgeSignals(inp({ sox_recent3_low: 8300 })); // 기준 저점 아래로
  assert.equal(signalNo(off, 3).on, false);
});

// 경계: 외국인 2일 연속 — 1일째 꺼짐, 2일째 켜짐
test('경계: 외국인 순매수 1일째 4번 꺼짐·2일째 켜짐', () => {
  assert.equal(signalNo(judge.judgeSignals(inp({ foreign_net_days: 1 })), 4).on, false);
  assert.equal(signalNo(judge.judgeSignals(inp({ foreign_net_days: 2 })), 4).on, true);
});

// 경계: 2거래일 내 큰 이벤트 → 5번 강제 꺼짐
test('경계: 큰 이벤트 2거래일 내 → 5번 꺼짐, 통과 후 급락 없음 → 켜짐', () => {
  assert.equal(signalNo(judge.judgeSignals(inp({ event_within_2d: true })), 5).on, false);
  assert.equal(signalNo(judge.judgeSignals(inp({ event_within_2d: false, post_event_drop_pct: -0.3 })), 5).on, true);
  assert.equal(signalNo(judge.judgeSignals(inp({ event_within_2d: false, post_event_drop_pct: -1.5 })), 5).on, false, '-1.5% 하락은 꺼짐');
});

// 결측 보수: VIX 결측 → 2번 꺼짐 + 결측 표시
test('결측 보수: VIX 결측 → 2번 꺼짐·표시', () => {
  const r = judge.judgeSignals(inp({ us_summary: null }));
  assert.equal(signalNo(r, 2).on, false);
  assert.ok(signalNo(r, 2).missing, '결측 표시');
});

// ============================ 단계 (REQ-021) ============================

function mkSignals(onList, sig6) {
  const s = [1, 2, 3, 4, 5].map((no) => ({ no, on: onList.includes(no), basis: 'x' }));
  s.push({ no: 6, on: !!sig6, basis: 'x' });
  return s;
}

// 시나리오 7 + AC2 + 경계: 1개 대기 / 2개·3개 1차 / 4개 2차 / 6번 3차
test('시나리오7: 단계 산출 — 0~1 대기·2~3 1차·4+ 2차·6번 3차(경계 포함)', () => {
  assert.equal(judge.judgeStage(mkSignals([2], false), {}).stage, 'wait', '1개 대기');
  assert.equal(judge.judgeStage(mkSignals([2, 3], false), {}).stage, 's1', '2개 1차');
  assert.equal(judge.judgeStage(mkSignals([1, 2, 3], false), {}).stage, 's1', '3개 1차(상한)');
  assert.equal(judge.judgeStage(mkSignals([1, 2, 3, 4], false), {}).stage, 's2', '4개 2차(하한)');
  assert.equal(judge.judgeStage(mkSignals([2, 3], true), {}).stage, 's3', '6번 켜짐 3차');
});

// 시나리오 8 + AC3: 1차 상태 + 기준 저점 재이탈 → 중단
test('시나리오8: 1차 후 기준 저점 재이탈 → 중단(회복 전 유지)', () => {
  const r = judge.judgeStage(mkSignals([2, 3], false), { prevStage: 's1', reentryBreak: true });
  assert.equal(r.stage, 'halt');
  // 중단 상태 유지(회복 판정 전)
  const r2 = judge.judgeStage(mkSignals([1, 2, 3, 4], false), { prevStage: 'halt', reentryBreak: false, recovered: false });
  assert.equal(r2.stage, 'halt', '회복 전 유지');
  const r3 = judge.judgeStage(mkSignals([1, 2, 3, 4], false), { prevStage: 'halt', recovered: true });
  assert.equal(r3.stage, 's2', '회복 후 재산출');
});

// 시나리오 9 + AC4: 촉군 출병 조건 — 1차 미만 불충족
test('시나리오9: 촉군 출병 — 대기 불충족·1차부터 충족(방어면 불가)', () => {
  assert.equal(judge.canSortieChok({ stage: 'wait', weather: 'neutral' }), false, '대기 불충족');
  assert.equal(judge.canSortieChok({ stage: 's1', weather: 'neutral' }), true, '1차 충족');
  assert.equal(judge.canSortieChok({ stage: 's2', weather: 'attack' }), true);
  assert.equal(judge.canSortieChok({ stage: 's1', weather: 'defense' }), false, '방어 날씨면 불가');
  assert.equal(judge.canSortieChok({ stage: 'halt', weather: 'neutral' }), false, '중단 불충족');
});

// 시나리오 10 + AC3(TSK-016): 순수 함수 — 같은 입력 같은 출력
test('시나리오10: 동일 입력 2회 → 동일 출력(순수 함수)', () => {
  const a = judge.judgeAll(inp(), {});
  const b = judge.judgeAll(inp(), {});
  assert.deepEqual(a, b);
});

// 기준 저점 갱신: 새 저점이 낮으면 재진입 기록 수정
test('기준 저점 갱신: 더 낮은 저점이 오면 reentry_record 수정', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst015-'));
  try {
    state.write('reentry_record', { sox_base_low: 8408.59, sox_base_low_date: '2026-11-10' }, { dataDir: dir });
    const r1 = judge.updateBaseLow(8300.5, '2026-11-25', { dataDir: dir });
    assert.equal(r1.updated, true);
    assert.equal(state.read('reentry_record', { dataDir: dir }).sox_base_low, 8300.5);
    // 높은 값은 갱신 안 함
    const r2 = judge.updateBaseLow(8500, '2026-11-26', { dataDir: dir });
    assert.equal(r2.updated, false);
    assert.equal(state.read('reentry_record', { dataDir: dir }).sox_base_low, 8300.5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================ 회귀: 오늘 아침 군의 실제 값 ============================
test('회귀(2026-11-25 군의): 방어·신호 2/6(2·3번)·1차·촉군 출병 불가', () => {
  const today = inp({
    night_future_pct: -4.56,
    us_summary: { sp500: -0.8, nasdaq: -1.4, sox: 8832.50, vix: 26.36 },
    sox_base_low: 8408.59,
    sox_recent3_low: 8657.78,
    kospi_close: 5006.03, kospi_ma20: 5322,
    foreign_net_days: 1,            // 11/23 매도 → 11/24 매수 = 연속 1일
    event_within_2d: true,          // PCE·금통위 2거래일 내
    bad_news_resilient: false,      // 야간선물 -4.56% — 악재 둔화 아님
  });
  const r = judge.judgeAll(today, {});

  assert.equal(r.weather, 'defense', '날씨 방어(야간선물 -4.56%)');
  const onNos = r.signals.filter((s) => s.on).map((s) => s.no);
  assert.deepEqual(onNos.sort(), [2, 3], '신호등 2/6 — 2번(VIX 26.36<30)·3번(SOX 저점 사수 반등)');
  assert.equal(r.signals.filter((s) => s.on).length, 2);
  assert.equal(r.stage, 's1', '단계 1차(1~5 중 2개)');
  assert.equal(judge.canSortieChok(r), false, '방어라 촉군 출병 불가');
  // 근거 수치 기록 확인
  assert.match(signalNo(r, 2).basis, /26\.36/);
  assert.match(signalNo(r, 3).basis, /8,?657\.78|8657\.78/);
  assert.match(signalNo(r, 6).basis, /5,?006|5006/);
});

// ============================ 스냅샷 통합(AC4): 판정+근거 기록·재현 ============================
test('AC4: 판정 결과·근거가 스냅샷에 기록돼 재현 가능', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst015s-'));
  try {
    const collected = {
      date: '2026-11-25',
      judgeInputs: inp({ night_future_pct: -4.56, kospi_close: 5006.03, kospi_ma20: 5322 }),
      intraday: null,
      sources: { kospi_close: 'kis_j', kospi_ma20: 'kis_j', us_summary: 'websearch' },
      missing: ['foreign_net_days'],
    };
    const j = judge.judgeAll(collected.judgeInputs, {});
    const file = market.saveSnapshot(collected, j, { dataDir: dir });
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(row.weather, 'defense');
    assert.equal(row.signals.length, 6, '신호 6개 전부');
    assert.ok(row.signals.every((s) => typeof s.basis === 'string' && s.basis.length > 0), '근거 수치 기록');
    assert.ok(row.missing.includes('foreign_net_days'), '결측 함께 기록');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// TSK-016 보완 (군주 확정 2026-11-25): 중단 회복은 수동만 + 외국인 미검증 태그
// =====================================================================

test('보완: 중단 자동 해제 금지 — manualRecoverHalt로만 해제·기록', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst015h-'));
  try {
    // 1차 → 재이탈 → halt 기록
    judge.recordStage('s1', { dataDir: dir });
    let h = judge.getStageHistory({ dataDir: dir });
    const r1 = judge.judgeStage([{ no: 2, on: true }, { no: 3, on: true }], Object.assign({}, h, { reentryBreak: true }));
    assert.equal(r1.stage, 'halt');
    judge.recordStage('halt', { dataDir: dir });

    // 신호가 아무리 좋아도(4개·6번) 자동 해제 없음
    h = judge.getStageHistory({ dataDir: dir });
    assert.equal(h.prevStage, 'halt');
    assert.notEqual(h.recovered, true, '자동 recovered 없음');
    const good = [1, 2, 3, 4].map((no) => ({ no, on: true })).concat([{ no: 5, on: false }, { no: 6, on: true }]);
    assert.equal(judge.judgeStage(good, h).stage, 'halt', '자동 해제 금지');

    // 군주 수동 해제 → 기록 + 다음 판정부터 재산출
    const rec = judge.manualRecoverHalt({ dataDir: dir }, '기준 저점 회복 확인 — 군주');
    assert.equal(rec.ok, true);
    h = judge.getStageHistory({ dataDir: dir });
    assert.equal(h.recovered, true, '수동 해제 반영');
    assert.equal(judge.judgeStage(good, h).stage, 's3', '해제 후 재산출');

    // 해제 기록(장부) 확인
    const paths2 = require('../src/paths');
    const d = paths2.ledgerDir(dir, 'stage_log');
    const rows = fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
    assert.ok(rows.some((r) => r.action === 'manual_recover' && /군주/.test(r.note)), '수동 해제 기록');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('보완: 외국인 미검증 태그 — 신호 4번 근거에 (미검증) 표기', () => {
  const r = judge.judgeSignals(inp({ foreign_net_days: 2, foreign_unverified: true }));
  const s4 = signalNo(r, 4);
  assert.equal(s4.on, true, '판정은 수행');
  assert.match(s4.basis, /미검증/, '미검증 태그');
});
