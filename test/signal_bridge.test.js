'use strict';

// 그림자 신호 입력 보강(군주 상책 2026-11-27) — 실서버·실키 0.
// ② 신호1(악재 둔화): Aside reports/날짜.json 군의 판정에서 읽기 전용으로 가져옴(그림자 기간).
// ③ VIX 휴장 null → 직전 거래일 값 유지(최대 3거래일, 초과 시 꺼짐 유지).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const market = require('../src/market');
const judge = require('../src/judge');
const shadow = require('../src/shadow');
const state = require('../src/state');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-sigbr-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function calPath(dir, holidays) {
  const p = path.join(dir, 'cal.json');
  fs.writeFileSync(p, JSON.stringify({ holidays: holidays || {}, special_open: {} }), 'utf8');
  return p;
}
function writeOvernight(dir, date, vix) {
  fs.mkdirSync(path.join(dir, 'market_cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'market_cache', `overnight_${date}.json`),
    JSON.stringify({ us_summary: { sp500: 1, nasdaq: 1, sox: 8800, vix }, night_future_pct: 0.1, source: 'websearch' }), 'utf8');
}

// ===== ③ VIX 직전 거래일 유지 =====
test('VIX 유지: 당일 null → 직전 거래일 값, 출처 표기·신호2 켜짐(basis에 유지 명시)', () => {
  const dir = makeTmpDir();
  try {
    writeOvernight(dir, '2026-11-26', 28.29); // 직전 거래일(수집 성공)
    const r = market.carryVix({ us_summary: { sp500: null, nasdaq: null, sox: null, vix: null } }, '2026-11-27', { dataDir: dir, calendarPath: calPath(dir) });
    assert.equal(r.vix, 28.29, '직전 값 유지');
    assert.equal(r.from, '2026-11-26', '유지 출처 날짜');
    // judge 신호 2: carried 플래그로 basis에 유지 명시
    const j = judge.judgeAll({ us_summary: { vix: 28.29 }, vix_carried_from: '2026-11-26' }, []);
    const s2 = j.signals.find((s) => s.no === 2);
    assert.equal(s2.on, true, 'VIX 28.29 < 30 켜짐');
    assert.match(s2.basis, /유지|2026-11-26/, '유지 사실 표기');
  } finally { rm(dir); }
});

test('VIX 유지: 3거래일 초과 결측 → 유지 안 함(보수 꺼짐 유지)', () => {
  const dir = makeTmpDir();
  try {
    writeOvernight(dir, '2026-11-20', 27.0); // 4거래일 전(11-23~26 거래일 4일 경과)
    const r = market.carryVix({ us_summary: { vix: null } }, '2026-11-27', { dataDir: dir, calendarPath: calPath(dir) });
    assert.equal(r, null, '3거래일 밖 — 유지 금지');
  } finally { rm(dir); }
});

test('VIX 유지: 당일 값이 있으면 건드리지 않음', () => {
  const dir = makeTmpDir();
  try {
    writeOvernight(dir, '2026-11-26', 99);
    const r = market.carryVix({ us_summary: { vix: 28.0 } }, '2026-11-27', { dataDir: dir, calendarPath: calPath(dir) });
    assert.equal(r, null, '당일 값 존재 — carry 불필요');
  } finally { rm(dir); }
});

// ===== ② 신호1 — Aside report에서 읽기 전용 가져오기 =====
function makeAside(dir, date, signalsOn) {
  const rp = path.join(dir, 'aside-root', 'trading', 'reports');
  fs.mkdirSync(rp, { recursive: true });
  if (signalsOn !== null) {
    fs.writeFileSync(path.join(rp, `${date}.json`), JSON.stringify({ date, signals_on: signalsOn, weather: '방어' }), 'utf8');
  }
  return path.join(dir, 'aside-root');
}

test('신호1 연동: Aside signals_on에 1 있으면 bad_news_resilient=true 기록(출처 표기)', () => {
  const dir = makeTmpDir();
  try {
    const asideRoot = makeAside(dir, '2026-11-27', [1, 2]);
    const r = shadow.syncSignal1FromAside('2026-11-27', { dataDir: dir, asideRoot });
    assert.equal(r.applied, true);
    const si = state.read('signal_inputs', { dataDir: dir });
    assert.equal(si.bad_news_resilient, true);
    assert.equal(si.signal1_source, 'aside_report');
    assert.equal(si.signal1_date, '2026-11-27');
  } finally { rm(dir); }
});

test('신호1 연동: 1 없으면 false 기록·다른 수동 필드 보존, 파일 없으면 변경 0·원본 쓰기 0', () => {
  const dir = makeTmpDir();
  try {
    state.write('signal_inputs', { event_within_2d: true }, { dataDir: dir });
    const asideRoot = makeAside(dir, '2026-11-27', [2]);
    shadow.syncSignal1FromAside('2026-11-27', { dataDir: dir, asideRoot });
    const si = state.read('signal_inputs', { dataDir: dir });
    assert.equal(si.bad_news_resilient, false, '1 없음 → false');
    assert.equal(si.event_within_2d, true, '다른 수동 필드 보존');
    // 당일 파일 없음 — 변경 없음
    const before = JSON.stringify(si);
    const r2 = shadow.syncSignal1FromAside('2026-11-28', { dataDir: dir, asideRoot });
    assert.equal(r2.applied, false, '파일 없음 — 미적용(기존 유지)');
    assert.equal(JSON.stringify(state.read('signal_inputs', { dataDir: dir })), before);
    // 원본 Aside 파일 불변(읽기 전용) — 전문 비교(군사 지적: 필드 부재 검사는 약함)
    const f = path.join(asideRoot, 'trading', 'reports', '2026-11-27.json');
    const snapBefore = fs.readFileSync(f, 'utf8');
    shadow.syncSignal1FromAside('2026-11-27', { dataDir: dir, asideRoot });
    assert.equal(fs.readFileSync(f, 'utf8'), snapBefore, '원본 전문 불변');
  } finally { rm(dir); }
});
