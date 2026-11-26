'use strict';

// 매수 체결 자동 반영(watchSorties) — 모의·실전, 멱등 키 = 주문번호
// 실행: node --test — 실서버·실키 0(가짜 체결 공급자, 어댑터 미사용).
// 배경(군사 지적 2026-11-26): 예약(매복) 매수가 나중에 체결되면 order_log·positions
// 어디에도 기록되지 않아 성벽 감시·세력전 한도·상관 검사가 전부 못 보는 사각.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const shadow = require('../src/shadow');
const state = require('../src/state');
const ledger = require('../src/ledger');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-sortie-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function rows(dir, name) {
  const d = paths.ledgerDir(dir, name);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}

// 출사표 필드를 포함한 submitted 행(gate.submit 기록 확장과 같은 모양)
function seedSubmitted(dir, over) {
  ledger.append('order_log', Object.assign({
    id: crypto.randomUUID(), account_type: 'paper', nation: 'wi',
    symbol: '458870', side: 'buy', order_type: 'limit', price: 13250, qty: 18, amount: 238500,
    stop_price: 12500, target_price: 14570, deadline: '2026-12-10', hypothesis_ids: ['HYP-B2'],
    status: 'submitted', block_reason: null, broker_order_no: '0000000367', filled_at: null,
    created_at: '2026-11-26T08:33:00+09:00',
  }, over || {}), { dataDir: dir });
}

function fill(over) {
  return Object.assign({ odno: '0000000367', symbol: '458870', side: 'buy', filled: 18, avgFill: 13250, remain: 0 }, over || {});
}

function opts(dir, fills, fillsReal) {
  return {
    dataDir: dir,
    providers: {
      fills: fills ? () => fills : undefined,
      fillsReal: fillsReal ? () => fillsReal : undefined,
    },
  };
}

// ===== ① 모의 매수 전량 체결 → order_log filled + positions open(출사표 복원) =====
test('시나리오1: 모의 매수 체결 — filled 행·positions open·세력 장부 갱신', async () => {
  const dir = makeTmpDir();
  try {
    seedSubmitted(dir);
    await shadow.watchSorties('2026-11-26', opts(dir, [fill()]));

    const filled = rows(dir, 'order_log').filter((r) => r.status === 'filled');
    assert.equal(filled.length, 1, 'filled 행 1');
    assert.equal(filled[0].broker_order_no, '0000000367');
    assert.equal(filled[0].stop_price, 12500, '출사표 필드 복원(성벽)');
    assert.deepEqual(filled[0].hypothesis_ids, ['HYP-B2'], '근거 복원');

    const pos = (state.read('positions', { dataDir: dir }) || []).filter((p) => p.status === 'open');
    assert.equal(pos.length, 1, 'positions open 1');
    assert.equal(pos[0].qty, 18);
    assert.equal(pos[0].avg_price, 13250);
    assert.equal(pos[0].nation, 'wi');
    assert.equal(pos[0].deadline, '2026-12-10');
    assert.equal(pos[0].broker_order_no, '0000000367', '멱등 키 저장');

    const nl = state.read('nation_ledger', { dataDir: dir });
    assert.equal(nl.wi.cash, 500000 - 238500, '세력 장부 스냅샷 갱신');
  } finally { rm(dir); }
});

// ===== ② 멱등 — 재실행 쓰기 0 =====
test('시나리오2: 재실행 — filled·positions 중복 0', async () => {
  const dir = makeTmpDir();
  try {
    seedSubmitted(dir);
    const o = opts(dir, [fill()]);
    await shadow.watchSorties('2026-11-26', o);
    await shadow.watchSorties('2026-11-26', o);
    assert.equal(rows(dir, 'order_log').filter((r) => r.status === 'filled').length, 1, 'filled 1 유지');
    assert.equal((state.read('positions', { dataDir: dir }) || []).length, 1, 'positions 1 유지');
  } finally { rm(dir); }
});

// ===== ③ pollFill 선기록 — 원장 추가 없이 positions만 =====
test('시나리오3: 제출 직후 체결로 filled가 이미 있으면 positions만 보충', async () => {
  const dir = makeTmpDir();
  try {
    seedSubmitted(dir);
    seedSubmitted(dir, { status: 'filled', filled_at: '2026-11-26T09:06:00+09:00' });
    await shadow.watchSorties('2026-11-26', opts(dir, [fill()]));
    assert.equal(rows(dir, 'order_log').filter((r) => r.status === 'filled').length, 1, 'filled 추가 0');
    assert.equal((state.read('positions', { dataDir: dir }) || []).length, 1, 'positions 보충 1');
  } finally { rm(dir); }
});

// ===== ④ 부분 체결 — 반영 보류·note(멱등) =====
test('시나리오4: 부분 체결(remain>0) — 반영 0·note 1회', async () => {
  const dir = makeTmpDir();
  try {
    seedSubmitted(dir);
    const o = opts(dir, [fill({ filled: 10, remain: 8 })]);
    await shadow.watchSorties('2026-11-26', o);
    await shadow.watchSorties('2026-11-26', o);
    assert.equal(rows(dir, 'order_log').filter((r) => r.status === 'filled').length, 0, '원장 반영 0');
    assert.equal(state.read('positions', { dataDir: dir }), null, 'positions 반영 0');
    const notes = rows(dir, 'shadow_job_log').filter((r) => r.job === 'sortie_watch' && r.status === 'note');
    assert.equal(notes.length, 1, 'note 멱등 1회');
  } finally { rm(dir); }
});

// ===== ⑤ submitted 없는 체결(관문 밖) — 반영 생략·note =====
test('시나리오5: submitted 없는 매수 체결 — 반영 0·note', async () => {
  const dir = makeTmpDir();
  try {
    await shadow.watchSorties('2026-11-26', opts(dir, [fill({ odno: '9999999999' })]));
    assert.equal(rows(dir, 'order_log').length, 0, '원장 반영 0');
    const notes = rows(dir, 'shadow_job_log').filter((r) => r.job === 'sortie_watch');
    assert.equal(notes.length, 1, 'note 기록');
    assert.match(notes[0].reason || '', /submitted/, '원인 명시');
  } finally { rm(dir); }
});

// ===== ⑥ 실전 체결(fillsReal) — account_type real =====
test('시나리오6: 실전 매수 체결 — positions real·세력 장부 무관', async () => {
  const dir = makeTmpDir();
  try {
    seedSubmitted(dir, { account_type: 'real', nation: null, broker_order_no: '0000000777' });
    await shadow.watchSorties('2026-11-26', opts(dir, null, [fill({ odno: '0000000777' })]));
    const pos = state.read('positions', { dataDir: dir }) || [];
    assert.equal(pos.length, 1);
    assert.equal(pos[0].account_type, 'real');
    assert.equal(state.read('nation_ledger', { dataDir: dir }), null, '실전은 세력 장부 미갱신');
  } finally { rm(dir); }
});

// ===== ⑦ 매도 체결 무시(회군은 watchRetreats 소관) =====
test('시나리오7: 매도 체결 행은 무시', async () => {
  const dir = makeTmpDir();
  try {
    seedSubmitted(dir);
    await shadow.watchSorties('2026-11-26', opts(dir, [fill({ side: 'sell' })]));
    assert.equal(rows(dir, 'order_log').filter((r) => r.status === 'filled').length, 0);
    assert.equal(state.read('positions', { dataDir: dir }), null);
  } finally { rm(dir); }
});
