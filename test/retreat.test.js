'use strict';

// TST-018 보완 — D계열 rule 분리·회군 사이클(TSK-019 보완)
// 실행: node --test — 실서버·실키·실claude 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const hyp = require('../src/hypothesis');
const retreat = require('../src/retreat');
const captives = require('../src/captives');
const merit = require('../src/merit');
const gate = require('../src/gate');
const secret = require('../src/secret');
const state = require('../src/state');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst018f-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function rows(dir, name) {
  const d = paths.ledgerDir(dir, name);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}

const PATTERNS = path.join(__dirname, '..', 'refs', 'research', 'patterns.md');

// ===== 군사 검토: D1~D3은 rule(군령류)·citable=false — verified 아님 =====
test('보완: 이관 시 D1~D3 → status=rule·citable=false (verified 0건)', () => {
  const dir = makeTmpDir();
  try {
    hyp.migratePatterns(PATTERNS, { dataDir: dir });
    const all = hyp.list({ dataDir: dir });
    for (const c of ['D1', 'D2', 'D3']) {
      const h = all.find((x) => x.code === c);
      assert.equal(h.status, 'rule', `${c}는 rule`);
      assert.equal(h.citable, false, `${c} 인용 불가`);
      assert.match(h.original_status, /사용 중/, '원문 라벨 보존');
    }
    // 이관 전수에서 verified 0건 — 증거 0건 가설이 verified가 되는 경로 없음
    assert.equal(all.filter((x) => x.status === 'verified').length, 0, '이관 verified 0');
  } finally {
    rm(dir);
  }
});

test('보완: 증거 0건 가설이 verified가 되는 경로가 없다(등록·전이 봉쇄)', () => {
  const dir = makeTmpDir();
  try {
    // 등록으로 verified 생성 불가
    assert.throws(() => hyp.register({ code: 'X', category: 'A', statement: 'x → y', status: 'verified' }, { dataDir: dir }), /verified|승격|전이/);
    // 전이는 기존대로 표본 조건 필요
    const h = hyp.register({ code: 'X2', category: 'A', statement: 'x → y' }, { dataDir: dir });
    hyp.transition(h.id, 'testing', { dataDir: dir });
    assert.throws(() => hyp.transition(h.id, 'verified', { dataDir: dir }), /0\/10|증거 0/);
    // rule은 전이 자체가 없다(종착)
    const r = hyp.register({ code: 'XR', category: 'D', statement: 'z', status: 'rule' }, { dataDir: dir });
    assert.equal(r.citable, false, 'rule은 자동 citable=false');
    assert.throws(() => hyp.transition(r.id, 'testing', { dataDir: dir }), /전이/);
  } finally {
    rm(dir);
  }
});

// ===== gate: rule만 인용 → no_rationale, rule은 등급 계산 제외 =====
function fakeKis() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      received.push({ path: u.pathname });
      const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/oauth2/tokenP') return reply({ access_token: 'FT', access_token_token_expired: '2026-11-26 23:59:59' });
      if (u.pathname.endsWith('inquire-balance')) return reply({ rt_cd: '0', output1: [], output2: [{ dnca_tot_amt: '2000000', prvs_rcdl_excc_amt: '2000000', tot_evlu_amt: '2500000' }] });
      if (u.pathname.endsWith('order-cash')) return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '1', ODNO: '99' } });
      if (u.pathname.endsWith('inquire-daily-ccld')) return reply({ rt_cd: '0', output1: [] });
      reply({ rt_cd: '1', msg1: '?' });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) })));
}
async function bootGate() {
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({ mock: { appkey: 'a', appsecret: 'b', account: '12345678' }, real: { appkey: 'c', appsecret: 'd', account: '87654321' } }), keysPath);
  state.write('guard_config', {
    id: 'default', per_order_limit_real: 200000, per_order_limit_paper: 500000,
    daily_loss_limit: -50000, stop_file_path: path.join(dir, 'STOP'),
    cash_ratio_min: 0.3, correlation_max: 0.7, sample_min: 10, updated_at: 'x',
  }, { dataDir: dir });
  state.write('hypothesis_book', { items: [
    { id: 'HYP-R', code: 'D1', category: 'D', statement: 'r', status: 'rule', citable: false, evidence_count: 0, trade_count: 0, reference_only: true, created_at: 'x' },
    { id: 'HYP-T', code: 'T', category: 'A', statement: 't', status: 'testing', citable: true, evidence_count: 5, trade_count: 1, reference_only: true, created_at: 'x' },
  ] }, { dataDir: dir });
  const srv = await fakeKis();
  const opts = { dataDir: dir, keysPath, baseUrls: { mock: srv.url, real: srv.url }, gapMs: 5, fillPollMs: 10, fillPollMax: 30, now: '2026-11-25T09:30:00+09:00' };
  return { dir, srv, opts };
}
function buyDraft(troops, ids) {
  return {
    account_type: 'paper', nation: null, symbol: '005930', side: 'buy',
    entry_low: 10000, entry_high: 10000, stop_price: 9000, target_price: 12000,
    deadline: '2026-12-05', troops, qty: troops, price: 10000,
    user_confirmed: true, created_by: 'human', reason: 't', hypothesis_ids: ids,
  };
}

test('보완: gate — rule만 인용 no_rationale·rule+검증 중 혼합은 검증 중 기준', async () => {
  const s = await bootGate();
  try {
    const only = await gate.submit(buyDraft(5, ['HYP-R']), s.opts);
    assert.equal(only.reason, 'no_rationale', 'rule만 인용 거부');
    // 혼합: 근거는 testing — 등급도 testing 기준(현령 10명)
    assert.equal((await gate.submit(buyDraft(10, ['HYP-R', 'HYP-T']), s.opts)).ok, true, '혼합 10명 통과');
    assert.equal((await gate.submit(buyDraft(11, ['HYP-R', 'HYP-T']), s.opts)).reason, 'grade_cap', 'rule은 등급 계산 제외');
  } finally {
    await s.srv.close(); rm(s.dir);
  }
});

// ===== 회군 사이클: trade_result → 증거 적립 → captive → 4분면 입력 =====
test('회군: 매도 체결 → trade_result·인용 가설 증거(자동+대기)·captive 반영·4분면 입력', async () => {
  const dir = makeTmpDir();
  try {
    // 가설 2개: 판정식 있음(A1형) / 없음(B형)
    const hAuto = hyp.register({ code: 'RA', category: 'A', statement: 'a', judge_expr: 'close < open' }, { dataDir: dir });
    const hMan = hyp.register({ code: 'RB', category: 'B', statement: 'b' }, { dataDir: dir });

    const r = await retreat.closeTrade({
      account_type: 'paper', symbol: '005930', trade_date: '2026-11-25',
      pnl: -30000, order_log_id: 'OL-1',
      hypothesis_ids: [hAuto.id, hMan.id],
      wall_deadline_respected: true, violation_count: 0,
      vars: { close: 9800, open: 10000 },
      note: '기한 만료 회군',
    }, { dataDir: dir });

    // ① trade_result 기록(4분면 입력)
    const tr = rows(dir, 'trade_result');
    assert.equal(tr.length, 1);
    assert.equal(tr[0].pnl, -30000);
    assert.equal(tr[0].rationale_cited, true);
    assert.equal(tr[0].wall_deadline_respected, true);
    assert.equal(tr[0].violation_count, 0);
    assert.equal(merit.quadrantOf(Object.assign({}, tr[0], { compliant: merit.isCompliant(tr[0]) })), 'honorable_defeat', '손실+준수=명예로운 패배');

    // ② 증거: 판정식 자동 1건(trade·app) + 군주 판정 대기 1건
    const evA = hyp.evidences(hAuto.id, { dataDir: dir });
    assert.equal(evA.length, 1);
    assert.equal(evA[0].kind, 'trade');
    assert.equal(evA[0].judged_by, 'app');
    assert.equal(evA[0].outcome, 'success', 'close<open 적중(손익 무관)');
    const pend = hyp.pendingJudgments({ dataDir: dir });
    assert.equal(pend.length, 1);
    assert.equal(pend[0].hypothesis_id, hMan.id);
    assert.equal(pend[0].kind, 'trade');

    // ③ captive 반영(-3만 → 포로 3)
    const st = captives.computeState('paper', { dataDir: dir });
    assert.equal(st.lossOutstanding, 30000);
    assert.equal(st.captives, 3);

    assert.equal(r.evidences.length, 2, '요약 반환');
  } finally {
    rm(dir);
  }
});

test('회군: 그림자 모드는 기록만 — captive_ledger 미반영(shadow 표시)', async () => {
  const dir = makeTmpDir();
  try {
    const h = hyp.register({ code: 'RS', category: 'A', statement: 'a', judge_expr: 'close < open' }, { dataDir: dir });
    await retreat.closeTrade({
      account_type: 'paper', symbol: '005930', trade_date: '2026-11-25',
      pnl: 20000, hypothesis_ids: [h.id], wall_deadline_respected: true, violation_count: 0,
      vars: { close: 10100, open: 10000 }, shadow: true,
    }, { dataDir: dir });
    const tr = rows(dir, 'trade_result');
    assert.equal(tr[0].shadow, true, 'shadow 표시');
    // 손익 원장 오염 없음
    assert.equal(rows(dir, 'captive_ledger').length, 0, '그림자는 captive 미반영');
    // 증거는 기록(가설 검증은 그림자에서도 진행)
    assert.equal(hyp.evidences(h.id, { dataDir: dir }).length, 1);
    assert.equal(hyp.evidences(h.id, { dataDir: dir })[0].outcome, 'fail', 'close>open — 빗나감');
  } finally {
    rm(dir);
  }
});

test('회군: rule 인용은 증거 적립 대상에서 제외·rationale_cited 판정은 citable 기준', async () => {
  const dir = makeTmpDir();
  try {
    const r1 = hyp.register({ code: 'RD', category: 'D', statement: 'r', status: 'rule' }, { dataDir: dir });
    await retreat.closeTrade({
      account_type: 'paper', symbol: '005930', trade_date: '2026-11-25',
      pnl: 10000, hypothesis_ids: [r1.id], wall_deadline_respected: true, violation_count: 0, shadow: true,
    }, { dataDir: dir });
    const tr = rows(dir, 'trade_result');
    assert.equal(tr[0].rationale_cited, false, 'rule만 인용은 근거 아님(요행 분류)');
    assert.equal(hyp.evidences(r1.id, { dataDir: dir }).length, 0, 'rule엔 증거 적립 없음');
    assert.equal(hyp.pendingJudgments({ dataDir: dir }).length, 0);
  } finally {
    rm(dir);
  }
});
