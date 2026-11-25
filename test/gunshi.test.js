'use strict';

// TST-013 — 군사 엔진 4기능(TSK-014): 군의 해석·출사표·전략 건의·통찰
// 상위: ARC-007 / REQ-016~019 / spec_morning.md 6장(보고 형식)
// 실행: node --test — 실제 claude 호출 0(가짜 CLI가 신뢰 입력의 숫자를 그대로 되돌려줌)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const gunshi = require('../src/gunshi');
const secret = require('../src/secret');
const state = require('../src/state');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst013-'));
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

// 가짜 claude CLI: stdin의 [신뢰 입력] JSON을 파싱해 그 숫자 그대로 출력(모드별).
function writeFakeCli(dir) {
  const p = path.join(dir, 'gunshi-fake.js');
  const script = `
const fs=require('fs');
const mode=process.argv[2];
let input=''; try{input=fs.readFileSync(0,'utf8');}catch(e){}
let d={};
try{
  const seg=input.split('[신뢰 입력')[1];
  const s=seg.indexOf('{');
  const e=seg.indexOf('\\n}');
  d=JSON.parse(seg.slice(s,e+2));
}catch(e){}
const out=(o)=>process.stdout.write(JSON.stringify(o));
if(mode==='counsel_ok') out({
  market_lines:[\`밤사이 S&P \${d.us_summary.sp500}% 나스닥 \${d.us_summary.nasdaq}% SOX \${d.us_summary.sox}\`,
                \`야간선물 \${d.night_future_pct}% VIX \${d.us_summary.vix}\`],
  today_actions:['신규 출병 보류(방어)','성벽 점검','관심 종목 관망'],
});
else if(mode==='counsel_badnum') out({
  market_lines:['VIX 27.0 로 급등'], today_actions:['관망'],
});
else if(mode==='draft_ok') out({
  symbol:d.watch.symbol, side:'buy', account_type:'paper', nation:'chok',
  entry_low:d.watch.entry_low, entry_high:d.watch.entry_high,
  stop_price:d.watch.stop_price, target_price:d.watch.target_price,
  deadline:d.watch.deadline, troops:d.watch.troops,
  rationale:\`재진입 신호등 \${d.signal_on}/6 — 진입대 도달\`,
});
else if(mode==='draft_norationale') out({
  symbol:d.watch.symbol, side:'buy', account_type:'paper',
  entry_low:d.watch.entry_low, entry_high:d.watch.entry_high,
  stop_price:d.watch.stop_price, target_price:d.watch.target_price,
  deadline:d.watch.deadline, troops:d.watch.troops,
});
else if(mode==='advise_ok') out({
  criterion:d.criterion,
  evidence:\`근거 수치: \${d.evidence_value}\`,
  change_plan:'출병 보류로 전환', keep_plan:'기존 계획 유지',
});
else if(mode==='insight_ok') out({
  anecdotes:[\`관도 전투의 조조는 \${d.price}원 같은 열세에서 보급선을 지켰다\`],
  options:{
    top:{action:\`지금 매도 \${d.price}원\`, gain:'위험 축소', lose:'반등 기회 상실'},
    mid:{action:'절반 매도', gain:'균형', lose:'결단 지연'},
    low:{action:'보유 유지', gain:'반등 수혜', lose:'추가 하락 노출'},
  },
  recommend:'top',
  note:'최종 선택은 군주',
  counter_lesson:'반대로 원소는 머뭇거리다 때를 놓쳤다',
});
else if(mode==='insight_bad') out({ anecdotes:['x'], options:{}, recommend:'top' });
else out({});
`;
  fs.writeFileSync(p, script, 'utf8');
  return p;
}

// market.collect 환경(가짜 KIS·네이버·overnight) — market.test.js 패턴 축약판
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
        return reply({ rt_cd: '0', output: [
          { stck_bsop_date: '20261124', frgn_ntby_tr_pbmn: '1200' },
          { stck_bsop_date: '20261123', frgn_ntby_tr_pbmn: '-500' },
        ] });
      }
      if (u.pathname.endsWith('inquire-daily-indexchartprice')) {
        const out = Array.from({ length: 25 }, (_, i) => ({
          stck_bsop_date: String(20261001 + i), bstp_nmix_prpr: String(5300 - i * 12), acml_vol: '1',
        }));
        // 최신이 5006.03이 되도록 마지막 봉 조정, 20일선은 5322 근처
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

async function boot() {
  const dir = makeTmpDir();
  const keysPath = path.join(dir, 'k.enc');
  secret.encryptToFile(JSON.stringify({
    mock: { appkey: 'FA', appsecret: 'FS', account: '12345678' },
    real: { appkey: 'FAR', appsecret: 'FSR', account: '87654321' },
  }), keysPath);
  const kisSrv = await fakeKis();
  const fakeCli = writeFakeCli(dir);
  state.write('reentry_record', { sox_base_low: 8408.59, sox_base_low_date: '2026-11-10', sox_recent3_low: 8657.78 }, { dataDir: dir });
  state.write('event_calendar', { events: ['PCE 2026-11-26'] }, { dataDir: dir });
  state.write('signal_inputs', { event_within_2d: true }, { dataDir: dir }); // 신호 5 입력 자리
  // overnight 캐시를 미리 심어 수집 단계의 CLI 의존 제거(회귀 숫자)
  fs.mkdirSync(path.join(dir, 'market_cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'market_cache', 'overnight_2026-11-25.json'),
    JSON.stringify({ us_summary: { sp500: -0.8, nasdaq: -1.4, sox: 8832.5, vix: 26.36 }, night_future_pct: -4.56, source: 'websearch' }), 'utf8');

  const stratOpts = (mode) => ({
    dataDir: dir,
    claudeBin: process.execPath,
    claudeArgsPrefix: [fakeCli, mode],
    config: { daily_max: 8, breakdown: {}, owner_chat_counts_separately: true },
    today: '2026-11-25',
  });
  const opts = {
    dataDir: dir, keysPath,
    baseUrls: { mock: kisSrv.url, real: kisSrv.url }, gapMs: 5,
    naverBase: 'http://127.0.0.1:1', // intraday 결측 허용
    now: '2026-11-25T08:30:30+09:00',
    strategistOpts: stratOpts('counsel_ok'),
  };
  return { dir, kisSrv, fakeCli, opts, stratOpts };
}
async function down(s) {
  await s.kisSrv.close(); rm(s.dir);
}

// ===== 시나리오 1 + AC1: 군의 보고 형식(1줄 모드+날씨 / 2줄 N/6→단계 / 작전 ≤3 / ≤15줄) =====
test('시나리오1: 군의 조립 — collect→judge→snapshot→briefing→counsel, spec 형식', async () => {
  const s = await boot();
  try {
    const r = await gunshi.morningCouncil(s.opts);
    assert.equal(r.judgment.weather, 'defense');
    assert.equal(r.judgment.stage, 's1');
    const lines = r.report.split('\n').filter((l) => l.trim());
    assert.ok(lines.length <= 15, `보고 ${lines.length}줄 ≤ 15`);
    assert.match(lines[0], /\[계획 유지\]|\[액션 필요\]/, '1줄 모드 표식');
    assert.match(lines[0], /방어/, '1줄 날씨');
    assert.match(lines[1], /2\/6/, '2줄 신호등 N/6');
    assert.match(lines[1], /1차/, '2줄 단계');
    const actionIdx = lines.findIndex((l) => /오늘 할 일/.test(l));
    assert.ok(actionIdx > 0, '오늘 할 일 섹션');
    assert.ok(lines.length - 1 - actionIdx - 1 <= 3 + 1, '작전 ≤3줄');
    assert.match(lines[lines.length - 1], /참고용, 최종 결정은 본인/);
    // 이모지·em dash 금지
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(r.report), '이모지 0');
    assert.ok(!r.report.includes('—'), 'em dash 0');
    // 스냅샷·군의 파일 기록
    assert.ok(fs.existsSync(r.snapshotFile), '스냅샷 기록');
    assert.ok(fs.existsSync(r.reportFile), '군의 파일 기록');
    assert.equal(r.counselUsed, true, 'LLM 해석 사용');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 2 + AC2: 숫자 불일치 → 해당 기능 생략·기록(보고는 숫자만으로) =====
test('시나리오2: 해석 숫자 불일치(VIX 27.0) → counsel 생략·기록·최소 보고', async () => {
  const s = await boot();
  s.opts.strategistOpts = s.stratOpts('counsel_badnum');
  try {
    const r = await gunshi.morningCouncil(s.opts);
    assert.equal(r.counselUsed, false, '해석 생략');
    assert.match(r.report, /해석 생략|숫자만/, '최소 보고 표기');
    const log = rows(s.dir, 'gunshi_log').filter((x) => x.type === 'number_mismatch');
    assert.equal(log.length, 1, '불일치 기록');
    assert.equal(log[0].feature, 'counsel');
    assert.ok(JSON.stringify(log[0].bad).includes('27'), '불일치 수치 기록');
  } finally {
    await down(s);
  }
});

// ===== 숫자 검증기 단위 =====
test('검증기: 입력에 있는 숫자만 허용(작은 정수·날짜·시각은 통과)', () => {
  const inputs = { vix: 26.36, close: 5006.03, pct: -4.56 };
  assert.equal(gunshi.verifyNumbers('VIX 26.36, 코스피 5,006.03 (-4.56%) 신호 2/6 15:05 2026-11-25', inputs).ok, true);
  const bad = gunshi.verifyNumbers('VIX 27.0 급등', inputs);
  assert.equal(bad.ok, false);
  assert.ok(bad.bad.includes('27.0'));
});

// ===== 시나리오 3 + AC4: 출사표 초안 — 5항목 완전·ai·false·근거 =====
test('시나리오3: draft — 5항목 완전·ai·false·근거 포함 / 근거 없으면 거부·기록', async () => {
  const s = await boot();
  try {
    const watch = { symbol: '005930', entry_low: 61000, entry_high: 62000, stop_price: 59000, target_price: 66000, deadline: '2026-12-05', troops: 15 };
    const r = await gunshi.draftFromSignal({ watch, signal_on: 2 }, s.stratOpts('draft_ok'));
    assert.equal(r.saved, true);
    const drafts = rows(s.dir, 'order_draft');
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].created_by, 'ai');
    assert.equal(drafts[0].user_confirmed, false);
    assert.match(drafts[0].rationale, /2\/6/, '근거 포함(숫자 일치)');

    // 근거 없는 초안 → 저장 거부
    const r2 = await gunshi.draftFromSignal({ watch, signal_on: 2 }, s.stratOpts('draft_norationale'));
    assert.notEqual(r2.saved, true, '근거 없으면 거부');
    assert.equal(rows(s.dir, 'order_draft').length, 1, '추가 저장 0');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 4 + 경계: 전략 건의 4기준 각 1건·±2.0/±1.9 경계 =====
test('시나리오4: advise — 4기준 각각 발동·형식(기준·수치·변경안·유지안)·경계', async () => {
  const s = await boot();
  try {
    const cases = [
      { situation: { condition_impossible_all_day: true }, criterion: 1 },
      { situation: { wall_breached: { symbol: '005930', close: 58900, stop: 59000 } }, criterion: 2 },
      { situation: { index_move_vs_expected_pct: -2.0 }, criterion: 3 },
      { situation: { major_news: '대규모 유상증자 공시' }, criterion: 4 },
    ];
    for (const c of cases) {
      const r = await gunshi.advise(c.situation, s.stratOpts('advise_ok'));
      assert.equal(r.triggered, true, `기준${c.criterion} 발동`);
      assert.equal(r.advice.criterion, c.criterion, '기준 번호');
      assert.ok(r.advice.evidence && r.advice.change_plan && r.advice.keep_plan, '형식 완전');
      // 다른 원인으로 넘어가도록 dedup 키 초기화
      state.write('advise_state', {}, { dataDir: s.dir });
    }
    // 경계: ±1.9%는 미발동
    const edge = await gunshi.advise({ index_move_vs_expected_pct: 1.9 }, s.stratOpts('advise_ok'));
    assert.equal(edge.triggered, false, '1.9%는 미해당');
    // 건의 기록
    assert.equal(rows(s.dir, 'advise_log').length, 4, '건의 4건 기록');
  } finally {
    await down(s);
  }
});

// ===== 시나리오 5 + AC3: 평온한 하루 → 건의 0건·LLM 호출 0 =====
test('시나리오5: 4기준 미해당 → 건의 0·호출 0', async () => {
  const s = await boot();
  try {
    const before = rows(s.dir, 'strategist_log').filter((x) => x.type === 'call').length;
    const r = await gunshi.advise({ index_move_vs_expected_pct: 0.3 }, s.stratOpts('advise_ok'));
    assert.equal(r.triggered, false);
    const after = rows(s.dir, 'strategist_log').filter((x) => x.type === 'call').length;
    assert.equal(after, before, 'LLM 호출 0(침묵)');
  } finally {
    await down(s);
  }
});

// ===== 같은 기준·같은 원인 연속 건의 금지(REQ-018) =====
test('건의 dedup: 동일 원인 연속 → 2회째 생략', async () => {
  const s = await boot();
  try {
    const sit = { wall_breached: { symbol: '005930', close: 58900, stop: 59000 } };
    const r1 = await gunshi.advise(sit, s.stratOpts('advise_ok'));
    assert.equal(r1.triggered, true);
    const r2 = await gunshi.advise(sit, s.stratOpts('advise_ok'));
    assert.equal(r2.deduped, true, '연속 건의 생략');
    assert.equal(rows(s.dir, 'advise_log').length, 1);
  } finally {
    await down(s);
  }
});

// ===== 시나리오 6: 통찰 — 3종 결정 순간·형식 고정·degrade 생략 =====
test('시나리오6: insight — 형식(일화≤2·상중하책 얻는 것/잃는 것·추천 1·군주 문구)·반대 교훈', async () => {
  const s = await boot();
  try {
    for (const type of ['execute_wait', 'advise', 'judgment_needed']) {
      const r = await gunshi.insight({ type, data: { symbol: '005930', price: 58900, stop: 59000 } }, s.stratOpts('insight_ok'));
      assert.ok(r, `${type} 통찰 생성`);
      assert.ok(r.anecdotes.length >= 1 && r.anecdotes.length <= 2, '일화 1~2개');
      assert.ok(r.anecdotes.every((a) => a.split('\n').length <= 2), '일화 각 2줄 이내');
      for (const k of ['top', 'mid', 'low']) {
        assert.ok(r.options[k].action && r.options[k].gain && r.options[k].lose, `${k}책 얻는 것·잃는 것`);
      }
      assert.equal(r.recommend, 'top');
      assert.match(r.note, /최종 선택은 군주/);
      assert.ok(r.counter_lesson, '반대편 교훈 1개 허용');
      assert.match(r.anecdotes[0], /58,?900|58900/, '오늘 숫자와 연결');
    }

    // 형식 불량 → 생략·기록
    const bad = await gunshi.insight({ type: 'advise', data: { price: 58900 } }, s.stratOpts('insight_bad'));
    assert.equal(bad, null, '형식 불량 생략');
    assert.ok(rows(s.dir, 'gunshi_log').some((x) => x.type === 'format_invalid' && x.feature === 'insight'), '기록');

    // degrade(CLI 부재) → null·예외 없음(결정은 숫자만으로 가능)
    const deg = await gunshi.insight({ type: 'advise', data: { price: 58900 } }, {
      dataDir: s.dir, claudeBin: path.join(s.dir, 'no-such'), config: { daily_max: 8, breakdown: {} }, today: '2026-11-25',
    });
    assert.equal(deg, null, 'degrade 생략');
  } finally {
    await down(s);
  }
});

// ===== 상한 집계 유지: 4기능 호출이 전부 strategist_log에 집계 =====
test('상한: counsel·advise·insight 호출이 하루 상한(8회) 집계에 포함', async () => {
  const s = await boot();
  try {
    await gunshi.morningCouncil(s.opts);
    await gunshi.advise({ major_news: '공시' }, s.stratOpts('advise_ok'));
    await gunshi.insight({ type: 'advise', data: { price: 58900 } }, s.stratOpts('insight_ok'));
    const calls = rows(s.dir, 'strategist_log').filter((x) => x.type === 'call');
    assert.ok(calls.length >= 3, `집계 ${calls.length}건 ≥ 3`);
  } finally {
    await down(s);
  }
});
