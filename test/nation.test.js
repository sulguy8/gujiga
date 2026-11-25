'use strict';

// TST-022 — 세력 장부·세력전 대시보드(TSK-023 / DAT-007·REQ-009·010·SCR-006)
// 실행: node --test — 모의 전용·실서버 0. 원본 mock_portfolio.md는 사본으로 검증(실파일 접촉 최소).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const nation = require('../src/nation');
const web = require('../src/web');
const gate = require('../src/gate');
const secret = require('../src/secret');
const state = require('../src/state');
const ledger = require('../src/ledger');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst022-')); }
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

// 체결 행 헬퍼(모의 세력전)
function fill(dir, over) {
  ledger.append('order_log', Object.assign({
    id: crypto.randomUUID(), account_type: 'paper', nation: 'chok',
    symbol: '000001', side: 'buy', order_type: 'limit',
    price: 10000, qty: 10, amount: 100000,
    status: 'filled', block_reason: null, broker_order_no: 'B', filled_at: '2026-11-24T10:00:00+09:00',
    created_at: '2026-11-24T10:00:00+09:00',
  }, over || {}), { dataDir: dir });
}

// ===== 시나리오 1: 전수 귀속 — 무소속·이중 0 =====
test('시나리오1: 모의 체결 전수 귀속 — 무소속 체결은 위반으로 보고', () => {
  const dir = makeTmpDir();
  try {
    fill(dir, { nation: 'chok' });
    fill(dir, { nation: 'wi', symbol: '000002' });
    const ok = nation.computeLedger({ dataDir: dir });
    assert.equal(ok.violations.length, 0, '무소속 0');
    // 무소속 주입 → 위반 보고
    fill(dir, { nation: null, symbol: '000003' });
    const bad = nation.computeLedger({ dataDir: dir });
    assert.equal(bad.violations.length, 1, '무소속 1건 검출');
    assert.match(bad.violations[0], /무소속|nation/);
  } finally {
    rm(dir);
  }
});

// ===== 재계산(저장값 신뢰 금지): 현금·실현손익·수익률 수기 검산 =====
test('재계산: 촉 매수 10만·일부 매도(+5천 실현) — 현금·실현·수익률 수기 일치', () => {
  const dir = makeTmpDir();
  try {
    // 촉: 10주 @10,000 매수(10만) → 5주 @11,000 매도(5.5만, 실현 +5,000)
    fill(dir, { nation: 'chok', symbol: '000001', side: 'buy', price: 10000, qty: 10, amount: 100000 });
    fill(dir, { nation: 'chok', symbol: '000001', side: 'sell', price: 11000, qty: 5, amount: 55000, created_at: '2026-11-24T11:00:00+09:00' });
    const L = nation.computeLedger({ dataDir: dir }).ledgers;
    const chok = L.chok;
    assert.equal(chok.allocated, 1000000);
    assert.equal(chok.cash, 1000000 - 100000 + 55000, '현금 95.5만');
    assert.equal(chok.realized_pnl, 5000, '실현 +5,000');
    // 잔여 5주 평가(시세 없으면 평단 10,000) = 50,000
    assert.equal(chok.position_value, 50000);
    assert.ok(Math.abs(chok.return_rate - 0.005) < 1e-9, '수익률 0.5%');
    // 위·오는 무거래 — 배정 그대로
    assert.equal(L.wi.cash, 500000);
    assert.equal(L.o.return_rate, 0);
    // 배정 합 200만 강제
    assert.equal(L.chok.allocated + L.wi.allocated + L.o.allocated, 2000000);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 2: 정합성 — 저장값 어긋남 경고 =====
test('시나리오2: 정합성 검사 — 정상 통과·일부러 어긋낸 저장값 경고', () => {
  const dir = makeTmpDir();
  try {
    fill(dir, { nation: 'chok' });
    nation.saveLedger({ dataDir: dir });
    const ok = nation.checkIntegrity({ dataDir: dir });
    assert.equal(ok.ok, true, '정상 정합');
    // 저장값을 일부러 어긋냄
    const st = state.read('nation_ledger', { dataDir: dir });
    st.chok.cash += 7777;
    state.write('nation_ledger', st, { dataDir: dir });
    const bad = nation.checkIntegrity({ dataDir: dir });
    assert.equal(bad.ok, false, '어긋남 감지');
    assert.ok(bad.warnings.some((w) => /chok/.test(w) && /7777|어긋/.test(w)), '나라·수치 경고');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 3·4: 관문 회귀 — 종목당 25만·3번째 종목·nation 없는 모의 매수 =====
// 저상관 일봉(±1% 교대·앞부분 뒤집기) — ⑥상관 통과용(⑦ 세력전 한도 검증이 목적)
function closesOf(flipK, start) {
  const closes = [start || 10000];
  for (let i = 0; i < 60; i++) {
    const sign = (i % 2 === 0 ? 1 : -1) * (i < flipK ? -1 : 1);
    closes.push(closes[closes.length - 1] * (1 + sign / 100));
  }
  return closes;
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
  state.write('hypothesis_book', { items: [{ id: 'HYP-V', code: 'V', category: 'A', statement: 'v', status: 'verified', citable: true, evidence_count: 12, trade_count: 4, reference_only: false, created_at: 'x' }] }, { dataDir: dir });
  // 관직을 태수로 — 관직 한도(grade_cap)보다 세력전 25만 한도가 먼저 걸리는지 검증하기 위함
  state.write('general_rank', { id: 'me', rank: 'taesu', per_stock_troops_max: 30, concurrent_max: 2, sortie_count: 0, clean_weeks: 0, review_weeks: 0, promoted_at: null, updated_at: 'x' }, { dataDir: dir });
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/oauth2/tokenP') return reply({ access_token: 'FT', access_token_token_expired: '2026-11-26 23:59:59' });
      if (u.pathname.endsWith('inquire-balance')) return reply({ rt_cd: '0', output1: [], output2: [{ dnca_tot_amt: '2000000', prvs_rcdl_excc_amt: '2000000', tot_evlu_amt: '2500000' }] });
      if (u.pathname.endsWith('order-cash')) return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '1', ODNO: '99' } });
      if (u.pathname.endsWith('inquire-daily-ccld')) return reply({ rt_cd: '0', output1: [] });
      if (u.pathname.endsWith('itemchartprice')) {
        const sym = u.searchParams.get('FID_INPUT_ISCD');
        const flipK = { '000003': 0, '000008': 20, '000009': 30 }[sym];
        if (flipK == null) return reply({ rt_cd: '1', msg1: '일봉 없음' });
        const out = closesOf(flipK, 5000 + flipK * 100).map((c, i) => ({
          stck_bsop_date: String(20260101 + i), stck_oprc: String(c), stck_hgpr: String(c), stck_lwpr: String(c), stck_clpr: String(c), acml_vol: '1',
        })).reverse();
        return reply({ rt_cd: '0', msg1: '정상', output2: out });
      }
      reply({ rt_cd: '1', msg1: '?' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const opts = { dataDir: dir, keysPath, baseUrls: { mock: `http://127.0.0.1:${srv.address().port}`, real: 'http://127.0.0.1:1' }, gapMs: 5, fillPollMs: 10, fillPollMax: 30, now: '2026-11-25T09:30:00+09:00' };
  return { dir, srv, opts };
}
function paperDraft(over) {
  return Object.assign({
    account_type: 'paper', nation: 'chok', symbol: '000001', side: 'buy',
    entry_low: 10000, entry_high: 10000, stop_price: 9000, target_price: 12000,
    deadline: '2026-12-05', troops: 10, qty: 10, price: 10000,
    user_confirmed: true, created_by: 'human', reason: 't', hypothesis_ids: ['HYP-V'],
  }, over || {});
}

test('시나리오3·4: 관문 — 종목당 25만 초과·3번째 종목·nation 없는 모의 매수 차단', async () => {
  const s = await bootGate();
  try {
    // 종목당 25만 초과(26만)
    const over = await gate.submit(paperDraft({ troops: 26, qty: 26 }), s.opts);
    assert.equal(over.reason, 'nation_limit', '25만 초과 차단');
    // 동시 2종목 보유 중 3번째
    state.write('positions', [
      { id: 'p1', account_type: 'paper', nation: 'chok', symbol: '000008', qty: 1, avg_price: 10000, stop_price: 9000, target_price: 12000, deadline: '2026-12-10', status: 'open' },
      { id: 'p2', account_type: 'paper', nation: 'chok', symbol: '000009', qty: 1, avg_price: 10000, stop_price: 9000, target_price: 12000, deadline: '2026-12-10', status: 'open' },
    ], { dataDir: s.dir });
    const third = await gate.submit(paperDraft({ symbol: '000003' }), s.opts);
    assert.equal(third.reason, 'nation_limit', '3번째 종목 차단');
    // nation 없는 모의 매수 — 거부(REQ-009 AC1)
    state.write('positions', [], { dataDir: s.dir });
    const noNation = await gate.submit(paperDraft({ nation: null }), s.opts);
    assert.equal(noNation.reason, 'no_nation', '무소속 모의 매수 거부');
    // 모의 '매도'는 nation 없어도 허용(회군 보장)
    const sell = await gate.submit(paperDraft({ nation: null, side: 'sell' }), s.opts);
    assert.equal(sell.ok, true, '매도는 무소속 허용');
  } finally {
    s.srv.close(); rm(s.dir);
  }
});

// ===== 시나리오 5 + SCR AC3: 매복 성공률 — 위 5건 중 3건 체결 = 60.0%, 촉·오 해당 없음 =====
test('시나리오5: 매복 성공률 60.0% 수기 일치·촉·오 해당 없음·0건 해당 없음', () => {
  const dir = makeTmpDir();
  try {
    // 위: 예약 5건(3 체결, 2 취소) — 주간(11-17~11-21)
    for (let i = 0; i < 3; i++) fill(dir, { nation: 'wi', symbol: `00000${i}`, status: 'filled', created_at: `2026-11-1${7 + i}T09:00:00+09:00` });
    for (let i = 0; i < 2; i++) fill(dir, { nation: 'wi', symbol: `00001${i}`, status: 'cancelled', created_at: `2026-11-1${7 + i}T09:00:00+09:00` });
    // 촉: 매수 1건
    fill(dir, { nation: 'chok', symbol: '000021', created_at: '2026-11-18T10:00:00+09:00' });
    const r = nation.weeklyReport({ from: '2026-11-17', to: '2026-11-21' }, { dataDir: dir });
    assert.equal(r.nations.wi.ambush_rate, 60.0, '3/5 = 60.0%');
    assert.equal(r.nations.chok.ambush_rate, null, '촉 해당 없음');
    assert.equal(r.nations.o.ambush_rate, null, '오 해당 없음');
    assert.equal(r.nations.wi.sorties, 3, '위 출병 3(체결 기준)');
    assert.equal(r.nations.chok.sorties, 1);
    assert.equal(r.nations.o.sorties, 0, '0건 나라도 포함');
    // 위 예약 0건 주간 → 해당 없음
    const empty = nation.weeklyReport({ from: '2026-11-10', to: '2026-11-14' }, { dataDir: dir });
    assert.equal(empty.nations.wi.ambush_rate, null, '예약 0건 — 해당 없음(0 나누기 방지)');
  } finally {
    rm(dir);
  }
});

// ===== 주차 전환: 저장 집계와 재계산 일치 =====
test('에지: 주간 리포트 저장 후 재계산이 저장본과 일치(주차 재현)', () => {
  const dir = makeTmpDir();
  try {
    fill(dir, { nation: 'wi', status: 'filled', created_at: '2026-11-18T09:00:00+09:00' });
    const saved = nation.saveWeeklyReport({ from: '2026-11-17', to: '2026-11-21' }, { dataDir: dir });
    const again = nation.weeklyReport({ from: '2026-11-17', to: '2026-11-21' }, { dataDir: dir });
    const stored = rows(dir, 'nation_weekly').find((r) => r.from === '2026-11-17');
    assert.deepEqual(again.nations, stored.nations, '재계산 = 저장본');
    assert.deepEqual(saved.nations, stored.nations);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 6 + AC3: mock_portfolio.md 이관(사본 fixture) — 대사·원본 불변·테스트 행 분리 =====
test('시나리오6: 이관 — 미체결 예약 2·만료 2·연결 테스트 분리·보유 0·원본 불변·멱등', () => {
  const dir = makeTmpDir();
  const fixture = path.join(dir, 'mock_portfolio.md');
  // 원본 구조의 사본 fixture(핵심 행만 — 실파일 형식 그대로)
  fs.writeFileSync(fixture, [
    '# 모의 실전 연습 장부',
    '## 보유 (모의)',
    '- (없음)',
    '## 미체결 주문',
    '- 2026-11-25 08:3x | 위군(B-예약형) | 매수 | 알지노믹스(476830) 12주 @20,000 | 조직 00950 주문번호 0000000365 | 전일 KRX 21,650',
    '- 2026-11-25 08:3x | 위군(B-예약형) | 매수 | 씨어스(458870) 18주 @13,250 | 조직 00950 주문번호 0000000367 | 전일 KRX 14,380',
    '- (참고) 11/24 예약형 2건(0000000305, 0000000307)은 미체결로 당일 만료, 11/25 08:18 fills로 확인 후 제거',
    '## 매매 기록 (모의)',
    '- 2026-11-24 | 위군(B-예약형) | 매수 미체결 | 알지노믹스 12주 @20,000 | 당일 저가 20,900(네이버 일봉), 가격 미도달 | 0',
    '- 2026-11-24 | 위군(B-예약형) | 매수 미체결 | 씨어스 18주 @13,250 | 당일 저가 13,890(네이버 일봉), 가격 미도달 | 0',
    '- 2026-11-23 13:51 | 테스트 | 매수 후 매도 | KODEX 200 | 1 | 73,995 -> 73,965 | 연결 테스트 | -30원(수수료 포함 잔고 -50원)',
  ].join('\n'), 'utf8');
  const before = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
  try {
    const rpt = nation.migrateMockPortfolio(fixture, { dataDir: dir });
    // 원본 불변
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'), before, '원본 읽기만');
    // 미체결 예약 2건 → order_log submitted(wi) — 매복 분모
    const ol = rows(dir, 'order_log');
    const pend = ol.filter((r) => r.status === 'submitted' && r.nation === 'wi');
    assert.equal(pend.length, 2, '미체결 예약 2건');
    assert.ok(pend.some((r) => r.symbol === '476830' && r.qty === 12 && r.price === 20000 && r.broker_order_no === '0000000365'));
    // 만료 예약 2건 → cancelled(wi)
    const exp = ol.filter((r) => r.status === 'cancelled' && r.nation === 'wi');
    assert.equal(exp.length, 2, '만료 예약 2건');
    // 테스트 행 → 세력전 밖 connection_test 분리(order_log 미유입)
    const ct = rows(dir, 'connection_test');
    assert.equal(ct.length, 1);
    assert.equal(ct[0].pnl, -30);
    assert.ok(!ol.some((r) => /KODEX|069500/.test(r.symbol || '')), '테스트 행은 세력전 장부 밖');
    // 보유 0 → 나라 현금 = 배정 그대로
    const L = nation.computeLedger({ dataDir: dir }).ledgers;
    assert.equal(L.wi.cash, 500000, '미체결·만료는 현금 영향 0');
    assert.equal(L.chok.cash + L.wi.cash + L.o.cash, 2000000);
    // 리포트 대사·멱등
    assert.equal(rpt.pending, 2);
    assert.equal(rpt.expired, 2);
    assert.equal(rpt.connection_test, 1);
    assert.equal(rpt.holdings, 0);
    assert.ok(fs.existsSync(path.join(dir, 'nations', 'migration_report.md')), '이관 리포트');
    const rpt2 = nation.migrateMockPortfolio(fixture, { dataDir: dir });
    assert.equal(rpt2.skipped, true, '재이관 방지');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 7·8 + SCR AC: 대시보드 =====
test('시나리오7·8: 대시보드 — 카드·순위·기준선 초과·정합 경고·주차 전환·읽기 전용', async () => {
  const dir = makeTmpDir();
  try {
    // 체결·예약(이번 주 2026-11-24~) + 지난주(11-17~)
    fill(dir, { nation: 'chok', symbol: '000001', side: 'buy', price: 10000, qty: 10, amount: 100000, created_at: '2026-11-24T10:00:00+09:00' });
    fill(dir, { nation: 'chok', symbol: '000001', side: 'sell', price: 11000, qty: 5, amount: 55000, created_at: '2026-11-24T11:00:00+09:00' });
    fill(dir, { nation: 'wi', symbol: '000002', status: 'filled', created_at: '2026-11-18T09:00:00+09:00' });
    fill(dir, { nation: 'wi', symbol: '000003', status: 'cancelled', created_at: '2026-11-18T09:10:00+09:00' });
    // 기준선(나라별) — 1주 +2%
    ledger.append('benchmark', { id: 'b1', date: '2026-11-24', kodex_close: 10000, source: 'krx_official', missing: false, real_units: 50, real_value: 500000, real_invested: 500000, nations: { chok: { units: 100, value: 1000000, invested: 1000000 }, wi: { units: 50, value: 500000, invested: 500000 }, o: { units: 50, value: 500000, invested: 500000 } }, created_at: '2026-11-24T16:00:00+09:00' }, { dataDir: dir });
    ledger.append('benchmark', { id: 'b2', date: '2026-11-25', kodex_close: 10200, source: 'krx_official', missing: false, real_units: 50, real_value: 510000, real_invested: 500000, nations: { chok: { units: 100, value: 1020000, invested: 1000000 }, wi: { units: 50, value: 510000, invested: 500000 }, o: { units: 50, value: 510000, invested: 500000 } }, created_at: '2026-11-25T16:00:00+09:00' }, { dataDir: dir });
    nation.saveLedger({ dataDir: dir });

    const srv = await web.start({ dataDir: dir, port: 0, today: '2026-11-25' });
    try {
      const page = await get(srv.port, '/nations');
      assert.equal(page.status, 200);
      // 카드: 배정 100/50/50만 + 잔고·수익률(장부 일치)
      assert.match(page.body, /1,000,000/, '촉 배정');
      assert.match(page.body, /955,000/, '촉 현금(재계산)');
      assert.match(page.body, /0\.5\s*%|0\.50%/, '촉 수익률');
      // 기준선 초과: 촉 +0.5% − 기준 +2.0% = −1.5%p
      assert.match(page.body, /-1\.5\s*%p/, '기준선 대비 초과');
      // 순위표: 매복 성공률 — 위 50.0%(1/2), 촉·오 해당 없음(주간 2026-11-23~)
      const thisWeek = await get(srv.port, '/nations?week=2026-11-17');
      assert.match(thisWeek.body, /50\.0\s*%|50%/, '위 매복 1/2');
      assert.match(page.body, /해당 없음/, '촉·오 해당 없음');
      assert.match(page.body, /출병/, '출병 수 열');
      // 거래 0건 나라(오)도 표에 포함
      assert.match(page.body, /오/, '오나라 포함');
      // 읽기 전용 유지
      const post = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/nations' }, (res) => resolve(res.statusCode));
        req.on('error', reject); req.end();
      });
      assert.equal(post, 405, 'POST 405');
      // 현황판 링크
      const board = await get(srv.port, '/');
      assert.match(board.body, /\/nations/, '현황판에서 세력전 링크');
    } finally {
      await srv.close();
    }

    // 정합 경고 띠: 저장값 어긋남 → 페이지 경고
    const st = state.read('nation_ledger', { dataDir: dir });
    st.chok.cash += 9999;
    state.write('nation_ledger', st, { dataDir: dir });
    const srv2 = await web.start({ dataDir: dir, port: 0, today: '2026-11-25' });
    try {
      const warn = await get(srv2.port, '/nations');
      assert.match(warn.body, /장부 어긋남/, '정합성 경고 띠');
    } finally {
      await srv2.close();
    }
  } finally {
    rm(dir);
  }
});

// ===== 빈 상태 =====
test('에지: 데이터 없음 — 개전 전 안내', async () => {
  const dir = makeTmpDir();
  try {
    const srv = await web.start({ dataDir: dir, port: 0, today: '2026-11-25' });
    try {
      const page = await get(srv.port, '/nations');
      assert.match(page.body, /출병 전|개전/, '빈 상태 안내');
    } finally {
      await srv.close();
    }
  } finally {
    rm(dir);
  }
});
