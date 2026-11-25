'use strict';

// 정시 작업 엔진 (TSK-007 / ARC-004)
//
// 거래일 캘린더 위에서 정시 작업을 1회 실행(runOnce)하고, 실행·지연·미실행을 기록한다.
// 상주하지 않는다(지시5) — 서비스·작업 스케줄러 등록 없음, 1회 실행 명령(bin/run-schedule.js)만.
//
// 핵심 규칙:
//  - 중복 0(RISK-004): 같은 날 같은 작업은 1회만. 기록 + 산출물 존재 둘 다로 막는다.
//  - 미실행은 '기록만'(지시3): 지난 날짜의 회차는 절대 늦게 실행하지 않는다 — missed로 남길 뿐.
//    당일 회차도 catchup=false 작업(판정·주문성)은 창(window)을 지나면 실행하지 않는다.
//  - 보고성 작업(catchup=true)만 당일에 한해 지각 생성(late 표시) 허용.
//  - 산출물은 전부 dataDir(gujiga-data) 아래 — Aside trading 폴더와 완전 분리(지시4).
//
// 데이터 공급자(providers)는 주입 인터페이스(지시1):
//   { watchlist(), quote(symbol), accountSnapshot(accountType) }
// 실제 증권사 연결은 TSK-003에서 붙인다.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ledger = require('./ledger');
const paths = require('./paths');
const calendar = require('./market_calendar');
const briefing = require('./briefing');

// 정시 작업표. time은 KST 'HH:MM'.
//  kind: report(보고성 — 당일 지각 생성 허용) / judgment(판정·주문성 — 창 밖 실행 금지)
const JOBS = [
  { name: 'snapshot_0830', time: '08:30', catchup: true, kind: 'report' },
  { name: 'briefing_0831', time: '08:31', catchup: true, kind: 'report' },
  // 15:05 마감 전 점검 — 본 로직은 후속 TSK. 여기서는 실행 창·미실행 감지의 대상으로만 둔다.
  { name: 'preclose_1505', time: '15:05', catchup: false, kind: 'judgment' },
];

const ON_TIME_WINDOW_MIN = 5; // 정시 창: 예정 시각 +5분 이내면 'run', 넘기면 'late'(보고성만)
const JUDGMENT_WINDOW_MIN = 10; // 판정성 실행 창: 이 창을 지나면 실행 금지(미실행 기록)
const MISSED_SCAN_DAYS = 7; // 미실행 감지: 최근 N일 거래일 역추적

// --- 시각 유틸: now를 KST 날짜('YYYY-MM-DD')·분(minute of day)으로 변환 ---
function kstParts(now) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error(`시각 해석 불가: ${now}`);
  // sv-SE 로케일은 'YYYY-MM-DD HH:MM:SS' 형식을 준다.
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  const [date, time] = s.split(' ');
  const [hh, mm] = time.split(':').map(Number);
  return { date, minutes: hh * 60 + mm };
}
function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// --- job_log 읽기 ---
function readJobLog(dataDir) {
  const d = paths.ledgerDir(dataDir, 'job_log');
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
function hasRecord(log, job, date, statuses) {
  return log.some((r) => r.job === job && r.date === date && (!statuses || statuses.includes(r.status)));
}
function logJob(status, job, date, opts, extra) {
  const now = (opts && opts.nowIso) || new Date().toISOString();
  ledger.append('job_log', Object.assign({ id: crypto.randomUUID(), job, date, status, created_at: now }, extra || {}), opts);
}

// --- 미실행 감지: 지난 거래일(최근 N일)의 기록 없는 회차 + 당일 창 지난 judgment 회차 → missed ---
function detectMissed(dataDir, today, nowMin, opts) {
  const log = readJobLog(dataDir);
  const found = [];

  // 지난 거래일들
  let d = new Date(`${today}T00:00:00`);
  for (let i = 0; i < MISSED_SCAN_DAYS; i++) {
    d = new Date(d.getTime() - 24 * 3600 * 1000);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!calendar.isTradingDay(ds, opts)) continue;
    for (const job of JOBS) {
      if (!hasRecord(log, job.name, ds)) {
        logJob('missed', job.name, ds, opts, { detected_on: today });
        found.push({ job: job.name, date: ds });
      }
    }
  }

  // 당일: 판정성(catchup=false) 작업이 실행 창을 지났는데 기록이 없으면 missed
  if (calendar.isTradingDay(today, opts)) {
    for (const job of JOBS) {
      if (job.catchup) continue;
      if (nowMin > toMin(job.time) + JUDGMENT_WINDOW_MIN && !hasRecord(log, job.name, today)) {
        logJob('missed', job.name, today, opts, { detected_on: today });
        found.push({ job: job.name, date: today });
      }
    }
  }
  return found;
}

// --- 작업 구현 ---
function runSnapshot(date, opts) {
  const providers = opts.providers;
  const dataDir = paths.resolveDataDir(opts);
  const errors = [];
  for (const acct of ['real', 'paper']) {
    // 하루 계좌당 1행(UNIQUE) — 이미 있으면 건너뜀
    const exists = readSnapshotRows(dataDir).some((r) => r.snapshot_date === date && r.account_type === acct);
    if (exists) continue;
    try {
      const s = providers.accountSnapshot(acct);
      ledger.append('daily_account_snapshot', {
        id: crypto.randomUUID(),
        snapshot_date: date,
        account_type: acct,
        start_total_eval: s.start_total_eval,
        start_cash: s.start_cash,
        created_at: opts.nowIso || new Date().toISOString(),
      }, opts);
    } catch (e) {
      errors.push(`${acct}: ${e.message}`); // 조회 실패 — 기록만(브리핑이 '조회 실패'로 표시)
    }
  }
  return { errors };
}
function readSnapshotRows(dataDir) {
  const d = paths.ledgerDir(dataDir, 'daily_account_snapshot');
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

// --- 엔진: 1회 실행 ---
// opts: { dataDir, now(ISO|Date), providers, calendarPath }
// 반환: { date, trading, ran: [job...], missed: [{job,date}...], skipped: [job...] }
function runOnce(opts) {
  opts = Object.assign({}, opts);
  const dataDir = paths.resolveDataDir(opts);
  const { date, minutes } = kstParts(opts.now || new Date());
  opts.nowIso = (opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now())).toISOString();

  // 1) 미실행 감지(기록만 — 지난 회차는 절대 실행하지 않는다)
  const missed = detectMissed(dataDir, date, minutes, opts);

  const ran = [];
  const skipped = [];
  const trading = calendar.isTradingDay(date, opts);
  if (!trading) return { date, trading, ran, missed, skipped };

  const log = readJobLog(dataDir);
  for (const job of JOBS) {
    const sched = toMin(job.time);
    if (minutes < sched) continue; // 아직 시각 전

    // 중복 방지: 이미 실행(run/late) 기록이 있으면 건너뜀
    if (hasRecord(log, job.name, date, ['run', 'late', 'missed'])) {
      skipped.push(job.name);
      continue;
    }
    // 판정성 작업은 창 밖이면 실행 금지(missed는 detectMissed가 이미 기록)
    if (!job.catchup && minutes > sched + JUDGMENT_WINDOW_MIN) continue;

    const late = minutes > sched + ON_TIME_WINDOW_MIN;

    if (job.name === 'snapshot_0830') {
      const r = runSnapshot(date, opts);
      logJob(late ? 'late' : 'run', job.name, date, opts, r.errors.length ? { errors: r.errors } : {});
      ran.push(job.name);
    } else if (job.name === 'briefing_0831') {
      // 산출물 존재로도 중복 차단(RISK-004 — Aside 병행 중 2중 생성 0)
      const g = briefing.generate({ date, late, providers: opts.providers }, opts);
      if (g.created) {
        logJob(late ? 'late' : 'run', job.name, date, opts, { file: g.file });
        ran.push(job.name);
      } else {
        logJob('skip_exists', job.name, date, opts, { file: g.file });
        skipped.push(job.name);
      }
    } else if (job.name === 'preclose_1505') {
      // 본 로직은 후속 TSK — 창 안 실행 시 기록만 남긴다.
      logJob('run', job.name, date, opts, { note: 'placeholder — 판정 로직 후속 TSK' });
      ran.push(job.name);
    }
  }

  return { date, trading, ran, missed, skipped };
}

module.exports = { runOnce, JOBS };
