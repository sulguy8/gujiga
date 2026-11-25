'use strict';

// 단일 주문 게이트 (TSK-005 / ARC-003)
//
// 모든 주문은 gate.submit(draft) 한 문으로만 나간다. kis_adapter는 이 모듈만 require하며
// (AC3 — 정규식 테스트로 강제), 주문·정정·취소를 밖에서 부르는 경로는 존재하지 않는다.
//
// 검사 7단계(순서 고정, 첫 차단에서 멈춤 — ARC-003):
//  ① STOP 파일(guard 부재 포함) ② 출사표 5항목(REQ-001) ③ 사용자 확인(실전)
//  ④ 화이트리스트(실전 매수)·지정가 ⑤ 1회 한도·하루 손실 ⑥ 군령 3종(군량30%·복수·상관0.7)
//  ⑦ 관직/세력전 한도
//  — 하루 손실·군령 3종·관직 한도·1회 한도는 '매수'에만. 매도는 ①②③+지정가만(성벽 퇴각 보장).
// 차단 시 order_log에 status=blocked·block_reason·수치(detail)를 기록한다.
// 통과 시 전송 → 체결조회(10초 간격 최대 1분) → 결과까지 order_log 기록(AC4).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const kis = require('./kis_adapter'); // ← 유일한 kis_adapter require 지점(AC3)
const guard = require('./guard');
const state = require('./state');
const ledger = require('./ledger');
const paths = require('./paths');
const orderDraft = require('./order_draft');
const generalRank = require('./general_rank');
const { kstParts } = require('./kst');

const DEFAULT_GATE_CONFIG = path.join(__dirname, '..', 'config', 'gate.json');
const SNAPSHOT_READY_MIN = 8 * 60 + 30; // 08:30 — 이후에만 첫 잔고로 스냅샷 보완
const FILL_POLL_MS = 10000;  // 체결조회 간격(ARC-003 확정: 10초)
const FILL_POLL_MAX = 60000; // 최대 1분

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 유틸 ---
function readLedger(dataDir, name) {
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

// 일간 수익률 피어슨 상관계수(REQ-015 확정: 최근 60거래일)
function returnsOf(closes) {
  const c = closes.slice(-61); // 최대 60수익률
  const out = [];
  for (let i = 1; i < c.length; i++) out.push(((c[i] - c[i - 1]) / c[i - 1]) * 100);
  return out;
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const A = a.slice(-n);
  const B = b.slice(-n);
  const ma = A.reduce((s, x) => s + x, 0) / n;
  const mb = B.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (A[i] - ma) * (B[i] - mb);
    va += (A[i] - ma) ** 2;
    vb += (B[i] - mb) ** 2;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

async function makeAdapter(env, opts, enableRealOrders) {
  if (opts.adapter) return opts.adapter;
  return kis.make(env, {
    dataDir: opts.dataDir, keysPath: opts.keysPath, baseUrls: opts.baseUrls, gapMs: opts.gapMs,
    enableRealOrders: enableRealOrders === true,
  });
}

// 실전 전송 경로 정책(기본 거부): config/gate.json enableRealOrders의 명시적 true만 허용.
// aside_chat은 추가로 confirmed=true·reason 존재가 전제(7단계 통과는 runChecks가 보장).
function realOrderAllowed(draft, opts) {
  let policy = opts.realOrderPolicy;
  if (!policy) {
    try {
      policy = JSON.parse(fs.readFileSync((opts.gateConfigPath || DEFAULT_GATE_CONFIG), 'utf8')).enableRealOrders;
    } catch (e) {
      policy = {};
    }
  }
  const by = draft.created_by;
  if (!policy || policy[by] !== true) return false;
  if (by === 'aside_chat') {
    return draft.user_confirmed === true && typeof draft.reason === 'string' && draft.reason.trim().length > 0;
  }
  return true;
}

function logOrder(row, opts) {
  ledger.append('order_log', Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, row), opts);
}

// --- 검사 7단계. 차단 시 {reason, detail} 반환, 통과 시 null ---
async function runChecks(draft, env, api, opts) {
  const today = kstParts(opts.now || new Date()).date;
  const nowMin = kstParts(opts.now || new Date()).minutes;
  const isBuy = draft.side === 'buy';

  // ① STOP(및 guard 부재 — 설정 없으면 전면 차단)
  const g = guard.loadGuard(opts);
  if (!g) return { reason: 'guard_missing', detail: {} };
  if (fs.existsSync(g.stop_file_path)) return { reason: 'stop_file', detail: {} };

  // ② 출사표 5항목(REQ-001)
  const invalid = orderDraft.validate(draft);
  if (invalid) return { reason: `draft_invalid_${invalid}`, detail: { missing: invalid } };

  // ③ 사용자 확인(실전) — AI 단독 주문 구조적 불가(REQ-002)
  if (env === 'real' && draft.user_confirmed !== true) return { reason: 'no_confirm', detail: {} };

  // ④ 화이트리스트(실전 매수) · 지정가(전 주문)
  if (env === 'real' && isBuy) {
    const wl = state.read('watchlist', opts);
    const ok = Array.isArray(wl) && wl.some((w) => w.symbol === draft.symbol && w.status !== 'excluded');
    if (!ok) return { reason: 'not_whitelisted', detail: {} };
  }
  if (!Number.isInteger(draft.price) || draft.price <= 0) return { reason: 'market_order', detail: {} };

  // --- 매도는 여기까지(①②③④의 지정가) — 성벽 퇴각이 막히면 안 된다(군사 지시3) ---
  if (!isBuy) return null;

  const amount = draft.qty * draft.price;

  // ⑤ 1회 한도 · 하루 손실(실전 매수)
  const lim = env === 'real' ? g.per_order_limit_real : g.per_order_limit_paper;
  if (amount > lim) return { reason: 'per_order_limit', detail: { amount, limit: lim } };

  let balance = null;
  if (env === 'real') {
    // 당일 스냅샷: 없으면 08:30 이후 첫 잔고로 보완(지시6), 이전·실패는 차단
    let snap = readLedger(paths.resolveDataDir(opts), 'daily_account_snapshot')
      .find((r) => r.snapshot_date === today && r.account_type === 'real');
    if (!snap) {
      if (nowMin < SNAPSHOT_READY_MIN) return { reason: 'no_snapshot', detail: { note: '08:30 이전' } };
      try {
        balance = await api.balance();
      } catch (e) {
        return { reason: 'no_snapshot', detail: { note: '잔고 조회 실패' } };
      }
      snap = { snapshot_date: today, account_type: 'real', start_total_eval: balance.total, start_cash: balance.cash };
      ledger.append('daily_account_snapshot', Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, snap), opts);
    }
    if (!balance) {
      try {
        balance = await api.balance();
      } catch (e) {
        return { reason: 'no_snapshot', detail: { note: '잔고 조회 실패' } };
      }
    }
    const diff = balance.total - snap.start_total_eval;
    if (diff <= g.daily_loss_limit) return { reason: 'daily_loss', detail: { diff, limit: g.daily_loss_limit } };
  }

  // ⑥ 군령 3종(매수만 — REQ-015)
  // 군량 30%: 매수 후 남을 현금 ÷ 총자산 ≥ 기준
  if (!balance) {
    try {
      balance = await api.balance();
    } catch (e) {
      return { reason: 'ration30', detail: { note: '잔고 조회 실패(안전 차단)' } };
    }
  }
  const cashAfter = balance.cash - amount;
  const ratio = balance.total > 0 ? cashAfter / balance.total : 0;
  if (ratio < g.cash_ratio_min) {
    return { reason: 'ration30', detail: { cash_after_pct: (ratio * 100).toFixed(2), min_pct: g.cash_ratio_min * 100 } };
  }

  // 복수 매매: 당일 확정 손실(포로 발생)이 있으면 신규 매수 금지
  const revenge = readLedger(paths.resolveDataDir(opts), 'captive_ledger')
    .some((r) => r.trade_date === today && r.realized_pnl < 0 && r.account_type === draft.account_type);
  if (revenge) return { reason: 'revenge', detail: { date: today } };

  // 상관 0.7: 보유 종목과 최근 60거래일 일간 수익률 피어슨(지시4)
  const positions = (state.read('positions', opts) || [])
    .filter((p) => p.status === 'open' && p.account_type === draft.account_type && p.symbol !== draft.symbol);
  if (positions.length > 0) {
    let candBars;
    try {
      candBars = await api.dailyCandle(draft.symbol, 120);
    } catch (e) {
      return { reason: 'correlation', detail: { note: 'data_unavailable', with: draft.symbol } };
    }
    const candReturns = returnsOf(candBars.map((b) => b.close));
    for (const p of positions) {
      let posBars;
      try {
        posBars = await api.dailyCandle(p.symbol, 120);
      } catch (e) {
        return { reason: 'correlation', detail: { note: 'data_unavailable', with: p.symbol } };
      }
      const posReturns = returnsOf(posBars.map((b) => b.close));
      const n = Math.min(candReturns.length, posReturns.length);
      const r = pearson(candReturns, posReturns);
      const sampleInsufficient = n < 60;
      if (r >= g.correlation_max) {
        return {
          reason: 'correlation',
          detail: Object.assign({ with: p.symbol, corr: Number(r.toFixed(2)), sample_n: n }, sampleInsufficient ? { sample_insufficient: true } : {}),
        };
      }
    }
  }

  // ⑦ 관직(실전) / 세력전(모의 nation) 한도
  const allPos = (state.read('positions', opts) || []).filter((p) => p.status === 'open');
  if (env === 'real') {
    const limits = generalRank.getLimits(opts); // 상태 없으면 안전 기본 현령
    const mine = allPos.filter((p) => p.account_type === 'real');
    const sameAmt = mine.filter((p) => p.symbol === draft.symbol).reduce((s, p) => s + p.qty * p.avg_price, 0);
    if (limits.perStockLimitWon != null && sameAmt + amount > limits.perStockLimitWon) {
      return { reason: 'nation_limit', detail: { kind: 'per_stock', have: sameAmt, add: amount, limit: limits.perStockLimitWon } };
    }
    const symbols = new Set(mine.map((p) => p.symbol));
    if (limits.concurrentMax != null && !symbols.has(draft.symbol) && symbols.size >= limits.concurrentMax) {
      return { reason: 'nation_limit', detail: { kind: 'concurrent', open: symbols.size, limit: limits.concurrentMax } };
    }
  } else if (draft.nation) {
    // REQ-009 세력전: 나라별 동시 2종목·종목당 250,000원
    const mine = allPos.filter((p) => p.account_type === 'paper' && p.nation === draft.nation);
    const sameAmt = mine.filter((p) => p.symbol === draft.symbol).reduce((s, p) => s + p.qty * p.avg_price, 0);
    if (sameAmt + amount > 250000) {
      return { reason: 'nation_limit', detail: { kind: 'nation_per_stock', have: sameAmt, add: amount, limit: 250000 } };
    }
    const symbols = new Set(mine.map((p) => p.symbol));
    if (!symbols.has(draft.symbol) && symbols.size >= 2) {
      return { reason: 'nation_limit', detail: { kind: 'nation_concurrent', open: symbols.size, limit: 2 } };
    }
  }

  return null;
}

// --- 체결조회: 10초 간격 최대 1분(설정 주입 가능) ---
async function pollFill(api, odno, today, opts) {
  const pollMs = opts.fillPollMs != null ? opts.fillPollMs : FILL_POLL_MS;
  const maxMs = opts.fillPollMax != null ? opts.fillPollMax : FILL_POLL_MAX;
  const ymd = today.replace(/-/g, '');
  const deadline = Date.now() + maxMs;
  let lastRow = null;
  for (;;) {
    try {
      const f = await api.fills(ymd);
      const row = (f.rows || []).find((x) => x.odno === odno);
      if (row) {
        lastRow = row;
        if (row.cancelled === 'Y' && row.filled === 0) return { status: 'cancelled', row };
        if (row.filled > 0 && row.remain === 0) return { status: 'filled', row };
        if (row.filled > 0) return { status: 'partial', row };
      }
    } catch (e) {
      // 체결조회 실패는 치명 아님 — 재시도
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  return { status: 'submitted', row: lastRow };
}

// --- 단일 진입: submit(draft, opts) ---
// draft: order_draft 형태 + qty·price(지정가)·reason. opts: { dataDir, keysPath, baseUrls, gapMs, now, fillPollMs, fillPollMax, adapter }
// 반환: 차단 {ok:false, blocked:true, reason, detail} / 전송 {ok, result, fill} / 오류 {ok:false, error}
async function submit(draft, opts) {
  opts = opts || {};
  const env = draft.account_type === 'real' ? 'real' : 'mock';
  const today = kstParts(opts.now || new Date()).date;

  let api;
  try {
    // 실전 전송은 경로별 정책(기본 거부) — 허용 경로가 아니면 어댑터 주문이 비활성으로 거부한다.
    api = await makeAdapter(env, opts, env === 'real' && realOrderAllowed(draft, opts));
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const block = await runChecks(draft, env, api, opts);
  const baseRow = {
    draft_id: draft.id || null,
    account_type: draft.account_type, nation: draft.nation || null,
    symbol: draft.symbol, side: draft.side, order_type: 'limit',
    price: draft.price, qty: draft.qty, amount: (draft.qty || 0) * (draft.price || 0),
    confirmed: draft.user_confirmed === true, reason: draft.reason || null,
    created_by: draft.created_by || null,
  };
  if (block) {
    logOrder(Object.assign({}, baseRow, {
      status: 'blocked', block_reason: block.reason, detail: block.detail,
      broker_order_no: null, filled_at: null,
    }), opts);
    return { ok: false, blocked: true, reason: block.reason, detail: block.detail, error: `관문 차단(${block.reason})` };
  }

  // 통과 → 전송(실전은 어댑터 비활성(TSK-012 전)이라 여기서 거부됨 — 전송 0 유지)
  let res;
  try {
    res = await api.order(draft.side, draft.symbol, draft.qty, draft.price);
  } catch (e) {
    logOrder(Object.assign({}, baseRow, {
      status: 'rejected', block_reason: null, detail: { error: e.message },
      broker_order_no: null, filled_at: null,
    }), opts);
    return { ok: false, error: e.message };
  }
  if (res.rt !== '0') {
    logOrder(Object.assign({}, baseRow, {
      status: 'rejected', block_reason: null, detail: { msg: res.msg },
      broker_order_no: res.odno || null, filled_at: null,
    }), opts);
    return { ok: false, error: res.msg, result: res };
  }

  // 체결조회(10초 간격 최대 1분 — ARC-003) 후 결과까지 기록(AC4)
  const fill = await pollFill(api, res.odno, today, opts);
  logOrder(Object.assign({}, baseRow, {
    status: fill.status, block_reason: null,
    broker_order_no: res.odno || null,
    filled_at: fill.status === 'filled' || fill.status === 'partial' ? new Date().toISOString() : null,
    detail: fill.row ? { filled: fill.row.filled, remain: fill.row.remain, avgFill: fill.row.avgFill } : {},
  }), opts);
  return { ok: true, result: res, fill: fill.row ? { filled: fill.row.filled, remain: fill.row.remain, status: fill.status } : null };
}

// --- 조회 통로(관문용): 주문이 아닌 함수만 — price/balance/fills/dailyCandle ---
const QUERY_FNS = { price: 'quote', balance: 'balance', fills: 'fills', dailyCandle: 'dailyCandle', dailyIndexCandle: 'dailyIndexCandle' };
async function query(env, fn, args, opts) {
  const mapped = QUERY_FNS[fn];
  if (!mapped) throw new Error(`조회 불가 함수: ${fn} — 주문은 gate.submit만`);
  const api = await makeAdapter(env, opts || {});
  return api[mapped](...(args || []));
}

// --- 정정·취소(STOP 검사 후 어댑터 경유 — gate만이 유일 통로) ---
// 실전 정정·취소는 aside_chat 실전 주문이 허용된 경우에만(기존 주문의 축소·철회 동작).
function realAmendAllowed(opts) {
  return realOrderAllowed({ created_by: 'aside_chat', user_confirmed: true, reason: 'amend' }, opts);
}
async function amend(env, [orgno, odno, qty, newPrice], opts) {
  const g = guard.loadGuard(opts);
  if (!g) throw new Error('관문 차단(guard_missing)');
  if (fs.existsSync(g.stop_file_path)) throw new Error('관문 차단(stop_file)');
  const api = await makeAdapter(env, opts || {}, env === 'real' && realAmendAllowed(opts || {}));
  return api.modify(orgno, odno, qty, newPrice);
}
async function revoke(env, [orgno, odno, qty], opts) {
  const g = guard.loadGuard(opts);
  if (!g) throw new Error('관문 차단(guard_missing)');
  if (fs.existsSync(g.stop_file_path)) throw new Error('관문 차단(stop_file)');
  const api = await makeAdapter(env, opts || {}, env === 'real' && realAmendAllowed(opts || {}));
  return api.cancel(orgno, odno, qty);
}

// --- 검사 미리보기(전송·기록 없음) — 실행 모달(SCR-001)의 검사 결과판용 ---
async function precheck(draft, opts) {
  opts = opts || {};
  const env = draft.account_type === 'real' ? 'real' : 'mock';
  const api = await makeAdapter(env, opts, false); // 미리보기는 전송 불가 어댑터
  const block = await runChecks(draft, env, api, opts);
  return {
    blocked: !!block,
    reason: block ? block.reason : null,
    detail: block ? block.detail : null,
    realAllowed: env !== 'real' ? true : realOrderAllowed(draft, opts),
  };
}

module.exports = { submit, precheck, query, amend, revoke, realOrderAllowed, pearson, returnsOf };
