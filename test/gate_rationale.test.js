'use strict';

// TST-019 — 관문 근거·등급 검사(TSK-020 / REQ-023)
// 실행: node --test — 모의 전용(실전 전송 0). 가짜 KIS·가짜 키.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const gate = require('../src/gate');
const secret = require('../src/secret');
const state = require('../src/state');
const generalRank = require('../src/general_rank');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst019-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function lastBlocked(dir) {
  const d = paths.ledgerDir(dir, 'order_log');
  if (!fs.existsSync(d)) return null;
  const rows = fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  const b = rows.filter((r) => r.status === 'blocked');
  return b[b.length - 1];
}

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

// 등급별 테스트 가설 4종(검증됨·검증 중·가설·폐기) 시드
function seedHyps(dir) {
  state.write('hypothesis_book', { items: [
    { id: 'HYP-V', code: 'V', category: 'A', statement: 'v', status: 'verified', evidence_count: 12, trade_count: 4, reference_only: false, created_at: 'x' },
    { id: 'HYP-T', code: 'T', category: 'A', statement: 't', status: 'testing', evidence_count: 5, trade_count: 1, reference_only: true, created_at: 'x' },
    { id: 'HYP-H', code: 'H', category: 'A', statement: 'h', status: 'hypothesis', evidence_count: 1, trade_count: 0, reference_only: true, created_at: 'x' },
    { id: 'HYP-D', code: 'D', category: 'A', statement: 'd', status: 'discarded', evidence_count: 3, trade_count: 0, reference_only: true, created_at: 'x' },
  ] }, { dataDir: dir });
}

async function boot() {
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({ mock: { appkey: 'a', appsecret: 'b', account: '12345678' }, real: { appkey: 'c', appsecret: 'd', account: '87654321' } }), keysPath);
  state.write('guard_config', {
    id: 'default', per_order_limit_real: 200000, per_order_limit_paper: 500000,
    daily_loss_limit: -50000, stop_file_path: path.join(dir, 'STOP'),
    cash_ratio_min: 0.3, correlation_max: 0.7, sample_min: 10, updated_at: 'x',
  }, { dataDir: dir });
  seedHyps(dir);
  state.write('watchlist', [{ symbol: '005930', status: 'ready' }], { dataDir: dir });
  const srv = await fakeKis();
  const opts = { dataDir: dir, keysPath, baseUrls: { mock: srv.url, real: srv.url }, gapMs: 5, fillPollMs: 10, fillPollMax: 30, now: '2026-11-25T09:30:00+09:00', realOrderPolicy: { human: true } };
  return { dir, srv, opts };
}
async function down(s) { await s.srv.close(); rm(s.dir); }

// troops명 매수 초안(모의) — 1만원=1명이 되도록 qty×price = troops×10000
function draft(troops, hypIds, over) {
  return Object.assign({
    account_type: 'paper', nation: 'chok', symbol: '005930', side: 'buy',
    entry_low: 10000, entry_high: 10000, stop_price: 9000, target_price: 12000,
    deadline: '2026-12-05', troops,
    qty: troops, price: 10000, user_confirmed: true, created_by: 'human', reason: '근거 검사 테스트',
    hypothesis_ids: hypIds,
  }, over || {});
}

// 실전 매수 초안 — 등급 상한(grade_cap)은 실전에만 적용(2026-11-26 군주 결정)
function draftReal(troops, hypIds) {
  return draft(troops, hypIds, { account_type: 'real', nation: undefined });
}

// ===== 시나리오 1·2: no_rationale =====
test('시나리오1·2: 근거 없음/미실재/4개/폐기만 → no_rationale(기록)', async () => {
  const s = await boot();
  try {
    const cases = [
      [undefined, '근거 없음'],
      [[], '빈 배열'],
      [['HYP-NOPE'], '장부에 없음'],
      [['HYP-V', 'HYP-T', 'HYP-H', 'HYP-V'], '4개 초과'],
      [['HYP-D'], '폐기만 인용'],
    ];
    for (const c of cases) {
      const r = await gate.submit(draft(10, c[0]), s.opts);
      assert.equal(r.reason, 'no_rationale', c[1] + ' 차단');
    }
    const row = lastBlocked(s.dir);
    assert.equal(row.block_reason, 'no_rationale');
    assert.ok(row.detail, '사유 기록');
    assert.equal(s.srv.received.filter((x) => x.path.endsWith('order-cash')).length, 0, '전송 0');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 3: 검증됨·현령 20명 전부 통과 =====
test('시나리오3: 검증됨 근거 20명(현령 전부) 통과', async () => {
  const s = await boot();
  try {
    const r = await gate.submit(draft(20, ['HYP-V']), s.opts);
    assert.equal(r.ok, true);
  } finally {
    await down(s);
  }
});

// ===== 시나리오 4: 검증 중 — 절반 버림(현령 10명) =====
test('시나리오4: 검증 중(실전) — 11명 차단(grade_cap)·10명 통과', async () => {
  const s = await boot();
  try {
    const r11 = await gate.submit(draftReal(11, ['HYP-T']), s.opts);
    assert.equal(r11.reason, 'grade_cap');
    const row = lastBlocked(s.dir);
    assert.equal(row.block_reason, 'grade_cap');
    assert.ok(JSON.stringify(row.detail).includes('10'), '상한 수치 기록');
    const r10 = await gate.submit(draftReal(10, ['HYP-T']), s.opts);
    assert.equal(r10.ok, true);
  } finally {
    await down(s);
  }
});

// ===== 시나리오 4-보강: 모의 세력전 — 등급 상한 미적용(2026-11-26 군주 결정) =====
test('시나리오4-보강: 모의는 등급 상한 미적용 — 검증 중·가설 11명 통과, 세력전 25만은 유지', async () => {
  const s = await boot();
  try {
    assert.equal((await gate.submit(draft(11, ['HYP-T']), s.opts)).ok, true, '모의 검증 중 11명 통과');
    assert.equal((await gate.submit(draft(11, ['HYP-H']), s.opts)).ok, true, '모의 가설 11명 통과');
    // 등급 상한만 풀린다 — 세력전 종목당 25만(REQ-009)은 그대로
    assert.equal((await gate.submit(draft(26, ['HYP-H']), s.opts)).reason, 'nation_limit');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 5: 가설 — 정찰대 10명 =====
test('시나리오5: 가설 근거(실전) — 11명 차단·10명 통과', async () => {
  const s = await boot();
  try {
    assert.equal((await gate.submit(draftReal(11, ['HYP-H']), s.opts)).reason, 'grade_cap');
    assert.equal((await gate.submit(draftReal(10, ['HYP-H']), s.opts)).ok, true);
  } finally {
    await down(s);
  }
});

// ===== 시나리오 6: 복수 인용 — 최고 등급 기준 =====
test('시나리오6: (실전) 검증 중+가설 → 최고 등급(검증 중) 10명 기준·검증됨 섞이면 전부', async () => {
  const s = await boot();
  try {
    assert.equal((await gate.submit(draftReal(10, ['HYP-T', 'HYP-H']), s.opts)).ok, true);
    assert.equal((await gate.submit(draftReal(11, ['HYP-T', 'HYP-H']), s.opts)).reason, 'grade_cap');
    assert.equal((await gate.submit(draftReal(20, ['HYP-V', 'HYP-H']), s.opts)).ok, true, '최고 등급=검증됨');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 7: 매도(회군)는 근거·등급 무검사 =====
test('시나리오7: 근거 없는 매도 통과(회군 보장)', async () => {
  const s = await boot();
  try {
    const sell = await gate.submit(draft(60, undefined, { side: 'sell', qty: 60 }), s.opts);
    assert.equal(sell.ok, true);
  } finally {
    await down(s);
  }
});

// ===== 경계: 태수 15/16·승상 재량 =====
test('경계: (실전) 태수 검증 중 15 통과·16 차단 / 승상 재량(가설만 10명 고정)', async () => {
  const s = await boot();
  try {
    generalRank.promote('taesu', { dataDir: s.dir });
    assert.equal((await gate.submit(draftReal(15, ['HYP-T']), s.opts)).ok, true, '태수 절반 15');
    assert.equal((await gate.submit(draftReal(16, ['HYP-T']), s.opts)).reason, 'grade_cap');
    generalRank.promote('seungsang', { dataDir: s.dir });
    // 승상 재량(per_stock null) — 1회 한도는 태수 동기화 값(30만)이 남으므로 25명(25만)으로 재량 입증
    assert.equal((await gate.submit(draftReal(25, ['HYP-T']), s.opts)).ok, true, '승상 검증 중 재량');
    assert.equal((await gate.submit(draftReal(11, ['HYP-H']), s.opts)).reason, 'grade_cap', '가설은 승상도 10명');
  } finally {
    await down(s);
  }
});

// ===== 경계: 제출 시점 등급 — 장중 폐기 전환 =====
test('경계: 인용 가설이 폐기로 바뀐 뒤 제출 → no_rationale', async () => {
  const s = await boot();
  try {
    assert.equal((await gate.submit(draft(10, ['HYP-T']), s.opts)).ok, true);
    const b = state.read('hypothesis_book', { dataDir: s.dir });
    b.items.find((x) => x.id === 'HYP-T').status = 'discarded';
    state.write('hypothesis_book', b, { dataDir: s.dir });
    assert.equal((await gate.submit(draft(10, ['HYP-T']), s.opts)).reason, 'no_rationale');
  } finally {
    await down(s);
  }
});

// ===== 지령 014: 근거 ID 별칭 정규화 + 차단 사유 상세 =====
function lastOrderRow(dir) {
  const d = paths.ledgerDir(dir, 'order_log');
  const rows = fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  return rows[rows.length - 1];
}

test('지령014: 접두어 없는 ID·소문자 → 정규화 통과·기록, 없는 ID → note 포함 차단', async () => {
  const s = await boot();
  try {
    // 'H' → 'HYP-H' (모의 매수 — 등급 상한 미적용이라 통과)
    const r1 = await gate.submit(draft(10, ['H']), s.opts);
    assert.equal(r1.ok, true, '별칭 통과');
    assert.deepEqual(lastOrderRow(s.dir).hypothesis_ids, ['HYP-H'], '정규화 결과가 기록에 남음');
    // 소문자 'hyp-v' → 'HYP-V'
    const r2 = await gate.submit(draft(10, ['hyp-v']), s.opts);
    assert.equal(r2.ok, true, '대소문자 정리 통과');
    assert.deepEqual(lastOrderRow(s.dir).hypothesis_ids, ['HYP-V']);
    // 정확 일치 그대로
    assert.equal((await gate.submit(draft(10, ['HYP-V']), s.opts)).ok, true);
    // 없는 ID → 차단 + note
    const r4 = await gate.submit(draft(10, ['B99']), s.opts);
    assert.equal(r4.reason, 'no_rationale');
    assert.match(r4.detail.note, /장부에 없는 가설: B99/, '원인 note');
  } finally {
    await down(s);
  }
});
