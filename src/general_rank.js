'use strict';

// 관직·승진 카운트·군령 위반 (REQ-013 / DAT-011)
//
// - general_rank: 현재 관직 상태(1행, 상태 파일). 조회 불가 시 가장 낮은 관직(현령)으로 동작(안전 우선).
// - 승진은 자동이 아니다 — promote()는 군주의 수락을 코드로 반영하는 지점.
// - violation: 군령 위반 기록(추가 전용, ledger.append만 사용). 위반 1건 → 승진 카운트 3종 0 초기화.

const crypto = require('node:crypto');
const ledger = require('./ledger');
const state = require('./state');
const ranks = require('./ranks');

const STATE_NAME = 'general_rank';
const COUNT_FIELDS = ['sortie_count', 'clean_weeks', 'review_weeks'];
const VIOLATION_CODES = new Set([
  'V1_no_draft',        // 출사표 없이 출병
  'V2_stop_exit_missed', // 손절 매도 기한 미이행
  'V3_revenge',         // 복수 매매
  'V4_correlation',     // 상관 0.7 이상 동시 보유
  'V5_ration',          // 현금 30% 미만
]);

// 현재 관직 상태(없으면 null).
function getRank(opts) {
  return state.read(STATE_NAME, opts);
}

// 관직 표에서 한 관직의 상태 레코드를 만든다.
function rankRecord(rank, opts, extra) {
  const lim = ranks.rankLimits(rank, opts);
  return Object.assign(
    {
      id: 'me',
      rank,
      per_stock_troops_max: lim.perStockTroopsMax,
      concurrent_max: lim.concurrentMax,
      sortie_count: 0,
      clean_weeks: 0,
      review_weeks: 0,
      promoted_at: null,
      updated_at: new Date().toISOString(),
    },
    extra || {}
  );
}

// 현재 관직의 한도(조회). 상태가 없으면 안전 기본 = 현령.
function getLimits(opts) {
  const r = getRank(opts);
  const rank = (r && r.rank) || 'hyeonryeong';
  return ranks.rankLimits(rank, opts);
}

// 실전 1회 주문 한도(조회) — 현재 관직 기준(현령 20만 / 태수 30만 …). REQ-003 동기화 원천.
function getRealOrderLimit(opts) {
  return getLimits(opts).perOrderLimitReal;
}

// 관직 승진/변경을 반영한다(군주 수락의 코드 반영 — 자동 승진 아님).
// 관직 표 한도로 상태를 갱신하고, guard_config가 있으면 per_order_limit_real을 동기화한다.
function promote(rank, opts) {
  const lim = ranks.rankLimits(rank, opts); // 유효성 검사 겸
  const prev = getRank(opts);
  const rec = rankRecord(rank, opts, {
    // 승진해도 승진 카운트는 새 관직 기준으로 다시 0부터(진행 카운트는 관직별).
    promoted_at: new Date().toISOString(),
  });
  state.write(STATE_NAME, rec, opts);
  syncGuardOrderLimit(lim.perOrderLimitReal, opts);
  return rec;
}

// 승진 카운트 진행 상태를 설정/증가 반영한다(테스트·루틴 입력용).
function setProgress(counts, opts) {
  const cur = getRank(opts) || rankRecord('hyeonryeong', opts);
  for (const f of COUNT_FIELDS) {
    if (counts && typeof counts[f] === 'number') cur[f] = counts[f];
  }
  cur.updated_at = new Date().toISOString();
  state.write(STATE_NAME, cur, opts);
  return cur;
}

// 군령 위반 1건 기록 → 원장(append-only)에 남기고 승진 카운트 3종을 0으로 초기화한다.
function recordViolation(v, opts) {
  if (!v || !VIOLATION_CODES.has(v.code)) {
    throw new Error(`허용되지 않은 위반 코드입니다(V1~V5만): ${v && v.code}`);
  }
  const now = new Date().toISOString();
  const row = {
    id: v.id || crypto.randomUUID(),
    violation_date: v.violation_date,
    code: v.code,
    context: v.context || '',
    order_log_id: v.order_log_id || null,
    created_at: v.created_at || now,
  };
  // 원장 기록은 반드시 ledger.append만 사용(직접 파일 쓰기 금지).
  ledger.append('violation', row, opts);

  // 승진 카운트 초기화(REQ-013 AC3 / DAT-011 연동 규칙).
  const cur = getRank(opts) || rankRecord('hyeonryeong', opts);
  for (const f of COUNT_FIELDS) cur[f] = 0;
  cur.updated_at = now;
  state.write(STATE_NAME, cur, opts);

  return { violation: row, rank: cur };
}

// guard_config가 있으면 실전 1회 한도를 관직과 동기화한다(없으면 조용히 통과).
function syncGuardOrderLimit(perOrderLimitReal, opts) {
  if (perOrderLimitReal == null) return;
  const cfg = state.read('guard_config', opts);
  if (!cfg) return;
  if (cfg.per_order_limit_real === perOrderLimitReal) return;
  cfg.per_order_limit_real = perOrderLimitReal;
  cfg.updated_at = new Date().toISOString();
  state.write('guard_config', cfg, opts);
}

module.exports = {
  getRank,
  getLimits,
  getRealOrderLimit,
  promote,
  setProgress,
  recordViolation,
  VIOLATION_CODES,
};
