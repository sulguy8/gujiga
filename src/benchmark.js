'use strict';

// 비교 기준선 — KODEX 200 보유 대비 성과 (TSK-022 / REQ-027)
//
// "지수를 그냥 들고 있었으면?"의 거울. KRX 공식 종가(krx_official)만 수용 —
// 다른 출처가 섞인 거울은 없느니만 못하다(TST-021 시나리오6).
//
//  - 유닛 모형: 시작일 종가로 시작 금액만큼 매수 가정. 입금(+)/출금(-)은 그날 종가로
//    같은 금액 매수/매도 가정(유닛 가감). 수수료·세금 제외(양쪽 동일 규칙).
//  - 수익률 = (평가액 − 누적 투입) ÷ 누적 투입. 초과수익(%p) = 우리 − 기준선.
//  - 최대 낙폭 = 고점 대비 최저 하락률. 결측일 = 직전 종가 유지 + 결측 표시.
//  - 4주 연속 주간 초과수익 마이너스 → "지수 보유보다 못함" 경고.
// 계산 함수는 전부 순수(같은 입력 → 같은 출력).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const state = require('./state');
const ledger = require('./ledger');
const paths = require('./paths');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'benchmark.json');

function cfg(opts) {
  if (opts && opts.benchmarkConfig) return opts.benchmarkConfig;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ---------- 순수 계산 ----------
// input: { startAmount, entries:[{date, close, source, missing?}], flows:[{date, amount}] }
// 반환: { units, values[], finalValue, invested, returnPct, missingDates[] }
function computeSeries(input) {
  const { startAmount } = input;
  const entries = input.entries || [];
  const flows = input.flows || [];
  if (entries.length === 0) throw new Error('기준선: 가격 입력 0건');

  const missingDates = [];
  let lastClose = null;
  let units = null;
  let invested = 0;
  const values = [];

  for (const e of entries) {
    let close = e.close;
    if (close == null || e.missing) {
      if (lastClose == null) throw new Error('기준선: 시작일 종가 결측');
      close = lastClose; // 직전 종가 유지
      missingDates.push(e.date);
    } else {
      // 출처 검증: KRX 공식만(REQ-022·027)
      if (e.source !== 'krx_official') {
        throw new Error(`기준선 계산 거부: 출처는 krx_official만(받음: ${e.source || '없음'})`);
      }
      lastClose = close;
    }

    if (units == null) {
      units = startAmount / close; // 시작일 종가 매수 가정
      invested = startAmount;
    }
    // 그날 현금흐름: 종가로 같은 금액 매수(+)/매도(-) 가정
    for (const f of flows.filter((x) => x.date === e.date)) {
      units += f.amount / close;
      invested += f.amount;
    }
    values.push(Math.round(units * close * 100) / 100);
  }

  const finalValue = values[values.length - 1];
  const returnPct = Math.round(((finalValue - invested) / invested) * 1000) / 10;
  return { units, values, finalValue, invested, returnPct, missingDates };
}

function excessPp(oursPct, benchPct) {
  return Math.round((oursPct - benchPct) * 10) / 10;
}

// 최대 낙폭(%) — 고점 대비 최대 하락. 단일 값이면 0.
function maxDrawdownPct(values) {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = ((v - peak) / peak) * 100;
    if (dd < mdd) mdd = dd;
  }
  return Math.round(mdd * 100) / 100;
}

// 끝에서부터 연속 마이너스 주수
function trailingNegativeWeeks(weeklyExcess) {
  let n = 0;
  for (let i = weeklyExcess.length - 1; i >= 0; i--) {
    if (weeklyExcess[i] < 0) n++;
    else break;
  }
  return n;
}
function warn4Weeks(weeklyExcess) {
  return trailingNegativeWeeks(weeklyExcess) >= 4;
}

// ---------- 원장(일 1행) ----------
function readRows(opts) {
  const d = paths.ledgerDir(paths.resolveDataDir(opts), 'benchmark');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 하루 1행 적립: {date, close(KRX 공식 종가), source, missing}
// 실전·나라별 유닛은 상태(benchmark_state)에 유지. 결측일은 직전 종가 유지 + missing 표시.
function recordDay(day, opts) {
  const existing = readRows(opts);
  if (existing.some((r) => r.date === day.date)) return { skipped: true }; // 멱등

  const c = cfg(opts);
  const st = state.read('benchmark_state', opts) || { real: null, nations: {}, lastClose: null, invested: {} };

  let close = day.close;
  let missing = false;
  if (close == null || day.missing) {
    if (st.lastClose == null) throw new Error('기준선: 시작 전 결측');
    close = st.lastClose;
    missing = true;
  } else {
    if (day.source !== 'krx_official') throw new Error(`기준선 기록 거부: 출처는 krx_official만(받음: ${day.source || '없음'})`);
    st.lastClose = close;
  }

  // 유닛 초기화(각 계좌의 시작일 이후 첫 가용 종가 기준)
  if (st.real == null && day.date >= c.real.start_date) {
    st.real = c.real.start_amount / close;
    st.invested.real = c.real.start_amount;
  }
  for (const [nation, nc] of Object.entries(c.nations)) {
    if (st.nations[nation] == null && day.date >= nc.start_date) {
      st.nations[nation] = nc.start_amount / close;
      st.invested[nation] = nc.start_amount;
    }
  }

  // 현금흐름(그날 종가 매매 가정): state 'benchmark_flows' {items:[{date, account, amount}]}
  const flows = (state.read('benchmark_flows', opts) || { items: [] }).items.filter((f) => f.date === day.date);
  for (const f of flows) {
    if (f.account === 'real' && st.real != null) {
      st.real += f.amount / close;
      st.invested.real += f.amount;
    } else if (st.nations[f.account] != null) {
      st.nations[f.account] += f.amount / close;
      st.invested[f.account] += f.amount;
    }
  }

  const row = {
    id: crypto.randomUUID(), date: day.date,
    kodex_close: close, source: missing ? null : 'krx_official', missing,
    real_units: st.real, real_value: st.real != null ? Math.round(st.real * close) : null,
    real_invested: st.invested.real || null,
    nations: Object.fromEntries(Object.entries(st.nations).map(([n, u]) => [n, {
      units: u, value: u != null ? Math.round(u * close) : null, invested: st.invested[n] || null,
    }])),
    created_at: new Date().toISOString(),
  };
  ledger.append('benchmark', row, opts);
  state.write('benchmark_state', st, opts);
  return { recorded: true, row };
}

// 입출금 등록(그날 종가 매매 가정은 recordDay가 반영)
function recordFlow(flow, opts) {
  const b = state.read('benchmark_flows', opts) || { items: [] };
  b.items.push({ date: flow.date, account: flow.account, amount: flow.amount });
  state.write('benchmark_flows', b, opts);
  return { ok: true };
}

// ---------- 표시용 요약(논공행상·현황판) ----------
function summary(opts) {
  const rowsAll = readRows(opts);
  if (rowsAll.length === 0) return null;
  const first = rowsAll.find((r) => r.real_value != null);
  const last = rowsAll[rowsAll.length - 1];
  const benchValues = rowsAll.filter((r) => r.real_value != null).map((r) => r.real_value);
  const bench = {
    returnPct: first && last.real_value != null
      ? Math.round(((last.real_value - last.real_invested) / last.real_invested) * 1000) / 10
      : null,
    mddPct: maxDrawdownPct(benchValues),
  };

  // 우리: 실전 일일 스냅샷(총평가) 추이
  const snapDir = paths.ledgerDir(paths.resolveDataDir(opts), 'daily_account_snapshot');
  let ours = { returnPct: null, mddPct: 0 };
  if (fs.existsSync(snapDir)) {
    const snaps = fs.readdirSync(snapDir)
      .flatMap((f) => fs.readFileSync(path.join(snapDir, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse))
      .filter((r) => r.account_type === 'real')
      .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    if (snaps.length >= 1) {
      const startAmt = cfg(opts).real.start_amount;
      const lastVal = snaps[snaps.length - 1].start_total_eval;
      ours = {
        returnPct: Math.round(((lastVal - startAmt) / startAmt) * 1000) / 10,
        mddPct: maxDrawdownPct(snaps.map((s) => s.start_total_eval)),
      };
    }
  }

  const weekly = (state.read('weekly_excess', opts) || { values: [] }).values;
  return {
    bench, ours,
    excessPp: bench.returnPct != null && ours.returnPct != null ? excessPp(ours.returnPct, bench.returnPct) : null,
    missingDays: rowsAll.filter((r) => r.missing).length,
    warn4w: warn4Weeks(weekly),
    asOf: last.date,
  };
}

module.exports = {
  computeSeries, excessPp, maxDrawdownPct, trailingNegativeWeeks, warn4Weeks,
  recordDay, recordFlow, summary, readRows,
};
