'use strict';

// 군율(guard_config) 로드·검증 + 검사 함수 (DAT-003 / REQ-003·REQ-004)
//
// 안전 원칙: guard_config 행이 없거나 제약을 위반하면 '모든 검사'가 차단을 반환한다
// (안전 쪽으로 실패 — 설정이 불확실하면 돈을 내보내지 않는다). DAT-003 마이그레이션 영향도 참조.
//
// ※ 각 검사의 상세 로직 자체는 REQ-003/004/015 소관이다. 여기서는 TSK-004 범위인
//   'guard_config 로드·검증과 없을 때의 전면 차단 안전 동작'을 확정하고, 대표 검사 3종을 제공한다.

const fs = require('node:fs');
const state = require('./state');

const BLOCK_MISSING = { allowed: false, reason: 'guard_missing' };

// guard_config를 읽고 검증한다. 유효하면 설정 객체, 아니면 null(= 차단 신호).
function loadGuard(opts) {
  const cfg = state.read('guard_config', opts);
  if (!cfg) return null;
  return isValid(cfg) ? cfg : null;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// DAT-003 값 제약을 그대로 검사(하나라도 어기면 안전하게 무효 처리).
function isValid(c) {
  return (
    c.id === 'default' &&
    isNum(c.per_order_limit_real) && c.per_order_limit_real > 0 &&
    isNum(c.per_order_limit_paper) && c.per_order_limit_paper > 0 &&
    isNum(c.daily_loss_limit) && c.daily_loss_limit < 0 &&
    typeof c.stop_file_path === 'string' && c.stop_file_path.length > 0 &&
    isNum(c.cash_ratio_min) && c.cash_ratio_min > 0 && c.cash_ratio_min < 1 &&
    isNum(c.correlation_max) && c.correlation_max > 0 && c.correlation_max <= 1 &&
    isNum(c.sample_min) && c.sample_min >= 1
  );
}

// STOP 파일이 존재하면 전체 주문 중단(REQ-004). guard 없으면 차단.
function checkStopFile(_input, opts) {
  const g = loadGuard(opts);
  if (!g) return BLOCK_MISSING;
  if (fs.existsSync(g.stop_file_path)) return { allowed: false, reason: 'stop_file' };
  return { allowed: true };
}

// 1회 주문 한도 초과 차단(REQ-003). guard 없으면 차단.
function checkPerOrderLimit(input, opts) {
  const g = loadGuard(opts);
  if (!g) return BLOCK_MISSING;
  const limit = input.accountType === 'real' ? g.per_order_limit_real : g.per_order_limit_paper;
  if (!(input.amount <= limit)) return { allowed: false, reason: 'per_order_limit' };
  return { allowed: true };
}

// 하루 손실 한도 차단(REQ-003): 당일 총평가가 시작 대비 한도 이하면 매수 차단. guard 없으면 차단.
function checkDailyLoss(input, opts) {
  const g = loadGuard(opts);
  if (!g) return BLOCK_MISSING;
  const loss = input.currentEval - input.dayStartEval;
  if (loss <= g.daily_loss_limit) return { allowed: false, reason: 'daily_loss' };
  return { allowed: true };
}

// '모든 검사 함수' 목록 — guard 없을 때 전부 차단되는지 일괄 검증 가능(TST-004 시나리오8).
const CHECKS = [
  { name: 'stop_file', fn: checkStopFile, sample: {} },
  { name: 'per_order_limit', fn: checkPerOrderLimit, sample: { amount: 100000, accountType: 'real' } },
  { name: 'daily_loss', fn: checkDailyLoss, sample: { currentEval: 0, dayStartEval: 0 } },
];

module.exports = { loadGuard, checkStopFile, checkPerOrderLimit, checkDailyLoss, CHECKS };
