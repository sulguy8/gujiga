'use strict';

// TST-005(일부 — 전수는 TSK-006) — 단일 주문 게이트 7단계 자동 테스트
// 상위: TSK-005 / ARC-003 / REQ-001~004·015 / DAT-001~003
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 공통: 실서버 호출 0(가짜 KIS 서버), 실키 열람 0(가짜 키). 실전 전송 0건 단언.
// 군사 지시: 검사 순서 고정(①STOP ②5항목 ③실전확인 ④화이트리스트·지정가 ⑤한도·하루손실
// ⑥군령3종 ⑦관직한도), 첫 차단에서 멈춤, 매도는 ①②③+지정가만, 상관은 60거래일 피어슨.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const gate = require('../src/gate');
const secret = require('../src/secret');
const state = require('../src/state');
const ledger = require('../src/ledger');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst005-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function logRows(dir) {
  const d = paths.ledgerDir(dir, 'order_log');
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}
function lastBlocked(dir) {
  const rows = logRows(dir).filter((r) => r.status === 'blocked');
  return rows[rows.length - 1];
}

// 수익률 패턴 → 종가 시계열(일봉용). KIS는 최신 먼저 반환하므로 역순 제공.
function closesFromReturns(returns, start) {
  const closes = [start || 10000];
  for (const r of returns) closes.push(closes[closes.length - 1] * (1 + r / 100));
  return closes;
}
const PAT = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1 : -1)); // ±1% 교대
function flip(pattern, k) {
  return pattern.map((v, i) => (i < k ? -v : v));
}

// 가짜 KIS 서버(게이트판): candles 맵·잔고 주입 가능. 요청 전수 기록.
function fakeKis(cfg) {
  cfg = cfg || {};
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      received.push({ path: u.pathname, ts: Date.now(), query: Object.fromEntries(u.searchParams) });
      const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/oauth2/tokenP') return reply({ access_token: 'FAKE-T', access_token_token_expired: '2026-11-26 23:59:59' });
      if (u.pathname.endsWith('inquire-balance')) {
        const b = cfg.balance || { cash: 900000, total: 1000000 };
        return reply({ rt_cd: '0', msg1: '정상', output1: [], output2: [{ dnca_tot_amt: String(b.cash), prvs_rcdl_excc_amt: String(b.cash), tot_evlu_amt: String(b.total) }] });
      }
      if (u.pathname.endsWith('itemchartprice')) {
        const sym = u.searchParams.get('FID_INPUT_ISCD');
        const closes = (cfg.candles || {})[sym];
        if (!closes) return reply({ rt_cd: '1', msg1: '일봉 없음' });
        const out = closes.map((c, i) => ({
          stck_bsop_date: String(20260101 + i), stck_oprc: String(c), stck_hgpr: String(c), stck_lwpr: String(c), stck_clpr: String(c), acml_vol: '1',
        })).reverse(); // 최신 먼저
        return reply({ rt_cd: '0', msg1: '정상', output2: out });
      }
      if (u.pathname.endsWith('order-cash')) return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '00950', ODNO: '0000117057' } });
      if (u.pathname.endsWith('inquire-daily-ccld')) {
        return reply({ rt_cd: '0', msg1: '정상', output1: cfg.noFill ? [] : [{ ord_gno_brno: '00950', odno: '0000117057', orgn_odno: '', sll_buy_dvsn_cd_name: '매수', prdt_name: 'x', ord_qty: '3', ord_unpr: '61500', tot_ccld_qty: '3', avg_prvs: '61500', rmn_qty: '0', cncl_yn: 'N', ord_tmd: '093001' }] });
      }
      if (u.pathname.endsWith('order-rvsecncl')) return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '00950', ODNO: '0000117058' } });
      reply({ rt_cd: '1', msg1: '?' });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) }));
  });
}

function setupKeys(dir) {
  const p = path.join(dir, 'fake_kis.json.enc');
  secret.encryptToFile(JSON.stringify({
    mock: { appkey: 'FK-AK-M', appsecret: 'FK-AS-M', account: '12345678' },
    real: { appkey: 'FK-AK-R', appsecret: 'FK-AS-R', account: '87654321' },
  }), p);
  return p;
}

// 표준 환경: guard·화이트리스트·관직(현령)·스냅샷
async function boot(cfg) {
  cfg = cfg || {};
  const dir = makeTmpDir();
  const keysPath = setupKeys(dir);
  state.write('guard_config', {
    id: 'default', per_order_limit_real: 200000, per_order_limit_paper: 500000,
    daily_loss_limit: -50000, stop_file_path: path.join(dir, 'STOP'),
    cash_ratio_min: 0.3, correlation_max: 0.7, sample_min: 10,
    updated_at: '2026-11-25T00:00:00+09:00',
  }, { dataDir: dir });
  state.write('watchlist', cfg.watchlist || [{ symbol: '005930', status: 'ready' }], { dataDir: dir });
  if (cfg.positions) state.write('positions', cfg.positions, { dataDir: dir });
  if (cfg.snapshot !== null) {
    ledger.append('daily_account_snapshot', Object.assign({
      id: 's1', snapshot_date: '2026-11-25', account_type: 'real',
      start_total_eval: 1000000, start_cash: 900000, created_at: '2026-11-25T08:30:30+09:00',
    }, cfg.snapshot || {}), { dataDir: dir });
  }
  for (const row of cfg.captiveRows || []) ledger.append('captive_ledger', row, { dataDir: dir });
  const mockSrv = await fakeKis(cfg.mock);
  const realSrv = await fakeKis(cfg.real);
  const opts = {
    dataDir: dir, keysPath,
    baseUrls: { mock: mockSrv.url, real: realSrv.url },
    gapMs: 5, fillPollMs: 10, fillPollMax: 40,
    now: cfg.now || '2026-11-25T09:30:00+09:00',
  };
  return { dir, mockSrv, realSrv, opts };
}
async function down(s) {
  await s.mockSrv.close(); await s.realSrv.close(); rm(s.dir);
}

// 성립 출사표(모의 매수 기본)
function draft(over) {
  return Object.assign({
    account_type: 'paper', nation: null, symbol: '005930', side: 'buy',
    entry_low: 61000, entry_high: 62000, stop_price: 59000, target_price: 66000,
    deadline: '2026-12-05', troops: 15,
    qty: 3, price: 61500, user_confirmed: true, created_by: 'human', reason: '테스트 출병',
  }, over || {});
}

// ===== 시나리오 1: STOP → stop_file (복수 위반 시 첫 단계 우선) =====
test('시나리오1: STOP 파일 → stop_file 차단(검사 순서 1위)', async () => {
  const s = await boot();
  try {
    fs.writeFileSync(path.join(s.dir, 'STOP'), '');
    // 5항목 누락 + 실전 미확인까지 겹쳐도 첫 단계인 stop_file이 기록돼야 한다
    const r = await gate.submit(draft({ account_type: 'real', user_confirmed: false, stop_price: null }), s.opts);
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'stop_file');
    assert.equal(lastBlocked(s.dir).block_reason, 'stop_file', '첫 차단 사유 기록');
    assert.equal(s.realSrv.received.length + s.mockSrv.received.length, 0, '전송 0');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 2: 5항목 누락 → draft_invalid =====
test('시나리오2: 손절선 빠진 출사표 → draft_invalid(REQ-001 거부)', async () => {
  const s = await boot();
  try {
    const r = await gate.submit(draft({ stop_price: null }), s.opts);
    assert.equal(r.blocked, true);
    assert.match(r.reason, /draft_invalid/);
    assert.match(lastBlocked(s.dir).block_reason, /draft_invalid/);
  } finally {
    await down(s);
  }
});

// ===== 시나리오 3 + AC1: 실전 user_confirmed=false → no_confirm·전송 0 =====
test('시나리오3(AC1): AI 출사표(user_confirmed=false) 실전 submit → no_confirm·전송 0건', async () => {
  const s = await boot();
  try {
    const r = await gate.submit(draft({ account_type: 'real', user_confirmed: false, created_by: 'ai' }), s.opts);
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'no_confirm');
    const row = lastBlocked(s.dir);
    assert.equal(row.block_reason, 'no_confirm');
    assert.equal(s.realSrv.received.length, 0, '실전 전송 0건');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 4·5: 화이트리스트·지정가 =====
test('시나리오4·5: 화이트리스트 밖 실전 매수 / 시장가 → not_whitelisted·market_order', async () => {
  const s = await boot();
  try {
    const wl = await gate.submit(draft({ account_type: 'real', symbol: '999999', entry_low: 61000, entry_high: 62000 }), s.opts);
    assert.equal(wl.reason, 'not_whitelisted');
    const mk = await gate.submit(draft({ account_type: 'real', price: 0 }), s.opts);
    assert.equal(mk.reason, 'market_order');
    assert.equal(s.realSrv.received.length, 0);
  } finally {
    await down(s);
  }
});

// ===== 시나리오 6: 1회 한도(매수만) + 경계 통과 =====
test('시나리오6: 한도 초과 차단·경계(정확 한도)는 통과·매도는 한도 미적용', async () => {
  const s = await boot();
  try {
    // 모의 500,001원 차단
    const over = await gate.submit(draft({ qty: 1, price: 500001 }), s.opts);
    assert.equal(over.reason, 'per_order_limit');
    assert.ok(lastBlocked(s.dir).amount === 500001, '수치 기록');
    // 실전 200,001원 차단
    const realOver = await gate.submit(draft({ account_type: 'real', qty: 1, price: 200001 }), s.opts);
    assert.equal(realOver.reason, 'per_order_limit');
    // 실전 정확 200,000원 — 게이트 7단계는 전부 통과(이후 어댑터 실전 비활성에서 멈춤 = 검사 통과 증명)
    const edge = await gate.submit(draft({ account_type: 'real', qty: 1, price: 200000 }), s.opts);
    assert.notEqual(edge.blocked, true, '경계 200,000원은 게이트 통과');
    assert.match(edge.error || '', /비활성|TSK-012/, '실전 전송은 어댑터 비활성(전송 0 유지)');
    assert.equal(s.realSrv.received.filter((r) => r.path.endsWith('order-cash')).length, 0, '실전 주문 전송 0');
    // 매도는 한도 미적용(모의 60만원 매도 접수)
    const sell = await gate.submit(draft({ side: 'sell', qty: 10, price: 61500, stop_price: 59000, target_price: 66000 }), s.opts);
    assert.notEqual(sell.blocked, true, '매도는 한도 검사 없음');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 7: 하루 손실(실전 매수만) + 경계 + 매도 허용 =====
test('시나리오7: -50,000원 도달 실전 매수 차단·-49,999 허용·매도는 허용', async () => {
  // 시작 1,050,000 → 현재 1,000,000 = -50,000 → 차단
  const s = await boot({ snapshot: { start_total_eval: 1050000 }, real: { balance: { cash: 900000, total: 1000000 } } });
  try {
    const r = await gate.submit(draft({ account_type: 'real' }), s.opts);
    assert.equal(r.reason, 'daily_loss');
    assert.equal(lastBlocked(s.dir).block_reason, 'daily_loss');
    // 매도는 하루 손실 상태에도 허용(성벽 퇴각 보장) — 게이트 통과(어댑터 비활성에서 멈춤)
    const sell = await gate.submit(draft({ account_type: 'real', side: 'sell' }), s.opts);
    assert.notEqual(sell.blocked, true, '매도 허용');
  } finally {
    await down(s);
  }
  // 경계: -49,999원이면 매수 진행(다음 단계로)
  const s2 = await boot({ snapshot: { start_total_eval: 1049999 }, real: { balance: { cash: 900000, total: 1000000 } } });
  try {
    const r2 = await gate.submit(draft({ account_type: 'real' }), s2.opts);
    assert.notEqual(r2.reason, 'daily_loss', '-49,999원은 하루 손실 아님');
  } finally {
    await down(s2);
  }
});

// ===== 지시6: 당일 스냅샷 자동 보완(08:30 이후) / 이전·실패는 차단 =====
test('지시6: 스냅샷 없으면 08:30 이후 첫 잔고로 생성, 08:30 이전은 차단', async () => {
  // 08:30 이후 + 스냅샷 없음 → 잔고로 생성 후 진행
  const s = await boot({ snapshot: null, real: { balance: { cash: 900000, total: 1000000 } } });
  try {
    const r = await gate.submit(draft({ account_type: 'real' }), Object.assign({}, s.opts, { now: '2026-11-25T09:00:00+09:00' }));
    assert.notEqual(r.reason, 'no_snapshot', '스냅샷 자동 생성으로 통과');
    const snapDir = paths.ledgerDir(s.dir, 'daily_account_snapshot');
    const rows = fs.readdirSync(snapDir).flatMap((f) => fs.readFileSync(path.join(snapDir, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
    const today = rows.find((x) => x.snapshot_date === '2026-11-25' && x.account_type === 'real');
    assert.ok(today, '스냅샷 기록 생성');
    assert.equal(today.start_total_eval, 1000000, '첫 잔고 값으로');
  } finally {
    await down(s);
  }
  // 08:30 이전 → 차단
  const s2 = await boot({ snapshot: null });
  try {
    const r2 = await gate.submit(draft({ account_type: 'real' }), Object.assign({}, s2.opts, { now: '2026-11-25T08:00:00+09:00' }));
    assert.equal(r2.reason, 'no_snapshot', '08:30 이전 차단');
  } finally {
    await down(s2);
  }
});

// ===== 시나리오 8: 군량 30% — 29.99% 차단 / 30.0% 통과 =====
test('시나리오8: 매수 후 현금 29.99% 차단·30.0% 통과(수치 기록)', async () => {
  // amount 184,500. cash 484,400 → after 299,900 (29.99%) 차단
  const s = await boot({ mock: { balance: { cash: 484400, total: 1000000 } } });
  try {
    const r = await gate.submit(draft(), s.opts);
    assert.equal(r.reason, 'ration30');
    const row = lastBlocked(s.dir);
    assert.equal(row.block_reason, 'ration30');
    assert.ok(JSON.stringify(row.detail).includes('29.9'), '현금 비중 수치 기록');
  } finally {
    await down(s);
  }
  // cash 484,500 → after 300,000 (정확 30.0%) 통과 → 체결까지
  const s2 = await boot({ mock: { balance: { cash: 484500, total: 1000000 } } });
  try {
    const r2 = await gate.submit(draft(), s2.opts);
    assert.equal(r2.ok, true, '30.0%는 통과·접수');
  } finally {
    await down(s2);
  }
});

// ===== 시나리오 9: 복수 매매 — 당일 포로 발생 시 매수 차단·매도 허용 =====
test('시나리오9: 당일 확정 손실 후 신규 매수 revenge 차단·매도는 허용', async () => {
  const captive = [{ id: 'c1', account_type: 'paper', trade_date: '2026-11-25', order_log_id: 'o', realized_pnl: -10000, loss_outstanding_after: 10000, captives_after: 1, merit_delta: 0, merit_total_after: 0, created_at: '2026-11-25T10:00:00+09:00' }];
  const s = await boot({ captiveRows: captive });
  try {
    const r = await gate.submit(draft(), s.opts);
    assert.equal(r.reason, 'revenge');
    const sell = await gate.submit(draft({ side: 'sell' }), s.opts);
    assert.equal(sell.ok, true, '매도 허용');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 10 + 지시4: 상관 0.7 피어슨(60거래일) =====
test('시나리오10: 보유 종목과 고상관 매수 차단·저상관 통과·표본 부족 기록·데이터 불가 차단', async () => {
  const closesA = closesFromReturns(PAT);            // 61개(60수익률)
  const closesSame = closesFromReturns(flip(PAT, 3)); // r≈0.9 — 차단
  const closesLow = closesFromReturns(flip(PAT, 20)); // r≈0.33 — 통과
  const positions = [{ id: 'p1', account_type: 'paper', symbol: '000660', qty: 1, avg_price: 10000, stop_price: 9000, target_price: 12000, deadline: '2026-12-10', status: 'open' }];

  // (a) 고상관 차단 + 상관계수 수치 기록
  const s = await boot({ positions, mock: { candles: { '005930': closesSame, '000660': closesA } } });
  try {
    const r = await gate.submit(draft(), s.opts);
    assert.equal(r.reason, 'correlation');
    assert.ok(JSON.stringify(lastBlocked(s.dir).detail).match(/0\.[89]/), '상관계수 수치 기록');
  } finally {
    await down(s);
  }
  // (b) 저상관 통과
  const s2 = await boot({ positions, mock: { candles: { '005930': closesLow, '000660': closesA } } });
  try {
    const r2 = await gate.submit(draft(), s2.opts);
    assert.equal(r2.ok, true, '저상관 통과');
  } finally {
    await down(s2);
  }
  // (c) 표본 부족(40거래일): 가용 기간으로 계산 + sample_insufficient 기록
  const shortA = closesFromReturns(PAT.slice(0, 40));
  const shortSame = closesFromReturns(flip(PAT.slice(0, 40), 2));
  const s3 = await boot({ positions, mock: { candles: { '005930': shortSame, '000660': shortA } } });
  try {
    const r3 = await gate.submit(draft(), s3.opts);
    assert.equal(r3.reason, 'correlation', '40일치로도 차단 기준 동일');
    assert.ok(JSON.stringify(lastBlocked(s3.dir).detail).includes('sample_insufficient'), '표본 부족 기록');
  } finally {
    await down(s3);
  }
  // (d) 일봉 데이터 불가 → 매수 차단(안전 쪽)
  const s4 = await boot({ positions, mock: { candles: { '000660': closesA } } }); // 005930 없음
  try {
    const r4 = await gate.submit(draft(), s4.opts);
    assert.equal(r4.reason, 'correlation');
    assert.ok(JSON.stringify(lastBlocked(s4.dir).detail).includes('data_unavailable'), '데이터 불가 기록');
  } finally {
    await down(s4);
  }
});

// ===== 시나리오 11: 관직 한도(실전)·세력전 한도(모의 nation) =====
test('시나리오11: 현령 한 종목 20만 초과·3번째 종목 → nation_limit', async () => {
  // 실전: 보유 005930 10만원 + 신규 11만원 = 21만원 > 현령 20만
  const posReal = [{ id: 'p1', account_type: 'real', symbol: '005930', qty: 10, avg_price: 10000, stop_price: 9000, target_price: 12000, deadline: '2026-12-10', status: 'open' }];
  const s = await boot({ positions: posReal, real: { balance: { cash: 900000, total: 1000000 }, candles: { '005930': closesFromReturns(PAT) } } });
  try {
    const r = await gate.submit(draft({ account_type: 'real', qty: 2, price: 55000 }), s.opts); // 11만원 추가
    assert.equal(r.reason, 'nation_limit');
  } finally {
    await down(s);
  }
  // 실전: 동시 2종목 보유 중 3번째 종목
  const pos2 = [
    { id: 'p1', account_type: 'real', symbol: '000001', qty: 1, avg_price: 10000, stop_price: 9000, target_price: 12000, deadline: '2026-12-10', status: 'open' },
    { id: 'p2', account_type: 'real', symbol: '000002', qty: 1, avg_price: 10000, stop_price: 9000, target_price: 12000, deadline: '2026-12-10', status: 'open' },
  ];
  const lowB = closesFromReturns(flip(PAT, 20));
  const s2 = await boot({
    positions: pos2,
    real: { balance: { cash: 900000, total: 1000000 }, candles: { '005930': lowB, '000001': closesFromReturns(PAT, 5000), '000002': closesFromReturns(flip(PAT, 30), 7000) } },
  });
  try {
    const r2 = await gate.submit(draft({ account_type: 'real', qty: 1, price: 100000 }), s2.opts);
    assert.equal(r2.reason, 'nation_limit', '3번째 종목 차단');
  } finally {
    await down(s2);
  }
});

// ===== 시나리오 12 + AC4: 통과 대조군 — 모의 접수 + 체결조회(10초/1분 정책) 결과까지 기록 =====
test('시나리오12(AC4): 정상 모의 주문 접수 → 체결조회 결과까지 order_log 기록', async () => {
  const s = await boot();
  try {
    const r = await gate.submit(draft(), s.opts);
    assert.equal(r.ok, true);
    assert.equal(r.result.odno, '0000117057');
    assert.equal(r.fill && r.fill.filled, 3, '체결 확인');
    const rows = logRows(s.dir).filter((x) => x.symbol === '005930' && x.status !== 'blocked');
    assert.equal(rows.length, 1, '최종 1행');
    assert.equal(rows[0].status, 'filled', '체결 상태 기록');
    assert.equal(rows[0].broker_order_no, '0000117057');
    assert.ok(rows[0].filled_at, 'filled_at 기록');
    assert.ok(rows[0].confirmed === true && rows[0].reason === '테스트 출병', 'confirmed·reason 기록');
    // 체결조회 호출이 일어났는지(가짜 서버)
    assert.ok(s.mockSrv.received.some((x) => x.path.endsWith('inquire-daily-ccld')), '체결조회 수행');
  } finally {
    await down(s);
  }
  // 미체결이면 submitted로 기록(폴링 한도까지 시도)
  const s2 = await boot({ mock: { noFill: true } });
  s2.opts.fillPollMs = 20;
  s2.opts.fillPollMax = 400;
  try {
    const r2 = await gate.submit(draft(), s2.opts);
    assert.equal(r2.ok, true);
    const rows2 = logRows(s2.dir).filter((x) => x.status !== 'blocked');
    assert.equal(rows2[0].status, 'submitted', '미체결은 submitted');
    assert.ok(s2.mockSrv.received.filter((x) => x.path.endsWith('inquire-daily-ccld')).length >= 2, '폴링 반복');
  } finally {
    await down(s2);
  }
});

// ===== AC3/지시1: 어댑터 주문 함수는 gate 밖에서 호출 불가(정규식 검사) =====
test('AC3: kis_adapter는 gate만 require하고, 주문 호출(.order/.modify/.cancel)은 gate 밖에 없다', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    if (f !== 'gate.js') {
      assert.ok(!/require\(['"]\.\/kis_adapter['"]\)/.test(src), `${f}: kis_adapter 직접 require 금지(gate만 허용)`);
    }
    if (f !== 'gate.js' && f !== 'kis_adapter.js') {
      assert.ok(!/\.(order|modify|cancel)\s*\(/.test(src), `${f}: 어댑터 주문류 호출 금지`);
    }
  }
  // bin도 검사
  const binDir = path.join(__dirname, '..', 'bin');
  for (const f of fs.readdirSync(binDir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(binDir, f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/src\/kis_adapter['"]\)/.test(src), `bin/${f}: kis_adapter 직접 require 금지`);
  }
});
