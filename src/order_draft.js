'use strict';

// 출사표(주문 초안) INSERT — AI 전용 경로 (REQ-017 / DAT-001)
//
// 불변식: 군사 엔진(AI)이 만든 출사표는 반드시 created_by='ai', user_confirmed=false로만
// 기록된다. 주문 전송·실행 확인 플래그를 켜는 함수는 이 모듈(및 strategist)에 '존재하지 않는다'.
// - AI 출력이 user_confirmed=true 등 실행 플래그를 올리려 하면: 저장 거부(조작 시도로 간주).
// - 그 외 created_by 같은 값이 와도 무시하고 ai/false로 강제한다(지시2).
// - 5항목([[REQ-001]]) 미달이면 저장 거부(불성립 초안 생성 금지).
//
// 기록은 ledger.append('order_draft', ...)만 사용(직접 파일 쓰기 금지).

const crypto = require('node:crypto');
const ledger = require('./ledger');

// REQ-001 필수 5항목(진입 가격대=하한/상한, 손절선, 목표가, 기한, 병력 수).
const REQUIRED = ['entry_low', 'entry_high', 'stop_price', 'target_price', 'deadline', 'troops'];

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// 출사표 성립 검증(REQ-001 값 제약). 통과 시 null, 실패 시 사유 문자열.
function validate(d) {
  for (const f of REQUIRED) {
    if (d[f] == null) return `missing_${f}`;
  }
  if (!['buy', 'sell'].includes(d.side)) return 'bad_side';
  if (typeof d.symbol !== 'string' || d.symbol.length === 0) return 'bad_symbol';
  if (!['real', 'paper'].includes(d.account_type)) return 'bad_account_type';
  if (!isNum(d.entry_low) || !isNum(d.entry_high) || d.entry_low > d.entry_high) return 'bad_entry_band';
  if (!isNum(d.troops) || d.troops < 1 || !Number.isInteger(d.troops)) return 'bad_troops';
  if (d.side === 'buy') {
    if (!(d.stop_price < d.entry_low)) return 'bad_stop_for_buy';
    if (!(d.target_price > d.entry_high)) return 'bad_target_for_buy';
  }
  return null;
}

// 출력으로부터 강제된 order_draft 행을 만든다(실행 플래그는 항상 꺼짐).
// createdBy는 'ai'(군사 엔진) 또는 'system'(자동 판정 — TSK-008)만 — 사람 값은 여기로 오지 않는다.
function buildRow(ai, now, createdBy) {
  return {
    id: ai.id || crypto.randomUUID(),
    account_type: ai.account_type,
    nation: ai.nation != null ? ai.nation : null,
    symbol: ai.symbol,
    side: ai.side,
    entry_low: ai.entry_low,
    entry_high: ai.entry_high,
    stop_price: ai.stop_price,
    target_price: ai.target_price,
    deadline: ai.deadline,
    troops: ai.troops,
    status: 'draft',
    // === 강제 불변식(REQ-017/REQ-008) — 입력값 무시 ===
    user_confirmed: false,
    confirmed_at: null,
    created_by: createdBy,
    rationale: typeof ai.rationale === 'string' ? ai.rationale : null,
    breach_date: ai.breach_date || null,
    created_at: now,
  };
}

function insertDraft(input, opts, createdBy) {
  const now = (opts && opts.now) || new Date().toISOString();

  if (!input || typeof input !== 'object') {
    return { saved: false, rejected: true, reason: 'no_output' };
  }
  // 실행 플래그 조작 시도 → 저장 거부(TST-012 #2 / REQ-017 AC3).
  if (input.user_confirmed === true) {
    return { saved: false, rejected: true, reason: 'flag_manipulation_user_confirmed' };
  }
  // 성립 검증(불성립 초안 생성 금지).
  const bad = validate(input);
  if (bad) {
    return { saved: false, rejected: true, reason: `incomplete_${bad}` };
  }
  // AI 초안은 근거(rationale) 필수 — REQ-017 "초안 생성 시 근거를 함께 적는다"(TSK-014).
  if (createdBy === 'ai' && (typeof input.rationale !== 'string' || !input.rationale.trim())) {
    return { saved: false, rejected: true, reason: 'incomplete_rationale' };
  }

  const row = buildRow(input, now, createdBy);
  ledger.append('order_draft', row, opts);
  return { saved: true, rejected: false, row };
}

// AI(군사 엔진) 출력을 검사해 INSERT — created_by='ai' 강제.
function insertAiDraft(ai, opts) {
  return insertDraft(ai, opts, 'ai');
}

// 자동 판정(손절 매도 등 — TSK-008)의 초안 INSERT — created_by='system' 강제.
// 실행 확인은 똑같이 사람 몫(user_confirmed=false 고정, 전송 수단 없음).
function insertSystemDraft(d, opts) {
  return insertDraft(d, opts, 'system');
}

// 의도적으로 INSERT(와 검증기)만 노출 — 전송·확인 함수는 두지 않는다.
module.exports = { insertAiDraft, insertSystemDraft, validate, REQUIRED };
