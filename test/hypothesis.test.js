'use strict';

// TST-018 — 가설 장부·증거 엔진·patterns.md 이관(TSK-019)
// 상위: DAT-008·DAT-009 / REQ-011·012·024·025
// 실행: node --test — 실서버·실키·실claude 0. 원본 patterns.md 수정 금지(해시 대조).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const hyp = require('../src/hypothesis');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst018-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function ledgerRows(dir, name) {
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

const PATTERNS = path.join(__dirname, '..', 'refs', 'research', 'patterns.md');

// A1 적중 시세: 고가 시각 09:10, 종가 < 시가
const A1_HIT = { high_time: '09:10', open: 10000, close: 9800, low: 9700, high: 10100 };
const A1_EXPR = 'high_time >= 09:00 && high_time <= 09:30 && close < open';

function regA1(dir) {
  return hyp.register({ code: 'T-A1', category: 'A', statement: '09:00~09:30 고점 → 오후 약세', judge_expr: A1_EXPR }, { dataDir: dir });
}

// ===== REQ-011 AC: 등록·전이·증거 기본 규칙 =====
test('REQ-011: 분류 필수·직행 전이 거부·날짜 없는 증거 거부·폐기 조회·승격 이력', () => {
  const dir = makeTmpDir();
  try {
    // AC1: 분류 없는 등록 거부
    assert.throws(() => hyp.register({ statement: 'x → y' }, { dataDir: dir }), /분류|category/);
    assert.throws(() => hyp.register({ category: 'A' }, { dataDir: dir }), /진술|statement/);

    const h = regA1(dir);
    assert.match(h.id, /^HYP-/);
    assert.equal(h.status, 'hypothesis');

    // AC2: 직행(hypothesis→verified) 거부, 순차는 허용
    assert.throws(() => hyp.transition(h.id, 'verified', { dataDir: dir }), /직행|순서|전이/);
    hyp.transition(h.id, 'testing', { dataDir: dir });
    assert.equal(hyp.get(h.id, { dataDir: dir }).status, 'testing');

    // AC3: 날짜 없는 증거 거부
    assert.throws(() => hyp.addEvidence({ hypothesis_id: h.id, note: 'x', outcome: 'success', kind: 'observation', judged_by: '군주' }, { dataDir: dir }), /날짜|date/);

    // AC4: 폐기해도 조회 가능
    const h2 = hyp.register({ code: 'T-D', category: 'D', statement: '조건 → 제외' }, { dataDir: dir });
    hyp.transition(h2.id, 'testing', { dataDir: dir });
    hyp.transition(h2.id, 'discarded', { dataDir: dir });
    const all = hyp.list({ dataDir: dir });
    assert.ok(all.some((x) => x.id === h2.id && x.status === 'discarded'), '폐기 조회');

    // AC5: 숫자 규칙 승격 시 rule_change에 가설 ID
    hyp.promoteToRule(h.id, '급락일 매도 기준을 10:30 반등으로', { dataDir: dir });
    const rc = ledgerRows(dir, 'rule_change');
    assert.equal(rc.length, 1);
    assert.equal(rc[0].hypothesis_id, h.id);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 1 + REQ-024 AC1: A1 판정식 적중 → success·app·trade =====
test('시나리오1: A1 판정식 적중 시세 → success·judged_by=app·kind=trade·근거 수치', () => {
  const dir = makeTmpDir();
  try {
    const h = regA1(dir);
    const r = hyp.recordTradeEvidence(h.id, A1_HIT, { evidence_date: '2026-11-25', note: '멜콘 회군', symbol: '123456' }, { dataDir: dir });
    assert.equal(r.recorded, true);
    const ev = hyp.evidences(h.id, { dataDir: dir });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].outcome, 'success');
    assert.equal(ev[0].judged_by, 'app');
    assert.equal(ev[0].kind, 'trade');
    assert.match(ev[0].basis, /09:10|550/, '판정 근거 수치 기록');
    assert.equal(hyp.get(h.id, { dataDir: dir }).trade_count, 1);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 2 + REQ-024 AC2: 손실 거래여도 가설 적중이면 success(손익 무관) =====
test('시나리오2: 손실 거래(-5만원)도 가설 적중이면 success', () => {
  const dir = makeTmpDir();
  try {
    const h = regA1(dir);
    const r = hyp.recordTradeEvidence(h.id, A1_HIT, { evidence_date: '2026-11-25', note: '손절 회군', pnl: -50000 }, { dataDir: dir });
    assert.equal(r.outcome, 'success', '손익 무관 — 예측 적중 기준');
    // 반대: 수익이어도 가설이 틀리면 fail
    const miss = { high_time: '11:00', open: 10000, close: 10500 };
    const r2 = hyp.recordTradeEvidence(h.id, miss, { evidence_date: '2026-11-26', note: '익절', pnl: 80000 }, { dataDir: dir });
    assert.equal(r2.outcome, 'fail', '수익이어도 가설 빗나감 → fail');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 3 + REQ-025 AC1: 출병 없는 조건 발생일 → observation 1건 =====
test('시나리오3: 관찰 증거 — kind=observation, evidence_count 동등 1건', () => {
  const dir = makeTmpDir();
  try {
    const h = regA1(dir);
    hyp.recordObservation(h.id, A1_HIT, { evidence_date: '2026-11-25', note: '출병 없이 조건 발생' }, { dataDir: dir });
    const ev = hyp.evidences(h.id, { dataDir: dir });
    assert.equal(ev[0].kind, 'observation');
    const g = hyp.get(h.id, { dataDir: dir });
    assert.equal(g.evidence_count, 1, '동등 1건 집계');
    assert.equal(g.trade_count, 0);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 4 + REQ-024 AC3: 판정식 없는 가설 → 판정 대기 → 군주 확정 =====
test('시나리오4: 판정식 없으면 판정 대기 → 군주 확정 시 judged_by=군주', () => {
  const dir = makeTmpDir();
  try {
    const h = hyp.register({ code: 'T-B3', category: 'B', statement: '이벤트 당일 고점 → 이벤트 전 매도' }, { dataDir: dir });
    const r = hyp.recordTradeEvidence(h.id, {}, { evidence_date: '2026-11-25', note: '앤트로픽 상장일' }, { dataDir: dir });
    assert.equal(r.pending, true, '판정 대기');
    assert.equal(hyp.evidences(h.id, { dataDir: dir }).length, 0, '아직 증거 아님');

    const pend = hyp.pendingJudgments({ dataDir: dir });
    assert.equal(pend.length, 1);
    hyp.confirmPending(pend[0].id, 'success', { dataDir: dir });
    const ev = hyp.evidences(h.id, { dataDir: dir });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].judged_by, '군주');
    assert.equal(ev[0].kind, 'trade');
  } finally {
    rm(dir);
  }
});

// ===== 에지 + REQ-024 AC4: 시세 결측 3거래일 → 수동 판정 전환 =====
test('에지: 판정식 있어도 시세 결측 3거래일이면 수동 판정으로 전환', () => {
  const dir = makeTmpDir();
  try {
    const h = regA1(dir);
    const r = hyp.recordTradeEvidence(h.id, null, { evidence_date: '2026-11-20', note: '시세 유실' }, { dataDir: dir });
    assert.equal(r.pending, true);
    let pend = hyp.pendingJudgments({ dataDir: dir });
    assert.equal(pend[0].mode, 'auto_retry', '자동 재시도 대기');

    // 1거래일 뒤 — 아직 자동 대기
    hyp.escalatePending('2026-11-21', { dataDir: dir });
    assert.equal(hyp.pendingJudgments({ dataDir: dir })[0].mode, 'auto_retry');
    // 3거래일 경과(11-20 → 11-25) → 수동 전환
    hyp.escalatePending('2026-11-25', { dataDir: dir });
    pend = hyp.pendingJudgments({ dataDir: dir });
    assert.equal(pend[0].mode, 'manual', '3거래일 후 수동 판정 전환');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 5·6 + REQ-025 AC2·3·4: 승격 조건(10건 + 출병 3건) =====
test('시나리오5·6: 승격 — 관찰 10/출병 0 차단·관찰 7+출병 3 허용·합계 9 차단', () => {
  const dir = makeTmpDir();
  try {
    const mk = (code) => {
      const h = hyp.register({ code, category: 'A', statement: 'x → y' }, { dataDir: dir });
      hyp.transition(h.id, 'testing', { dataDir: dir });
      return h;
    };
    const add = (id, kind, n) => {
      for (let i = 0; i < n; i++) {
        hyp.addEvidence({ hypothesis_id: id, evidence_date: `2026-11-${String(10 + i).padStart(2, '0')}`, note: 'e', outcome: 'success', kind, judged_by: '군주' }, { dataDir: dir });
      }
    };
    // (5) 관찰 10·출병 0 → 차단 "출병 0/3"
    const h1 = mk('T-S5');
    add(h1.id, 'observation', 10);
    assert.throws(() => hyp.transition(h1.id, 'verified', { dataDir: dir }), /출병 0\/3/);
    // (6) 관찰 7·출병 3 → 허용
    const h2 = mk('T-S6');
    add(h2.id, 'observation', 7);
    add(h2.id, 'trade', 3);
    hyp.transition(h2.id, 'verified', { dataDir: dir });
    assert.equal(hyp.get(h2.id, { dataDir: dir }).status, 'verified');
    // (REQ-025 AC4) 합계 9(출병 3 포함) → 차단 "9/10"
    const h3 = mk('T-S9');
    add(h3.id, 'observation', 6);
    add(h3.id, 'trade', 3);
    assert.throws(() => hyp.transition(h3.id, 'verified', { dataDir: dir }), /9\/10/);
    // 참고 수준 라벨
    assert.equal(hyp.get(h3.id, { dataDir: dir }).reference_only, true);
    assert.equal(hyp.get(h2.id, { dataDir: dir }).reference_only, false);
  } finally {
    rm(dir);
  }
});

// ===== 에지: 증거 삭제로 미달 복귀 — verified는 경고만·재전이는 차단 =====
test('에지: 증거 삭제 → verified는 자동 강등 없이 경고, 라벨 복원', () => {
  const dir = makeTmpDir();
  try {
    const h = hyp.register({ code: 'T-DEL', category: 'A', statement: 'x → y' }, { dataDir: dir });
    hyp.transition(h.id, 'testing', { dataDir: dir });
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(hyp.addEvidence({ hypothesis_id: h.id, evidence_date: '2026-11-10', note: 'e', outcome: 'success', kind: 'observation', judged_by: '군주' }, { dataDir: dir }).id);
    for (let i = 0; i < 3; i++) ids.push(hyp.addEvidence({ hypothesis_id: h.id, evidence_date: '2026-11-11', note: 'e', outcome: 'success', kind: 'trade', judged_by: '군주' }, { dataDir: dir }).id);
    hyp.transition(h.id, 'verified', { dataDir: dir });

    const r = hyp.removeEvidence(ids[ids.length - 1], { dataDir: dir }); // trade 2건으로
    assert.equal(r.warning != null, true, '경고 반환');
    const g = hyp.get(h.id, { dataDir: dir });
    assert.equal(g.status, 'verified', '자동 강등 없음');
    assert.equal(g.trade_count, 2);
    assert.equal(g.reference_only, true, '라벨 복원(9건)');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 9 + AC4: 판정식 주입 불가(화이트리스트 밖 토큰 거부) =====
test('시나리오9: 판정식 평가기 — 화이트리스트 밖 토큰·코드 주입 거부', () => {
  const dir = makeTmpDir();
  try {
    for (const evil of [
      "process.exit(1)",
      "require('fs')",
      "close); console.log('x'",
      "constructor.constructor('return 1')()",
      "unknown_var > 1",
      "close < open; while(true){}",
    ]) {
      assert.throws(() => hyp.evaluateExpr(evil, A1_HIT), /허용|토큰|화이트리스트|식/, `주입 거부: ${evil}`);
    }
    // 정상식은 평가
    assert.equal(hyp.evaluateExpr(A1_EXPR, A1_HIT), true);
    assert.equal(hyp.evaluateExpr('close > open', A1_HIT), false);
    assert.equal(hyp.evaluateExpr('gap_pct <= -3', { gap_pct: -3.5 }), true);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 7·8 + AC2·3: patterns.md 이관(원본 불변·전수·상태·증거 대사) =====
test('시나리오7·8: patterns.md 이관 — 20개 전수·상태 원본 일치·증거 수 대사·원본 불변', () => {
  const dir = makeTmpDir();
  const before = crypto.createHash('sha256').update(fs.readFileSync(PATTERNS)).digest('hex');
  try {
    const rpt = hyp.migratePatterns(PATTERNS, { dataDir: dir });

    // 원본 불변
    const after = crypto.createHash('sha256').update(fs.readFileSync(PATTERNS)).digest('hex');
    assert.equal(after, before, '원본 patterns.md 수정 금지');

    // 20개 전수
    const codes = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'C1', 'C2', 'C3', 'C4', 'C5', 'D1', 'D2', 'D3'];
    const all = hyp.list({ dataDir: dir });
    assert.equal(rpt.hypotheses, 20, '이관 가설 20');
    for (const c of codes) {
      assert.ok(all.some((h) => h.code === c), `존재: ${c}`);
    }

    // 상태 원본 일치('검증 중'→testing, '가설'→hypothesis, '사용 중'→verified — 원문 라벨 보존)
    const st = (c) => all.find((h) => h.code === c);
    for (const c of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C5']) assert.equal(st(c).status, 'testing', `${c} 검증 중`);
    for (const c of ['A4', 'A5', 'A6', 'B4', 'B5', 'B6', 'C2', 'C3', 'C4']) assert.equal(st(c).status, 'hypothesis', `${c} 가설`);
    for (const c of ['D1', 'D2', 'D3']) assert.equal(st(c).status, 'rule', `${c} 사용 중 → rule(군령류)`);
    assert.match(st('D3').original_status, /사용 중/, '원문 라벨 보존');

    // 판정식: 시세로 잴 수 있는 것만(A1·A3·A6), 나머지는 비움(군주 판정)
    assert.ok(st('A1').judge_expr && st('A3').judge_expr && st('A6').judge_expr, '측정 가능 3건 등록');
    for (const c of ['A2', 'B3', 'C1', 'D1']) assert.ok(!st(c).judge_expr, `${c} 판정식 비움(군주)`);

    // 증거 수 대사: 증거 칸이 있고 '기록 예정'이 아닌 가설 15개 = 증거 15건
    assert.equal(rpt.evidences, 15, '증거 15건(A6 + B4 + C5, 예정 2건 제외)');
    const totalEv = all.reduce((s, h) => s + h.evidence_count, 0);
    assert.equal(totalEv, rpt.evidences, '장부 집계 일치');
    // 예정 항목은 0건
    assert.equal(st('B5').evidence_count, 0);
    assert.equal(st('B6').evidence_count, 0);

    // 이관 리포트 파일
    const rp = path.join(dir, 'hypothesis', 'migration_report.md');
    assert.ok(fs.existsSync(rp), '이관 리포트');
    assert.match(fs.readFileSync(rp, 'utf8'), /20.*15|가설 20/s, '대사 수치');

    // 멱등: 재실행해도 중복 생성 없음
    const rpt2 = hyp.migratePatterns(PATTERNS, { dataDir: dir });
    assert.equal(rpt2.skipped, true, '재이관 방지');
    assert.equal(hyp.list({ dataDir: dir }).length, 20);
  } finally {
    rm(dir);
  }
});
