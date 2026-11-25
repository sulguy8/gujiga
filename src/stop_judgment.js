'use strict';

// 종가 손절 판정·익일 매도 출사표·급락일 분기 (REQ-008 / TSK-008)
//
// 판정과 실행의 2단 분리:
//  - 판정: 'KRX 공식(증권사 일봉)' 출처 태그(source='krx_official')가 있는 종가가
//    손절선 아래로 마감했을 때만. 출처가 다르면(NXT 포함 시세 등) 판정을 거부·기록한다(retro 교훈).
//    장 마감(캘린더 closeTime — 수능일 16:30) 이후에만 실행. 장중 이탈은 scout이 기록만 한다.
//  - 실행 준비: 판정 다음 거래일 오전에 매도 출사표를 자동 생성한다 —
//    created_by='system', user_confirmed=false. 전송 경로는 존재하지 않는다(관문 TSK-005 전까지 전송 수단 0).
//  - 급락일(REQ-008 확정 숫자): 시가 ≤ 전일 종가 × 0.97(-3% 이상 하락 출발).
//    첫 반등 = 장중 저가 +2% 회복 첫 시점 → 실행 대상. 10:30까지 반등 없으면 10:30에 실행 대상.
//    '실행 대상'은 표시일 뿐 — 실제 매도는 사람 확인(게이트) 경유.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ledger = require('./ledger');
const paths = require('./paths');
const state = require('./state');
const calendar = require('./market_calendar');
const orderDraft = require('./order_draft');
const { kstParts, toMin } = require('./kst');

const OFFICIAL_SOURCE = 'krx_official'; // 수용하는 유일한 종가 출처 태그
const CRASH_OPEN_RATIO = 0.97;          // 급락일: 시가 ≤ 전일 종가 × 0.97
const REBOUND_RATIO = 1.02;             // 첫 반등: 저가 × 1.02 회복
const CRASH_DEADLINE_MIN = 10 * 60 + 30; // 10:30

function readRows(dataDir, name) {
  const d = paths.ledgerDir(dataDir, name);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

// 급락일 분류: 시가가 전일 종가 대비 -3% 이상 낮게 출발(9,700원 = 정확 -3.0%도 급락).
function isCrashOpen(prevClose, open) {
  return open <= prevClose * CRASH_OPEN_RATIO;
}

// 다음 거래일
function nextTradingDay(dateStr, opts) {
  let d = new Date(`${dateStr}T00:00:00`);
  for (let i = 0; i < 30; i++) {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (calendar.isTradingDay(s, opts)) return s;
  }
  throw new Error(`30일 내 다음 거래일 없음: ${dateStr}`);
}

// --- 종가 판정 (장 마감 후 1회) ---
// opts: { dataDir, now, providers:{dailyCandle}, notify }
function judgeClose(opts) {
  const dataDir = paths.resolveDataDir(opts);
  const notify = opts.notify || (() => {});
  const { date, minutes } = kstParts(opts.now || new Date());
  const nowIso = (opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now())).toISOString();

  if (!calendar.isTradingDay(date, opts)) return { judged: false, reason: 'holiday' };
  // 장 마감 이후에만(지시3) — 수능일은 16:30 이후
  if (minutes <= toMin(calendar.closeTime(date, opts))) return { judged: false, reason: 'market_open' };

  const positions = state.read('positions', opts) || [];
  const existing = readRows(dataDir, 'stop_judgment');
  const results = [];

  for (const p of positions) {
    if (p.status !== 'open' || p.stop_price == null) continue;
    // 중복 판정 방지: 같은 (종목, 날짜) 판정(breach/clean)은 1회만
    if (existing.some((r) => r.symbol === p.symbol && r.date === date && (r.type === 'breach' || r.type === 'clean'))) continue;

    const candle = opts.providers.dailyCandle(p.symbol);
    // 출처 태그 검증(지시1): krx_official만 수용 — 아니면 판정 거부·기록
    if (!candle || candle.source !== OFFICIAL_SOURCE) {
      ledger.append('stop_judgment', {
        id: crypto.randomUUID(), type: 'refused', symbol: p.symbol, date,
        reason: `bad_source: ${candle ? candle.source || '(태그 없음)' : '(캔들 없음)'} — 출처는 ${OFFICIAL_SOURCE}만 수용`,
        created_at: nowIso,
      }, opts);
      continue;
    }

    if (candle.close < p.stop_price) {
      // 성벽 뚫림 — 판정 기록 + 포지션에 판정일·매도 기한 기재
      ledger.append('stop_judgment', {
        id: crypto.randomUUID(), type: 'breach', symbol: p.symbol, date,
        close: candle.close, stop: p.stop_price, created_at: nowIso,
      }, opts);
      const next = nextTradingDay(date, opts);
      p.stop_breached_date = date;
      p.stop_exit_due = `${next}T10:30`;
      results.push({ symbol: p.symbol, breached: true });
      notify({ kind: 'stop_breach', symbol: p.symbol, date, close: candle.close, stop: p.stop_price });
    } else {
      // 장중 이탈했어도 종가가 선 위면 판정 없음 — clean 기록(중복 실행 방지용)
      ledger.append('stop_judgment', {
        id: crypto.randomUUID(), type: 'clean', symbol: p.symbol, date,
        close: candle.close, stop: p.stop_price, created_at: nowIso,
      }, opts);
      results.push({ symbol: p.symbol, breached: false });
    }
  }

  if (results.some((r) => r.breached)) state.write('positions', positions, opts);
  return { judged: true, results };
}

// --- 익일 오전: 매도 출사표 생성 + 급락일 분기 ---
// opts: { dataDir, now, providers:{morning(symbol) → {open, low, price, prevClose?}}, notify }
function generateSellDrafts(opts) {
  const dataDir = paths.resolveDataDir(opts);
  const notify = opts.notify || (() => {});
  const { date } = kstParts(opts.now || new Date());
  const nowIso = (opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now())).toISOString();

  const positions = state.read('positions', opts) || [];
  const draftsExisting = readRows(dataDir, 'order_draft');
  const created = [];

  for (const p of positions) {
    if (p.status !== 'open' || !p.stop_breached_date || p.stop_breached_date >= date) continue;
    // 멱등: 같은 판정 건으로 이미 출사표를 만들었으면 건너뜀
    if (draftsExisting.some((d) => d.symbol === p.symbol && d.side === 'sell' && d.breach_date === p.stop_breached_date)) continue;

    const m = opts.providers.morning(p.symbol);
    // 급락일 기준: 전일 KRX 종가(판정 종가). 공급자가 prevClose를 주면 그 값을 쓴다.
    const prevClose = m.prevClose != null ? m.prevClose
      : (readRows(dataDir, 'stop_judgment').find((r) => r.type === 'breach' && r.symbol === p.symbol && r.date === p.stop_breached_date) || {}).close;
    const crash = prevClose != null && isCrashOpen(prevClose, m.open);

    const ins = orderDraft.insertSystemDraft({
      symbol: p.symbol,
      side: 'sell',
      account_type: p.account_type,
      nation: p.nation != null ? p.nation : null,
      entry_low: m.price,
      entry_high: m.price,
      stop_price: p.stop_price,
      target_price: p.target_price,
      deadline: date,
      troops: Math.max(1, Math.floor((p.qty * p.avg_price) / 10000)),
      rationale: `종가 손절 판정(${p.stop_breached_date}, 종가<성벽 ${p.stop_price}원) → 익일 매도${crash ? ' — 급락일 분기' : ''}`,
      breach_date: p.stop_breached_date,
    }, opts);
    if (!ins.saved) continue; // 불성립이면 결함 기록은 insert가 돌려준 사유로 — 생성 생략

    // 실행 계획: 평시는 오전 즉시 실행 대상, 급락일은 첫 반등(저가+2%) 또는 10:30까지 대기
    const plan = {
      id: crypto.randomUUID(), symbol: p.symbol, date, draft_id: ins.row.id,
      mode: crash ? 'crash' : 'normal',
      execute_ready: !crash,
      trigger: crash ? null : 'morning',
      created_at: nowIso,
    };
    ledger.append('exit_plan', plan, opts);
    notify({ kind: 'sell_draft', symbol: p.symbol, mode: plan.mode });
    created.push({ symbol: p.symbol, draftId: ins.row.id, exitPlan: { mode: plan.mode } });
  }

  return { created };
}

// --- 급락일 장중 감시: 첫 반등(저가+2%) 또는 10:30 도달 → 실행 대상 표시 ---
// opts: { dataDir, now, providers:{morning}, notify }
function checkCrashExit(opts) {
  const dataDir = paths.resolveDataDir(opts);
  const notify = opts.notify || (() => {});
  const { date, minutes } = kstParts(opts.now || new Date());
  const nowIso = (opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now())).toISOString();

  const plans = readRows(dataDir, 'exit_plan').filter((r) => r.date === date && r.mode === 'crash');
  // 종목별 최신 상태(마지막 행이 현재 상태)
  const latest = new Map();
  for (const r of plans) latest.set(r.symbol, r);

  const updated = [];
  for (const [symbol, plan] of latest) {
    if (plan.execute_ready) continue; // 이미 실행 대상
    const m = opts.providers.morning(symbol);
    const reboundLine = m.low * REBOUND_RATIO;

    let trigger = null;
    if (m.price >= reboundLine) trigger = 'rebound';           // 첫 반등
    else if (minutes >= CRASH_DEADLINE_MIN) trigger = 'time_1030'; // 10:30 도달

    if (!trigger) continue;
    ledger.append('exit_plan', {
      id: crypto.randomUUID(), symbol, date, draft_id: plan.draft_id,
      mode: 'crash', execute_ready: true, trigger,
      rebound_price: trigger === 'rebound' ? m.price : null,
      low: m.low, created_at: nowIso,
    }, opts);
    notify({ kind: 'crash_exit_ready', symbol, trigger });
    updated.push({ symbol, trigger });
  }
  return { updated };
}

module.exports = { judgeClose, generateSellDrafts, checkCrashExit, isCrashOpen, nextTradingDay };
