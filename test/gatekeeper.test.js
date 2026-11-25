'use strict';

// TST-016 — 허도 관문(gatekeeper)·Aside 얇은 kis_client 자동 테스트
// 상위: TSK-017 / ARC-009(127.0.0.1:62910·무작위 토큰·Host 검사) / ARC-005·ARC-003
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 공통 지시: 실제 증권사 호출 0(가짜 KIS 서버), 실키 열람 0(가짜 키), 실전 전송 0건 증명.
// Aside 쪽 검증: 토큰 파일·guard.json·order_log 전부 임시 폴더 — 실제 Aside 폴더 접촉 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const gatekeeper = require('../src/gatekeeper');
const secret = require('../src/secret');
const state = require('../src/state');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst016-'));
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

// 가짜 KIS 서버(간이판): 토큰·시세·잔고·주문. 요청 전수 기록.
function fakeKis() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      received.push({ path: u.pathname, ts: Date.now() });
      const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/oauth2/tokenP') return reply({ access_token: 'FAKE-KIS-TOKEN-zz', access_token_token_expired: '2026-11-26 23:59:59' });
      if (u.pathname.endsWith('inquire-price')) return reply({ rt_cd: '0', msg1: '정상', output: { stck_prpr: '61500', prdy_ctrt: '1.2', stck_oprc: '61000', stck_hgpr: '61900', stck_lwpr: '60800', acml_vol: '100', prdy_vrss_vol_rate: '99' } });
      if (u.pathname.endsWith('inquire-balance')) return reply({ rt_cd: '0', msg1: '정상', output1: [], output2: [{ dnca_tot_amt: '900000', prvs_rcdl_excc_amt: '900000', tot_evlu_amt: '1000000' }] });
      if (u.pathname.endsWith('order-cash')) return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '00950', ODNO: '0000117057' } });
      if (u.pathname.endsWith('order-rvsecncl')) return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '00950', ODNO: '0000117058' } });
      if (u.pathname.endsWith('inquire-daily-ccld')) return reply({ rt_cd: '0', msg1: '정상', output1: [] });
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
    mock: { appkey: 'FAKE-AK-M', appsecret: 'FAKE-AS-M', account: '12345678' },
    real: { appkey: 'FAKE-AK-R', appsecret: 'FAKE-AS-R', account: '87654321' },
  }), p);
  return p;
}
function writeGuard(dir, over) {
  state.write('guard_config', Object.assign({
    id: 'default', per_order_limit_real: 200000, per_order_limit_paper: 500000,
    daily_loss_limit: -50000, stop_file_path: path.join(dir, 'STOP'),
    cash_ratio_min: 0.3, correlation_max: 0.7, sample_min: 10,
    updated_at: '2026-11-25T00:00:00+09:00',
  }, over || {}), { dataDir: dir });
}

// 게이트 경유 주문의 성립 출사표용 공통 opt(5항목 — 출사표 없는 출병 금지)
const DRAFT_OPT = { stop_price: 59000, target_price: 66000, deadline: '2026-12-10', reason: '관문 테스트' };

async function boot(over) {
  const dir = makeTmpDir();
  const keysPath = setupKeys(dir);
  writeGuard(dir);
  const mockSrv = await fakeKis();
  const realSrv = await fakeKis();
  const tokenFile = path.join(dir, 'aside', 'secrets', 'gujiga_broker.token');
  const gate = await gatekeeper.start(Object.assign({
    dataDir: dir, keysPath, port: 0, tokenFile,
    baseUrls: { mock: mockSrv.url, real: realSrv.url }, gapMs: 30,
    fillPollMs: 20, fillPollMax: 60,
  }, over || {}));
  const gateToken = fs.readFileSync(tokenFile, 'utf8').trim();
  return { dir, keysPath, mockSrv, realSrv, tokenFile, gate, gateToken };
}
async function shutdown(s) {
  try { await s.gate.close(); } catch (e) {}
  await s.mockSrv.close(); await s.realSrv.close(); rm(s.dir);
}

function call(port, token, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/call',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        token ? { 'x-gate-token': token } : {}, headers || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ===== 시나리오 1·2: 토큰 없음/불일치 → 401 =====
test('시나리오1·2: 토큰 없음·불일치 요청은 401', async () => {
  const s = await boot();
  try {
    const noTok = await call(s.gate.port, null, { env: 'mock', fn: 'price', args: ['005930'] });
    assert.equal(noTok.status, 401, '토큰 없음 401');
    const badTok = await call(s.gate.port, 'WRONG-TOKEN', { env: 'mock', fn: 'price', args: ['005930'] });
    assert.equal(badTok.status, 401, '토큰 불일치 401');
    assert.equal(s.mockSrv.received.length, 0, 'KIS 전송 0');
  } finally {
    await shutdown(s);
  }
});

// ===== 시나리오 3: 127.0.0.1 전용 바인딩(+0.0.0.0 설정 거부) =====
test('시나리오3: 바인딩 주소 127.0.0.1, 비루프백 설정 거부', async () => {
  const s = await boot();
  try {
    assert.equal(s.gate.address, '127.0.0.1');
  } finally {
    await shutdown(s);
  }
  const dir = makeTmpDir();
  try {
    await assert.rejects(
      () => gatekeeper.start({ dataDir: dir, keysPath: setupKeys(dir), port: 0, host: '0.0.0.0', tokenFile: path.join(dir, 't') }),
      /127\.0\.0\.1|루프백/
    );
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 4: 잘못된 Host 헤더 거부(DNS 리바인딩 방지) =====
test('시나리오4: Host 헤더가 localhost/127.0.0.1 아니면 403', async () => {
  const s = await boot();
  try {
    const bad = await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'price', args: ['005930'] }, { Host: 'evil.example.com' });
    assert.equal(bad.status, 403);
  } finally {
    await shutdown(s);
  }
});

// ===== 시나리오 8: 정상 토큰 — 모의 시세·잔고가 기존 kis_client 형태로 =====
test('시나리오8: 모의 시세·잔고 — 기존 kis_client와 동일 형태', async () => {
  const s = await boot();
  try {
    const p = await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'price', args: ['005930'] });
    assert.equal(p.status, 200);
    assert.equal(p.json.ok, true);
    assert.equal(p.json.result.price, 61500, 'price 필드(kis_client 형태)');
    assert.ok('chg' in p.json.result && 'open' in p.json.result);

    const b = await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'balance', args: [] });
    assert.equal(b.json.result.total, 1000000);
    assert.ok(Array.isArray(b.json.result.holdings) && 'cash' in b.json.result);
  } finally {
    await shutdown(s);
  }
});

// ===== 시나리오 5 + 이중 잠금: confirmed 없는 실전 주문 → 관문 차단·전송 0 =====
test('시나리오5: confirmed 없는 실전 주문은 관문이 차단(전송 0건·order_log 기록)', async () => {
  const s = await boot();
  try {
    const r = await call(s.gate.port, s.gateToken, { env: 'real', fn: 'order', args: ['buy', '005930', 1, 61500, { ...DRAFT_OPT }] });
    assert.equal(r.json.ok, false, '차단');
    assert.match(r.json.error, /확인|confirm/, '사유 명시');
    assert.equal(s.realSrv.received.length, 0, '실전 KIS 전송 0');
    const blocked = ledgerRows(s.dir, 'order_log').filter((x) => x.status === 'blocked');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].block_reason, 'no_confirm');
  } finally {
    await shutdown(s);
  }
});

// ===== 이중 잠금 대표 케이스: STOP·1회 한도·화이트리스트·guard 부재 =====
test('이중 잠금: STOP·한도 초과·화이트리스트 미등재·guard 부재 각각 차단', async () => {
  const s = await boot();
  try {
    // 모의 한도 초과(50만 초과)
    const lim = await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'order', args: ['buy', '005930', 10, 61500, { ...DRAFT_OPT }] });
    assert.equal(lim.json.ok, false, '615,000원 > 모의 50만 차단');
    // STOP 파일 → 전면 차단
    fs.writeFileSync(path.join(s.dir, 'STOP'), '');
    const stop = await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'order', args: ['buy', '005930', 1, 61500, { ...DRAFT_OPT }] });
    assert.equal(stop.json.ok, false, 'STOP 차단');
    fs.rmSync(path.join(s.dir, 'STOP'));
    // 실전 매수 화이트리스트 미등재(confirmed 있어도)
    const wl = await call(s.gate.port, s.gateToken, { env: 'real', fn: 'order', args: ['buy', '005930', 1, 61500, { ...DRAFT_OPT, confirmed: true }] });
    assert.equal(wl.json.ok, false, '화이트리스트 차단');
    assert.equal(s.realSrv.received.length, 0, '실전 전송 여전히 0');
    // 차단 기록 누적 확인
    const reasons = ledgerRows(s.dir, 'order_log').filter((x) => x.status === 'blocked').map((x) => x.block_reason);
    assert.ok(reasons.includes('per_order_limit') && reasons.includes('stop_file') && reasons.includes('not_whitelisted'), `사유 기록: ${reasons}`);
  } finally {
    await shutdown(s);
  }
});

test('이중 잠금: guard_config 없으면 모의 주문도 차단(안전 쪽 실패)', async () => {
  const dir = makeTmpDir();
  const keysPath = setupKeys(dir); // guard_config 미작성
  const mockSrv = await fakeKis();
  const tokenFile = path.join(dir, 'gate.token');
  const gate = await gatekeeper.start({ dataDir: dir, keysPath, port: 0, tokenFile, baseUrls: { mock: mockSrv.url, real: mockSrv.url }, gapMs: 30 });
  try {
    const tok = fs.readFileSync(tokenFile, 'utf8').trim();
    const r = await call(gate.port, tok, { env: 'mock', fn: 'order', args: ['buy', '005930', 1, 61500, { stop_price: 59000, target_price: 66000, deadline: '2026-12-10', reason: 'x' }] });
    assert.equal(r.json.ok, false, 'guard 부재 차단');
    assert.equal(mockSrv.received.length, 0);
  } finally {
    await gate.close(); await mockSrv.close(); rm(dir);
  }
});

// ===== 모의 정상 주문: 관문 경유 접수 + order_log submitted =====
test('모의 정상 주문: 한도 내 모의 매수는 접수되고 order_log에 남는다', async () => {
  const s = await boot();
  try {
    const r = await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'order', args: ['buy', '005930', 3, 61500, { ...DRAFT_OPT, reason: '테스트' }] });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.result.odno, '0000117057');
    const subs = ledgerRows(s.dir, 'order_log').filter((x) => x.status === 'submitted');
    assert.equal(subs.length, 1);
    assert.equal(subs[0].symbol, '005930');
  } finally {
    await shutdown(s);
  }
});

// ===== 시나리오 7: 응답·장부·토큰 파일에 평문 키·KIS 토큰 0건 =====
test('시나리오7: 응답·장부 전수에 키·KIS 토큰 값 미노출', async () => {
  const s = await boot();
  try {
    const responses = [];
    responses.push(await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'price', args: ['005930'] }));
    responses.push(await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'balance', args: [] }));
    responses.push(await call(s.gate.port, s.gateToken, { env: 'mock', fn: 'order', args: ['buy', '005930', 3, 61500, { ...DRAFT_OPT }] }));
    const corpus = JSON.stringify(responses)
      + JSON.stringify(ledgerRows(s.dir, 'order_log'))
      + JSON.stringify(ledgerRows(s.dir, 'token_log'))
      + fs.readFileSync(s.tokenFile, 'utf8');
    for (const sec of ['FAKE-AK-M', 'FAKE-AS-M', 'FAKE-AK-R', 'FAKE-AS-R', 'FAKE-KIS-TOKEN-zz']) {
      assert.ok(!corpus.includes(sec), `${sec} 미노출`);
    }
  } finally {
    await shutdown(s);
  }
});

// ===== 에지: 재기동 — 이전 토큰 401, 새 토큰 정상 =====
test('에지: 관문 재기동 후 이전 토큰 401·새 토큰 정상', async () => {
  const s = await boot();
  const oldToken = s.gateToken;
  await s.gate.close();
  // 같은 토큰 파일로 재기동
  const gate2 = await gatekeeper.start({
    dataDir: s.dir, keysPath: s.keysPath, port: 0, tokenFile: s.tokenFile,
    baseUrls: { mock: s.mockSrv.url, real: s.realSrv.url }, gapMs: 30,
  });
  try {
    const newToken = fs.readFileSync(s.tokenFile, 'utf8').trim();
    assert.notEqual(newToken, oldToken, '재기동 시 토큰 교체');
    const old = await call(gate2.port, oldToken, { env: 'mock', fn: 'price', args: ['005930'] });
    assert.equal(old.status, 401, '이전 토큰 401');
    const ok = await call(gate2.port, newToken, { env: 'mock', fn: 'price', args: ['005930'] });
    assert.equal(ok.status, 200, '새 토큰 정상');
  } finally {
    await gate2.close(); await s.mockSrv.close(); await s.realSrv.close(); rm(s.dir);
  }
});

// =====================================================================
// Aside 얇은 클라이언트 (clients/aside/kis_client.js) — eval 로드 검증
// =====================================================================

const CLIENT_PATH = path.join(__dirname, '..', 'clients', 'aside', 'kis_client.js');

function loadClient() {
  const src = fs.readFileSync(CLIENT_PATH, 'utf8');
  // Aside REPL 환경 재현: fs(promises)·fetch 전역, eval 로드
  const fsP = require('node:fs').promises;
  // eslint-disable-next-line no-unused-vars
  const fsLocal = fsP;
  // eval 스코프에 fs 주입
  return (function (fs) { return eval(src); })(fsP);
}

// ===== 조건: eval 로드형 — require·child_process 금지, fetch·fs.readFile/writeFile만 =====
test('클라이언트: require·child_process 없이 eval 로드된다', () => {
  const src = fs.readFileSync(CLIENT_PATH, 'utf8');
  assert.ok(!/require\s*\(/.test(src), 'require 금지');
  assert.ok(!/child_process|spawn|exec/.test(src), 'child_process 금지');
  const client = loadClient();
  assert.equal(typeof client.make, 'function', 'make 존재');
  assert.equal(typeof client.roundTick, 'function', 'roundTick 존재');
  assert.equal(client.roundTick(10243, false, 'up'), 10250, 'roundTick 동일 동작');
});

// Aside 임시 루트 구성(실제 Aside 폴더 접촉 0)
function setupAsideRoot(dir, gateUrl, gateToken) {
  const root = path.join(dir, 'aside-root');
  fs.mkdirSync(path.join(root, 'trading'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'trading', 'guard.json'), JSON.stringify({
    maxOrderKRW: 200000, mockMaxOrderKRW: 500000, whitelist: ['005930'], dailyLossLimitKRW: 50000,
  }), 'utf8');
  if (gateToken != null) fs.writeFileSync(path.join(root, 'secrets', 'gujiga_broker.token'), gateToken, 'utf8');
  globalThis.GUJIGA_ASIDE_ROOT = root;
  globalThis.GUJIGA_GATE_URL = gateUrl;
  globalThis.GUJIGA_GATE_TOKEN_FILE = path.join(root, 'secrets', 'gujiga_broker.token');
  return root;
}
function clearGlobals() {
  delete globalThis.GUJIGA_ASIDE_ROOT;
  delete globalThis.GUJIGA_GATE_URL;
  delete globalThis.GUJIGA_GATE_TOKEN_FILE;
}

// ===== AC1·시나리오8: 얇은 클라이언트로 모의 시세·잔고 — 기존 모양 =====
test('클라이언트: make("mock") → price/balance가 기존 형태로 동작(관문 경유)', async () => {
  const s = await boot();
  const root = setupAsideRoot(s.dir, `http://127.0.0.1:${s.gate.port}`, s.gateToken);
  try {
    const client = loadClient();
    const api = await client.make('mock');
    const p = await api.price('005930');
    assert.equal(p.price, 61500);
    const b = await api.balance();
    assert.equal(b.total, 1000000);
    // 모의 주문 → 접수 + Aside 쪽 order_log.jsonl 기록(기존 안전장치·로그 유지)
    const o = await api.order('buy', '005930', 3, 61500, { reason: 'tst', stop_price: 59000, target_price: 66000, deadline: '2026-12-10' });
    assert.equal(o.odno, '0000117057');
    const log = fs.readFileSync(path.join(root, 'trading', 'order_log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1, '클라이언트 order_log 기록 유지');
    assert.match(log[0], /005930/);
  } finally {
    clearGlobals();
    await shutdown(s);
  }
});

// ===== 기존 안전장치 유지: 클라이언트 STOP·한도·confirmed·화이트리스트 =====
test('클라이언트: Aside 쪽 guard.json 안전장치가 그대로 동작(관문 이전 1차 잠금)', async () => {
  const s = await boot();
  const root = setupAsideRoot(s.dir, `http://127.0.0.1:${s.gate.port}`, s.gateToken);
  try {
    const client = loadClient();
    const api = await client.make('mock');
    // 모의 한도 초과 — 클라이언트 단에서 거부(관문 도달 전)
    const before = s.mockSrv.received.length;
    await assert.rejects(() => api.order('buy', '005930', 10, 61500), /한도/);
    assert.equal(s.mockSrv.received.length, before, '관문·KIS 미도달');
    // STOP 파일 — 클라이언트 거부
    fs.writeFileSync(path.join(root, 'trading', 'STOP'), '');
    await assert.rejects(() => api.order('buy', '005930', 1, 61500), /STOP/);
    fs.rmSync(path.join(root, 'trading', 'STOP'));
    // 실전 confirmed 필수 — 클라이언트 거부
    const realApi = await client.make('real');
    await assert.rejects(() => realApi.order('buy', '005930', 1, 61500), /확인|confirmed/);
    // 실전 화이트리스트 미등재 — 클라이언트 거부
    await assert.rejects(() => realApi.order('buy', '999999', 1, 61500, { confirmed: true }), /화이트리스트/);
    assert.equal(s.realSrv.received.length, 0, '실전 전송 0 유지');
  } finally {
    clearGlobals();
    await shutdown(s);
  }
});

// ===== 시나리오 6 + AC4: 관문 꺼짐 → '[정지] 관문 꺼짐' 명확 오류·주문 시도 0 =====
test('시나리오6: 관문 꺼짐 시 클라이언트가 [정지] 오류를 던지고 주문하지 않는다', async () => {
  const s = await boot();
  const gatePort = s.gate.port;
  const root = setupAsideRoot(s.dir, `http://127.0.0.1:${gatePort}`, s.gateToken);
  try {
    await s.gate.close(); // 관문 중단
    const client = loadClient();
    const api = await client.make('mock');
    await assert.rejects(() => api.price('005930'), /\[정지\] 관문 꺼짐/, '시세도 정지 보고');
    await assert.rejects(() => api.order('buy', '005930', 1, 61500), /\[정지\] 관문 꺼짐/, '주문 시도 없이 정지');
    // 토큰 파일 자체가 없을 때도 명확 오류
    fs.rmSync(path.join(root, 'secrets', 'gujiga_broker.token'));
    await assert.rejects(() => api.price('005930'), /\[정지\] 관문 꺼짐/);
  } finally {
    clearGlobals();
    await s.mockSrv.close(); await s.realSrv.close(); rm(s.dir);
  }
});

// ===== 스케줄러 등록/해제 스크립트: 존재만 확인(실행 금지) =====
test('스케줄러 스크립트: 등록/해제 파일이 존재하고 로그온 트리거를 담는다(실행하지 않음)', () => {
  const reg = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gatekeeper-task-register.ps1'), 'utf8');
  const unreg = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gatekeeper-task-unregister.ps1'), 'utf8');
  assert.match(reg, /ONLOGON|AtLogOn/i, '로그온 시 시작');
  assert.match(reg, /schtasks|Register-ScheduledTask/i);
  assert.match(reg, /군주가 직접/, '실행 주체 안내');
  assert.match(unreg, /Delete|Unregister/i);
});
