'use strict';

// 출사표 002 — 그림자 배선(기준선 적립·주간 초과수익·회군 감지)
// 짝: TST-017(그림자)·TST-018(회군)·TST-021(기준선). 실서버·실키·실claude 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const shadow = require('../src/shadow');
const benchmark = require('../src/benchmark');
const hyp = require('../src/hypothesis');
const secret = require('../src/secret');
const state = require('../src/state');
const ledger = require('../src/ledger');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-ord002-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function rows(dir, name) {
  const d = paths.ledgerDir(dir, name);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
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
      if (u.pathname.endsWith('inquire-investor-daily-by-market')) {
        return reply({ rt_cd: '0', output: [{ stck_bsop_date: '20261124', frgn_ntby_tr_pbmn: '1200' }, { stck_bsop_date: '20261123', frgn_ntby_tr_pbmn: '-500' }] });
      }
      if (u.pathname.endsWith('inquire-daily-indexchartprice')) {
        const out = Array.from({ length: 25 }, (_, i) => ({ stck_bsop_date: String(20261001 + i), bstp_nmix_prpr: String(5300 - i * 12), acml_vol: '1' }));
        out[0].bstp_nmix_prpr = '5006.03';
        return reply({ rt_cd: '0', output2: out });
      }
      reply({ rt_cd: '1', msg1: '?' });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) })));
}

function writeFakeCli(dir) {
  const p = path.join(dir, 'fake.js');
  fs.writeFileSync(p, [
    "const fs=require('fs');",
    "let input=''; try{input=fs.readFileSync(0,'utf8');}catch(e){}",
    "process.stdout.write(JSON.stringify({market_lines:['x'],today_actions:['y']}));",
  ].join('\n'), 'utf8');
  return p;
}

async function boot() {
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({
    mock: { appkey: 'FA', appsecret: 'FS', account: '12345678' },
    real: { appkey: 'FAR', appsecret: 'FSR', account: '87654321' },
  }), keysPath);
  const kisSrv = await fakeKis();
  const cli = writeFakeCli(dir);
  state.write('reentry_record', { sox_base_low: 8408.59, sox_base_low_date: '2026-11-10', sox_recent3_low: 8657.78 }, { dataDir: dir });
  state.write('signal_inputs', { event_within_2d: true }, { dataDir: dir });
  state.write('positions', [], { dataDir: dir });
  fs.mkdirSync(path.join(dir, 'market_cache'), { recursive: true });
  for (const d of ['2026-11-23', '2026-11-24', '2026-11-25']) {
    fs.writeFileSync(path.join(dir, 'market_cache', `overnight_${d}.json`),
      JSON.stringify({ us_summary: { sp500: -0.8, nasdaq: -1.4, sox: 8832.5, vix: 26.36 }, night_future_pct: -4.56, source: 'websearch' }), 'utf8');
  }
  const osSent = [];
  const quotes = { '005930': 11000 };
  const opts = {
    dataDir: dir, keysPath,
    baseUrls: { mock: kisSrv.url, real: kisSrv.url }, gapMs: 5,
    naverBase: 'http://127.0.0.1:1',
    providers: {
      quote: (sym) => {
        if (!(sym in quotes)) throw new Error('시세 없음');
        return { symbol: sym, price: quotes[sym] };
      },
      accountSnapshot: (acct) => ({ account_type: acct, start_total_eval: 1000000, start_cash: 900000 }),
    },
    strategistOpts: {
      dataDir: dir, claudeBin: process.execPath, claudeArgsPrefix: [cli],
      config: { daily_max: 8, breakdown: {}, owner_chat_counts_separately: true },
      today: '2026-11-25',
    },
    notifyOpts: {
      dataDir: dir,
      config: { channels: { os: true, telegram: false } },
      osSender: (p) => osSent.push(p),
    },
  };
  return { dir, kisSrv, osSent, quotes, opts };
}
async function down(s) { await s.kisSrv.close(); rm(s.dir); }
function at(s, time, date) {
  return Object.assign({}, s.opts, { now: `${date || '2026-11-25'}T${time}+09:00` });
}

// ===== 배선 1: 기준선 일일 적립(멱등·결측·자동 flow 0) =====
test('배선1: 08:31 회차에 benchmark 1행 적립·멱등·결측 표시', async () => {
  const s = await boot();
  try {
    s.opts.providers.kodexClose = () => ({ date: '2026-11-24', close: 10000, source: 'krx_official' });
    await shadow.runOnce(at(s, '08:31:30'));
    let b = rows(s.dir, 'benchmark');
    assert.equal(b.length, 1, '기준선 1행');
    assert.equal(b[0].date, '2026-11-24');
    assert.equal(b[0].real_value, 500000);
    await shadow.runOnce(at(s, '08:40:00'));
    assert.equal(rows(s.dir, 'benchmark').length, 1, '멱등');
    // 결측 경로(직접): 직전 종가 유지 + missing
    benchmark.recordDay({ date: '2026-11-25', close: null, missing: true }, { dataDir: s.dir });
    const b2 = rows(s.dir, 'benchmark');
    assert.equal(b2[1].missing, true);
    assert.equal(b2[1].kodex_close, 10000);
  } finally {
    await down(s);
  }
});

// ===== 배선 1b: 미설명 '현금' 입금 감지(출사표 003 — 예수금 기준) =====
test('배선1b: 예수금 +20만(미설명) → flow_pending 기록만·benchmark_flows 자동 0·멱등', async () => {
  const s = await boot();
  try {
    ledger.append('daily_account_snapshot', { id: 'p0', snapshot_date: '2026-11-24', account_type: 'real', start_total_eval: 1000000, start_cash: 900000, created_at: '2026-11-24T08:30:00+09:00' }, { dataDir: s.dir });
    s.opts.providers.accountSnapshot = (acct) => ({ account_type: acct, start_total_eval: 1200000, start_cash: acct === 'real' ? 1100000 : 900000 });
    await shadow.runOnce(at(s, '08:31:30'));
    const fp = rows(s.dir, 'flow_pending');
    assert.equal(fp.length, 1, '감지 1건');
    assert.equal(fp[0].amount, 200000, '현금 기준 +20만');
    assert.equal(fp[0].status, 'awaiting_confirm');
    const st = state.read('benchmark_flows', { dataDir: s.dir });
    assert.ok(!st || st.items.length === 0, '자동 recordFlow 0');
    await shadow.runOnce(at(s, '08:45:00'));
    assert.equal(rows(s.dir, 'flow_pending').length, 1, '멱등');
  } finally {
    await down(s);
  }
});

// ===== 배선 1c: 체결 현금 흐름(order_log)으로 설명되면 감지 0 =====
test('배선1c: 매도 대금으로 설명되는 예수금 증가는 flow_pending 미기록', async () => {
  const s = await boot();
  try {
    ledger.append('daily_account_snapshot', { id: 'p0', snapshot_date: '2026-11-24', account_type: 'real', start_total_eval: 1000000, start_cash: 900000, created_at: '2026-11-24T08:30:00+09:00' }, { dataDir: s.dir });
    ledger.append('order_log', { id: 'o1', account_type: 'real', symbol: '005930', side: 'sell', order_type: 'limit', price: 20000, qty: 10, amount: 200000, status: 'filled', block_reason: null, broker_order_no: 'X', filled_at: '2026-11-24T10:00:00+09:00', created_at: '2026-11-24T10:00:00+09:00' }, { dataDir: s.dir });
    s.opts.providers.accountSnapshot = (acct) => ({ account_type: acct, start_total_eval: 1000000, start_cash: acct === 'real' ? 1100000 : 900000 });
    await shadow.runOnce(at(s, '08:31:30'));
    assert.equal(rows(s.dir, 'flow_pending').length, 0, '매도 대금 설명 — 감지 0');
  } finally {
    await down(s);
  }
});

// ===== 배선 2: 월요일 주간 초과수익·4주 경고 =====
test('배선2: 월요일 직전 주 초과수익 -1.0%p 적립·4주 연속 경고·멱등·화요일 미실행', async () => {
  const s = await boot();
  try {
    ledger.append('benchmark', { id: 'b1', date: '2026-11-17', kodex_close: 10000, source: 'krx_official', missing: false, real_units: 50, real_value: 500000, real_invested: 500000, nations: {}, created_at: '2026-11-17T16:00:00+09:00' }, { dataDir: s.dir });
    ledger.append('benchmark', { id: 'b2', date: '2026-11-21', kodex_close: 10200, source: 'krx_official', missing: false, real_units: 50, real_value: 510000, real_invested: 500000, nations: {}, created_at: '2026-11-21T16:00:00+09:00' }, { dataDir: s.dir });
    ledger.append('daily_account_snapshot', { id: 'w1', snapshot_date: '2026-11-17', account_type: 'real', start_total_eval: 500000, start_cash: 500000, created_at: '2026-11-17T08:30:00+09:00' }, { dataDir: s.dir });
    ledger.append('daily_account_snapshot', { id: 'w2', snapshot_date: '2026-11-21', account_type: 'real', start_total_eval: 505000, start_cash: 400000, created_at: '2026-11-21T08:30:00+09:00' }, { dataDir: s.dir });
    state.write('weekly_excess', { values: [-0.5, -1.2, -0.3] }, { dataDir: s.dir });

    const r = await shadow.runOnce(at(s, '08:36:00', '2026-11-23'));
    assert.ok(r.ran.includes('weekly_monday'), '월요일 집계 실행');
    const we = state.read('weekly_excess', { dataDir: s.dir });
    assert.equal(we.values.length, 4);
    assert.ok(Math.abs(we.values[3] - -1.0) < 0.01, '수기: 우리 +1% - 기준 +2% = -1.0%p');
    assert.equal(rows(s.dir, 'weekly_excess_log').length, 1);
    assert.ok(s.osSent.some((e) => /지수/.test(JSON.stringify(e))), '4주 연속 경고 알림');
    // 멱등 + 화요일 미실행
    await shadow.runOnce(at(s, '09:00:00', '2026-11-23'));
    assert.equal(rows(s.dir, 'weekly_excess_log').length, 1, '멱등');
    const r2 = await shadow.runOnce(at(s, '08:36:00', '2026-11-24'));
    assert.ok(!r2.ran.includes('weekly_monday'), '화요일 미실행');
  } finally {
    await down(s);
  }
});

// ===== 배선 3: 매도 체결 감지 → closeTrade(shadow)·멱등 키 =====
test('배선3: 매도 체결로 포지션 0 → close·trade_result(shadow)·대기 증거·captive 0·멱등', async () => {
  const s = await boot();
  try {
    const h = hyp.register({ code: 'W1', category: 'B', statement: 'x → y' }, { dataDir: s.dir });
    state.write('positions', [
      { id: 'p1', account_type: 'paper', symbol: '005930', name: '삼성전자', qty: 10, avg_price: 10000, stop_price: 9500, target_price: 12000, deadline: '2026-12-10', status: 'open', hypothesis_ids: [h.id] },
    ], { dataDir: s.dir });
    s.opts.providers.fills = () => [
      { odno: 'F-001', symbol: '005930', side: 'sell', filled: 10, avgFill: 10500, remain: 0 },
    ];
    await shadow.runOnce(at(s, '10:00:10'));
    const pos = state.read('positions', { dataDir: s.dir });
    assert.equal(pos[0].status, 'closed', '포지션 close');
    const tr = rows(s.dir, 'trade_result');
    assert.equal(tr.length, 1);
    assert.equal(tr[0].pnl, 5000, '(10500-10000)×10 = 5,000원');
    assert.equal(tr[0].shadow, true);
    assert.equal(tr[0].close_key, 'F-001', '멱등 키=주문번호');
    assert.equal(rows(s.dir, 'captive_ledger').length, 0, '그림자 captive 0');
    assert.equal(hyp.pendingJudgments({ dataDir: s.dir }).length, 1, '인용 가설 판정 대기');
    await shadow.runOnce(at(s, '10:05:20'));
    assert.equal(rows(s.dir, 'trade_result').length, 1, '멱등');
  } finally {
    await down(s);
  }
});

// ===== 배선 3b: 기한 만료 → 15:06 회차에서 같은 경로(이행 실패) =====
test('배선3b: deadline 경과 미매도 → 15:06에 closeTrade(기한 이행 실패)·멱등', async () => {
  const s = await boot();
  try {
    state.write('positions', [
      { id: 'p1', account_type: 'paper', symbol: '005930', name: '삼성전자', qty: 10, avg_price: 10000, stop_price: 9500, target_price: 12000, deadline: '2026-11-24', status: 'open', hypothesis_ids: [] },
    ], { dataDir: s.dir });
    s.quotes['005930'] = 10250;
    await shadow.runOnce(at(s, '15:06:00'));
    const tr = rows(s.dir, 'trade_result');
    assert.equal(tr.length, 1, '기한 만료 회군 기록');
    assert.equal(tr[0].wall_deadline_respected, false, '기한 이행 실패');
    assert.equal(tr[0].pnl, 2500, '(10250-10000)×10');
    assert.match(tr[0].close_key, /deadline/, '만료 멱등 키');
    const pos = state.read('positions', { dataDir: s.dir });
    assert.equal(pos[0].status, 'closed');
    assert.equal(pos[0].closed_reason, 'deadline_expired');
    await shadow.runOnce(at(s, '15:08:00'));
    assert.equal(rows(s.dir, 'trade_result').length, 1, '멱등');
  } finally {
    await down(s);
  }
});
