'use strict';

// 5분 척후 (REQ-006 / TSK-008)
//
// 장중(개장~폐장, 캘린더 closeTime — 수능일 16:30)에만 실행한다. 조용한 정찰이 기본:
// 조건 충족 시에만 보고(report)를 남기고, 같은 조건이 연속 충족되는 동안은 중복 보고하지
// 않으며, 해제 후 재충족 시 재보고한다. 시세 실패 회차는 기록만 하고 건너뛰되,
// 연속 3회 실패면 '정찰 두절 경고'를 1회 남긴다.
//
// 장중 손절선 이탈은 '기록만' — 판정은 종가 확정 후 stop_judgment가 한다(지시3).
// 알림은 훅(opts.notify) 자리만 — 실제 발송은 TSK-011.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ledger = require('./ledger');
const paths = require('./paths');
const state = require('./state');
const calendar = require('./market_calendar');
const { kstParts, toMin } = require('./kst');

const STOP_APPROACH_PCT = 3; // 성벽 접근 조건: 손절선까지 거리 ≤3%
const FAIL_ALERT_STREAK = 3; // 연속 실패 3회 → 두절 경고 1회

function readLog(dataDir) {
  const d = paths.ledgerDir(dataDir, 'scout_log');
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

function append(dataDir, row, opts) {
  ledger.append('scout_log', Object.assign({ id: crypto.randomUUID() }, row), opts);
}

// 1회 정찰. opts: { dataDir, now, providers:{quote}, notify }
function runScout(opts) {
  const dataDir = paths.resolveDataDir(opts);
  const notify = opts.notify || (() => {});
  const { date, minutes } = kstParts(opts.now || new Date());
  const nowIso = (opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now())).toISOString();

  // 장중에만: 휴장일·개장 전·폐장 후 미실행(수능일은 캘린더 closeTime 16:30까지)
  if (!calendar.isTradingDay(date, opts)) return { ran: false, reason: 'holiday' };
  const openMin = toMin(calendar.openTime(date, opts));
  const closeMin = toMin(calendar.closeTime(date, opts));
  if (minutes < openMin || minutes > closeMin) return { ran: false, reason: 'off_hours' };

  const positions = (state.read('positions', opts) || []).filter((p) => p.status === 'open');
  const todayTicks = readLog(dataDir).filter((r) => r.type === 'tick' && r.date === date);
  const last = todayTicks[todayTicks.length - 1] || null;
  const prevMet = last ? last.met || [] : [];
  const prevStreak = last ? last.fail_streak || 0 : 0;

  // 시세 수집·조건 평가
  const met = [];
  const reports = [];
  let failed = 0;
  for (const p of positions) {
    let price;
    try {
      price = opts.providers.quote(p.symbol).price;
    } catch (e) {
      failed++;
      continue;
    }
    if (p.stop_price != null) {
      const dist = Math.abs(price - p.stop_price) / p.stop_price * 100;
      if (dist <= STOP_APPROACH_PCT) {
        const key = `${p.symbol}:stop_approach`;
        met.push(key);
        if (!prevMet.includes(key)) reports.push({ symbol: p.symbol, condition: 'stop_approach', price, line: p.stop_price, dist });
      }
    }
    if (p.target_price != null && price >= p.target_price) {
      const key = `${p.symbol}:target_hit`;
      met.push(key);
      if (!prevMet.includes(key)) reports.push({ symbol: p.symbol, condition: 'target_hit', price, line: p.target_price });
    }
  }

  // 회차 실패(전 종목 시세 실패): 기록만, 연속 3회째 두절 경고 1회
  if (positions.length > 0 && failed === positions.length) {
    const streak = prevStreak + 1;
    append(dataDir, { type: 'tick', date, fail: true, fail_streak: streak, met: prevMet, created_at: nowIso }, opts);
    if (streak === FAIL_ALERT_STREAK) {
      append(dataDir, { type: 'alert_lost', date, streak, created_at: nowIso }, opts);
      notify({ kind: 'alert_lost', date, streak });
    }
    return { ran: true, fail: true, streak };
  }

  // 새로 충족된 조건만 보고(연속 충족 중복 억제)
  for (const r of reports) {
    append(dataDir, Object.assign({ type: 'report', date, created_at: nowIso }, r), opts);
    notify(Object.assign({ kind: 'report' }, r));
  }
  append(dataDir, { type: 'tick', date, fail: false, fail_streak: 0, met, created_at: nowIso }, opts);
  return { ran: true, fail: false, reports: reports.length, met };
}

module.exports = { runScout };
