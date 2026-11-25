'use strict';

// 포로·구출·전공 계산 (REQ-014 / DAT-012)
//
// 규칙:
//  - 손실(확정 pnl<0): 누적 손실액(loss_outstanding)에 |pnl| 더함. 전공 변화 없음.
//  - 수익(pnl>0): 누적 손실부터 차감(구출). 포로가 0이 된 뒤의 잔여 수익만 전공.
//  - 내부 금액은 원 단위 정확. '포로 명수' 표시만 반올림(round, 1만원=1명).
//
// 원장 기록은 반드시 ledger.append만 사용한다(직접 파일 쓰기 금지). 읽기는 fs로 직접 한다.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ledger = require('./ledger');
const paths = require('./paths');

// 누적 손실액(원) → 포로 명수(반올림). 14,000→1, 16,000→2, 5,000→1(round half up).
function captivesOf(lossWon) {
  return Math.round(lossWon / 10000);
}

// 순수 계산 1스텝: prev={lossOutstanding, meritTotal}, pnl(원, 음수=손실)
function captiveStep(prev, pnl) {
  let loss = prev.lossOutstanding || 0;
  let merit = prev.meritTotal || 0;
  let meritDelta = 0;

  if (pnl < 0) {
    loss += -pnl; // 포로 적립
  } else if (pnl > 0) {
    const rescue = Math.min(loss, pnl); // 구출 우선
    loss -= rescue;
    meritDelta = pnl - rescue; // 포로 0 이후 잔여만 전공
    merit += meritDelta;
  }

  return {
    lossOutstanding: loss,
    meritTotal: merit,
    meritDelta,
    captives: captivesOf(loss),
  };
}

// 한 계좌의 captive_ledger 전체 행을 시간순(created_at)으로 반환한다.
function readRows(accountType, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const dir = paths.ledgerDir(dataDir, 'captive_ledger');
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (!accountType || r.account_type === accountType) rows.push(r);
    }
  }
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows;
}

// 현재 누적 상태(계좌별)를 원장 전체 재계산으로 구한다(정합성 = 재계산 일치).
function computeState(accountType, opts) {
  const rows = readRows(accountType, opts);
  let s = { lossOutstanding: 0, meritTotal: 0 };
  for (const r of rows) s = captiveStep(s, r.realized_pnl);
  // 원장이 비어 있으면 captiveStep을 거치지 않아 s.captives가 없다 — 항상 재계산해 반환.
  return { lossOutstanding: s.lossOutstanding, captives: captivesOf(s.lossOutstanding), meritTotal: s.meritTotal };
}

// 확정 손익 이벤트 1건을 기록한다. 이전 상태를 원장 재계산으로 구한 뒤 1스텝 진행해
// captive_ledger에 ledger.append로 1행 추가한다. 추가된 행을 반환한다.
function recordPnl(event, opts) {
  if (!event || typeof event.realized_pnl !== 'number') {
    throw new Error('recordPnl: realized_pnl(원)이 필요합니다.');
  }
  const accountType = event.account_type;
  if (accountType !== 'real' && accountType !== 'paper') {
    throw new Error(`recordPnl: account_type는 real/paper (받음: ${accountType})`);
  }

  const prev = computeState(accountType, opts);
  const step = captiveStep(prev, event.realized_pnl);
  const now = new Date().toISOString();

  const row = {
    id: event.id || crypto.randomUUID(),
    account_type: accountType,
    trade_date: event.trade_date,
    order_log_id: event.order_log_id,
    realized_pnl: event.realized_pnl,
    loss_outstanding_after: step.lossOutstanding,
    captives_after: step.captives,
    merit_delta: step.meritDelta,
    merit_total_after: step.meritTotal,
    created_at: event.created_at || now,
  };

  ledger.append('captive_ledger', row, opts);
  return row;
}

module.exports = { captivesOf, captiveStep, computeState, recordPnl };
