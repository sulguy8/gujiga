'use strict';

// 그림자 운용 데몬 조립 (TSK-018 / ARC-004 이행기)
//
// 지금까지의 부품(시장 수집·판정·군의·척후·점검·알림)을 하나로 조립해 실거래일에
// '그림자'로 돌린다 — **주문은 0건**. 산출물·판정만 만들어 Aside 루틴과 매일 대조한다.
//
// 그림자 불변식:
//  - 이 모듈은 주문 경로(gate·kis_adapter·gatekeeper·order_draft·stop_judgment)를
//    require하지 않는다(모듈 경계 — TST-017 정규식으로 강제). 조회는 간접(군의 내부)뿐.
//  - 산출물은 전부 dataDir(gujiga-data) 아래 자체 폴더에만. Aside trading 폴더는
//    대조용 '읽기'만 허용(쓰기 0).
//  - 놓친 회차는 '미실행' 기록만(따라잡기 실행 금지 — 군의·스냅샷만 당일 지각 허용).
//  - 알림은 notifyOpts 설정대로(그림자 기본: PC OS만, 텔레그램 off).
//
// 시각표(캘린더 — 수능일 등 반영): 08:30 계좌 스냅샷 → 08:31 군의(gunshi.morningCouncil)
// → 장중 5분 척후(scout → [액션 필요] 시 insight, 성벽 '이탈'은 advise) → 15:05 전황 점검
// → 15:40 Aside 대조 기록.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const calendar = require('./market_calendar');
const { kstParts, toMin } = require('./kst');
const ledger = require('./ledger');
const state = require('./state');
const paths = require('./paths');
const scout = require('./scout');
const preclose = require('./preclose');
const gunshi = require('./gunshi');
const market = require('./market');
const notify = require('./notify');
const benchmark = require('./benchmark');
const retreat = require('./retreat');
const backup = require('./backup');
const nation = require('./nation');
const councilMod = require('./council');
const councilScore = require('./council_score');

const JOBS = [
  { name: 'snapshot_0830', time: '08:30', catchup: true },
  { name: 'council_0831', time: '08:31', catchup: true },
  { name: 'preclose_1505', time: '15:05', catchup: false, windowMin: 10 },
  { name: 'compare_1540', time: '15:40', catchup: true },
  { name: 'backup_1550', time: '15:50', catchup: true },
];
const SCOUT_INTERVAL_MIN = 5;
const MISSED_SCAN_DAYS = 7;

function readLog(dataDir, name) {
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
function hasRec(log, job, date) {
  return log.some((r) => r.job === job && r.date === date);
}
function logJob(status, job, date, opts, extra) {
  ledger.append('shadow_job_log', Object.assign({
    id: crypto.randomUUID(), job, date, status,
    created_at: (opts.now ? new Date(opts.now) : new Date()).toISOString(),
  }, extra || {}), opts);
}

// --- sox_recent3_low: 최근 3거래일 창 유지(4일 전 값 탈락) → reentry_record 갱신 ---
function updateSoxWindow(soxValue, date, opts) {
  if (soxValue == null || !Number.isFinite(soxValue)) return { updated: false };
  const win = state.read('sox_window', opts) || { items: [] };
  const items = win.items.filter((x) => x.date !== date);
  items.push({ date, value: soxValue });
  items.sort((a, b) => a.date.localeCompare(b.date));
  const last3 = items.slice(-3);
  state.write('sox_window', { items: last3 }, opts);
  const low = Math.min(...last3.map((x) => x.value));
  const rec = state.read('reentry_record', opts) || {};
  state.write('reentry_record', Object.assign({}, rec, { sox_recent3_low: low }), opts);
  return { updated: true, recent3_low: low };
}

// --- Aside 대조(읽기 전용): 우리 스냅샷 vs Aside 군의 보고 ---
function loadAsideReport(date, opts) {
  if (!opts.asideRoot) return null;
  const p = path.join(opts.asideRoot, 'trading', 'reports', `${date}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function compareWithAside(date, opts) {
  const snap = market.loadSnapshot(date, opts);
  const ours = snap ? {
    weather: snap.weather,
    signals_on: (snap.signals || []).filter((s) => s.on).length,
    stage: snap.stage,
  } : null;
  const aside = loadAsideReport(date, opts);

  const row = {
    id: crypto.randomUUID(), date,
    ours, aside,
    ours_missing: !ours,
    aside_missing: !aside,
    match: null, mismatches: [],
    created_at: (opts.now ? new Date(opts.now) : new Date()).toISOString(),
  };
  if (ours && aside) {
    for (const f of ['weather', 'signals_on', 'stage']) {
      if (ours[f] !== aside[f]) {
        row.mismatches.push({ field: f, ours: ours[f], aside: aside[f], reason: `우리 ${ours[f]} vs Aside ${aside[f]}` });
      }
    }
    row.match = row.mismatches.length === 0;
  }
  ledger.append('shadow_compare', row, opts);
  writeCompareReport(opts);
  return row;
}

// 누적 대조 리포트(이관 조건 판정용 — 10거래일) — 자체 폴더(dataDir/shadow)에만 기록
function writeCompareReport(opts) {
  const rowsAll = readLog(paths.resolveDataDir(opts), 'shadow_compare');
  const days = rowsAll.length;
  const matched = rowsAll.filter((r) => r.match === true).length;
  const mismatched = rowsAll.filter((r) => r.match === false);
  const L = [];
  L.push('# 그림자 운용 대조 리포트 (ARC-004 이관 조건: 10거래일 불일치 0 또는 전 건 사유 설명)');
  L.push('');
  L.push(`- 누적 ${days}거래일 · 일치 ${matched} · 불일치 ${mismatched.length} · Aside 보고 부재 ${rowsAll.filter((r) => r.aside_missing).length}`);
  L.push('');
  L.push('| 날짜 | 일치 | 불일치 사유 |');
  L.push('|---|---|---|');
  for (const r of rowsAll) {
    const status = r.aside_missing ? 'Aside 부재' : r.match ? '일치' : '불일치';
    const why = (r.mismatches || []).map((m) => m.reason).join(' · ') || '-';
    L.push(`| ${r.date} | ${status} | ${why} |`);
  }
  const dir = path.join(paths.resolveDataDir(opts), 'shadow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compare_report.md'), L.join('\n') + '\n', 'utf8');
}

// --- 미실행 감지(기록만 — 절대 따라잡지 않는다) ---
function detectMissed(dataDir, today, nowMin, opts) {
  const log = readLog(dataDir, 'shadow_job_log');
  const found = [];
  let d = new Date(`${today}T00:00:00`);
  for (let i = 0; i < MISSED_SCAN_DAYS; i++) {
    d = new Date(d.getTime() - 24 * 3600 * 1000);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!calendar.isTradingDay(ds, opts)) continue; // 휴장일은 미실행 기록도 아님
    for (const job of JOBS) {
      if (!hasRec(log, job.name, ds)) {
        logJob('missed', job.name, ds, opts, { detected_on: today });
        found.push({ job: job.name, date: ds });
      }
    }
  }
  // 당일: 판정성(preclose)은 창을 지나면 missed
  if (calendar.isTradingDay(today, opts)) {
    for (const job of JOBS) {
      if (job.catchup) continue;
      if (nowMin > toMin(job.time) + (job.windowMin || 10) && !hasRec(log, job.name, today)) {
        logJob('missed', job.name, today, opts, { detected_on: today });
        found.push({ job: job.name, date: today });
      }
    }
  }
  return found;
}

function send(opts, event) {
  try {
    return notify.send(event, opts.notifyOpts || { config: { channels: { os: false, telegram: false } }, dataDir: opts.dataDir });
  } catch (e) {
    return null;
  }
}

// --- 계좌 스냅샷(공급자 주입 — 그림자에선 가짜/실조회, 주문 아님) ---
function runSnapshot(date, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const existing = readLog(dataDir, 'daily_account_snapshot');
  const errors = [];
  for (const acct of ['real', 'paper']) {
    if (existing.some((r) => r.snapshot_date === date && r.account_type === acct)) continue;
    try {
      const s = opts.providers.accountSnapshot(acct);
      ledger.append('daily_account_snapshot', {
        id: crypto.randomUUID(), snapshot_date: date, account_type: acct,
        start_total_eval: s.start_total_eval, start_cash: s.start_cash,
        created_at: (opts.now ? new Date(opts.now) : new Date()).toISOString(),
      }, opts);
    } catch (e) {
      errors.push(acct);
    }
  }
  return { errors };
}

// --- 입금 감지(출사표 003 개정 — '현금(예수금)' 기준) ---
// 군사 검토: 총평가에는 미실현 평가손익이 섞여 매일 오탐 — 예수금 변동에서 체결 현금 흐름
// (매수 대금 −, 매도 대금 +)을 뺀 '미설명 현금 흐름'만 감지한다. 자동 확정 금지(확인 대기).
function detectUnexplainedFlow(date, opts) {
  const dataDir = paths.resolveDataDir(opts);
  if (readLog(dataDir, 'flow_pending').some((r) => r.date === date)) return; // 멱등(일 1회)
  const snaps = readLog(dataDir, 'daily_account_snapshot')
    .filter((r) => r.account_type === 'real')
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  if (snaps.length < 2) return;
  const today = snaps[snaps.length - 1];
  const prev = snaps[snaps.length - 2];
  if (today.snapshot_date !== date) return;
  const diffCash = today.start_cash - prev.start_cash;
  // 체결 현금 흐름(직전 스냅샷일 이후): 매도 +, 매수 −. 체결(filled/partial)만.
  const explained = readLog(dataDir, 'order_log')
    .filter((r) => r.account_type === 'real'
      && ['filled', 'partial'].includes(r.status)
      && String(r.created_at || '').slice(0, 10) >= prev.snapshot_date
      && String(r.created_at || '').slice(0, 10) < date)
    .reduce((s, r) => s + (r.side === 'sell' ? r.amount : -r.amount), 0);
  const unexplained = diffCash - explained;
  if (Math.abs(unexplained) < 1000) return; // 잡음 무시
  ledger.append('flow_pending', {
    id: crypto.randomUUID(), date, amount: unexplained,
    prev_cash: prev.start_cash, today_cash: today.start_cash, explained_cash: explained,
    status: 'awaiting_confirm',
    note: '입출금 추정(현금 기준) — 군주 확인 후 확정(자동 확정 금지)',
    created_at: new Date().toISOString(),
  }, opts);
}

// --- 주 첫 거래일 판정(출사표 002 지시 2): 월요일, 월요일 휴장이면 그 주 첫 거래일 ---
function isFirstTradingDayOfWeek(dateStr, opts) {
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = d.getDay(); // 1=월
  if (dow === 0 || dow === 6) return false;
  for (let i = 1; i < dow; i++) {
    const e = new Date(d.getTime() - i * 24 * 3600 * 1000);
    const s = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
    if (calendar.isTradingDay(s, opts)) return false; // 이번 주 앞선 거래일 존재
  }
  return true;
}

// 직전 주(월~일) 구간의 수익률 — 기준선(benchmark 원장)·우리(실전 스냅샷)
function weekRangeBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  const thisMonday = new Date(d.getTime() - (dow - 1) * 24 * 3600 * 1000);
  const prevMonday = new Date(thisMonday.getTime() - 7 * 24 * 3600 * 1000);
  const prevSunday = new Date(thisMonday.getTime() - 1 * 24 * 3600 * 1000);
  const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { from: fmt(prevMonday), to: fmt(prevSunday) };
}

function runWeeklyExcess(date, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const { from, to } = weekRangeBefore(date);
  const bench = readLog(dataDir, 'benchmark').filter((r) => r.date >= from && r.date <= to && r.real_value != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const snaps = readLog(dataDir, 'daily_account_snapshot')
    .filter((r) => r.account_type === 'real' && r.snapshot_date >= from && r.snapshot_date <= to)
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  if (bench.length < 2 || snaps.length < 2) {
    ledger.append('weekly_excess_log', {
      id: crypto.randomUUID(), week_from: from, week_to: to, skipped: 'no_data', created_at: new Date().toISOString(),
    }, opts);
    return { skipped: true };
  }
  const pct = (a, b) => ((b - a) / a) * 100;
  const benchPct = pct(bench[0].real_value, bench[bench.length - 1].real_value);
  const oursPct = pct(snaps[0].start_total_eval, snaps[snaps.length - 1].start_total_eval);
  const excess = Math.round((oursPct - benchPct) * 10) / 10;

  const st = state.read('weekly_excess', opts) || { values: [] };
  st.values.push(excess);
  state.write('weekly_excess', st, opts);
  ledger.append('weekly_excess_log', {
    id: crypto.randomUUID(), week_from: from, week_to: to,
    bench_pct: Math.round(benchPct * 10) / 10, ours_pct: Math.round(oursPct * 10) / 10, excess_pp: excess,
    created_at: new Date().toISOString(),
  }, opts);
  return { excess, warn: benchmark.warn4Weeks(st.values) };
}

// --- 회군 감지(출사표 002 지시 3) ---
// 매도 체결로 포지션 수량이 0 → close + retreat.closeTrade(그림자: shadow=true 기록만). 멱등 키 = 주문번호.
async function watchRetreats(date, opts) {
  if (!opts.providers.fills) return;
  let fillsRows;
  try {
    fillsRows = opts.providers.fills(date.replace(/-/g, ''));
  } catch (e) {
    return;
  }
  if (!Array.isArray(fillsRows) || fillsRows.length === 0) return;
  // pdno(종목코드) 없는 체결 행은 매칭 불가 — 회군 감지에서 건너뛰고 기록(출사표 003, 멱등)
  const noted = new Set(readLog(paths.resolveDataDir(opts), 'shadow_job_log')
    .filter((r) => r.job === 'retreat_watch' && r.status === 'note')
    .map((r) => r.skipped_odno));
  for (const f of fillsRows) {
    if (!f.symbol && f.odno && !noted.has(f.odno)) {
      logJob('note', 'retreat_watch', date, opts, { skipped_odno: f.odno, reason: 'no_pdno — 종목코드 없는 체결 행, 회군 감지 제외' });
    }
  }

  const positions = state.read('positions', opts) || [];
  let changed = false;
  for (const p of positions) {
    // fills는 모의 체결조회 — 실전 보유를 모의 매도로 닫는 오매칭 방지(군사 지적 2026-11-26).
    // 실전 회군 자동 감지는 미구현(한계 — TSK-024 카드 명기), 실전 매도는 수동 반영.
    if (p.status !== 'open' || p.account_type !== 'paper') continue;
    const fill = fillsRows.find((f) => f.symbol && f.symbol === p.symbol && f.side === 'sell' && f.remain === 0 && f.filled >= p.qty);
    if (!fill) continue;
    p.status = 'closed';
    p.closed_at = new Date().toISOString();
    p.closed_reason = 'sell_filled';
    changed = true;
    await retreat.closeTrade({
      account_type: p.account_type, symbol: p.symbol, trade_date: date,
      pnl: Math.round((fill.avgFill - p.avg_price) * p.qty),
      hypothesis_ids: p.hypothesis_ids || [],
      wall_deadline_respected: date <= p.deadline,
      violation_count: 0,
      close_key: fill.odno, // 멱등 키 = 주문번호
      shadow: true, // 그림자: 기록만(captive 미반영)
      note: `매도 체결 회군(${fill.avgFill}원 × ${p.qty})`,
    }, opts);
  }
  if (changed) state.write('positions', positions, opts);
}

// --- 책사단 안건 수집(지령 013): "그날 결정할 것"만 — 없으면 책사단 생략 ---
// 보유 점검(hold): 성벽(손절선) 3% 이내 접근 종목. 진입 검토(entry): watchlist에
// entry_low/high가 있고 현재가가 범위 ±3% 안인 관심 성 최대 2개.
// inputs의 bars는 providers.dailyBars(비동기·조회 전용)로 공급 — 없으면 곽가·법정은 폴백.
async function buildCouncilAgendas(date, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const agendas = [];
  const captiveToday = readLog(dataDir, 'captive_ledger')
    .some((r) => r.trade_date === date && r.realized_pnl < 0);
  const getBars = async (symbol) => {
    if (!opts.providers || !opts.providers.dailyBars) return undefined;
    try {
      return await opts.providers.dailyBars(symbol);
    } catch (e) {
      return undefined;
    }
  };
  const quoteOf = (symbol) => {
    try {
      return opts.providers.quote(symbol).price;
    } catch (e) {
      return null;
    }
  };

  for (const p of (state.read('positions', opts) || []).filter((x) => x.status === 'open')) {
    if (p.stop_price == null) continue;
    const price = quoteOf(p.symbol);
    if (price == null) continue;
    const dist = Math.round(((price - p.stop_price) / p.stop_price) * 1000) / 10;
    if (dist > 3) continue; // 판정 필요 없음 — 안건 아님
    agendas.push({
      id: `AG-${date}-${p.symbol}-hold`, date, ticker: p.symbol, name: p.name || null,
      agenda_type: 'hold',
      inputs: { stopDistPct: dist, captiveToday, bars: await getBars(p.symbol) },
    });
  }
  let entries = 0;
  for (const w of (state.read('watchlist', opts) || [])) {
    if (entries >= 2) break; // 관심 성 최대 2개(지령 013)
    if (w.status === 'excluded' || w.entry_low == null || w.entry_high == null) continue;
    const price = quoteOf(w.symbol);
    if (price == null) continue;
    if (price < w.entry_low * 0.97 || price > w.entry_high * 1.03) continue;
    agendas.push({
      id: `AG-${date}-${w.symbol}-entry`, date, ticker: w.symbol, name: w.name || null,
      agenda_type: 'entry',
      inputs: { captiveToday, bars: await getBars(w.symbol) },
    });
    entries++;
  }
  return agendas;
}

// --- 매수 체결 자동 반영(출병 감지 — 군사 지적 2026-11-26) ---
// 예약(매복) 매수가 나중에 체결되면 order_log·positions 어디에도 기록되지 않는 사각을 메운다.
// 멱등 키 = (계좌, 주문번호) — KIS 주문번호는 계좌별 일련번호라 모의·실전이 겹칠 수 있다.
// 전량 체결만 반영, 부분 체결은 note로 보류. submitted 행이 없는 체결(관문 밖 — 비정상)은 note만.
// 한계: pollFill이 partial로 기록한 주문의 전량 전환은 금액 보정 없이 생략(지정가라 과대 차감 쪽 — 보수적).
async function watchSorties(date, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const sources = [];
  if (opts.providers && opts.providers.fills) sources.push(['paper', opts.providers.fills]);
  if (opts.providers && opts.providers.fillsReal) sources.push(['real', opts.providers.fillsReal]);
  let mockChanged = false;

  for (const [acct, provider] of sources) {
    let fillsRows;
    try {
      fillsRows = provider(date.replace(/-/g, ''));
    } catch (e) {
      continue; // 체결조회 실패 — 이 회차 감지 생략(다음 틱 재시도)
    }
    if (!Array.isArray(fillsRows) || fillsRows.length === 0) continue;

    const orders = readLog(dataDir, 'order_log');
    const positions = state.read('positions', opts) || [];
    const noted = new Set(readLog(dataDir, 'shadow_job_log')
      .filter((r) => r.job === 'sortie_watch' && r.status === 'note')
      .map((r) => r.skipped_odno));
    let posChanged = false;
    const acctType = acct === 'real' ? 'real' : 'paper';
    const seen = new Set(); // 같은 틱 fills에 동일 주문번호 중복 행 방어(원장 이중 기재 방지)

    for (const f of fillsRows) {
      if (f.side !== 'buy' || !f.odno || !(f.filled > 0)) continue;
      if (seen.has(f.odno)) continue;
      seen.add(f.odno);
      if (f.remain > 0) {
        if (!noted.has(f.odno)) {
          logJob('note', 'sortie_watch', date, opts, { skipped_odno: f.odno, reason: 'partial — 부분 체결 보류(전량 체결 시 반영)' });
          noted.add(f.odno);
        }
        continue;
      }
      const already = orders.find((r) => r.account_type === acctType && r.broker_order_no === f.odno && r.side === 'buy' && ['filled', 'partial'].includes(r.status));
      const sub = orders.find((r) => r.account_type === acctType && r.broker_order_no === f.odno && r.side === 'buy' && r.status === 'submitted');
      const base = already || sub;
      if (!base) {
        if (!noted.has(f.odno)) {
          logJob('note', 'sortie_watch', date, opts, { skipped_odno: f.odno, reason: 'no_submitted — 관문 기록 없는 매수 체결, 반영 생략(수동 확인 필요)' });
          noted.add(f.odno);
        }
        continue;
      }
      if (!already) {
        ledger.append('order_log', {
          id: crypto.randomUUID(), account_type: base.account_type, nation: base.nation || null,
          symbol: base.symbol, side: 'buy', order_type: base.order_type || 'limit',
          price: f.avgFill != null ? f.avgFill : base.price, qty: f.filled,
          amount: (f.avgFill != null ? f.avgFill : base.price) * f.filled,
          stop_price: base.stop_price != null ? base.stop_price : null,
          target_price: base.target_price != null ? base.target_price : null,
          deadline: base.deadline || null,
          hypothesis_ids: base.hypothesis_ids || null,
          status: 'filled', block_reason: null, broker_order_no: f.odno,
          filled_at: new Date().toISOString(), created_at: new Date().toISOString(),
          source: 'sortie_watch',
        }, opts);
        if (acct === 'paper') mockChanged = true;
      }
      if (!positions.some((p) => p.account_type === acctType && p.broker_order_no === f.odno)) {
        positions.push({
          id: crypto.randomUUID(), account_type: acctType,
          nation: base.nation || null, symbol: f.symbol || base.symbol,
          qty: f.filled, avg_price: f.avgFill != null ? f.avgFill : base.price,
          stop_price: base.stop_price != null ? base.stop_price : null,
          target_price: base.target_price != null ? base.target_price : null,
          deadline: base.deadline || null, hypothesis_ids: base.hypothesis_ids || [],
          status: 'open', opened_at: new Date().toISOString(), broker_order_no: f.odno,
        });
        posChanged = true;
        if (acct === 'paper') mockChanged = true;
      }
    }
    if (posChanged) state.write('positions', positions, opts);
  }
  // 모의 반영이 있었으면 세력 장부 스냅샷 재계산(실전은 세력전 밖)
  if (mockChanged) {
    try { nation.saveLedger(opts); } catch (e) { /* 스냅샷 실패는 치명 아님 — 재계산이 정본 */ }
  }
}

// 기한 만료(미매도) — 15:05 점검 회차에서 같은 경로. 기한 이행 실패로 기록.
async function closeExpiredPositions(date, opts) {
  const positions = state.read('positions', opts) || [];
  let changed = false;
  for (const p of positions) {
    if (p.status !== 'open' || !p.deadline || p.deadline >= date) continue;
    let price = p.avg_price;
    try {
      price = opts.providers.quote(p.symbol).price;
    } catch (e) { /* 시세 없으면 평단 기준 0 손익 */ }
    p.status = 'closed';
    p.closed_at = new Date().toISOString();
    p.closed_reason = 'deadline_expired';
    changed = true;
    await retreat.closeTrade({
      account_type: p.account_type, symbol: p.symbol, trade_date: date,
      pnl: Math.round((price - p.avg_price) * p.qty),
      hypothesis_ids: p.hypothesis_ids || [],
      wall_deadline_respected: false, // 기한 내 매도 미이행
      violation_count: 0,
      close_key: `deadline:${p.id}:${p.deadline}`,
      shadow: true,
      note: `기한 만료(${p.deadline}) 미매도 — 평가 ${price}원 기준`,
    }, opts);
  }
  if (changed) state.write('positions', positions, opts);
}

// --- 척후 간격(5분) 판단 ---
function scoutDue(dataDir, date, nowMin, opts) {
  const ticks = readLog(dataDir, 'scout_log').filter((r) => r.type === 'tick' && r.date === date);
  if (ticks.length === 0) return true;
  const last = ticks[ticks.length - 1];
  const lastMin = kstParts(last.created_at).minutes;
  return nowMin - lastMin >= SCOUT_INTERVAL_MIN;
}

// --- 1회 실행(분 단위 틱에서 호출) ---
async function runOnce(opts) {
  const dataDir = paths.resolveDataDir(opts);
  const { date, minutes } = kstParts(opts.now || new Date());
  const ran = [];

  const missed = detectMissed(dataDir, date, minutes, opts);
  if (!calendar.isTradingDay(date, opts)) return { trading: false, date, ran, missed };

  const log = readLog(dataDir, 'shadow_job_log');
  const openMin = toMin(calendar.openTime(date, opts));
  const closeMin = toMin(calendar.closeTime(date, opts));

  // 08:30 계좌 스냅샷 + 기준선 적립 + 입금 감지(출사표 002)
  if (minutes >= toMin('08:30') && !hasRec(log, 'snapshot_0830', date)) {
    const r = runSnapshot(date, opts);
    logJob(minutes > toMin('08:35') ? 'late' : 'run', 'snapshot_0830', date, opts, r.errors.length ? { errors: r.errors } : {});
    ran.push('snapshot_0830');

    // 기준선: KODEX 200 전일 KRX 종가(공급자 주입) → recordDay(멱등·결측 표시)
    if (opts.providers.kodexClose) {
      try {
        const bar = opts.providers.kodexClose();
        benchmark.recordDay({ date: bar.date, close: bar.close, source: bar.source, missing: bar.missing }, opts);
      } catch (e) {
        logJob('note', 'benchmark_0830', date, opts, { note: `기준선 적립 생략: ${e.message}` });
      }
    }
    // 입금 감지: 직전 스냅샷 대비 총평가 변동 중 손익(captive)으로 설명되지 않는 부분 —
    // 감지만 하고 군주 확인 대기로 기록(자동 recordFlow 금지 — 출사표 002 지시 1)
    detectUnexplainedFlow(date, opts);
  }

  // 08:31 군의(수집→판정→스냅샷→보고) + sox 3일 창 갱신 + PC 알림
  // 책사단(지령 013): 안건이 있으면 군의 counsel 호출 '한 번'에 4목소리 편승(별도 회차 0)
  if (minutes >= toMin('08:31') && !hasRec(log, 'council_0831', date)) {
    const councilAgendas = await buildCouncilAgendas(date, opts);
    const c = await gunshi.morningCouncil(Object.assign({}, opts, { councilAgendas }));
    const sox = c.collected.judgeInputs.us_summary && c.collected.judgeInputs.us_summary.sox;
    updateSoxWindow(sox, date, opts);
    await send(opts, {
      kind: 'council', title: '아침 군의(그림자)',
      body: c.report.split('\n').slice(0, 2).join(' / '),
      fields: { stage: c.judgment.stage, weather: c.judgment.weather },
    });
    logJob(minutes > toMin('08:36') ? 'late' : 'run', 'council_0831', date, opts, { file: c.reportFile });
    ran.push('council_0831');
  }

  // 월요일(휴장이면 주 첫 거래일) 주간 초과수익 적립 + 4주 연속 경고(출사표 002)
  if (minutes >= toMin('08:35') && isFirstTradingDayOfWeek(date, opts) && !hasRec(log, 'weekly_monday', date)) {
    const w = runWeeklyExcess(date, opts);
    if (w.warn) {
      await send(opts, { kind: 'benchmark_warn', title: '기준선 경고', body: '4주 연속 초과수익 마이너스 — 지수 보유보다 못함' });
    }
    logJob('run', 'weekly_monday', date, opts, w.skipped ? { skipped: 'no_data' } : { excess_pp: w.excess });
    ran.push('weekly_monday');
  }

  // 출병·회군 감지(체결조회): 매수 체결 → positions 반영이 먼저, 그다음 매도 회군
  if (minutes >= openMin && minutes <= closeMin + 30) {
    await watchSorties(date, opts);
    await watchRetreats(date, opts);
  }

  // 15:45 책사단 채점(TSK-026 / 지령 012): 5거래일 경과 의견 채점 → 관직 재계산 → 한목소리 경고
  // JOBS 미등록(detectMissed 감사 밖) 의도: 놓친 날은 다음 거래일 배치가 자동 만회한다(채점 멱등).
  // 실패 note도 hasRec에 걸려 당일 재시도 없음 — 같은 이유(다음 거래일 만회)로 스팸 방지를 택함.
  if (minutes >= toMin('15:45') && opts.providers.closes && !hasRec(log, 'council_score_1545', date)) {
    try {
      const s = await councilScore.scoreVerdicts(date, Object.assign({}, opts, { closes: opts.providers.closes }));
      councilScore.recomputeRanks(opts);
      const dw = councilScore.disagreementWarning(opts);
      if (dw.warn) {
        await send(opts, {
          kind: 'council_warn', title: '책사단 한목소리 경고',
          body: `최근 ${dw.count}안건 불일치율 평균 ${dw.avg}% — 20% 미만(가짜 다양성 의심)`,
        });
      }
      // 실관찰 메모(지령 013 5항): 15:45 일봉 응답에 '당일 봉'이 포함되는지 기록 — 채점 보수화 완화 판단용
      let todayBar = null;
      try {
        todayBar = await opts.providers.closes('069500', date);
      } catch (e) { /* 결측 기록 */ }
      logJob('run', 'council_score_1545', date, opts, {
        scored: s.scored, warn: dw.warn === true,
        today_bar_present: !!todayBar, today_bar_source: todayBar ? todayBar.source : null,
      });
      ran.push('council_score_1545');
    } catch (e) {
      logJob('note', 'council_score_1545', date, opts, { error: e.message });
    }
  }

  // 장중 5분 척후 → [액션 필요] 보고 시 insight(판정 필요), 성벽 '이탈'은 advise(기준2)
  if (minutes >= openMin && minutes <= closeMin && scoutDue(dataDir, date, minutes, opts)) {
    const pending = [];
    const hook = (e) => {
      if (e.kind === 'report') {
        pending.push(send(opts, {
          kind: 'scout', title: '척후 보고',
          body: `${e.symbol} ${e.condition} 현재가 ${e.price}`,
          fields: { symbol: e.symbol, condition: e.condition, price: e.price },
        }));
        // 장중 책사단(지령 013 2항): 척후 [액션 필요] 회차의 insight 호출에 편승(척후 몫 6회 안 — 별도 회차 0).
        // 하루 1심: 아침 군의에서 이미 기록된 안건이면 싣지 않는다(출력 낭비 방지 — 군사 지적 2026-11-26).
        pending.push((async () => {
          const agendaId = `AG-${date}-${e.symbol}-hold`;
          const already = councilMod.readVerdicts(opts).some((r) => !r.type && r.agenda_id === agendaId);
          let agendas = [];
          if (!already) {
            const dist = e.line != null ? Math.round(((e.price - e.line) / e.line) * 1000) / 10 : undefined;
            let bars;
            try {
              bars = opts.providers.dailyBars ? await opts.providers.dailyBars(e.symbol) : undefined;
            } catch (err) { bars = undefined; }
            agendas = [{ id: agendaId, date, ticker: e.symbol, agenda_type: 'hold', inputs: { stopDistPct: dist, bars } }];
          }
          return gunshi.insight(
            { type: 'judgment_needed', data: { symbol: e.symbol, price: e.price, line: e.line } },
            opts.strategistOpts,
            { dataDir: opts.dataDir, councilAgendas: agendas }
          );
        })());
        if (e.condition === 'stop_approach' && e.line != null && e.price <= e.line) {
          pending.push(gunshi.advise({ wall_breached: { symbol: e.symbol, close: e.price, stop: e.line } }, opts.strategistOpts));
        }
      } else if (e.kind === 'alert_lost') {
        pending.push(send(opts, { kind: 'alert_lost', title: '정찰 두절 경고', body: `시세 연속 ${e.streak}회 실패` }));
      }
    };
    scout.runScout({ dataDir: opts.dataDir, now: opts.now, providers: { quote: opts.providers.quote }, notify: hook });
    await Promise.all(pending);
    ran.push('scout');
  }

  // 15:05 전황 점검(판정성 — 창 밖 실행 금지)
  const pre = JOBS.find((j) => j.name === 'preclose_1505');
  if (minutes >= toMin(pre.time) && minutes <= toMin(pre.time) + pre.windowMin && !hasRec(log, 'preclose_1505', date)) {
    const r = preclose.check({ dataDir: opts.dataDir, now: opts.now, providers: { quote: opts.providers.quote } });
    const needs = r.items.filter((i) => i.needJudgment);
    if (needs.length) {
      await send(opts, {
        kind: 'preclose', title: '15:05 전황 점검',
        body: needs.map((i) => `${i.name || i.symbol} ${i.lineName} ${i.distPct}%${i.auctionWarning ? ' 동시호가 경고' : ''}`).join(' / '),
        fields: { count: needs.length },
      });
    }
    logJob('run', 'preclose_1505', date, opts, { items: r.items.length });
    ran.push('preclose_1505');

    // 기한 만료(미매도) 포지션 → 같은 회군 경로(기한 이행 실패 기록 — 출사표 002)
    await closeExpiredPositions(date, opts);
  }

  // 15:40 Aside 대조 기록(읽기 전용) + 누적 리포트
  if (minutes >= toMin('15:40') && !hasRec(log, 'compare_1540', date)) {
    const row = compareWithAside(date, opts);
    logJob('run', 'compare_1540', date, opts, { match: row.match, aside_missing: row.aside_missing });
    ran.push('compare_1540');
  }

  // 15:50 gujiga-data 백업(지령 005) — 하루 1회. 주문 경로와 무관, 실패해도 기록만.
  if (minutes >= toMin('15:50') && !hasRec(log, 'backup_1550', date)) {
    const b = backup.runBackup({ dataDir: opts.dataDir });
    logJob('run', 'backup_1550', date, opts, { committed: b.committed, pushed: b.pushed, skipped: b.skipped, reason: b.reason });
    ran.push('backup_1550');
  }

  return { trading: true, date, ran, missed };
}

module.exports = { runOnce, updateSoxWindow, compareWithAside, watchSorties, JOBS };
