'use strict';

// TST-010 — notify 모듈(단일 발신처·채널 독립·본문 필터) 자동 테스트
// 상위: TSK-011 / ARC-006(텔레그램 확정·본문 수위) / ARC-005(토큰 보관)
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 군사 지시 반영:
//  - 텔레그램 테스트는 '가짜 서버'로만(실제 전송 0). 봇 토큰은 secret.js로만 읽는다(가짜 토큰을 DPAPI로 저장).
//  - 본문 필터: 계좌번호 패턴·잔고 금액 필드는 전송 전에 제거.
//  - 텔레그램 실패해도 PC 알림은 나가야 한다(채널 독립).
// 수동 항목(군주): 시나리오 1(휴대폰 수신)·5(PC 알림 클릭 딥링크).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const notify = require('../src/notify');
const secret = require('../src/secret');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst010-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function logRows(dir) {
  const d = paths.ledgerDir(dir, 'notify_log');
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

// 가짜 텔레그램 서버(실제 전송 0): 받은 요청을 기록하고 지정된 상태코드로 응답.
function fakeTelegramServer(statusCode) {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, body });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: statusCode === 200 }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        received,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

const FAKE_TOKEN = 'FAKE-BOT-7777:AAAA-dummy-token';

function setupDir() {
  const dir = makeTmpDir();
  // 봇 토큰은 secret.js(DPAPI) 경유로만 — 가짜 토큰을 암호화 저장
  secret.saveToken('telegram_bot', { token: FAKE_TOKEN, chat_id: '12345' }, { dataDir: dir });
  return dir;
}

function baseOpts(dir, tg, osSent, over) {
  return Object.assign({
    dataDir: dir,
    config: { channels: { os: true, telegram: true }, telegram: { token_name: 'telegram_bot' } },
    telegramUrl: tg ? tg.url : undefined,
    osSender: (payload) => { osSent.push(payload); },
  }, over || {});
}

// 척후 알림 예시(원문에는 계좌번호·잔고가 섞여 있음 — 필터 검증용)
function sampleEvent() {
  return {
    kind: 'report',
    title: '성벽 접근',
    body: '삼성전자(005930) 성벽 접근 — 현재가 10,250원(거리 2.5%). 계좌 12345678-01 잔고 9,876,543원 기준.',
    fields: {
      symbol: '005930', condition: 'stop_approach', price: 10250,
      account_no: '12345678-01', balance: 9876543, 잔고: 9876543,
    },
    deeplink: 'http://127.0.0.1:62900/',
  };
}

// ===== 시나리오 1(자동 부분): 알림 1건 → OS·텔레그램 양쪽 발송 =====
test('시나리오1: 알림 1건이 OS·텔레그램 양 채널로 발송된다', async () => {
  const dir = setupDir();
  const tg = await fakeTelegramServer(200);
  const osSent = [];
  try {
    const res = await notify.send(sampleEvent(), baseOpts(dir, tg, osSent));
    assert.equal(res.os.ok, true, 'OS 발송');
    assert.equal(res.telegram.ok, true, '텔레그램 발송');
    assert.equal(osSent.length, 1);
    assert.equal(tg.received.length, 1, '가짜 서버 수신 1건');
    assert.match(tg.received[0].url, /sendMessage/, '텔레그램 sendMessage 경로');
  } finally {
    await tg.close();
    rm(dir);
  }
});

// ===== 시나리오 2 + AC2: 텔레그램 본문 필터 — 계좌번호·잔고 제거, 종목·조건·수치 유지 =====
test('시나리오2: 텔레그램 본문에서 계좌번호·잔고가 제거된다(종목·조건·수치만)', async () => {
  const dir = setupDir();
  const tg = await fakeTelegramServer(200);
  const osSent = [];
  try {
    await notify.send(sampleEvent(), baseOpts(dir, tg, osSent));
    const sent = tg.received[0].body;
    // 제거 대상
    assert.ok(!sent.includes('12345678-01'), '계좌번호 패턴 제거');
    assert.ok(!sent.includes('9876543'), '잔고 금액 제거');
    assert.ok(!/잔고/.test(sent), '잔고 라벨 제거');
    // 유지 대상(종목·조건·수치)
    assert.match(sent, /005930/, '종목 유지');
    assert.match(sent, /10,?250/, '수치 유지');
    assert.match(sent, /성벽 접근/, '조건 유지');
  } finally {
    await tg.close();
    rm(dir);
  }
});

// ===== 시나리오 3 + AC3: 텔레그램 실패에도 OS 알림은 정상(채널 독립) =====
test('시나리오3: 텔레그램 5xx·접속 불가에도 OS 알림은 나간다', async () => {
  const dir = setupDir();
  const osSent = [];
  // (a) 5xx 응답
  const tg = await fakeTelegramServer(500);
  try {
    const res = await notify.send(sampleEvent(), baseOpts(dir, tg, osSent));
    assert.equal(res.os.ok, true, 'OS 정상');
    assert.equal(res.telegram.ok, false, '텔레그램 실패 감지');
  } finally {
    await tg.close();
  }
  // (b) 서버 자체가 없음(접속 불가)
  const res2 = await notify.send(sampleEvent(), baseOpts(dir, null, osSent, { telegramUrl: 'http://127.0.0.1:1' }));
  assert.equal(res2.os.ok, true, '접속 불가에도 OS 정상');
  assert.equal(res2.telegram.ok, false);
  // (c) OS 발송 쪽이 던져도 전체는 던지지 않는다
  const res3 = await notify.send(sampleEvent(), baseOpts(dir, null, osSent, {
    telegramUrl: 'http://127.0.0.1:1',
    osSender: () => { throw new Error('toast 실패'); },
  }));
  assert.equal(res3.os.ok, false);
  rm(dir);
});

// ===== 시나리오 4 + AC4: 로그·장부·오류에 봇 토큰 실값 미노출 =====
test('시나리오4: 봇 토큰이 장부·오류 메시지에 나타나지 않는다', async () => {
  const dir = setupDir();
  const tg = await fakeTelegramServer(200);
  const osSent = [];
  try {
    const res = await notify.send(sampleEvent(), baseOpts(dir, tg, osSent));
    // 장부(notify_log)에 토큰 없음
    const all = JSON.stringify(logRows(dir));
    assert.ok(!all.includes(FAKE_TOKEN), '장부에 토큰 없음');
    // 결과 객체에도 토큰 없음
    assert.ok(!JSON.stringify(res).includes(FAKE_TOKEN), '반환값에 토큰 없음');

    // 실패 시 오류 메시지에도 토큰 없음
    const bad = await notify.send(sampleEvent(), baseOpts(dir, null, osSent, { telegramUrl: 'http://127.0.0.1:1' }));
    assert.ok(!JSON.stringify(bad).includes(FAKE_TOKEN), '오류에도 토큰 없음');
  } finally {
    await tg.close();
    rm(dir);
  }
});

// ===== 시나리오 6: 알림 원문이 로컬 장부에 기록된다 =====
test('시나리오6: 알림 원문(필터 전)이 notify_log에 기록된다', async () => {
  const dir = setupDir();
  const tg = await fakeTelegramServer(200);
  const osSent = [];
  try {
    await notify.send(sampleEvent(), baseOpts(dir, tg, osSent));
    const rows = logRows(dir);
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /12345678-01/, '원문은 로컬 장부에 그대로(로컬은 외부 경유 아님)');
    assert.equal(rows[0].kind, 'report');
    assert.ok(rows[0].channels.os && rows[0].channels.telegram, '채널 결과 기록');
  } finally {
    await tg.close();
    rm(dir);
  }
});

// ===== 채널 on/off 설정 =====
test('설정: 채널 off면 해당 채널 발송 0', async () => {
  const dir = setupDir();
  const tg = await fakeTelegramServer(200);
  const osSent = [];
  try {
    const res = await notify.send(sampleEvent(), baseOpts(dir, tg, osSent, {
      config: { channels: { os: true, telegram: false }, telegram: { token_name: 'telegram_bot' } },
    }));
    assert.equal(osSent.length, 1, 'OS만 발송');
    assert.equal(tg.received.length, 0, '텔레그램 발송 0');
    assert.equal(res.telegram.skipped, true);

    const res2 = await notify.send(sampleEvent(), baseOpts(dir, tg, osSent, {
      config: { channels: { os: false, telegram: false } },
    }));
    assert.equal(osSent.length, 1, 'OS off면 발송 안 함');
    assert.equal(res2.os.skipped, true);
    // 꺼져 있어도 장부 기록은 남는다
    assert.equal(logRows(dir).length, 2);
  } finally {
    await tg.close();
    rm(dir);
  }
});

// ===== 에지: 장 마감 후 차단 알림(STOP)도 전달 — notify에 시간 게이트 없음 =====
test('에지: 장 마감 후 STOP 차단 알림도 발송된다', async () => {
  const dir = setupDir();
  const tg = await fakeTelegramServer(200);
  const osSent = [];
  try {
    const res = await notify.send({
      kind: 'blocked', title: '전군 정지', body: 'STOP 파일 감지 — 모든 주문 중단',
      fields: { reason: 'stop_file' },
    }, baseOpts(dir, tg, osSent, { now: '2026-11-25T18:00:00+09:00' }));
    assert.equal(res.os.ok, true);
    assert.equal(res.telegram.ok, true, '마감 후에도 전달');
  } finally {
    await tg.close();
    rm(dir);
  }
});

// ===== 에지: 중복 억제는 발생원(scout) 책임 — scout 1회 보고 = 알림 1회(통합) =====
test('에지: scout 연속 충족 1보고 → notify 1회(양 채널 동일)', async () => {
  const dir = setupDir();
  const tg = await fakeTelegramServer(200);
  const osSent = [];
  try {
    const scout = require('../src/scout');
    const state = require('../src/state');
    state.write('positions', [
      { id: 'p1', account_type: 'paper', symbol: '005930', name: '삼성전자', qty: 10, avg_price: 10500, stop_price: 10000, target_price: 12000, deadline: '2026-12-10', status: 'open' },
    ], { dataDir: dir });
    const pending = [];
    const hook = (e) => pending.push(notify.send(
      { kind: e.kind, title: e.condition || e.kind, body: `${e.symbol} ${e.condition} ${e.price}`, fields: e },
      baseOpts(dir, tg, osSent)
    ));
    const q = (price) => ({ quote: () => ({ price }) });
    scout.runScout({ dataDir: dir, now: '2026-11-25T10:00:00+09:00', providers: q(10250), notify: hook });
    scout.runScout({ dataDir: dir, now: '2026-11-25T10:05:00+09:00', providers: q(10200), notify: hook });
    await Promise.all(pending);
    assert.equal(osSent.length, 1, '연속 충족 OS 1회');
    assert.equal(tg.received.length, 1, '연속 충족 텔레그램 1회(양 채널 동일)');
  } finally {
    await tg.close();
    rm(dir);
  }
});

// ===== 표면: 토큰을 인자·필드로 받는 API가 없다(secret 경유 강제) =====
test('표면: notify 모듈이 토큰 평문을 받지 않는다', () => {
  for (const k of Object.keys(notify)) {
    assert.ok(!/token/i.test(k), `토큰 수수 API 금지: ${k}`);
  }
  assert.equal(typeof notify.send, 'function');
});
