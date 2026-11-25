'use strict';

// TST-014 — 시장 데이터 수집기 4종(TSK-015) 자동 테스트
// 상위: ARC-008 / DAT-013 / REQ-022
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 공통: 실서버·실키 호출 0 — KIS·네이버·웹검색 전부 가짜. 네이버 일봉은 판정 금지(retro 교훈).
// 실수집 관찰 1일(TST-014 사전조건)은 군주 몫.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const market = require('../src/market');
const strategist = require('../src/strategist');
const secret = require('../src/secret');
const state = require('../src/state');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst014-'));
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

// 가짜 KIS: 지수 일봉(미검증 TR — 실수집 1일에서 확인 예정) 25봉 제공
function fakeKis(cfg) {
  cfg = cfg || {};
  const received = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      received.push({ path: u.pathname, trId: req.headers['tr_id'], query: Object.fromEntries(u.searchParams) });
      const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/oauth2/tokenP') return reply({ access_token: 'FT', access_token_token_expired: '2026-11-26 23:59:59' });
      if (u.pathname.endsWith('inquire-investor-daily-by-market')) {
        if (cfg.investorFail) return reply({ rt_cd: '1', msg1: '투자자 동향 실패' });
        // 필드명 frgn_ntby_tr_pbmn 은 fixture — 실제 관찰 1일에서 확인 항목(제안서 기재)
        return reply({ rt_cd: '0', msg1: '정상', output: [
          { stck_bsop_date: '20261124', frgn_ntby_tr_pbmn: '1200' },
          { stck_bsop_date: '20261123', frgn_ntby_tr_pbmn: '-500' },
          { stck_bsop_date: '20261122', frgn_ntby_tr_pbmn: '-300' },
        ] });
      }
      if (u.pathname.endsWith('inquire-daily-indexchartprice')) {
        if (cfg.indexFail) return reply({ rt_cd: '1', msg1: '지수 일봉 실패' });
        // 25봉: 종가 5000, 5001, ..., 5024 (최신이 5024) — KIS는 최신 먼저
        const out = Array.from({ length: 25 }, (_, i) => ({
          stck_bsop_date: String(20261001 + i),
          bstp_nmix_prpr: String(5000 + i), bstp_nmix_oprc: String(5000 + i), bstp_nmix_hgpr: String(5000 + i), bstp_nmix_lwpr: String(5000 + i),
          acml_vol: '1',
        })).reverse();
        return reply({ rt_cd: '0', msg1: '정상', output2: out });
      }
      reply({ rt_cd: '1', msg1: '?' });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) }));
  });
}

// 가짜 네이버 m.stock 지수 API(장중 — 참고용만)
function fakeNaver() {
  const received = [];
  const srv = http.createServer((req, res) => {
    received.push(req.url);
    if (/\/api\/index\/KOSPI\/basic/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ closePrice: '5,010.11', fluctuationsRatio: '-0.42' }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) }));
  });
}

// 가짜 claude CLI(웹 검색 결과 모사 — 실검색 0)
function writeOvernightCli(dir) {
  const p = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(p, `
const fs=require('fs');
try{fs.readFileSync(0,'utf8');}catch(e){}
process.stdout.write(JSON.stringify({sp500:-0.8,nasdaq:-1.4,sox:-2.1,vix:26.36,night_future_pct:-4.56}));
`, 'utf8');
  return p;
}

async function boot(cfg) {
  cfg = cfg || {};
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({
    mock: { appkey: 'FA', appsecret: 'FS', account: '12345678' },
    real: { appkey: 'FAR', appsecret: 'FSR', account: '87654321' },
  }), keysPath);
  const kisSrv = await fakeKis(cfg.kis);
  const naverSrv = cfg.noNaver ? null : await fakeNaver();
  const fakeCli = writeOvernightCli(dir);
  state.write('reentry_record', { sox_base_low: 8408.59, sox_base_low_date: '2026-11-10' }, { dataDir: dir });
  state.write('event_calendar', { events: ['PCE 2026-11-26', '금통위 2026-11-27'] }, { dataDir: dir });
  const opts = {
    dataDir: dir, keysPath,
    baseUrls: { mock: kisSrv.url, real: kisSrv.url }, gapMs: 5,
    naverBase: naverSrv ? naverSrv.url : 'http://127.0.0.1:1', // 차단 시 접속 불가 포트
    now: '2026-11-25T08:30:00+09:00',
    strategistOpts: {
      dataDir: dir,
      claudeBin: process.execPath,
      claudeArgsPrefix: [fakeCli],
      config: { daily_max: 8, breakdown: {}, owner_chat_counts_separately: true },
      today: '2026-11-25',
    },
  };
  return { dir, kisSrv, naverSrv, opts };
}
async function down(s) {
  await s.kisSrv.close();
  if (s.naverSrv) await s.naverSrv.close();
  rm(s.dir);
}

const JUDGE_STUB = { weather: 'defense', signals: [], stage: 'wait', missing: [] };

// ===== 시나리오 1 + AC1: 수집 1회 → 스냅샷 1행(필수 필드) =====
test('시나리오1: 수집 1회로 market_snapshot 1행 생성(필수 필드·외국인은 결측)', async () => {
  const s = await boot();
  try {
    const c = await market.collect(s.opts);
    assert.equal(c.date, '2026-11-25');
    assert.equal(c.judgeInputs.kospi_close, 5024, 'KIS 지수 종가(최신봉)');
    assert.ok(Math.abs(c.judgeInputs.kospi_ma20 - (5005 + 5024) / 2) < 0.001, '20일선 = 최근 20봉 평균');
    assert.equal(c.judgeInputs.night_future_pct, -4.56, '야간선물(웹검색)');
    assert.equal(c.judgeInputs.us_summary.vix, 26.36);
    assert.equal(c.judgeInputs.sox_base_low, 8408.59, '기준 저점(장부)');
    // 지령 007: 필드명은 실관찰 확인(해제), 날짜 수정은 '(미검증-날짜)' — 확인 전까지 신호 4 결측 처리
    assert.equal(c.judgeInputs.foreign_net_days, null, '날짜 수정 확인 전 결측 처리(보수 꺼짐)');
    assert.equal(c.judgeInputs.foreign_date_unverified, true);
    assert.ok(c.missing.includes('foreign_net_days'));
    assert.ok(c.unverified.includes('foreign_net_days(미검증-날짜)'), '(미검증-날짜) 태그');
    // 날짜 파라미터(지령 007 수정): 기준일 — 두 날짜 모두 '오늘'로 보낸다(최신일이 오도록)
    const invReq = s.kisSrv.received.find((r) => r.path.endsWith('inquire-investor-daily-by-market'));
    const ymdNow = (() => { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); })();
    assert.equal(invReq.query.FID_INPUT_DATE_1, ymdNow, '기준일 1 = 오늘');
    assert.equal(invReq.query.FID_INPUT_DATE_2, ymdNow, '기준일 2 = 오늘');

    const file = market.saveSnapshot(c, JUDGE_STUB, s.opts);
    assert.ok(fs.existsSync(file));
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(row.snapshot_date, '2026-11-25');
    assert.equal(row.weather, 'defense');
    assert.ok(row.sources && row.created_at && Array.isArray(row.signals), 'DAT-013 필수 필드');
    assert.ok((row.unverified || []).includes('foreign_net_days(미검증-날짜)'), '스냅샷에도 (미검증-날짜) 태그');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 2 + REQ-022 AC1: 종가·20일선 출처 태그 100% kis_j + 타 출처 기록 거부 =====
test('시나리오2: 종가·20일선 태그 kis_j 100%, 다른 태그는 기록 거부', async () => {
  const s = await boot();
  try {
    const c = await market.collect(s.opts);
    assert.equal(c.sources.kospi_close, 'kis_j');
    assert.equal(c.sources.kospi_ma20, 'kis_j');
    // 타 출처로 조작 → 기록 거부(DAT-013 제약)
    const bad = JSON.parse(JSON.stringify(c));
    bad.sources.kospi_close = 'naver_intraday';
    assert.throws(() => market.saveSnapshot(bad, JUDGE_STUB, s.opts), /kis_j|기록 거부/);
  } finally {
    await down(s);
  }
});

// ===== 시나리오 3 + REQ-022 AC2: 네이버 일봉·종목 basic 참조 0건(코드 전수 검사) =====
test('시나리오3: src 전수에 네이버 일봉(chart/domestic)·종목 basic(api/stock) 참조 0건', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    assert.ok(!src.includes('chart/domestic/item'), `${f}: 네이버 일봉 금지`);
    assert.ok(!/api\/stock\//.test(src), `${f}: 네이버 종목 basic 금지`);
  }
});

// ===== 시나리오 4 + REQ-022 AC3: 웹 검색 군의당 1회(같은 날 재수집 시 캐시) =====
test('시나리오4: 같은 날 2회 수집해도 웹 검색(strategist 호출)은 1회', async () => {
  const s = await boot();
  try {
    await market.collect(s.opts);
    await market.collect(s.opts);
    const calls = ledgerRows(s.dir, 'strategist_log').filter((r) => r.type === 'call' && r.feature === 'overnight');
    assert.equal(calls.length, 1, '웹 검색 1회(캐시 재사용)');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 5: 장중 지수(네이버)는 판정 입력에 미사용 — 참고 표기만 =====
test('시나리오5: intraday는 judgeInputs 밖·reference_only 표기', async () => {
  const s = await boot();
  try {
    const c = await market.collect(s.opts);
    assert.equal(c.intraday.reference_only, true, '참고용 고정 표기');
    assert.equal(c.intraday.source, 'naver_intraday');
    assert.equal(c.intraday.chgPct, -0.42);
    assert.ok(!('intraday' in c.judgeInputs), '판정 입력에 미포함');
    assert.ok(!JSON.stringify(Object.keys(c.judgeInputs)).includes('naver'), '판정 입력에 네이버 값 없음');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 6 + REQ-022 AC4 + AC4(수집기 독립): 네이버 차단 → 해당 값만 결측·대체 0 =====
test('시나리오6: 네이버 차단 시 intraday만 결측, 대체 출처 유입 0, 나머지 정상', async () => {
  const s = await boot({ noNaver: true });
  try {
    const c = await market.collect(s.opts);
    assert.equal(c.intraday, null, 'intraday 결측');
    assert.ok(c.missing.includes('intraday'), '결측 표시');
    assert.equal(c.judgeInputs.kospi_close, 5024, 'KIS는 정상');
    assert.equal(c.judgeInputs.night_future_pct, -4.56, '웹검색 정상');
    // 대체 출처 금지: 판정 입력 어디에도 네이버 값이 스며들지 않음
    assert.equal(c.sources.kospi_close, 'kis_j');
  } finally {
    await down(s);
  }
});

// ===== 에지: KIS 지수 일봉 실패 → kospi만 결측, 수집은 계속(군의 비블로킹) =====
test('에지: KIS 실패 시 kospi 결측으로 선진행', async () => {
  const s = await boot({ kis: { indexFail: true } });
  try {
    const c = await market.collect(s.opts);
    assert.ok(c.missing.includes('kospi_close'), 'kospi 결측');
    assert.equal(c.judgeInputs.kospi_close, null);
    assert.equal(c.judgeInputs.night_future_pct, -4.56, '다른 수집은 정상');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 7 + AC5: 외국인 TR 제안서 존재(근거·군사 검토 대기) =====
test('시나리오7: 외국인 순매수 TR 제안서 — 후보·근거·미확정 표시', () => {
  const p = path.join(__dirname, '..', 'docs', 'investor_tr_proposal.md');
  const doc = fs.readFileSync(p, 'utf8');
  assert.match(doc, /refs\/api/, 'refs/api 확인 근거');
  assert.match(doc, /군사 검토 대기|군사.*검토/, '검토 대기 표시');
  assert.match(doc, /미확정|추측.*금지|확정하지 않/, '확정 아님 명시');
  assert.match(doc, /FHKST01010900|FHPTJ/, 'TR 후보 기재');
});

// ===== overnight 전용 도구: WebSearch만 허용(파일·셸 여전히 금지) =====
test('strategist: overnight 기능은 WebSearch만, 기본은 도구 0 유지', () => {
  const def = strategist.claudeArgs();
  assert.equal(def[def.indexOf('--tools') + 1], '', '기본 도구 0');
  const ov = strategist.claudeArgs('overnight');
  assert.equal(ov[ov.indexOf('--tools') + 1], 'WebSearch', 'overnight는 WebSearch만');
  assert.ok(ov.includes('--strict-mcp-config'), 'MCP 차단 유지');
});

// ===== 스냅샷 수정 금지: 같은 날 재기록은 새 버전 파일 =====
test('스냅샷: 같은 날 재판정은 새 버전 파일(수정 금지)', async () => {
  const s = await boot();
  try {
    const c = await market.collect(s.opts);
    const f1 = market.saveSnapshot(c, JUDGE_STUB, s.opts);
    const f2 = market.saveSnapshot(c, Object.assign({}, JUDGE_STUB, { weather: 'neutral' }), s.opts);
    assert.notEqual(f1, f2, '새 버전 파일');
    assert.ok(fs.existsSync(f1) && fs.existsSync(f2), '이력 보존');
    assert.equal(JSON.parse(fs.readFileSync(f1, 'utf8')).weather, 'defense', '원본 불변');
  } finally {
    await down(s);
  }
});

// =====================================================================
// TSK-015/016 보완 (군주 확정 2026-11-25)
// =====================================================================

// ===== 외국인 TR 확정: FHPTJ04040000·파라미터 검증 =====
test('보완: 외국인 투자자 동향 TR FHPTJ04040000·U·0001·KSP 파라미터', async () => {
  const s = await boot();
  try {
    await market.collect(s.opts);
    const req = s.kisSrv.received.find((r) => r.path.endsWith('inquire-investor-daily-by-market'));
    assert.ok(req, '투자자 동향 호출');
    assert.equal(req.trId, 'FHPTJ04040000', '확정 TR');
    assert.equal(req.query.FID_COND_MRKT_DIV_CODE, 'U');
    assert.equal(req.query.FID_INPUT_ISCD, '0001');
    assert.equal(req.query.FID_INPUT_ISCD_1, 'KSP');
    assert.equal(req.query.FID_INPUT_ISCD_2, '0001');
    assert.ok(req.query.FID_INPUT_DATE_1 && req.query.FID_INPUT_DATE_2, '조회일 파라미터');
  } finally {
    await down(s);
  }
});

// ===== 외국인 수집 실패 → 결측(대체 금지) =====
test('보완: 투자자 동향 실패 시 foreign만 결측·나머지 정상', async () => {
  const s = await boot({ kis: { investorFail: true } });
  try {
    const c = await market.collect(s.opts);
    assert.ok(c.missing.includes('foreign_net_days'), '결측');
    assert.equal(c.judgeInputs.foreign_net_days, null);
    assert.equal(c.judgeInputs.kospi_close, 5024, '지수는 정상');
  } finally {
    await down(s);
  }
});

// ===== overnight 입력 순수성: 장부·계좌·키 관련 정보 0 =====
test('보완: overnight 프롬프트에 장부·계좌·키 정보가 없다', async () => {
  const s = await boot();
  try {
    // 민감 데이터를 환경에 심어 둔다 — 프롬프트에 새면 실패
    state.write('positions', [{ id: 'p1', account_type: 'real', symbol: '005930', qty: 88, avg_price: 61600, stop_price: 59000, target_price: 66000, deadline: '2026-12-05', status: 'open' }], { dataDir: s.dir });
    secret.saveToken('kis_token_real', { token: 'SUPER-SECRET-TOKEN-XYZ', expires: '2026-11-26 23:59:59' }, { dataDir: s.dir });

    // 가짜 CLI가 stdin(프롬프트)을 파일로 남기도록 교체
    const dumpFile = path.join(s.dir, 'stdin-dump.txt');
    const cli = path.join(s.dir, 'dump-cli.js');
    fs.writeFileSync(cli, `
const fs=require('fs');
let input=''; try{input=fs.readFileSync(0,'utf8');}catch(e){}
fs.writeFileSync(${JSON.stringify(dumpFile)}, input);
process.stdout.write(JSON.stringify({sp500:-0.8,nasdaq:-1.4,sox:-2.1,vix:26.36,night_future_pct:-4.56}));
`, 'utf8');
    s.opts.strategistOpts.claudeArgsPrefix = [cli];

    await market.collect(s.opts);
    const prompt = fs.readFileSync(dumpFile, 'utf8');
    for (const bad of ['SUPER-SECRET', '61600', '88', 'positions', 'secrets', 'appkey', '계좌', '잔고']) {
      assert.ok(!prompt.includes(bad), `프롬프트에 민감 정보 없음: ${bad}`);
    }
    assert.match(prompt, /야간선물|S&P|미국/, '요청 내용은 시장 수치뿐');
  } finally {
    await down(s);
  }
});

// ===== 카나리아 스크립트: overnight 인자 모드 존재(실행하지 않음 — 군주 승인 후 1회) =====
test('보완: 카나리아 스크립트에 overnight 모드가 있고 승인 문구가 있다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'canary-strategist.js'), 'utf8');
  assert.match(src, /--overnight|overnight/, 'overnight 모드');
  assert.match(src, /군주 승인/, '실행은 군주 승인 후');
  assert.match(src, /CANARY/, '카나리아 파일 검증');
});
