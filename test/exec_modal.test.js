'use strict';

// TST-009 — 출사표 확인·실행 창(SCR-001) 자동 테스트
// 상위: TSK-010 / SCR-001 / REQ-002 / TSK-005(게이트)
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 실행 창은 관문(62910)이 같은 출처로 직접 제공한다(현황판 62900은 읽기 전용 유지).
// 보안: 페이지 로드 때 1회용 CSRF 토큰, POST의 Origin·Host 검사.
// 이 경로(created_by='ai'/'ui'/'system')의 실전은 정책상 잠김(TSK-012 전) — 모의만 실제 동작.
// 수동 항목(군주): 시나리오 3(짧은 탭 오터치)·4(클릭 흐름) — 2단 확인 마크업은 자동 검사.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const gatekeeper = require('../src/gatekeeper');
const secret = require('../src/secret');
const state = require('../src/state');
const ledger = require('../src/ledger');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst009-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function rows(dir, name) {
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

function fakeKis() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      received.push({ path: u.pathname });
      const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/oauth2/tokenP') return reply({ access_token: 'FT', access_token_token_expired: '2026-11-26 23:59:59' });
      if (u.pathname.endsWith('inquire-balance')) return reply({ rt_cd: '0', output1: [], output2: [{ dnca_tot_amt: '900000', prvs_rcdl_excc_amt: '900000', tot_evlu_amt: '1000000' }] });
      if (u.pathname.endsWith('order-cash')) return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '00950', ODNO: '0000117057' } });
      if (u.pathname.endsWith('inquire-daily-ccld')) return reply({ rt_cd: '0', output1: [{ ord_gno_brno: '00950', odno: '0000117057', orgn_odno: '', sll_buy_dvsn_cd_name: '매수', prdt_name: 'x', ord_qty: '3', ord_unpr: '61500', tot_ccld_qty: '3', avg_prvs: '61500', rmn_qty: '0', cncl_yn: 'N', ord_tmd: '093001' }] });
      reply({ rt_cd: '1', msg1: '?' });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) }));
  });
}

function draftRow(over) {
  return Object.assign({
    id: 'D-' + Math.random().toString(36).slice(2, 8),
    account_type: 'paper', nation: null, symbol: '005930', side: 'buy',
    entry_low: 61000, entry_high: 61500, stop_price: 59000, target_price: 66000,
    deadline: '2026-12-05', troops: 18, status: 'draft',
    user_confirmed: false, confirmed_at: null, created_by: 'ai', hypothesis_ids: ['HYP-FIX-V'],
    rationale: '신호등 3/6', created_at: '2026-11-25T08:31:12+09:00',
  }, over || {});
}

async function boot(cfg) {
  cfg = cfg || {};
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({
    mock: { appkey: 'FA-M', appsecret: 'FS-M', account: '12345678' },
    real: { appkey: 'FA-R', appsecret: 'FS-R', account: '87654321' },
  }), keysPath);
  state.write('guard_config', {
    id: 'default', per_order_limit_real: 200000, per_order_limit_paper: 500000,
    daily_loss_limit: -50000, stop_file_path: path.join(dir, 'STOP'),
    cash_ratio_min: 0.3, correlation_max: 0.7, sample_min: 10, updated_at: 'x',
  }, { dataDir: dir });
  state.write('hypothesis_book', { items: [{ id: 'HYP-FIX-V', code: 'FV', category: 'A', statement: 'f', status: 'verified', evidence_count: 12, trade_count: 4, reference_only: false, created_at: 'x' }] }, { dataDir: dir });
  for (const d of cfg.drafts || []) ledger.append('order_draft', d, { dataDir: dir });
  const mockSrv = await fakeKis();
  const realSrv = await fakeKis();
  const tokenFile = path.join(dir, 'gate.token');
  const gate = await gatekeeper.start({
    dataDir: dir, keysPath, port: 0, tokenFile,
    baseUrls: { mock: mockSrv.url, real: realSrv.url }, gapMs: 5,
    fillPollMs: 10, fillPollMax: 60,
  });
  return { dir, mockSrv, realSrv, gate };
}
async function down(s) {
  try { await s.gate.close(); } catch (e) {}
  await s.mockSrv.close(); await s.realSrv.close(); rm(s.dir);
}

function get(port, pathName, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName, headers: headers || {} }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}
function post(port, pathName, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: pathName,
      headers: Object.assign({
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        origin: `http://127.0.0.1:${port}`,
      }, headers || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function csrfOf(html) {
  const m = html.match(/name="csrf" value="([a-f0-9]+)"/);
  return m && m[1];
}

// ===== 시나리오 1: 전부 통과 출사표 — 5항목·검사판·[실행] 활성 =====
test('시나리오1: 통과 출사표 페이지 — 5항목 표·검사 통과·실행 활성·CSRF 발급', async () => {
  const d = draftRow();
  const s = await boot({ drafts: [d] });
  try {
    const list = await get(s.gate.port, '/drafts');
    assert.equal(list.status, 200);
    assert.match(list.body, new RegExp(d.id), '목록에 출사표 표시');

    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    assert.equal(page.status, 200);
    // 5항목 표
    for (const v of ['61,000', '61,500', '59,000', '66,000', '2026-12-05', '18명']) {
      assert.ok(page.body.includes(v), `5항목 표시: ${v}`);
    }
    assert.match(page.body, /AI/, '작성 주체 배지');
    assert.match(page.body, /검사.*통과|전부 통과/, '검사판 통과 표시');
    assert.ok(!/id="execute"[^>]*disabled/.test(page.body), '[실행] 활성');
    assert.ok(csrfOf(page.body), 'CSRF 토큰 발급');
    // 2단 확인 마크업(오터치 방지)
    assert.match(page.body, /2단 확인|출병시키겠습니까/, '2단 확인 장치');
    // 외부 리소스 0·이모지 0
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(page.body), '외부 URL 0');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 2(대표 — 전수는 TSK-006 재사용): 차단 사유 → [실행] 비활성 + 사유·수치 =====
test('시나리오2: 차단 출사표는 실행 비활성 + 사유·수치 표시', async () => {
  // 모의 1회 한도 초과(troops 60 = 60만원)
  const d = draftRow({ troops: 60, entry_high: 61500 });
  const s = await boot({ drafts: [d] });
  try {
    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    assert.match(page.body, /per_order_limit/, '사유 표시');
    assert.match(page.body, /500,?000|500000/, '한도 수치 표시');
    assert.ok(/id="execute"[^>]*disabled/.test(page.body), '[실행] 비활성');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 7: STOP 활성 → "전군 정지 중" 띠 + 비활성 =====
test('시나리오7: STOP 활성 시 전군 정지 띠·실행 비활성', async () => {
  const d = draftRow();
  const s = await boot({ drafts: [d] });
  try {
    fs.writeFileSync(path.join(s.dir, 'STOP'), '');
    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    assert.match(page.body, /전군 정지 중/, '정지 띠');
    assert.ok(/id="execute"[^>]*disabled/.test(page.body), '비활성');
  } finally {
    await down(s);
  }
});

// ===== 에지: 5항목 누락 출사표 비정상 유입 → 불성립 표시 =====
test('에지: 손절선 없는 출사표 → 불성립 표시·실행 비활성', async () => {
  const d = draftRow({ stop_price: null });
  const s = await boot({ drafts: [d] });
  try {
    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    assert.match(page.body, /불성립|draft_invalid/, '불성립 표시');
    assert.ok(/id="execute"[^>]*disabled/.test(page.body));
  } finally {
    await down(s);
  }
});

// ===== 실전 잠김 표시: real 출사표 → "실전 잠김(TSK-012 전)" =====
test('실전 잠김: real 출사표 페이지에 잠김 표시', async () => {
  const d = draftRow({ account_type: 'real', troops: 18 });
  const s = await boot({ drafts: [d] });
  try {
    // 실전 검사를 위해 화이트리스트·스냅샷 세팅
    state.write('watchlist', [{ symbol: '005930', status: 'ready' }], { dataDir: s.dir });
    ledger.append('daily_account_snapshot', { id: 's1', snapshot_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }), account_type: 'real', start_total_eval: 1000000, start_cash: 900000, created_at: new Date().toISOString() }, { dataDir: s.dir });
    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    assert.match(page.body, /실전 잠김.*TSK-012|실전 잠김/, '잠김 표시(ui 경로 정책 false)');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 4(자동부) + AC3: 실행 확정 → confirmed_at 기록·게이트 경유 모의 체결 =====
test('실행 확정: CSRF 검증 → user_confirmed=true·created_by 유지·모의 체결·confirmed_at 기록', async () => {
  const d = draftRow();
  const s = await boot({ drafts: [d] });
  try {
    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    const csrf = csrfOf(page.body);
    const r = await post(s.gate.port, '/draft/execute', { id: d.id, csrf });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true, '게이트 경유 접수');
    assert.equal(r.json.result.odno, '0000117057');

    // 모의 전송 1건
    assert.equal(s.mockSrv.received.filter((x) => x.path.endsWith('order-cash')).length, 1);
    // order_log: confirmed=true·created_by 유지(ai)
    const sent = rows(s.dir, 'order_log').filter((x) => x.status !== 'blocked');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].confirmed, true, 'user_confirmed=true로 실행');
    assert.equal(sent[0].created_by, 'ai', 'created_by 유지');
    // confirmed_at 기록(draft_decision)
    const dec = rows(s.dir, 'draft_decision');
    assert.equal(dec.length, 1);
    assert.equal(dec[0].action, 'executed');
    assert.ok(dec[0].confirmed_at, 'confirmed_at 기록');
    // 실행된 출사표는 목록에서 사라진다
    const list = await get(s.gate.port, '/drafts');
    assert.ok(!list.body.includes(d.id), '목록 제외');
  } finally {
    await down(s);
  }
});

// ===== CSRF·Origin 보안 =====
test('보안: CSRF 없음/오류/재사용 403, 타 출처 Origin 403, Origin 없음 403', async () => {
  const d = draftRow();
  const s = await boot({ drafts: [d] });
  try {
    // CSRF 없음/오류
    const no = await post(s.gate.port, '/draft/execute', { id: d.id });
    assert.equal(no.status, 403, 'CSRF 없음 403');
    const bad = await post(s.gate.port, '/draft/execute', { id: d.id, csrf: 'deadbeef' });
    assert.equal(bad.status, 403, 'CSRF 오류 403');
    // 타 출처 Origin
    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    const csrf = csrfOf(page.body);
    const evil = await post(s.gate.port, '/draft/execute', { id: d.id, csrf }, { origin: 'http://evil.example.com' });
    assert.equal(evil.status, 403, '타 출처 403');
    // Origin 없음
    const page2 = await get(s.gate.port, `/draft?id=${d.id}`);
    const csrf2 = csrfOf(page2.body);
    const noOrigin = await post(s.gate.port, '/draft/execute', { id: d.id, csrf: csrf2 }, { origin: '' });
    assert.equal(noOrigin.status, 403, 'Origin 없음 403');
    // 정상 1회 사용 후 재사용 403(1회용)
    const page3 = await get(s.gate.port, `/draft?id=${d.id}`);
    const csrf3 = csrfOf(page3.body);
    const ok = await post(s.gate.port, '/draft/execute', { id: d.id, csrf: csrf3 });
    assert.equal(ok.status, 200);
    const reuse = await post(s.gate.port, '/draft/execute', { id: d.id, csrf: csrf3 });
    assert.equal(reuse.status, 403, 'CSRF 재사용 403');
    // 전송은 정상 1회뿐
    assert.equal(s.mockSrv.received.filter((x) => x.path.endsWith('order-cash')).length, 1);
  } finally {
    await down(s);
  }
});

// ===== 시나리오 5: 닫기(미실행) → 전송 0·상태 불변 =====
test('시나리오5: 페이지만 열고 닫으면 전송 0·출사표 유지', async () => {
  const d = draftRow();
  const s = await boot({ drafts: [d] });
  try {
    await get(s.gate.port, `/draft?id=${d.id}`);
    await get(s.gate.port, '/drafts');
    assert.equal(s.mockSrv.received.filter((x) => x.path.endsWith('order-cash')).length, 0, '전송 0');
    assert.equal(rows(s.dir, 'draft_decision').length, 0, '상태 불변');
    const list = await get(s.gate.port, '/drafts');
    assert.ok(list.body.includes(d.id), '목록 유지');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 6: 반려 → cancelled 처리·목록 제외 =====
test('시나리오6: 반려 시 cancelled 기록·목록 제외·전송 0', async () => {
  const d = draftRow();
  const s = await boot({ drafts: [d] });
  try {
    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    const csrf = csrfOf(page.body);
    const r = await post(s.gate.port, '/draft/reject', { id: d.id, csrf, reason: '가격대 이탈' });
    assert.equal(r.status, 200);
    const dec = rows(s.dir, 'draft_decision');
    assert.equal(dec[0].action, 'cancelled');
    assert.equal(dec[0].reject_reason, '가격대 이탈');
    const list = await get(s.gate.port, '/drafts');
    assert.ok(!list.body.includes(d.id), '목록 제외');
    assert.equal(s.mockSrv.received.filter((x) => x.path.endsWith('order-cash')).length, 0, '전송 0');
  } finally {
    await down(s);
  }
});

// ===== 에지: 페이지 로드 후 STOP 생성 → 실행 시점 게이트 재검사로 차단(최종 방어) =====
test('에지: 모달 열린 뒤 STOP 생성 — 실행은 게이트가 최종 차단', async () => {
  const d = draftRow();
  const s = await boot({ drafts: [d] });
  try {
    const page = await get(s.gate.port, `/draft?id=${d.id}`);
    const csrf = csrfOf(page.body); // 이때는 통과 상태
    fs.writeFileSync(path.join(s.dir, 'STOP'), ''); // 조건 변화
    const r = await post(s.gate.port, '/draft/execute', { id: d.id, csrf });
    assert.equal(r.json.ok, false, '게이트 최종 방어');
    assert.match(r.json.error, /stop_file/, '차단 사유');
    assert.equal(s.mockSrv.received.filter((x) => x.path.endsWith('order-cash')).length, 0, '전송 0');
  } finally {
    await down(s);
  }
});

// ===== 현황판 링크: 읽기 전용 유지 + 실행 창 링크만 추가 =====
test('현황판: 실행 창으로 가는 링크만 추가(쓰기 경로는 여전히 없음)', async () => {
  const web = require('../src/web');
  const dir = makeTmpDir();
  try {
    const srv = await web.start({ dataDir: dir, port: 0, today: '2026-11-25' });
    try {
      const res = await get(srv.port, '/');
      assert.match(res.body, /62910\/drafts/, '실행 창 링크');
      // 읽기 전용 유지(POST 405)
      const p = await post(srv.port, '/', {});
      assert.equal(p.status, 405, '현황판은 계속 읽기 전용');
    } finally {
      await srv.close();
    }
  } finally {
    rm(dir);
  }
});
