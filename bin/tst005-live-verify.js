'use strict';

// TSK-006 모의 전수 검증 — 실제 모의(VTS)계좌 대상 차단 사유 전수 재현 (지령 006)
//
// 허용 범위(지령 006에 한함): 모의(VTS) 도메인 실호출, 실전 도메인 '조회'
// (시세·일봉·지수 일봉·투자자 동향)만. 실전 주문·정정·취소 호출 0.
//  - 하루 손실(daily_loss)은 '실전 잔고 조회'가 필요한데 허용 목록 밖 → 보류(보고로 올림).
//  - 키는 GUJIGA_KIS_KEYS(.enc) in-process. 토큰은 gujiga-data 캐시를 복사해 재사용 —
//    새 발급이 일어나면 token_log 수로 드러난다(보고 항목). 키·토큰 값 출력 0.
//  - 증거 보존: 전용 데이터 폴더 %USERPROFILE%\gujiga-data-tst006 (본 장부 오염 0).
//
// 사용: node bin/tst005-live-verify.js [출력번호]
//  - 결과는 콘솔과 함께 _campaign/reports/<번호>-live-output.md 에 UTF-8로 직접 쓴다
//    (PowerShell 리디렉션 한글 깨짐 방지 — 지령 007). 번호 기본값 007.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const gate = require('../src/gate');
const state = require('../src/state');
const ledger = require('../src/ledger');
const paths = require('../src/paths');

// 시험 격리(지령 008): 실행마다 새 증거 폴더에서 빈 상태로 시작 — 같은 날 재실행 때
// 이전 실행의 포로일(15번) 기록이 남아 11~14번이 전부 revenge로 오염되는 문제 방지.
// 이전 실행 폴더는 지우지 않는다(증거 보존).
function runStamp() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace(/-/g, '').replace(/:/g, '').replace('T', '-');
}
const DATA = path.join(os.homedir(), 'gujiga-data-tst006', runStamp());
// gapMs 600: 연속 잔고·일봉 조회의 초당 거래건수 제한(EGW00201)으로 조회가 실패하면
// ration30 '안전 차단'이 떠서 재현 라벨이 어긋난다(1차 실행 13번 불일치의 유력 원인).
const opts = { dataDir: DATA, keysPath: process.env.GUJIGA_KIS_KEYS || 'C:\\Users\\조용수\\.aside\\u\\1\\secrets\\kis.json.enc', gapMs: 600 };
const STOP = path.join(DATA, 'STOP');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 결과를 UTF-8 파일에 직접 기록(지령 007 — 리디렉션 한글 깨짐 방지)
const OUT_NO = (process.argv[2] || '007').replace(/[^0-9]/g, '') || '007';
const OUT_PATH = path.join(__dirname, '..', '_campaign', 'reports', `${OUT_NO}-live-output.md`);
const outLines = [];
function say(line) {
  console.log(line);
  outLines.push(line);
}
function flushOut() {
  try {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, `# TST-005 실계좌 전수 검증 출력 (${new Date().toISOString()})\n\n` + outLines.join('\n') + '\n', 'utf8');
  } catch (e) { console.log('출력 파일 기록 실패:', e.message); }
}

function kstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
const TODAY = kstToday();
const TODAY8 = TODAY.replace(/-/g, '');

function readL(name) {
  const d = paths.ledgerDir(DATA, name);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}

// 수익률·피어슨(gate와 같은 정의 — 경계 기록용)
function returnsOf(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  return out;
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

function seed() {
  fs.mkdirSync(path.join(DATA, 'secrets'), { recursive: true });
  // 토큰 캐시 재사용(gujiga-data → 검증 폴더 복사, 값은 읽지 않음)
  const src = path.join(os.homedir(), 'gujiga-data', 'secrets');
  for (const f of ['token_kis_token_mock.enc', 'token_kis_token_real.enc']) {
    const p = path.join(src, f);
    if (fs.existsSync(p) && !fs.existsSync(path.join(DATA, 'secrets', f))) fs.copyFileSync(p, path.join(DATA, 'secrets', f));
  }
  state.write('guard_config', {
    id: 'default', per_order_limit_real: 200000, per_order_limit_paper: 500000,
    daily_loss_limit: -50000, stop_file_path: STOP,
    cash_ratio_min: 0.3, correlation_max: 0.7, sample_min: 10, updated_at: new Date().toISOString(),
  }, opts);
  state.write('hypothesis_book', { items: [
    { id: 'HYP-V', code: 'V', category: 'A', statement: '검증됨 더미', status: 'verified', citable: true, evidence_count: 12, trade_count: 4, reference_only: false, created_at: 'x' },
    { id: 'HYP-T', code: 'T', category: 'A', statement: '검증 중 더미', status: 'testing', citable: true, evidence_count: 5, trade_count: 1, reference_only: true, created_at: 'x' },
  ] }, opts);
  // 관직 태수(한 성 30만·동시 2성) — 세력전 25만 한도가 관직 한도보다 먼저 걸리는지 보려고
  state.write('general_rank', { id: 'me', rank: 'taesu', per_stock_troops_max: 30, concurrent_max: 2, sortie_count: 0, clean_weeks: 0, review_weeks: 0, promoted_at: null, updated_at: 'x' }, opts);
  state.write('watchlist', [{ symbol: '005930', status: 'ready' }], opts);
  state.write('positions', [], opts);
}

function paperDraft(over) {
  return Object.assign({
    account_type: 'paper', nation: 'chok', symbol: '005930', side: 'buy',
    entry_low: 9000, entry_high: 11000, stop_price: 8000, target_price: 15000,
    deadline: '2026-12-05', troops: 10, qty: 10, price: 10000,
    user_confirmed: true, created_by: 'human', reason: 'TST-005 전수 재현', hypothesis_ids: ['HYP-V'],
  }, over || {});
}

const results = [];
async function expectBlock(label, draft, wantReason) {
  let r;
  try {
    r = await gate.submit(draft, opts);
  } catch (e) {
    r = { error: e.message };
  }
  const got = r.reason || (r.error ? `error:${r.error}` : (r.ok ? 'PASSED(!)' : '?'));
  const ok = r.blocked === true && (wantReason instanceof RegExp ? wantReason.test(r.reason) : r.reason === wantReason);
  results.push({ label, want: String(wantReason), got, ok, detail: r.detail || null });
  // detail의 note까지 출력 — '잔고 조회 실패(안전 차단)' 같은 원인 구분용(지령 007)
  const extra = [
    r.detail && r.detail.corr != null ? `corr=${r.detail.corr}` : null,
    r.detail && r.detail.cash_after_pct != null ? `cash_after=${r.detail.cash_after_pct}%` : null,
    r.detail && r.detail.note ? `note=${r.detail.note}` : null,
    r.detail && r.detail.kind ? `kind=${r.detail.kind}` : null,
  ].filter(Boolean).join(' ');
  say(`${ok ? 'OK ' : 'XX '} ${label}: ${got}${extra ? ' ' + extra : ''}`);
  await sleep(700); // 초당 거래건수 제한 회피(연속 잔고 조회 간격)
}

(async () => {
  seed();
  say(`증거 폴더(시험 격리 — 실행마다 새로): ${DATA}`);
  const tokenRowsBefore = readL('token_log').length;

  // --- 네트워크 이전 단계(①~⑤ 한도) — 호출 0 구간 ---
  fs.writeFileSync(STOP, '');
  await expectBlock('1 STOP 파일', paperDraft(), 'stop_file');
  fs.rmSync(STOP);

  await expectBlock('2 5항목 누락(손절선)', paperDraft({ stop_price: null }), /^draft_invalid/);
  await expectBlock('3 근거 없음', paperDraft({ hypothesis_ids: [] }), 'no_rationale');
  await expectBlock('4 나라 없음(모의 매수)', paperDraft({ nation: null }), 'no_nation');
  await expectBlock('5 실행 확인 없음(실전)', paperDraft({ account_type: 'real', user_confirmed: false }), 'no_confirm');
  await expectBlock('6 화이트리스트 밖(실전)', paperDraft({ account_type: 'real', symbol: '000660' }), 'not_whitelisted');
  await expectBlock('7 시장가(가격 없음)', paperDraft({ price: null }), 'market_order');
  await expectBlock('8 1회 한도(모의 51만)', paperDraft({ troops: 51, qty: 51 }), 'per_order_limit');
  await expectBlock('9 1회 한도(실전 21만)', paperDraft({ account_type: 'real', troops: 21, qty: 21 }), 'per_order_limit');

  // --- VTS 잔고·일봉 실호출 구간(⑥) ---
  // 10 군량 30%: 모의계좌 실잔고로는 30% 밑으로 못 내리므로 기준만 0.999999로 올려 같은 식 재현.
  // try/finally로 원복 보장(지령 007 — 이후 사례가 ration30으로 오염되는 일 방지).
  try {
    const g = state.read('guard_config', opts);
    g.cash_ratio_min = 0.999999;
    state.write('guard_config', g, opts);
    await expectBlock('10 군량 30%(기준 상향 재현, 실잔고)', paperDraft(), 'ration30');
  } finally {
    const g2 = state.read('guard_config', opts);
    g2.cash_ratio_min = 0.3;
    state.write('guard_config', g2, opts);
  }

  // 11 상관 0.7: 보유 069500(KODEX 200) 중 102110(TIGER 200) 매수 — 실일봉 피어슨
  state.write('positions', [{ id: 'p1', account_type: 'paper', nation: 'chok', symbol: '069500', qty: 1, avg_price: 10000, stop_price: 8000, target_price: 15000, deadline: '2026-12-10', status: 'open' }], opts);
  await expectBlock('11 상관 0.7(069500 보유 중 102110)', paperDraft({ symbol: '102110' }), 'correlation');
  state.write('positions', [], opts);

  // --- ⑦ 관직·등급·세력전(상태만 — 호출 0) ---
  await expectBlock('12 등급 상한(검증 중 가설 16명, 태수 절반 15)', paperDraft({ troops: 16, qty: 16, hypothesis_ids: ['HYP-T'] }), 'grade_cap');
  await expectBlock('13 세력전 종목당 25만(26만)', paperDraft({ troops: 26, qty: 26 }), 'nation_limit');
  state.write('positions', [
    { id: 'p1', account_type: 'paper', nation: 'chok', symbol: '000001', qty: 1, avg_price: 10000, stop_price: 8000, target_price: 15000, deadline: '2026-12-10', status: 'open' },
    { id: 'p2', account_type: 'paper', nation: 'chok', symbol: '000002', qty: 1, avg_price: 10000, stop_price: 8000, target_price: 15000, deadline: '2026-12-10', status: 'open' },
  ], opts);
  await expectBlock('14 세력전 동시 2종목 중 3번째', paperDraft({ symbol: '000003' }), 'nation_limit');
  state.write('positions', [], opts);

  // 15 포로일(복수 금지) — 다른 모의 사례 끝난 뒤 마지막에(이후 모의 매수 전부 막히므로)
  ledger.append('captive_ledger', { id: crypto.randomUUID(), account_type: 'paper', trade_date: TODAY, realized_pnl: -10000, order_log_id: 'verify006', created_at: new Date().toISOString() }, opts);
  await expectBlock('15 포로일 신규 출병 금지', paperDraft(), 'revenge');

  // 16 하루 손실(실전 전용): 실전 '잔고' 조회가 필요한데 지령 허용 목록 밖 → 보류
  results.push({ label: '16 하루 손실(실전 전용)', want: 'daily_loss', got: '보류(실전 잔고 조회 필요 — 허용 목록 밖, 군주 결정)', ok: null });
  say('-- 16 하루 손실: 보류(실전 잔고 조회 필요 — 허용 목록 밖)');

  // --- 증권사 쪽 증거: 모의계좌 당일 주문 내역(러너 주문 0건 — 주문번호 대조용 전 행 출력) ---
  let fills = null;
  try {
    fills = await gate.query('mock', 'fills', [TODAY8], opts);
    say(`모의계좌 당일 주문·체결 내역: ${fills.rows.length}건 (rt=${fills.rt})`);
    for (const row of fills.rows) {
      say(`  주문번호 ${row.odno} | ${row.side} | ${row.symbol || row.name} | ${row.ordQty}주@${row.ordPrice} | 취소 ${row.cancelled} | ${row.time}`);
    }
  } catch (e) {
    say('모의 체결조회 실패: ' + e.message);
  }

  // --- 상관 경계 기록: 실일봉 피어슨(실전 도메인 '일봉' 조회 — 허용) ---
  // 153130(KODEX 단기채권)은 0.7 아래 대조군(지령 007 — 경계 양쪽을 다 본다)
  const pairs = [['069500', '102110'], ['069500', '005930'], ['069500', '153130']];
  for (const [a, b] of pairs) {
    try {
      const ca = await gate.query('real', 'dailyCandle', [a, 120], opts);
      await sleep(600);
      const cb = await gate.query('real', 'dailyCandle', [b, 120], opts);
      await sleep(600);
      const r = pearson(returnsOf(ca.map((x) => x.close)), returnsOf(cb.map((x) => x.close)));
      const n = Math.min(ca.length, cb.length) - 1;
      say(`상관(실일봉): ${a}×${b} = ${r.toFixed(4)} (표본 ${n}) → ${r >= 0.7 ? '차단권(>=0.7)' : '통과권(<0.7)'}`);
      results.push({ label: `상관 경계 ${a}×${b}`, want: 'measure', got: r.toFixed(4), ok: true });
    } catch (e) {
      say(`상관 측정 실패 ${a}×${b}: ` + e.message);
    }
  }

  // --- 실관찰: 지수 일봉 U·0001, 투자자 동향 필드명·최신일 ---
  try {
    const idx = await gate.query('real', 'dailyIndexCandle', ['0001', 30], opts);
    const last = idx[idx.length - 1];
    say(`지수 일봉(FHKUP03500100 U·0001): ${idx.length}행, 최신 ${last.date} 종가 ${last.close} (source=${last.source})`);
  } catch (e) {
    say('지수 일봉 실패: ' + e.message);
  }
  await sleep(600);
  try {
    const inv = await gate.query('real', 'investorDaily', [10], opts);
    const fieldSet = [...new Set(inv.map((x) => x.field))];
    say(`투자자 동향(FHPTJ04040000): ${inv.length}행, 외국인 필드 = ${fieldSet.join(',')}, 최신 ${inv[0] && inv[0].date} 값 ${inv[0] && inv[0].foreignNet}`);
    say(`  (최신일이 오늘/전 거래일이면 날짜 파라미터 수정 확인 — '(미검증-날짜)' 해제 판단 자료)`);
  } catch (e) {
    say('투자자 동향 실패: ' + e.message);
  }

  // --- 전송 0 증명 + 토큰 발급 여부 ---
  const ol = readL('order_log');
  const byStatus = {};
  for (const r of ol) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const sent = ol.filter((r) => ['submitted', 'filled', 'partial', 'rejected'].includes(r.status));
  say(`order_log: ${JSON.stringify(byStatus)} — 전송 시도 ${sent.length}건`);
  const tokenRowsAfter = readL('token_log');
  say(`토큰 신규 발급: ${tokenRowsAfter.length - tokenRowsBefore}건 (env: ${tokenRowsAfter.map((t) => t.env).join(',') || '없음'})`);

  const bad = results.filter((r) => r.ok === false);
  say(`\n결과: 재현 ${results.filter((r) => r.ok === true).length} · 보류 ${results.filter((r) => r.ok === null).length} · 불일치 ${bad.length}`);
  fs.writeFileSync(path.join(DATA, 'verify006_results.json'), JSON.stringify({ date: TODAY, results, order_log_status: byStatus, fills_today: fills ? fills.rows.length : null }, null, 2));
  flushOut();
  say(`출력 저장: ${OUT_PATH}`);
  if (bad.length) process.exit(1);
})();
