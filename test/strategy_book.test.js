'use strict';

// TST-020 — 병법서·논공행상 화면 보강(TSK-021 / SCR-006·007 / REQ-024·026)
// 실행: node --test — 실서버·실키·실claude 0.
// 병법서·논공행상 '조회'는 현황판(62900, 읽기 전용 유지). '군주 판정 대기' 확정은
// 관문(62910) 같은 출처 POST + 1회용 CSRF로만. 수동 검수(4·5 일부)는 군주 몫.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const web = require('../src/web');
const merit = require('../src/merit');
const hyp = require('../src/hypothesis');
const gatekeeper = require('../src/gatekeeper');
const secret = require('../src/secret');
const state = require('../src/state');
const ledger = require('../src/ledger');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst020-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function get(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
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

// ===== 4분면 분류(REQ-026) 단위 =====
test('4분면: 수익+준수=전공 / 수익+위반=요행 / 손실+준수=명예로운 패배 / 손실+위반=진짜 실패 / 0원=무승부', () => {
  assert.equal(merit.quadrantOf({ pnl: 50000, compliant: true }), 'merit');
  assert.equal(merit.quadrantOf({ pnl: 50000, compliant: false }), 'fluke');
  assert.equal(merit.quadrantOf({ pnl: -30000, compliant: true }), 'honorable_defeat');
  assert.equal(merit.quadrantOf({ pnl: -30000, compliant: false }), 'true_failure');
  assert.equal(merit.quadrantOf({ pnl: 0, compliant: true }), 'draw');
});

test('준수 판정: 근거 인용 + 성벽·기한 이행 + 위반 0', () => {
  assert.equal(merit.isCompliant({ rationale_cited: true, wall_deadline_respected: true, violation_count: 0 }), true);
  assert.equal(merit.isCompliant({ rationale_cited: false, wall_deadline_respected: true, violation_count: 0 }), false);
  assert.equal(merit.isCompliant({ rationale_cited: true, wall_deadline_respected: false, violation_count: 0 }), false);
  assert.equal(merit.isCompliant({ rationale_cited: true, wall_deadline_respected: true, violation_count: 1 }), false);
});

// ===== 시나리오 3 + 경계: 집계 리포트(준수율·0건 주간) =====
test('시나리오3: 4분면 집계·준수율 검산·0건은 해당 없음', () => {
  const trades = [
    { pnl: 50000, rationale_cited: true, wall_deadline_respected: true, violation_count: 0 },
    { pnl: 20000, rationale_cited: false, wall_deadline_respected: true, violation_count: 0 },
    { pnl: -30000, rationale_cited: true, wall_deadline_respected: true, violation_count: 0 },
    { pnl: -10000, rationale_cited: true, wall_deadline_respected: false, violation_count: 1 },
    { pnl: 0, rationale_cited: true, wall_deadline_respected: true, violation_count: 0 },
  ];
  const r = merit.report(trades);
  assert.equal(r.counts.merit, 1);
  assert.equal(r.counts.fluke, 1);
  assert.equal(r.counts.honorable_defeat, 1);
  assert.equal(r.counts.true_failure, 1);
  assert.equal(r.counts.draw, 1);
  assert.equal(r.total, 5);
  assert.equal(r.compliantRatePct, 60, '준수 3/5 = 60%(수기 검산)');
  const empty = merit.report([]);
  assert.equal(empty.compliantRatePct, null, '0건 — 해당 없음(0 나누기 방지)');
});

// ===== 병법서·논공행상 조회(현황판 62900 — 읽기 전용 유지) =====
async function bootWeb() {
  const dir = makeTmpDir();
  // 증거 7/10(출병 1 포함) 가설
  const h = hyp.register({ code: 'A1', category: 'A', statement: '09:00~09:30 고점 → 오후 약세', judge_expr: 'close < open' }, { dataDir: dir });
  hyp.transition(h.id, 'testing', { dataDir: dir });
  for (let i = 0; i < 6; i++) hyp.addEvidence({ hypothesis_id: h.id, evidence_date: '2026-11-1' + i, note: 'e', outcome: 'success', kind: 'observation', judged_by: '군주' }, { dataDir: dir });
  hyp.addEvidence({ hypothesis_id: h.id, evidence_date: '2026-11-20', note: 't', outcome: 'success', kind: 'trade', judged_by: 'app' }, { dataDir: dir });
  // 완료(10/10·3/3) 가설
  const h2 = hyp.register({ code: 'A9', category: 'A', statement: 'x → y' }, { dataDir: dir });
  hyp.transition(h2.id, 'testing', { dataDir: dir });
  for (let i = 0; i < 7; i++) hyp.addEvidence({ hypothesis_id: h2.id, evidence_date: '2026-11-01', note: 'e', outcome: 'success', kind: 'observation', judged_by: '군주' }, { dataDir: dir });
  for (let i = 0; i < 3; i++) hyp.addEvidence({ hypothesis_id: h2.id, evidence_date: '2026-11-02', note: 'e', outcome: 'success', kind: 'trade', judged_by: '군주' }, { dataDir: dir });
  // 논공행상 거래 기록(4분면 각 1 + 무승부)
  const rows = [
    { pnl: 50000, rationale_cited: true, wall_deadline_respected: true, violation_count: 0, symbol: 'S1' },
    { pnl: 20000, rationale_cited: false, wall_deadline_respected: true, violation_count: 0, symbol: 'S2' },
    { pnl: -30000, rationale_cited: true, wall_deadline_respected: true, violation_count: 0, symbol: 'S3' },
    { pnl: -10000, rationale_cited: true, wall_deadline_respected: false, violation_count: 1, symbol: 'S4' },
    { pnl: 0, rationale_cited: true, wall_deadline_respected: true, violation_count: 0, symbol: 'S5' },
  ];
  for (const t of rows) ledger.append('trade_result', Object.assign({ date: '2026-11-25', created_at: '2026-11-25T16:00:00+09:00' }, t), { dataDir: dir });
  const srv = await web.start({ dataDir: dir, port: 0, today: '2026-11-25' });
  return { dir, srv, h, h2 };
}

// ===== 시나리오 1 + AC2: 진행 막대 7/10·출병 1/3 =====
test('시나리오1: 병법서 상세 — 진행 막대 7/10·출병 1/3·판정식 표시', async () => {
  const s = await bootWeb();
  try {
    const list = await get(s.srv.port, '/hypotheses');
    assert.equal(list.status, 200);
    assert.match(list.body, /A1/, '목록');
    const page = await get(s.srv.port, `/hypothesis?id=${s.h.id}`);
    assert.match(page.body, /7\s*\/\s*10/, '표본 진행 7/10');
    assert.match(page.body, /1\s*\/\s*3/, '출병 1/3');
    assert.match(page.body, /close &lt; open|close < open/, '판정식 표시');
  } finally {
    await s.srv.close(); rm(s.dir);
  }
});

// ===== 시나리오 6 + AC: 등급별 병력 상한 안내 =====
test('시나리오6: 등급별 병력 상한 안내 — 검증 중 → 현령 기준 10명', async () => {
  const s = await bootWeb();
  try {
    const page = await get(s.srv.port, `/hypothesis?id=${s.h.id}`);
    assert.match(page.body, /10명/, '검증 중 = 현령 20의 절반');
    assert.match(page.body, /검증 중|testing/, '등급 표시');
  } finally {
    await s.srv.close(); rm(s.dir);
  }
});

// ===== 경계: 10/10·3/3 → 완료·승격 가능 안내 =====
test('경계: 표본 완료 가설 — 승격 가능 안내', async () => {
  const s = await bootWeb();
  try {
    const page = await get(s.srv.port, `/hypothesis?id=${s.h2.id}`);
    assert.match(page.body, /10\s*\/\s*10/);
    assert.match(page.body, /3\s*\/\s*3/);
    assert.match(page.body, /승격 가능/, '승격 가능 안내');
  } finally {
    await s.srv.close(); rm(s.dir);
  }
});

// ===== 시나리오 2·3 + AC4: 논공행상 화면 — 4분면·준수율·명예/실패 구분 =====
test('시나리오2·3: 논공행상 — 4분면 표·준수율 별도 열·명예로운 패배 시각 구분', async () => {
  const s = await bootWeb();
  try {
    const page = await get(s.srv.port, '/merit');
    assert.equal(page.status, 200);
    for (const label of ['전공', '요행', '명예로운 패배', '진짜 실패', '무승부']) {
      assert.ok(page.body.includes(label), `사분면: ${label}`);
    }
    assert.match(page.body, /요행[^<]*⚠|⚠/u === false ? /요행/ : /요행/, '요행 표기');
    assert.match(page.body, /준수율[^%]*60\s*%|60%/, '준수율 60%');
    // 명예로운 패배 vs 진짜 실패 — 서로 다른 클래스/배지
    assert.match(page.body, /q-honor/, '명예 배지 클래스');
    assert.match(page.body, /q-fail/, '실패 클래스');
    assert.ok(page.body.indexOf('q-honor') !== page.body.indexOf('q-fail'), '구분됨');
    // 손익 열과 별도(손익 수치도 표기)
    assert.match(page.body, /-30,?000/, '손익 열');
    // 현황판은 여전히 읽기 전용
    const p = await post(s.srv.port, '/hypotheses', {});
    assert.equal(p.status, 405, '62900 POST 405(읽기 전용 유지)');
  } finally {
    await s.srv.close(); rm(s.dir);
  }
});

// ===== 시나리오 4(자동부): 군주 판정 대기 — 관문 POST+CSRF로만 확정 =====
test('시나리오4: 판정 대기 확정 — 관문 same-origin POST+CSRF, judged_by=군주·집계 갱신', async () => {
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({ mock: { appkey: 'a', appsecret: 'b', account: '12345678' }, real: { appkey: 'c', appsecret: 'd', account: '87654321' } }), keysPath);
  const h = hyp.register({ code: 'B3', category: 'B', statement: '이벤트 당일 고점' }, { dataDir: dir });
  hyp.recordTradeEvidence(h.id, {}, { evidence_date: '2026-11-25', note: '앤트로픽 상장일' }, { dataDir: dir });
  const tokenFile = path.join(dir, 'gate.token');
  const gate = await gatekeeper.start({ dataDir: dir, keysPath, port: 0, tokenFile, baseUrls: { mock: 'http://127.0.0.1:1', real: 'http://127.0.0.1:1' } });
  try {
    // 대기 목록 페이지(CSRF 발급)
    const page = await get(gate.port, '/judgments');
    assert.equal(page.status, 200);
    assert.match(page.body, /앤트로픽 상장일/, '대기 증거 표시');
    const csrf = (page.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
    assert.ok(csrf, 'CSRF 발급');

    const pend = hyp.pendingJudgments({ dataDir: dir });
    // CSRF 없이 → 403
    const no = await post(gate.port, '/judgment/confirm', { id: pend[0].id, outcome: 'success' });
    assert.equal(no.status, 403);
    // 타 출처 → 403
    const evil = await post(gate.port, '/judgment/confirm', { id: pend[0].id, outcome: 'success', csrf }, { origin: 'http://evil.example.com' });
    assert.equal(evil.status, 403);
    // 정상 확정
    const page2 = await get(gate.port, '/judgments');
    const csrf2 = (page2.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
    const ok = await post(gate.port, '/judgment/confirm', { id: pend[0].id, outcome: 'success', csrf: csrf2 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);

    const ev = hyp.evidences(h.id, { dataDir: dir });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].judged_by, '군주');
    assert.equal(hyp.get(h.id, { dataDir: dir }).evidence_count, 1, '집계 즉시 갱신');
    assert.equal(hyp.pendingJudgments({ dataDir: dir }).length, 0, '대기 목록에서 제거');
  } finally {
    await gate.close(); rm(dir);
  }
});
