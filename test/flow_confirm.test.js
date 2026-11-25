'use strict';

// 출사표 003 — 체결 pdno·현금 기준 입금 감지·flow_pending 확인 화면
// 짝: TST-003(어댑터)·TST-017(그림자)·TST-021(기준선). 실서버·실키·실claude 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const shadow = require('../src/shadow');
const benchmark = require('../src/benchmark');
const gatekeeper = require('../src/gatekeeper');
const web = require('../src/web');
const secret = require('../src/secret');
const state = require('../src/state');
const ledger = require('../src/ledger');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-ord003-')); }
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
function post(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: p,
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: `http://127.0.0.1:${port}` }, headers || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// 그림자 환경(현금 감지·pdno 스킵용 — 최소 구성)
async function bootShadow(snapshotProvider) {
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({
    mock: { appkey: 'FA', appsecret: 'FS', account: '12345678' },
    real: { appkey: 'FAR', appsecret: 'FSR', account: '87654321' },
  }), keysPath);
  // KIS·overnight: council이 결측으로 선진행하도록 접속 불가 주소
  state.write('reentry_record', { sox_base_low: 8408.59, sox_recent3_low: 8657.78 }, { dataDir: dir });
  state.write('positions', [], { dataDir: dir });
  fs.mkdirSync(path.join(dir, 'market_cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'market_cache', 'overnight_2026-11-25.json'),
    JSON.stringify({ us_summary: { sp500: 0, nasdaq: 0, sox: 8800, vix: 25 }, night_future_pct: 0, source: 'websearch' }), 'utf8');
  const cli = path.join(dir, 'cli.js');
  fs.writeFileSync(cli, "process.stdout.write(JSON.stringify({market_lines:['x'],today_actions:['y']}))", 'utf8');
  const opts = {
    dataDir: dir, keysPath,
    baseUrls: { mock: 'http://127.0.0.1:1', real: 'http://127.0.0.1:1' }, gapMs: 5,
    naverBase: 'http://127.0.0.1:1',
    now: '2026-11-25T08:31:30+09:00',
    providers: {
      quote: () => { throw new Error('없음'); },
      accountSnapshot: snapshotProvider,
    },
    strategistOpts: { dataDir: dir, claudeBin: process.execPath, claudeArgsPrefix: [cli], config: { daily_max: 8, breakdown: {} }, today: '2026-11-25' },
    notifyOpts: { dataDir: dir, config: { channels: { os: false, telegram: false } } },
  };
  return { dir, opts };
}

// ===== 2. 현금 기준 입금 감지 =====
test('현금 기준: 예수금 +20만(체결 설명 없음) → flow_pending·자동 확정 0·멱등', async () => {
  const s = await bootShadow((acct) => ({ account_type: acct, start_total_eval: 1200000, start_cash: 1100000 }));
  try {
    ledger.append('daily_account_snapshot', { id: 'p0', snapshot_date: '2026-11-24', account_type: 'real', start_total_eval: 1000000, start_cash: 900000, created_at: '2026-11-24T08:30:00+09:00' }, { dataDir: s.dir });
    await shadow.runOnce(s.opts);
    const fp = rows(s.dir, 'flow_pending');
    assert.equal(fp.length, 1, '감지 1건');
    assert.equal(fp[0].amount, 200000, '현금 +20만');
    assert.equal(fp[0].status, 'awaiting_confirm');
    const st = state.read('benchmark_flows', { dataDir: s.dir });
    assert.ok(!st || st.items.length === 0, '자동 recordFlow 0');
    await shadow.runOnce(Object.assign({}, s.opts, { now: '2026-11-25T08:45:00+09:00' }));
    assert.equal(rows(s.dir, 'flow_pending').length, 1, '멱등');
  } finally {
    rm(s.dir);
  }
});

test('현금 기준: 평가손익만 변한 날(현금 동일) → 감지 0', async () => {
  const s = await bootShadow((acct) => ({ account_type: acct, start_total_eval: 1200000, start_cash: 900000 }));
  try {
    ledger.append('daily_account_snapshot', { id: 'p0', snapshot_date: '2026-11-24', account_type: 'real', start_total_eval: 1000000, start_cash: 900000, created_at: '2026-11-24T08:30:00+09:00' }, { dataDir: s.dir });
    await shadow.runOnce(s.opts);
    assert.equal(rows(s.dir, 'flow_pending').length, 0, '총평가 +20만이어도 현금 불변 — 감지 0(군사 검토 반영)');
  } finally {
    rm(s.dir);
  }
});

test('현금 기준: 체결 현금 흐름(매도 대금)으로 설명되면 감지 0', async () => {
  const s = await bootShadow((acct) => ({ account_type: acct, start_total_eval: 1000000, start_cash: 1005000 }));
  try {
    ledger.append('daily_account_snapshot', { id: 'p0', snapshot_date: '2026-11-24', account_type: 'real', start_total_eval: 1000000, start_cash: 900000, created_at: '2026-11-24T08:30:00+09:00' }, { dataDir: s.dir });
    // 11-24 매도 체결 10.5만(현금 +) — order_log로 설명
    ledger.append('order_log', { id: 'o1', account_type: 'real', symbol: '005930', side: 'sell', order_type: 'limit', price: 10500, qty: 10, amount: 105000, status: 'filled', block_reason: null, broker_order_no: 'X', filled_at: '2026-11-24T10:00:00+09:00', created_at: '2026-11-24T10:00:00+09:00' }, { dataDir: s.dir });
    await shadow.runOnce(s.opts);
    assert.equal(rows(s.dir, 'flow_pending').length, 0, '매도 대금으로 설명 — 감지 0');
  } finally {
    rm(s.dir);
  }
});

// ===== 1. pdno 없는 체결 행 — 회군 감지 건너뛰고 기록 =====
test('pdno: 종목코드 없는 체결 행은 회군 감지 스킵 + 기록(포지션 불변)', async () => {
  const s = await bootShadow((acct) => ({ account_type: acct, start_total_eval: 1000000, start_cash: 900000 }));
  try {
    state.write('positions', [
      { id: 'p1', account_type: 'paper', symbol: '005930', name: '삼성전자', qty: 10, avg_price: 10000, stop_price: 9500, target_price: 12000, deadline: '2026-12-10', status: 'open', hypothesis_ids: [] },
    ], { dataDir: s.dir });
    s.opts.providers.fills = () => [
      { odno: 'NOPD-1', symbol: null, side: 'sell', filled: 10, avgFill: 10500, remain: 0 },
    ];
    await shadow.runOnce(Object.assign({}, s.opts, { now: '2026-11-25T10:00:00+09:00' }));
    const pos = state.read('positions', { dataDir: s.dir });
    assert.equal(pos[0].status, 'open', '매칭 불가 — 포지션 불변');
    assert.equal(rows(s.dir, 'trade_result').length, 0, '회군 기록 0');
    const notes = rows(s.dir, 'shadow_job_log').filter((r) => r.job === 'retreat_watch' && r.status === 'note');
    assert.ok(notes.length >= 1, '스킵 기록');
    assert.match(JSON.stringify(notes[0]), /NOPD-1/, '해당 주문번호 기록');
    // 스킵 기록 멱등(같은 행 반복 기록 안 함)
    await shadow.runOnce(Object.assign({}, s.opts, { now: '2026-11-25T10:06:00+09:00' }));
    assert.equal(rows(s.dir, 'shadow_job_log').filter((r) => r.job === 'retreat_watch' && r.status === 'note').length, notes.length, '스킵 기록 멱등');
  } finally {
    rm(s.dir);
  }
});

// ===== 3. flow_pending 확인 화면(관문 62910) =====
async function bootGate() {
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({ mock: { appkey: 'a', appsecret: 'b', account: '12345678' }, real: { appkey: 'c', appsecret: 'd', account: '87654321' } }), keysPath);
  ledger.append('flow_pending', {
    id: 'FP-1', date: '2026-11-25', amount: 200000,
    prev_cash: 900000, today_cash: 1100000, explained_cash: 0,
    status: 'awaiting_confirm', note: '입출금 추정', created_at: '2026-11-25T08:31:00+09:00',
  }, { dataDir: dir });
  const tokenFile = path.join(dir, 'gate.token');
  const gate = await gatekeeper.start({ dataDir: dir, keysPath, port: 0, tokenFile, baseUrls: { mock: 'http://127.0.0.1:1', real: 'http://127.0.0.1:1' } });
  return { dir, gate };
}

test('확인 화면: GET /flows 목록·CSRF → confirm 시 recordFlow·결정 기록·목록 제외', async () => {
  const s = await bootGate();
  try {
    const page = await get(s.gate.port, '/flows');
    assert.equal(page.status, 200);
    assert.match(page.body, /200,?000/, '금액 표시');
    const csrf = (page.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
    assert.ok(csrf, 'CSRF 발급');

    // CSRF 없음·타 출처 403
    assert.equal((await post(s.gate.port, '/flow/confirm', { id: 'FP-1' })).status, 403);
    assert.equal((await post(s.gate.port, '/flow/confirm', { id: 'FP-1', csrf }, { origin: 'http://evil.example.com' })).status, 403);

    // 정상 확정 → benchmark.recordFlow 반영 + 결정 기록
    const page2 = await get(s.gate.port, '/flows');
    const csrf2 = (page2.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
    const ok = await post(s.gate.port, '/flow/confirm', { id: 'FP-1', csrf: csrf2 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    const flows = state.read('benchmark_flows', { dataDir: s.dir });
    assert.equal(flows.items.length, 1, 'recordFlow 호출');
    assert.equal(flows.items[0].amount, 200000);
    assert.equal(flows.items[0].account, 'real');
    const dec = rows(s.dir, 'flow_decision');
    assert.equal(dec[0].action, 'confirmed');
    // 목록에서 제거
    const page3 = await get(s.gate.port, '/flows');
    assert.ok(!page3.body.includes('FP-1'), '확정 후 목록 제외');
  } finally {
    await s.gate.close(); rm(s.dir);
  }
});

test('확인 화면: reject 시 사유 기록·recordFlow 미호출', async () => {
  const s = await bootGate();
  try {
    const page = await get(s.gate.port, '/flows');
    const csrf = (page.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
    const r = await post(s.gate.port, '/flow/reject', { id: 'FP-1', csrf, reason: '평가손익 오탐' });
    assert.equal(r.status, 200);
    const dec = rows(s.dir, 'flow_decision');
    assert.equal(dec[0].action, 'rejected');
    assert.equal(dec[0].reason, '평가손익 오탐');
    const flows = state.read('benchmark_flows', { dataDir: s.dir });
    assert.ok(!flows || flows.items.length === 0, 'recordFlow 미호출');
  } finally {
    await s.gate.close(); rm(s.dir);
  }
});

// ===== 3b. 현황판: 대기 건수 배지만(읽기 전용 유지) =====
test('현황판: 입금 확인 대기 배지 + 관문 링크, 0건이면 미표시', async () => {
  const dir = makeTmpDir();
  try {
    ledger.append('flow_pending', { id: 'FP-9', date: '2026-11-25', amount: 150000, status: 'awaiting_confirm', created_at: '2026-11-25T08:31:00+09:00' }, { dataDir: dir });
    const srv = await web.start({ dataDir: dir, port: 0, today: '2026-11-25' });
    try {
      const res = await get(srv.port, '/');
      assert.match(res.body, /입금.*확인.*대기.*1건|확인 대기 1건/, '배지 표시');
      assert.match(res.body, /62910\/flows/, '관문 링크');
    } finally {
      await srv.close();
    }
    // 0건(결정 완료)이면 미표시
    ledger.append('flow_decision', { id: 'd1', flow_id: 'FP-9', action: 'confirmed', created_at: '2026-11-25T09:00:00+09:00' }, { dataDir: dir });
    const srv2 = await web.start({ dataDir: dir, port: 0, today: '2026-11-25' });
    try {
      const res2 = await get(srv2.port, '/');
      assert.ok(!/확인 대기 \d+건/.test(res2.body), '0건 미표시');
    } finally {
      await srv2.close();
    }
  } finally {
    rm(dir);
  }
});
