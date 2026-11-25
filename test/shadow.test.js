'use strict';

// TST-017 — 그림자 운용 데몬(TSK-018) 자동 테스트(시뮬레이션)
// 상위: ARC-004(이관 조건)·ARC-007(상한 8회)·ARC-009(상주 방식)
// 실행: node --test — 실서버·실키·실claude 0(가짜 공급자·가짜 KIS·가짜 CLI)
//
// 핵심: 그림자 모드에서 주문 함수 호출이 '구조적으로' 불가능함을 증명(모듈 경계+정규식+시뮬레이션).
// Aside trading 폴더는 읽기만(대조용) — 쓰기 0건을 디렉터리 전후 비교로 증명.
// 실거래일 관찰 1일은 군주 몫.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const shadow = require('../src/shadow');
const secret = require('../src/secret');
const state = require('../src/state');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst017-'));
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
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

// 가짜 KIS(조회 전용 — 주문류 수신은 전부 기록되어 0건 단언에 쓰임)
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
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) }));
  });
}

// 가짜 claude CLI(신뢰 입력 숫자 반사)
function writeFakeCli(dir) {
  const p = path.join(dir, 'fake.js');
  fs.writeFileSync(p, `
const fs=require('fs');
let input=''; try{input=fs.readFileSync(0,'utf8');}catch(e){}
let d={};
try{const seg=input.split('[신뢰 입력')[1];const s=seg.indexOf('{');const e=seg.indexOf('\\n}');d=JSON.parse(seg.slice(s,e+2));}catch(e){}
const out=o=>process.stdout.write(JSON.stringify(o));
if(input.includes('market_lines')) out({market_lines:[\`야간선물 \${d.night_future_pct}%\`],today_actions:['관망']});
else if(input.includes('criterion')) out({criterion:d.criterion,evidence:\`수치 \${d.evidence_value}\`,change_plan:'보류',keep_plan:'유지'});
else if(input.includes('anecdotes')) out({anecdotes:[\`조조는 \${d.price}에서 버텼다\`],options:{top:{action:'퇴각',gain:'보전',lose:'기회'},mid:{action:'절반',gain:'균형',lose:'지연'},low:{action:'유지',gain:'반등',lose:'노출'}},recommend:'top',note:'최종 선택은 군주'});
else out({});
`, 'utf8');
  return p;
}

// Aside 루트 fixture(읽기 전용 대조용)
function makeAsideRoot(dir, report) {
  const root = path.join(dir, 'aside-root');
  fs.mkdirSync(path.join(root, 'trading', 'reports'), { recursive: true });
  if (report) fs.writeFileSync(path.join(root, 'trading', 'reports', '2026-11-25.json'), JSON.stringify(report), 'utf8');
  return root;
}

async function boot(cfg) {
  cfg = cfg || {};
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
  state.write('positions', [
    { id: 'p1', account_type: 'paper', symbol: '005930', name: '삼성전자', qty: 10, avg_price: 10500, stop_price: 10000, target_price: 12000, deadline: '2026-12-10', status: 'open' },
  ], { dataDir: dir });
  fs.mkdirSync(path.join(dir, 'market_cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'market_cache', 'overnight_2026-11-25.json'),
    JSON.stringify({ us_summary: { sp500: -0.8, nasdaq: -1.4, sox: 8832.5, vix: 26.36 }, night_future_pct: -4.56, source: 'websearch' }), 'utf8');

  const asideRoot = makeAsideRoot(dir, cfg.asideReport !== undefined ? cfg.asideReport : { weather: 'defense', signals_on: 2, stage: 's1' });
  const osSent = [];
  const tgSrv = await fakeKis(); // 텔레그램 대용 가짜 서버(수신 0 단언용)

  const quotes = cfg.quotes || { '005930': 11000 };
  const opts = {
    dataDir: dir, keysPath,
    baseUrls: { mock: kisSrv.url, real: kisSrv.url }, gapMs: 5,
    naverBase: 'http://127.0.0.1:1',
    asideRoot,
    providers: {
      quote: (sym) => {
        const v = quotes[sym];
        if (v == null) throw new Error('시세 없음');
        return { symbol: sym, price: typeof v === 'function' ? v() : v };
      },
      accountSnapshot: (acct) => ({ account_type: acct, start_total_eval: 1000000, start_cash: 900000 }),
    },
    strategistOpts: {
      dataDir: dir, claudeBin: process.execPath, claudeArgsPrefix: [cli],
      config: cfg.capConfig || { daily_max: 8, breakdown: {}, owner_chat_counts_separately: true },
      today: '2026-11-25',
    },
    notifyOpts: {
      dataDir: dir,
      config: { channels: { os: true, telegram: false }, telegram: { token_name: 'telegram_bot' } },
      telegramUrl: tgSrv.url,
      osSender: (p) => osSent.push(p),
    },
  };
  return { dir, kisSrv, tgSrv, asideRoot, osSent, opts, quotes };
}
async function down(s) {
  await s.kisSrv.close(); await s.tgSrv.close(); rm(s.dir);
}

function at(s, time) {
  return Object.assign({}, s.opts, { now: `2026-11-25T${time}+09:00` });
}

// ===== 시나리오 1(a): 코드 경계 — 주문류 모듈·함수 참조 0 =====
test('시나리오1a: shadow 코드에 주문 경로가 없다(모듈 경계·정규식)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shadow.js'), 'utf8');
  for (const mod of ['./gate', './kis_adapter', './gatekeeper', './order_draft', './stop_judgment']) {
    assert.ok(!src.includes(`require('${mod}')`), `주문 경로 모듈 금지: ${mod}`);
  }
  assert.ok(!/\.(order|submit|amend|revoke|modify|cancel)\s*\(/.test(src), '주문류 호출 0');
});

// ===== 시나리오 1(b)+2+3+6+7: 하루 전체 시뮬레이션 =====
test('시나리오1b·2·3·6·7: 하루 시뮬레이션 — 주문 0·정시 실행·자체 폴더·상한·PC 알림만', async () => {
  const s = await boot();
  const asideBefore = walk(s.asideRoot);
  try {
    // 08:29 — 아무것도 안 함
    let r = await shadow.runOnce(at(s, '08:29:00'));
    assert.equal(r.ran.length, 0, '08:29 실행 0');

    // 08:31 — 스냅샷+군의
    r = await shadow.runOnce(at(s, '08:31:30'));
    assert.ok(r.ran.includes('snapshot_0830'), '계좌 스냅샷');
    assert.ok(r.ran.includes('council_0831'), '군의 실행');
    assert.ok(fs.existsSync(path.join(s.dir, 'briefings', '2026-11-25-gunui.md')), '군의 산출물(자체 폴더)');

    // 장중 5분 척후: 성벽 접근(10,250) → [액션 필요] → advise+insight 연결
    s.quotes['005930'] = 10250;
    r = await shadow.runOnce(at(s, '10:00:10'));
    assert.ok(r.ran.includes('scout'), '척후 실행');
    // 5분 안 지난 재호출 → 척후 생략
    r = await shadow.runOnce(at(s, '10:02:00'));
    assert.ok(!r.ran.includes('scout'), '5분 간격 유지');
    // 15:06 — 전황 점검
    r = await shadow.runOnce(at(s, '15:06:00'));
    assert.ok(r.ran.includes('preclose_1505'), '15:05 점검');
    // 15:45 — 대조 기록
    r = await shadow.runOnce(at(s, '15:45:00'));
    assert.ok(r.ran.includes('compare_1540'), '대조 기록');

    // (1b) 주문 0건: 가짜 KIS에 주문류 수신 0
    const orders = s.kisSrv.received.filter((x) => /order-cash|order-rvsecncl/.test(x.path));
    assert.equal(orders.length, 0, '주문 전송 0건');
    assert.equal(rows(s.dir, 'order_log').length, 0, 'order_log 0건');
    assert.equal(rows(s.dir, 'order_draft').length, 0, '초안 생성도 0건(그림자)');

    // (3) Aside 폴더 쓰기 0건
    assert.deepEqual(walk(s.asideRoot), asideBefore, 'Aside trading 폴더 불변(읽기만)');

    // (6) LLM 상한: 하루 8회 이하
    const calls = rows(s.dir, 'strategist_log').filter((x) => x.type === 'call');
    assert.ok(calls.length <= 8, `LLM 호출 ${calls.length} ≤ 8`);
    assert.ok(calls.length >= 1, '군의 1회 이상');

    // (7) 알림: PC만 — 텔레그램 수신 0
    assert.ok(s.osSent.length >= 1, 'PC 알림 발송');
    assert.equal(s.tgSrv.received.length, 0, '텔레그램 0건');

    // 실행 기록
    const log = rows(s.dir, 'shadow_job_log');
    for (const j of ['snapshot_0830', 'council_0831', 'preclose_1505', 'compare_1540']) {
      assert.ok(log.some((x) => x.job === j && (x.status === 'run' || x.status === 'late')), `기록: ${j}`);
    }
  } finally {
    await down(s);
  }
});

// ===== 시나리오 4: 재기동 — 놓친 회차는 미실행 기록만(따라잡기·주문 0) =====
test('시나리오4: 전일 전체 미가동 후 재기동 → missed 기록만, 실행·주문 0', async () => {
  const s = await boot();
  try {
    // 2026-11-24(화) 아무 기록 없음 → 11-25 08:10 기동
    const r = await shadow.runOnce(at(s, '08:10:00'));
    assert.equal(r.ran.length, 0, '08:10 실행 0');
    const missed = rows(s.dir, 'shadow_job_log').filter((x) => x.status === 'missed' && x.date === '2026-11-24');
    const jobs = missed.map((x) => x.job);
    for (const j of ['snapshot_0830', 'council_0831', 'preclose_1505']) {
      assert.ok(jobs.includes(j), `미실행 기록: ${j}`);
    }
    // 따라잡기 실행 없음
    assert.ok(!fs.existsSync(path.join(s.dir, 'briefings', '2026-11-24-gunui.md')), '어제 군의 생성 안 함');
    assert.equal(s.kisSrv.received.filter((x) => /order/.test(x.path)).length, 0, '주문 0');
    // 멱등
    await shadow.runOnce(at(s, '08:12:00'));
    const missed2 = rows(s.dir, 'shadow_job_log').filter((x) => x.status === 'missed' && x.date === '2026-11-24' && x.job === 'council_0831');
    assert.equal(missed2.length, 1, '미실행 기록 멱등');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 5: 대조 기록 — 일치/불일치·사유 =====
test('시나리오5: 대조 기록 — 일치·불일치 사유·Aside 보고 부재 처리', async () => {
  // (a) 일치
  const s = await boot({ asideReport: { weather: 'defense', signals_on: 2, stage: 's1' } });
  try {
    await shadow.runOnce(at(s, '08:31:30')); // 군의(스냅샷 생성)
    await shadow.runOnce(at(s, '15:45:00')); // 대조
    const cmp = rows(s.dir, 'shadow_compare');
    assert.equal(cmp.length, 1);
    assert.equal(cmp[0].match, true, '일치');
    assert.equal(cmp[0].mismatches.length, 0);
    assert.ok(fs.existsSync(path.join(s.dir, 'shadow', 'compare_report.md')), '누적 리포트(자체 폴더)');
  } finally {
    await down(s);
  }
  // (b) 불일치 — 사유 기록
  const s2 = await boot({ asideReport: { weather: 'neutral', signals_on: 3, stage: 'wait' } });
  try {
    await shadow.runOnce(at(s2, '08:31:30'));
    await shadow.runOnce(at(s2, '15:45:00'));
    const cmp = rows(s2.dir, 'shadow_compare');
    assert.equal(cmp[0].match, false);
    assert.ok(cmp[0].mismatches.length >= 2, '불일치 필드 목록');
    const fields = cmp[0].mismatches.map((m) => m.field);
    assert.ok(fields.includes('weather') && fields.includes('stage'));
    assert.match(JSON.stringify(cmp[0].mismatches), /defense.*neutral|neutral.*defense/, '사유(양측 값)');
  } finally {
    await down(s2);
  }
  // (c) Aside 보고 없음 → aside_missing 기록(불일치 아님)
  const s3 = await boot({ asideReport: null });
  try {
    await shadow.runOnce(at(s3, '08:31:30'));
    await shadow.runOnce(at(s3, '15:45:00'));
    const cmp = rows(s3.dir, 'shadow_compare');
    assert.equal(cmp[0].aside_missing, true, 'Aside 보고 부재 표시');
  } finally {
    await down(s3);
  }
});

// ===== 경계: 휴장일 — 회차 미실행(미실행 기록도 아님) =====
test('경계: 휴장일(토)에는 실행·미실행 기록 모두 없음', async () => {
  const s = await boot();
  try {
    const r = await shadow.runOnce(Object.assign({}, s.opts, { now: '2026-11-28T10:00:00+09:00' }));
    assert.equal(r.trading, false);
    assert.equal(rows(s.dir, 'shadow_job_log').filter((x) => x.date === '2026-11-28').length, 0, '휴장일 기록 0');
  } finally {
    await down(s);
  }
});

// ===== 경계: sox_recent3_low 3거래일 창(4일 전 저점 탈락) =====
test('경계: sox 3거래일 창 — 4일 전 저점은 탈락', async () => {
  const s = await boot();
  try {
    shadow.updateSoxWindow(8000, '2026-11-20', s.opts); // 4일 전(탈락 예정)
    shadow.updateSoxWindow(8700, '2026-11-21', s.opts);
    shadow.updateSoxWindow(8650, '2026-11-24', s.opts);
    shadow.updateSoxWindow(8832.5, '2026-11-25', s.opts);
    const rec = state.read('reentry_record', { dataDir: s.dir });
    assert.equal(rec.sox_recent3_low, 8650, '최근 3일(21·24·25) 최저 — 8000 탈락');
  } finally {
    await down(s);
  }
});

// ===== 경계: 척후 [액션 필요] 상한 소진 — 규칙 엔진만 + 상한 알림 1회 =====
test('경계: 상한 소진 후 척후 액션 — LLM 생략·상한 알림 1회·보고는 계속', async () => {
  const s = await boot({ capConfig: { daily_max: 3, breakdown: {}, owner_chat_counts_separately: true } });
  try {
    await shadow.runOnce(at(s, '08:31:30')); // 군의 1회(call 1)
    // 성벽 접근 반복 발생(해제→재충족으로 매번 새 보고) — advise+insight 2콜씩
    const seq = [10250, 11000, 10250, 11000, 10250];
    const times = ['09:00:00', '09:05:10', '09:10:20', '09:15:30', '09:20:40'];
    for (let i = 0; i < seq.length; i++) {
      s.quotes['005930'] = seq[i];
      await shadow.runOnce(at(s, times[i]));
    }
    const log = rows(s.dir, 'strategist_log');
    const calls = log.filter((x) => x.type === 'call').length;
    assert.ok(calls <= 3, `상한 3 준수(실호출 ${calls})`);
    assert.equal(log.filter((x) => x.type === 'alert').length, 1, '상한 도달 알림 1회');
    assert.ok(log.filter((x) => x.type === 'skip').length >= 1, '초과분 생략');
    // 척후 보고 자체(규칙 엔진)는 계속
    assert.ok(rows(s.dir, 'scout_log').filter((x) => x.type === 'report').length >= 2, '규칙 보고 지속');
  } finally {
    await down(s);
  }
});

// ===== 상주 등록 스크립트(실행 안 함) =====
test('상주: shadow 등록/해제 ps1 존재·로그온 트리거·군주 실행 문구', () => {
  const reg = fs.readFileSync(path.join(__dirname, '..', 'bin', 'shadow-task-register.ps1'), 'utf8');
  const unreg = fs.readFileSync(path.join(__dirname, '..', 'bin', 'shadow-task-unregister.ps1'), 'utf8');
  // 지령 006: schtasks(ONLOGON) → Register-ScheduledTask(-AtLogOn)로 재작성 — 둘 다 허용
  assert.match(reg, /ONLOGON|AtLogOn/i);
  assert.match(reg, /군주가 직접/);
  assert.match(reg, /run-shadow/);
  assert.match(unreg, /Delete/i);
});
