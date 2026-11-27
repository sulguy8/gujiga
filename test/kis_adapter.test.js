'use strict';

// TST-003 — kis-adapter 자동 테스트 (가짜 KIS 서버 — 실제 증권사 호출 0)
// 상위: TSK-003 / ARC-003 / ARC-005 / refs/api(kis_client.js·kis_notes.md 검증 방식)
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 군주 공통 지시: 실제 증권사 서버 호출 0, 실제 키 파일 열람 0.
//  - 가짜 KIS 서버가 모의 도메인 프로토콜(TR ID·파라미터)을 재현한다.
//  - 실전 도메인용 가짜 서버의 수신 건수가 0임을 단언(실전 호출 0 증명).
//  - 키·토큰은 secret.js(DPAPI) 경유의 '가짜' 값만 사용.
// TST-003의 모의 도메인 '실호출' 1회는 군주 수동 항목으로 이관.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const kis = require('../src/kis_adapter');
const secret = require('../src/secret');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst003-'));
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

const FAKE = {
  appkey: 'FAKE-APPKEY-MOCK', appsecret: 'FAKE-SECRET-MOCK', account: '12345678',
};

// 가짜 KIS 서버: TR ID·경로별로 KIS 응답 모양을 재현. 모든 요청을 기록한다.
function fakeKisServer(overrides) {
  const received = []; // {ts, path, trId, method, query/body}
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const rec = {
        ts: Date.now(), path: u.pathname, method: req.method,
        trId: req.headers['tr_id'] || null, auth: req.headers['authorization'] || null,
        appkey: req.headers['appkey'] || null,
        query: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null,
      };
      received.push(rec);
      const reply = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const ov = overrides || {};
      if (u.pathname === '/oauth2/tokenP') {
        if (ov.tokenFail) return reply({ error_code: 'EGW00123', error_description: '발급 실패' }, 403);
        return reply({ access_token: 'FAKE-ACCESS-TOKEN-abc', access_token_token_expired: '2026-11-26 23:59:59' });
      }
      if (ov.rateLimitOnce && !ov._rated) {
        ov._rated = true;
        return reply({ rt_cd: '1', msg1: '초당 거래건수를 초과하였습니다' });
      }
      if (u.pathname.endsWith('/quotations/inquire-price')) {
        return reply({ rt_cd: '0', msg1: '정상', output: { stck_prpr: '61500', prdy_ctrt: '1.25', stck_oprc: '61000', stck_hgpr: '61900', stck_lwpr: '60800', acml_vol: '1234567', prdy_vrss_vol_rate: '120.5' } });
      }
      if (u.pathname.endsWith('/quotations/inquire-daily-itemchartprice')) {
        return reply({ rt_cd: '0', msg1: '정상', output2: [
          { stck_bsop_date: '20261125', stck_oprc: '61000', stck_hgpr: '61900', stck_lwpr: '60800', stck_clpr: '61500', acml_vol: '1234567' },
          { stck_bsop_date: '20261124', stck_oprc: '60500', stck_hgpr: '61100', stck_lwpr: '60200', stck_clpr: '61000', acml_vol: '1000000' },
        ] });
      }
      if (u.pathname.endsWith('/trading/inquire-balance')) {
        return reply({ rt_cd: '0', msg1: '정상', output1: [{ prdt_name: '삼성전자', pdno: '005930', hldg_qty: '3', pchs_avg_pric: '61000', prpr: '61500', evlu_pfls_amt: '1500', evlu_pfls_rt: '0.82' }], output2: [{ dnca_tot_amt: '400000', prvs_rcdl_excc_amt: '400000', tot_evlu_amt: '584500' }] });
      }
      if (u.pathname.endsWith('/trading/order-cash')) {
        if (ov.preOpen) return reply({ rt_cd: '1', msg1: '모의투자 장시작전 입니다' });
        return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '00950', ODNO: '0000117057' } });
      }
      if (u.pathname.endsWith('/trading/order-rvsecncl')) {
        return reply({ rt_cd: '0', msg1: '정상', output: { KRX_FWDG_ORD_ORGNO: '00950', ODNO: '0000117058' } });
      }
      if (u.pathname.endsWith('/trading/inquire-daily-ccld')) {
        return reply({ rt_cd: '0', msg1: '정상', output1: [{ ord_gno_brno: '00950', odno: '0000117057', orgn_odno: '', sll_buy_dvsn_cd_name: '매수', prdt_name: '삼성전자', pdno: '005930', ord_qty: '3', ord_unpr: '61500', tot_ccld_qty: '0', avg_prvs: '0', rmn_qty: '3', cncl_yn: 'Y', ord_tmd: '093000' }] });
      }
      reply({ rt_cd: '1', msg1: '알 수 없는 경로' });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

// 가짜 키 파일(DPAPI 암호화)을 만든다 — 실키 접촉 0.
function setupKeys(dir) {
  const keys = { mock: FAKE, real: { appkey: 'FAKE-APPKEY-REAL', appsecret: 'FAKE-SECRET-REAL', account: '87654321' } };
  const p = path.join(dir, 'fake_kis.json.enc');
  secret.encryptToFile(JSON.stringify(keys), p);
  return p;
}

async function setup(overrides, opts) {
  const dir = makeTmpDir();
  const keysPath = setupKeys(dir);
  const mockSrv = await fakeKisServer(overrides);
  const realSrv = await fakeKisServer({});
  const api = await kis.make('mock', Object.assign({
    dataDir: dir, keysPath,
    baseUrls: { mock: mockSrv.url, real: realSrv.url },
    gapMs: 30, // 테스트 가속(간격 검증 테스트만 기본값 사용)
  }, opts || {}));
  return { dir, keysPath, mockSrv, realSrv, api };
}
async function teardown(s) {
  await s.mockSrv.close();
  await s.realSrv.close();
  rm(s.dir);
}

// ===== 시나리오 1: 시세 조회(검증된 TR·파라미터 그대로) =====
test('시나리오1: quote — FHKST01010100·J 파라미터로 현재가 수신', async () => {
  const s = await setup();
  try {
    const q = await s.api.quote('005930');
    assert.equal(q.price, 61500);
    const req = s.mockSrv.received.find((r) => r.path.endsWith('inquire-price'));
    assert.equal(req.trId, 'FHKST01010100', '검증된 TR ID');
    assert.equal(req.query.FID_COND_MRKT_DIV_CODE, 'J', 'KRX 구분 J');
    assert.equal(req.query.FID_INPUT_ISCD, '005930');
  } finally {
    await teardown(s);
  }
});

// ===== 일봉 공급자: FHKST03010100·J → source='krx_official' 태그 =====
test('dailyCandle: 일봉 J 조회 → krx_official 출처 태그', async () => {
  const s = await setup();
  try {
    const bars = await s.api.dailyCandle('005930', 30);
    assert.equal(bars.length, 2);
    assert.equal(bars[bars.length - 1].close, 61500, '최신 봉(오름차순)');
    assert.equal(bars[0].source, 'krx_official', '출처 태그(stop_judgment 수용 조건)');
    const req = s.mockSrv.received.find((r) => r.path.endsWith('itemchartprice'));
    assert.equal(req.trId, 'FHKST03010100');
    assert.equal(req.query.FID_COND_MRKT_DIV_CODE, 'J', 'KRX 정규장(NXT 미포함)');
  } finally {
    await teardown(s);
  }
});

// ===== 시나리오 2~5: 주문·정정·취소·체결조회·잔고 (모의 TR V*) =====
test('시나리오2~5: order/modify/cancel/fills/balance — 모의 TR ID·파라미터', async () => {
  const s = await setup();
  try {
    const b = await s.api.balance();
    assert.equal(b.total, 584500);
    assert.equal(b.holdings[0].code, '005930');

    const o = await s.api.order('buy', '005930', 3, 61500);
    assert.equal(o.rt, '0');
    assert.equal(o.odno, '0000117057', '주문번호 수신');

    const m = await s.api.modify(o.orgno, o.odno, 3, 61600);
    assert.equal(m.rt, '0');
    const c = await s.api.cancel(o.orgno, m.odno, 3);
    assert.equal(c.rt, '0');

    const f = await s.api.fills('20261125');
    assert.equal(f.rows[0].odno, '0000117057', '체결조회 재확인');
    assert.equal(f.rows[0].symbol, '005930', '종목코드(pdno) 포함 — 출사표 003');

    // TR ID 검증(모의 V 프리픽스 — kis_client.js 그대로)
    const tr = (p) => s.mockSrv.received.filter((r) => r.path.endsWith(p)).map((r) => r.trId);
    assert.deepEqual(tr('order-cash'), ['VTTC0012U'], '모의 매수 TR');
    assert.ok(tr('order-rvsecncl').every((t) => t === 'VTTC0013U'), '정정·취소 TR');
    assert.deepEqual(tr('inquire-balance'), ['VTTC8434R'], '모의 잔고 TR');
    assert.deepEqual(tr('inquire-daily-ccld'), ['VTTC0081R'], '모의 체결 TR');
    // 정정/취소 구분 코드
    const rvse = s.mockSrv.received.filter((r) => r.path.endsWith('order-rvsecncl'));
    assert.equal(rvse[0].body.RVSE_CNCL_DVSN_CD, '01', '정정 01');
    assert.equal(rvse[1].body.RVSE_CNCL_DVSN_CD, '02', '취소 02');
  } finally {
    await teardown(s);
  }
});

// ===== 시나리오 6 + AC2: 연속 호출 간격 ≥ 1.2초(기본 gap) =====
test('시나리오6: 기본 간격 1.2초 — 인접 호출 간격이 좁혀지지 않는다', async () => {
  const s = await setup({}, { gapMs: undefined }); // 기본값(1200ms) 사용
  try {
    await s.api.quote('005930');
    await s.api.quote('005930');
    const api2 = s.mockSrv.received.filter((r) => r.path.endsWith('inquire-price'));
    assert.equal(api2.length, 2);
    const gap = api2[1].ts - api2[0].ts;
    assert.ok(gap >= 1150, `인접 호출 간격 ${gap}ms ≥ 1.2초(오차 50ms 허용)`);
  } finally {
    await teardown(s);
  }
});

// ===== 토큰: 캐시 유효 시 절대 재발급 없음(만료 30분 전까지 재사용) =====
test('토큰: 유효 캐시가 있으면 tokenP 호출 0 (재발급 금지 — 알림톡 방지)', async () => {
  const dir = makeTmpDir();
  const keysPath = setupKeys(dir);
  const mockSrv = await fakeKisServer({});
  const realSrv = await fakeKisServer({});
  try {
    // 유효한 가짜 토큰 캐시(만료까지 여유)를 DPAPI로 미리 저장 — 만료는 '내일'로 동적 생성(날짜 하드코딩 금지)
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    secret.saveToken('kis_token_mock', { token: 'FAKE-CACHED-TOKEN', expires: `${tomorrow} 23:59:59` }, { dataDir: dir });
    const api = await kis.make('mock', { dataDir: dir, keysPath, baseUrls: { mock: mockSrv.url, real: realSrv.url }, gapMs: 30 });
    await api.quote('005930');
    await api.balance();
    const tokenCalls = mockSrv.received.filter((r) => r.path === '/oauth2/tokenP');
    assert.equal(tokenCalls.length, 0, '재발급 0회');
    // 캐시된 토큰이 헤더에 쓰였는지
    const q = mockSrv.received.find((r) => r.path.endsWith('inquire-price'));
    assert.equal(q.auth, 'Bearer FAKE-CACHED-TOKEN');
  } finally {
    await mockSrv.close(); await realSrv.close(); rm(dir);
  }
});

// ===== 토큰: 만료(30분 이내) 캐시 → 1회 발급 후 암호화 캐시 갱신. 발급 실패 시 즉시 실패 =====
test('토큰: 만료 시 1회 발급·암호화 캐시 갱신, 발급 실패는 즉시 보고(무한 재시도 금지)', async () => {
  const dir = makeTmpDir();
  const keysPath = setupKeys(dir);
  const mockSrv = await fakeKisServer({});
  const realSrv = await fakeKisServer({});
  try {
    // 만료 임박(이미 지난) 캐시
    secret.saveToken('kis_token_mock', { token: 'FAKE-OLD', expires: '2026-11-25 00:00:01' }, { dataDir: dir });
    const api = await kis.make('mock', { dataDir: dir, keysPath, baseUrls: { mock: mockSrv.url, real: realSrv.url }, gapMs: 30 });
    await api.quote('005930');
    assert.equal(mockSrv.received.filter((r) => r.path === '/oauth2/tokenP').length, 1, '발급 1회');
    // 새 토큰이 암호화 캐시로 갱신(디스크에 평문 없음)
    const cached = secret.loadToken('kis_token_mock', { dataDir: dir });
    assert.equal(cached.token, 'FAKE-ACCESS-TOKEN-abc');
    const rawAll = fs.readdirSync(path.join(dir, 'secrets')).map((f) => fs.readFileSync(path.join(dir, 'secrets', f)));
    assert.ok(rawAll.every((b) => !b.includes(Buffer.from('FAKE-ACCESS-TOKEN-abc'))), '캐시 평문 없음');
    // 발급 기록(token_log — 값 미포함)
    const tlog = ledgerRows(dir, 'token_log');
    assert.equal(tlog.length, 1);
    assert.ok(!JSON.stringify(tlog).includes('FAKE-ACCESS-TOKEN'), '발급 기록에 토큰 값 없음');

    // 발급 실패 → 즉시 실패(tokenP 1회만 — 무한 재시도 금지)
    const dir2 = makeTmpDir();
    const keys2 = setupKeys(dir2);
    const failSrv = await fakeKisServer({ tokenFail: true });
    try {
      const api2 = await kis.make('mock', { dataDir: dir2, keysPath: keys2, baseUrls: { mock: failSrv.url, real: realSrv.url }, gapMs: 30 });
      await assert.rejects(() => api2.quote('005930'), /토큰/);
      assert.equal(failSrv.received.filter((r) => r.path === '/oauth2/tokenP').length, 1, '실패 시 1회로 끝');
    } finally {
      await failSrv.close(); rm(dir2);
    }
  } finally {
    await mockSrv.close(); await realSrv.close(); rm(dir);
  }
});

// ===== 재시도: '초당 거래건수 초과' 1회 → 재시도 후 성공(kis_client.js 관습) =====
test('재시도: 초당 건수 초과 응답이면 재시도해 성공한다', async () => {
  const s = await setup({ rateLimitOnce: true }, { gapMs: 30, retryWaitMs: 50 });
  try {
    const q = await s.api.quote('005930');
    assert.equal(q.price, 61500, '재시도로 성공');
    assert.equal(s.mockSrv.received.filter((r) => r.path.endsWith('inquire-price')).length, 2, '재시도 1회');
  } finally {
    await teardown(s);
  }
});

// ===== 에지: 08:30 이전 '장시작전' 거부가 명확히 전달 =====
test('에지: 모의 장시작전 거부(rt_cd 1)가 명확한 결과로 전달된다', async () => {
  const s = await setup({ preOpen: true });
  try {
    const o = await s.api.order('buy', '005930', 3, 61500);
    assert.equal(o.rt, '1');
    assert.match(o.msg, /장시작전/, '거부 사유 전달');
  } finally {
    await teardown(s);
  }
});

// ===== 시나리오 7 + AC3: 토큰·키가 반환값·장부에 미노출 =====
test('시나리오7: 공개 API 반환값·장부에 토큰·키 미노출', async () => {
  const s = await setup();
  try {
    const results = [];
    results.push(await s.api.quote('005930'));
    results.push(await s.api.balance());
    results.push(await s.api.order('buy', '005930', 3, 61500));
    const all = JSON.stringify(results) + JSON.stringify(s.api);
    for (const sec of ['FAKE-APPKEY', 'FAKE-SECRET', 'FAKE-ACCESS-TOKEN']) {
      assert.ok(!all.includes(sec), `${sec} 미노출`);
    }
    // 장부(token_log)에도 없음
    assert.ok(!JSON.stringify(ledgerRows(s.dir, 'token_log')).includes('FAKE-ACCESS-TOKEN'));
    // 계좌번호 마스킹
    assert.ok(!JSON.stringify(s.api.account || '').includes('12345678'), '계좌 전체번호 미노출');
  } finally {
    await teardown(s);
  }
});

// ===== 시나리오 8 + AC4 + 공통 지시: 실전 주문 비활성 + 실전 도메인 호출 0 =====
test('시나리오8: 실전 주문·정정·취소는 비활성 거부, 실전 도메인 수신 0건', async () => {
  const dir = makeTmpDir();
  const keysPath = setupKeys(dir);
  const mockSrv = await fakeKisServer({});
  const realSrv = await fakeKisServer({});
  try {
    const realApi = await kis.make('real', { dataDir: dir, keysPath, baseUrls: { mock: mockSrv.url, real: realSrv.url }, gapMs: 30 });
    await assert.rejects(() => realApi.order('buy', '005930', 1, 61500, { confirmed: true }), /비활성|TSK-012/, '실전 주문 거부');
    await assert.rejects(() => realApi.modify('00950', '1', 1, 61500), /비활성|TSK-012/);
    await assert.rejects(() => realApi.cancel('00950', '1', 1), /비활성|TSK-012/);
    // 핵심: 실전 도메인으로 나간 요청이 0건(토큰 발급 포함)
    assert.equal(realSrv.received.length, 0, '실전 도메인 호출 0');
    assert.equal(mockSrv.received.length, 0, '거부는 네트워크 이전 단계');
  } finally {
    await mockSrv.close(); await realSrv.close(); rm(dir);
  }
});

// ===== roundTick: kis_client.js 호가 단위 그대로 =====
test('roundTick: 호가 단위 계승', () => {
  assert.equal(kis.roundTick(10243, false, 'up'), 10250, '1만원대 10원 단위 올림');
  assert.equal(kis.roundTick(10240, false, 'up'), 10240, '배수면 그대로(kis_client 동작)');
  assert.equal(kis.roundTick(10243, false, 'down'), 10240);
  assert.equal(kis.roundTick(61530, false, 'up'), 61600, '5만원대 100원 단위');
  assert.equal(kis.roundTick(1999, false, 'down'), 1999, '2천원 미만 1원');
  assert.equal(kis.roundTick(10003, true, 'up'), 10005, 'ETF 5원');
});
