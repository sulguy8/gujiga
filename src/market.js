'use strict';

// 시장 데이터 수집 계층 — 수집기 4종 (TSK-015 / ARC-008 / REQ-022)
//
//  ① daily-kis     : KIS 지수·종목 일봉(J/U — KRX 공식) → 종가·20일선. **판정용 유일 출처(kis_j)**
//  ② intraday-naver: 네이버 m.stock '지수' API — 참고·정찰용만(판정 입력에 넣지 않는다)
//  ③ overnight-web : strategist(군사 엔진) 웹 검색 1회 — 미국 4지표·야간선물. 군의당 1회 캐시, 상한 집계 포함
//  ④ investor-kis  : 외국인 순매수 — TR id 미확정(docs/investor_tr_proposal.md, 군사 검토 대기) → '결측'
//
// 공통 규칙(ARC-008):
//  - 결측이면 대체 출처로 메우지 않는다 — missing에 표시(판정은 보수).
//  - 네이버 '일봉'(chart/domestic)·'종목 basic'은 NXT 포함이라 어떤 경로에도 쓰지 않는다(retro 교훈).
//  - KIS 호출은 gate.query 경유(어댑터 직접 접근 금지 — AC3 유지).
// 산출: market_snapshot 1일 1행(DAT-013) — 판정(TSK-016) 결과와 합쳐 saveSnapshot으로 기록.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const gate = require('./gate');
const state = require('./state');
const strategist = require('./strategist');
const paths = require('./paths');
const { kstParts } = require('./kst');

const KOSPI_INDEX_CODE = '0001';

// ① KIS 지수 일봉 → 종가·20일선(정확히 최근 20거래일 평균)
async function dailyKospi(opts) {
  const bars = await gate.query('real', 'dailyIndexCandle', [KOSPI_INDEX_CODE, 120], opts);
  if (!bars || bars.length === 0) throw new Error('지수 일봉 0건');
  const closes = bars.map((b) => b.close);
  const close = closes[closes.length - 1];
  const ma20 = closes.length >= 20
    ? closes.slice(-20).reduce((s, x) => s + x, 0) / 20
    : null;
  return { close, ma20, bars: bars.length, source: 'kis_j' };
}

// ② 네이버 m.stock '지수' API(장중) — 참고용 고정. 판정 입력 금지.
function intradayNaver(opts) {
  const base = (opts && opts.naverBase) || 'https://m.stock.naver.com';
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(`${base}/api/index/KOSPI/basic`);
    } catch (e) {
      return resolve(null);
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve({
            chgPct: parseFloat(j.fluctuationsRatio),
            value: parseFloat(String(j.closePrice || '').replace(/,/g, '')),
            source: 'naver_intraday',
            reference_only: true, // 참고·정찰용만 — 판정에 쓰지 않는다
          });
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ③ 밤사이 미국·야간선물 — strategist 웹 검색 1회(군의당 1회 캐시·상한 집계 포함)
function overnightCachePath(dataDir, date) {
  return path.join(dataDir, 'market_cache', `overnight_${date}.json`);
}
async function overnightWeb(date, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const cacheFile = overnightCachePath(dataDir, date);
  if (fs.existsSync(cacheFile)) {
    return Object.assign(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), { cached: true });
  }
  const res = strategist.call('overnight', {
    data: {
      request: '밤사이 미국 마감(S&P500·나스닥·SOX·VIX)과 코스피200 야간선물 등락률을 웹 검색 1회로 찾아 JSON으로.',
      date,
    },
  }, opts.strategistOpts || opts);
  if (!res.ok || !res.data) return null; // degrade → 결측(대체 출처 금지)
  const d = res.data;
  const out = {
    us_summary: { sp500: d.sp500, nasdaq: d.nasdaq, sox: d.sox, vix: d.vix },
    night_future_pct: typeof d.night_future_pct === 'number' ? d.night_future_pct : null,
    source: 'websearch',
  };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out), 'utf8');
  return out;
}

// ④ 외국인 순매수 — TR FHPTJ04040000 확정(군주 2026-11-25).
// 필드명(frgn_ntby_tr_pbmn)은 2026-11-25 실관찰로 **확인됨**(지령 007 — 필드 태그 해제).
// 날짜 파라미터 수정(기준일=오늘)은 다음 실관찰에서 최신일 확인 전까지 '(미검증-날짜)' —
// 그때까지 신호 4번은 결측 처리(보수 꺼짐). 확인되면 아래 상수를 true로(지령으로만 변경).
const FOREIGN_DATE_VERIFIED = false;
// 연속 일수: 최신일의 순매수 부호가 이어지는 일수(순매도면 음수).
async function investorKis(opts) {
  const rows = await gate.query('real', 'investorDaily', [10], opts); // 최신 먼저
  if (!rows || rows.length === 0) throw new Error('투자자 동향 0건');
  const sign = Math.sign(rows[0].foreignNet);
  if (sign === 0) return { net_days: 0, unverified: true };
  let n = 0;
  for (const r of rows) {
    if (Math.sign(r.foreignNet) !== sign) break;
    n++;
  }
  return { net_days: sign * n, unverified: true };
}

// --- 수집 오케스트레이션: 한 번에 모아 judgeInputs(판정 입력)와 참고값을 분리해 반환 ---
async function collect(opts) {
  const date = kstParts(opts.now || new Date()).date;
  const sources = {};
  const missing = [];
  const judgeInputs = {
    night_future_pct: null, kospi_close: null, kospi_ma20: null,
    foreign_net_days: null, us_summary: null,
    sox_base_low: null, sox_base_low_date: null, event_calendar: null,
  };

  // ① KIS 지수 일봉 — 실패해도 선진행(군의 비블로킹, 결측 보수 판정)
  try {
    const k = await dailyKospi(opts);
    judgeInputs.kospi_close = k.close;
    judgeInputs.kospi_ma20 = k.ma20;
    sources.kospi_close = 'kis_j';
    sources.kospi_ma20 = 'kis_j';
    if (k.ma20 == null) missing.push('kospi_ma20');
  } catch (e) {
    missing.push('kospi_close', 'kospi_ma20');
  }

  // ③ 밤사이 웹 검색(1회 캐시)
  const on = await overnightWeb(date, opts);
  if (on) {
    judgeInputs.night_future_pct = on.night_future_pct;
    judgeInputs.us_summary = on.us_summary;
    sources.us_summary = 'websearch';
    sources.night_future_pct = 'websearch';
    if (on.night_future_pct == null) missing.push('night_future_pct');
  } else {
    missing.push('night_future_pct', 'us_summary');
  }

  // ④ 외국인 — 필드명 확인됨(실관찰 2026-11-25). 날짜 수정 확인 전엔 결측 처리(보수 꺼짐).
  const unverified = [];
  try {
    const inv = await investorKis(opts);
    if (FOREIGN_DATE_VERIFIED) {
      judgeInputs.foreign_net_days = inv.net_days;
      sources.foreign_net_days = 'kis_investor';
    } else {
      // (미검증-날짜): 값은 받았어도 판정에 넣지 않는다 — 결측과 같은 보수 동작
      judgeInputs.foreign_date_unverified = true;
      missing.push('foreign_net_days');
      unverified.push('foreign_net_days(미검증-날짜)');
    }
  } catch (e) {
    missing.push('foreign_net_days');
  }

  // 장부 값: 기준 저점·이벤트 캘린더(사람 관리)
  const reentry = state.read('reentry_record', opts);
  if (reentry && reentry.sox_base_low != null) {
    judgeInputs.sox_base_low = reentry.sox_base_low;
    judgeInputs.sox_base_low_date = reentry.sox_base_low_date || null;
    // SOX 최근 3거래일 최저도 재진입 기록(장부)에서 — 루틴이 갱신, 없으면 신호 3 보수 꺼짐
    judgeInputs.sox_recent3_low = reentry.sox_recent3_low != null ? reentry.sox_recent3_low : null;
    if (judgeInputs.sox_recent3_low == null) missing.push('sox_recent3_low');
  } else {
    missing.push('sox_base_low');
  }
  const cal = state.read('event_calendar', opts);
  if (cal && Array.isArray(cal.events)) judgeInputs.event_calendar = cal.events;
  else missing.push('event_calendar');

  // ② 장중 지수(참고용) — judgeInputs 밖에 둔다
  const intraday = await intradayNaver(opts);
  if (intraday) sources.intraday = 'naver_intraday';
  else missing.push('intraday');

  return { date, judgeInputs, intraday, sources, missing, unverified };
}

// --- market_snapshot 기록(DAT-013): 1일 1행, 수정 금지 — 재판정은 새 버전 파일 ---
const WEATHERS = new Set(['defense', 'attack', 'neutral']);
const STAGES = new Set(['wait', 's1', 's2', 's3', 'halt']);

function saveSnapshot(collected, judgment, opts) {
  // 출처 제약(DAT-013): 종가·20일선 태그는 kis_j만 — 다른 값이면 기록 거부
  for (const f of ['kospi_close', 'kospi_ma20']) {
    if (collected.sources[f] != null && collected.sources[f] !== 'kis_j') {
      throw new Error(`기록 거부: ${f} 출처는 kis_j만 허용(받음: ${collected.sources[f]})`);
    }
  }
  if (!WEATHERS.has(judgment.weather)) throw new Error('기록 거부: weather는 판정 함수 출력만');
  if (!STAGES.has(judgment.stage)) throw new Error('기록 거부: stage는 판정 함수 출력만');

  const row = {
    snapshot_date: collected.date,
    night_future_pct: collected.judgeInputs.night_future_pct,
    kospi_close: collected.judgeInputs.kospi_close,
    kospi_ma20: collected.judgeInputs.kospi_ma20,
    foreign_net_days: collected.judgeInputs.foreign_net_days,
    us_summary: collected.judgeInputs.us_summary,
    sox_base_low: collected.judgeInputs.sox_base_low,
    sox_base_low_date: collected.judgeInputs.sox_base_low_date,
    event_calendar: collected.judgeInputs.event_calendar,
    intraday_ref: collected.intraday, // 참고 표기(판정 미사용)
    weather: judgment.weather,
    signals: judgment.signals || [],
    stage: judgment.stage,
    sources: collected.sources,
    unverified: collected.unverified || [],
    missing: [...new Set([...(collected.missing || []), ...((judgment.missing) || [])])],
    created_at: new Date().toISOString(),
  };

  const dir = path.join(paths.resolveDataDir(opts), 'market_snapshot');
  fs.mkdirSync(dir, { recursive: true });
  // 수정 금지: 이미 있으면 .r2, .r3 … 새 버전 파일(이력 보존)
  let file = path.join(dir, `${collected.date}.json`);
  let rev = 2;
  while (fs.existsSync(file)) {
    file = path.join(dir, `${collected.date}.r${rev}.json`);
    rev++;
  }
  fs.writeFileSync(file, JSON.stringify(row, null, 2) + '\n', 'utf8');
  return file;
}

// 최신 스냅샷 읽기(군의·현황판·촉군 검사용)
function loadSnapshot(date, opts) {
  const dir = path.join(paths.resolveDataDir(opts), 'market_snapshot');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(date)).sort();
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
}

module.exports = { collect, saveSnapshot, loadSnapshot, dailyKospi, intradayNaver, overnightWeb, investorKis };
