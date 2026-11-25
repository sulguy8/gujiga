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

const JOBS = [
  { name: 'snapshot_0830', time: '08:30', catchup: true },
  { name: 'council_0831', time: '08:31', catchup: true },
  { name: 'preclose_1505', time: '15:05', catchup: false, windowMin: 10 },
  { name: 'compare_1540', time: '15:40', catchup: true },
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

  // 08:30 계좌 스냅샷
  if (minutes >= toMin('08:30') && !hasRec(log, 'snapshot_0830', date)) {
    const r = runSnapshot(date, opts);
    logJob(minutes > toMin('08:35') ? 'late' : 'run', 'snapshot_0830', date, opts, r.errors.length ? { errors: r.errors } : {});
    ran.push('snapshot_0830');
  }

  // 08:31 군의(수집→판정→스냅샷→보고) + sox 3일 창 갱신 + PC 알림
  if (minutes >= toMin('08:31') && !hasRec(log, 'council_0831', date)) {
    const c = await gunshi.morningCouncil(opts);
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
        pending.push(gunshi.insight({ type: 'judgment_needed', data: { symbol: e.symbol, price: e.price, line: e.line } }, opts.strategistOpts));
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
  }

  // 15:40 Aside 대조 기록(읽기 전용) + 누적 리포트
  if (minutes >= toMin('15:40') && !hasRec(log, 'compare_1540', date)) {
    const row = compareWithAside(date, opts);
    logJob('run', 'compare_1540', date, opts, { match: row.match, aside_missing: row.aside_missing });
    ran.push('compare_1540');
  }

  return { trading: true, date, ran, missed };
}

module.exports = { runOnce, updateSoxWindow, compareWithAside, JOBS };
