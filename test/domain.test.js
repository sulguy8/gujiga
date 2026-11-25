'use strict';

// TST-004 — 도메인 상태 모듈(군율·관직·위반·포로) 자동 테스트
// 상위: TSK-004 / REQ-013·REQ-014 / DAT-003·DAT-011·DAT-012
// 실행: node --test  (Node 내장, 외부 패키지 0). 원장 기록은 ledger.append만 사용.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const captives = require('../src/captives');
const generalRank = require('../src/general_rank');
const guard = require('../src/guard');
const ranks = require('../src/ranks');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst004-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
// captive_ledger 파일의 모든 행 수(월별 분할 합산)
function captiveRows(dir) {
  const d = paths.ledgerDir(dir, 'captive_ledger');
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

// =========================================================================
// 포로·구출·전공 (REQ-014) — 순수 계산
// =========================================================================

// 시나리오 1~3: -3만 → 포로3 / +2만 → 포로1·전공0 / +2만 → 포로0·전공1만
test('시나리오1~3: 포로 적립→구출→전공 순수 계산', () => {
  let s = { lossOutstanding: 0, meritTotal: 0 };

  s = captives.captiveStep(s, -30000);
  assert.equal(s.lossOutstanding, 30000);
  assert.equal(s.captives, 3, '-3만원 → 포로 3명');
  assert.equal(s.meritDelta, 0);
  assert.equal(s.meritTotal, 0);

  s = captives.captiveStep(s, 20000);
  assert.equal(s.lossOutstanding, 10000, '잔여 손실 10,000');
  assert.equal(s.captives, 1, '+2만원 → 포로 1명');
  assert.equal(s.meritDelta, 0, '아직 전공 없음');
  assert.equal(s.meritTotal, 0);

  s = captives.captiveStep(s, 20000);
  assert.equal(s.lossOutstanding, 0);
  assert.equal(s.captives, 0, '포로 0');
  assert.equal(s.meritDelta, 10000, '포로 0 이후 잔여 수익만 전공');
  assert.equal(s.meritTotal, 10000, '전공 10,000원');
});

// 시나리오 4: 반올림 표시 (내부 금액은 원 단위 정확)
test('시나리오4: 포로 명수 반올림(14,000→1 / 16,000→2)', () => {
  assert.equal(captives.captivesOf(14000), 1, '14,000원 → 1명');
  assert.equal(captives.captivesOf(16000), 2, '16,000원 → 2명');
  // 내부 손실 금액은 원 단위 정확
  const s = captives.captiveStep({ lossOutstanding: 0, meritTotal: 0 }, -14000);
  assert.equal(s.lossOutstanding, 14000, '내부 금액은 원 단위 정확');
  assert.equal(s.captives, 1);
});

// 에지: 5,000원(0.5명) — 끝수 규칙(round) 증빙
test('에지: 5,000원(0.5명) 반올림 규칙 = 1명(round half up)', () => {
  assert.equal(captives.captivesOf(5000), 1, 'round(0.5)=1 — 군주 확인용 증빙');
  assert.equal(captives.captivesOf(4999), 0);
  assert.equal(captives.captivesOf(0), 0);
});

// 원장 연동: recordPnl이 ledger.append로 captive_ledger에 쌓이고 수치 재현 ---
test('포로 원장: recordPnl 3연속이 시나리오1~3을 재현(계좌별 분리)', () => {
  const dir = makeTmpDir();
  try {
    const base = { account_type: 'paper', trade_date: '2026-11-24', order_log_id: 'o1', created_at: '2026-11-24T15:32:00+09:00' };
    const r1 = captives.recordPnl({ ...base, realized_pnl: -30000 }, { dataDir: dir });
    assert.equal(r1.loss_outstanding_after, 30000);
    assert.equal(r1.captives_after, 3);
    assert.equal(r1.merit_delta, 0);

    const r2 = captives.recordPnl({ ...base, realized_pnl: 20000, created_at: '2026-11-24T15:33:00+09:00' }, { dataDir: dir });
    assert.equal(r2.loss_outstanding_after, 10000);
    assert.equal(r2.captives_after, 1);
    assert.equal(r2.merit_delta, 0);

    const r3 = captives.recordPnl({ ...base, realized_pnl: 20000, created_at: '2026-11-24T15:34:00+09:00' }, { dataDir: dir });
    assert.equal(r3.loss_outstanding_after, 0);
    assert.equal(r3.captives_after, 0);
    assert.equal(r3.merit_delta, 10000);
    assert.equal(r3.merit_total_after, 10000);

    // 원장에 3행 쌓였고 직접 파일쓰기가 아닌 ledger.append 경로를 통함(파일 존재로 간접 확인)
    assert.equal(captiveRows(dir).length, 3, 'captive_ledger에 3행');

    // 계좌 분리: real 계좌는 독립(포로 0에서 시작)
    const real1 = captives.recordPnl({ account_type: 'real', trade_date: '2026-11-24', order_log_id: 'r1', created_at: '2026-11-24T15:35:00+09:00', realized_pnl: -50000 }, { dataDir: dir });
    assert.equal(real1.loss_outstanding_after, 50000, 'real 계좌는 paper와 분리 집계');
    assert.equal(real1.captives_after, 5);
    // paper 상태는 영향 없음
    assert.equal(captives.computeState('paper', { dataDir: dir }).meritTotal, 10000);
  } finally {
    rm(dir);
  }
});

// 에지: 같은 날 손실→수익 섞일 때 시간순 처리 보장 ---
test('에지: 같은 날 손실·수익 혼재 시 시간순 처리', () => {
  const dir = makeTmpDir();
  try {
    const base = { account_type: 'paper', trade_date: '2026-11-25', order_log_id: 'x' };
    captives.recordPnl({ ...base, realized_pnl: -10000, created_at: '2026-11-25T10:00:00+09:00' }, { dataDir: dir });
    captives.recordPnl({ ...base, realized_pnl: 30000, created_at: '2026-11-25T11:00:00+09:00' }, { dataDir: dir });
    const st = captives.computeState('paper', { dataDir: dir });
    assert.equal(st.lossOutstanding, 0, '손실 1만 구출 후');
    assert.equal(st.meritTotal, 20000, '잔여 2만이 전공');
  } finally {
    rm(dir);
  }
});

// =========================================================================
// 관직·위반 (REQ-013)
// =========================================================================

// 시나리오 6: 현령 한도 조회 (상태 없어도 안전 기본=현령) ---
test('시나리오6: 현령 한도 = 종목당 20만원·동시 2성', () => {
  const dir = makeTmpDir();
  try {
    const lim = generalRank.getLimits({ dataDir: dir });
    assert.equal(lim.rank, 'hyeonryeong');
    assert.equal(lim.perStockLimitWon, 200000, '종목당 20만원');
    assert.equal(lim.concurrentMax, 2, '동시 2성');
    assert.equal(generalRank.getRealOrderLimit({ dataDir: dir }), 200000, '실전 1회 한도 20만원');
  } finally {
    rm(dir);
  }
});

// 시나리오 7: 태수 승진 반영 후 한도 ---
test('시나리오7: 태수 승진 → 30만원·3성, 실전 1회 한도 300,000원', () => {
  const dir = makeTmpDir();
  try {
    generalRank.promote('taesu', { dataDir: dir });
    const lim = generalRank.getLimits({ dataDir: dir });
    assert.equal(lim.rank, 'taesu');
    assert.equal(lim.perStockLimitWon, 300000, '종목당 30만원');
    assert.equal(lim.concurrentMax, 3, '동시 3성');
    assert.equal(generalRank.getRealOrderLimit({ dataDir: dir }), 300000, '실전 1회 한도 300,000원');
  } finally {
    rm(dir);
  }
});

// 시나리오 5: 위반 1건 기록 시 승진 카운트 3종 0 초기화 ---
test('시나리오5: violation 1건 → sortie/clean/review 카운트 모두 0', () => {
  const dir = makeTmpDir();
  try {
    // 승진 카운트 진행 중 상태를 세팅
    generalRank.setProgress({ sortie_count: 3, clean_weeks: 2, review_weeks: 2 }, { dataDir: dir });
    let r = generalRank.getRank({ dataDir: dir });
    assert.equal(r.sortie_count, 3);

    const res = generalRank.recordViolation(
      { code: 'V2_stop_exit_missed', violation_date: '2026-11-18', context: '손절 판정 후 익일 매도 미이행' },
      { dataDir: dir }
    );
    assert.ok(res.violation.id, '위반 레코드 id가 생성된다');

    r = generalRank.getRank({ dataDir: dir });
    assert.equal(r.sortie_count, 0, 'sortie_count 0');
    assert.equal(r.clean_weeks, 0, 'clean_weeks 0');
    assert.equal(r.review_weeks, 0, 'review_weeks 0');

    // 위반 원장에 1행 기록(ledger.append 경로)
    const vdir = paths.ledgerDir(dir, 'violation');
    const files = fs.readdirSync(vdir).filter((f) => f.endsWith('.jsonl'));
    const lines = files.flatMap((f) => fs.readFileSync(path.join(vdir, f), 'utf8').split('\n').filter(Boolean));
    assert.equal(lines.length, 1, 'violation 1행');
    assert.equal(JSON.parse(lines[0]).code, 'V2_stop_exit_missed');
  } finally {
    rm(dir);
  }
});

// 위반 코드 검증: 5종(V1~V5)만 허용 ---
test('위반 코드: 미정의 코드는 거부', () => {
  const dir = makeTmpDir();
  try {
    assert.throws(
      () => generalRank.recordViolation({ code: 'V9_unknown', violation_date: '2026-11-18', context: 'x' }, { dataDir: dir }),
      /위반 코드/
    );
  } finally {
    rm(dir);
  }
});

// =========================================================================
// 군율 guard_config (DAT-003) — 없으면 전면 차단(안전 동작)
// =========================================================================

// 시나리오 8: guard_config 없으면 모든 검사 함수가 차단 ---
test('시나리오8: guard_config 파일이 없으면 모든 검사 함수가 차단', () => {
  const dir = makeTmpDir(); // guard_config 미존재
  try {
    assert.ok(Array.isArray(guard.CHECKS) && guard.CHECKS.length >= 3, '검사 함수 목록이 있어야 한다');
    for (const c of guard.CHECKS) {
      const res = c.fn(c.sample, { dataDir: dir });
      assert.equal(res.allowed, false, `${c.name}: guard 없으면 차단`);
      assert.equal(res.reason, 'guard_missing', `${c.name}: 차단 사유=guard_missing`);
    }
    assert.equal(guard.loadGuard({ dataDir: dir }), null, 'guard 로드는 null');
  } finally {
    rm(dir);
  }
});

// 대조군: 유효한 guard_config면 한도 내 주문은 허용(항상차단이 아님) ---
test('guard: 유효 설정이면 한도 내 주문은 허용, 초과는 차단', () => {
  const dir = makeTmpDir();
  try {
    const cfg = {
      id: 'default',
      per_order_limit_real: 200000, per_order_limit_paper: 500000,
      daily_loss_limit: -50000,
      stop_file_path: path.join(dir, 'STOP'), // 존재하지 않음
      cash_ratio_min: 0.30, correlation_max: 0.70, sample_min: 10,
      updated_at: '2026-11-24T00:00:00+09:00',
    };
    require('../src/state').write('guard_config', cfg, { dataDir: dir });

    assert.deepEqual(guard.loadGuard({ dataDir: dir }).id, 'default');
    assert.equal(guard.checkPerOrderLimit({ amount: 150000, accountType: 'real' }, { dataDir: dir }).allowed, true);
    assert.equal(guard.checkPerOrderLimit({ amount: 250000, accountType: 'real' }, { dataDir: dir }).allowed, false);
    assert.equal(guard.checkStopFile({}, { dataDir: dir }).allowed, true, 'STOP 없으면 통과');
    assert.equal(guard.checkDailyLoss({ currentEval: 100000, dayStartEval: 160000 }, { dataDir: dir }).allowed, false, '-6만 손실이면 차단');

    // STOP 파일 생성 시 차단
    fs.writeFileSync(cfg.stop_file_path, '');
    assert.equal(guard.checkStopFile({}, { dataDir: dir }).allowed, false, 'STOP 있으면 차단');
  } finally {
    rm(dir);
  }
});

// 손상된 guard_config(제약 위반)도 안전 쪽으로 차단 ---
test('guard: 제약 위반 설정은 null(차단)으로 처리', () => {
  const dir = makeTmpDir();
  try {
    require('../src/state').write('guard_config', { id: 'default', per_order_limit_real: -1 }, { dataDir: dir });
    assert.equal(guard.loadGuard({ dataDir: dir }), null, '제약 위반이면 안전하게 null');
    assert.equal(guard.checkStopFile({}, { dataDir: dir }).allowed, false);
  } finally {
    rm(dir);
  }
});

// rank table은 설정(JSON)으로 관리 ---
test('ranks: 관직 표가 설정에서 로드되고 5관직을 포함', () => {
  const t = ranks.loadRankTable();
  for (const k of ['hyeonryeong', 'taesu', 'jasa', 'daejanggun', 'seungsang']) {
    assert.ok(t[k], `관직 ${k} 존재`);
  }
  assert.equal(ranks.rankLimits('hyeonryeong').perOrderLimitReal, 200000);
  assert.equal(ranks.rankLimits('taesu').perOrderLimitReal, 300000);
});
