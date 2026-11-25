'use strict';

// 회군 사이클 (TSK-019 보완 / REQ-024·025·026 연결)
//
// 매도 체결(또는 기한 만료)으로 전투가 끝나면 한 번에 묶어 기록한다:
//  ① trade_result 원장 — 4분면 입력(손익·근거 인용·성벽/기한 이행·위반 수). 모의·실전 공통.
//  ② 출사표가 인용한 가설마다 kind=trade 증거 자동 적립 —
//     판정식 있으면 앱 자동(success/fail), 없으면 군주 판정 대기. rule(군령류)은 제외.
//  ③ captive_ledger 손익 반영(포로·전공) — 그림자 모드(shadow=true)는 '기록만':
//     trade_result·증거는 남기되 실손익 원장(captive)은 건드리지 않는다(가짜 손익 오염 방지).
//
// 근거 인용(rationale_cited) 판정은 citable 가설 기준 — rule만 인용한 거래는 근거 없음(요행/실패 축).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ledger = require('./ledger');
const state = require('./state');
const hyp = require('./hypothesis');
const captives = require('./captives');
const paths = require('./paths');

// 멱등 키 조회: 같은 체결(close_key)로 두 번 기록되지 않게(출사표 002 지시 3)
function closeKeyExists(key, opts) {
  if (!key) return false;
  const d = paths.ledgerDir(paths.resolveDataDir(opts), 'trade_result');
  if (!fs.existsSync(d)) return false;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim() && JSON.parse(line).close_key === key) return true;
    }
  }
  return false;
}

// input: {
//   account_type('real'|'paper'), symbol, trade_date, pnl(원, 확정),
//   hypothesis_ids(출사표 인용), vars(판정식 평가용 시세 — 없으면 대기),
//   wall_deadline_respected(성벽·기한 이행), violation_count,
//   order_log_id?, draft_id?, note?, shadow?(그림자 — captive 미반영)
// }
async function closeTrade(input, opts) {
  if (!input || !['real', 'paper'].includes(input.account_type)) throw new Error('account_type는 real/paper');
  if (!input.trade_date) throw new Error('trade_date 필수');
  if (typeof input.pnl !== 'number') throw new Error('pnl(확정 손익) 필수');
  // 멱등: 같은 체결(close_key)은 1회만
  if (input.close_key && closeKeyExists(input.close_key, opts)) {
    return { skipped: true, reason: 'duplicate_close_key' };
  }

  const ids = Array.isArray(input.hypothesis_ids) ? input.hypothesis_ids : [];
  const bookItems = (state.read('hypothesis_book', opts) || { items: [] }).items;
  const citable = ids
    .map((id) => bookItems.find((x) => x.id === id))
    .filter((h) => h && h.status !== 'rule' && h.citable !== false && h.status !== 'discarded');

  // ① 4분면 입력(trade_result) — 근거 인용은 citable 기준
  const tradeRow = {
    id: crypto.randomUUID(),
    date: input.trade_date, trade_date: input.trade_date,
    account_type: input.account_type, symbol: input.symbol || null,
    nation: input.nation || null, // 세력전 귀속(TSK-023 — 나라별 논공행상 집계용)
    pnl: input.pnl,
    rationale_cited: citable.length >= 1,
    wall_deadline_respected: input.wall_deadline_respected === true,
    violation_count: input.violation_count || 0,
    hypothesis_ids: ids.length ? ids : null,
    order_log_id: input.order_log_id || null,
    draft_id: input.draft_id || null,
    close_key: input.close_key || null,
    shadow: input.shadow === true,
    created_at: new Date().toISOString(),
  };
  ledger.append('trade_result', tradeRow, opts);

  // ② 인용 가설(citable)마다 출병 증거 — 판정식 자동 / 군주 판정 대기
  const evidences = [];
  for (const h of citable) {
    const r = hyp.recordTradeEvidence(h.id, input.vars || null, {
      evidence_date: input.trade_date,
      note: input.note || `회군(${input.symbol || ''} ${input.pnl >= 0 ? '+' : ''}${input.pnl}원) — 손익 무관 가설 적중 판정`,
      symbol: input.symbol,
      pnl: input.pnl,
    }, opts);
    evidences.push(Object.assign({ hypothesis_id: h.id }, r));
  }

  // ③ 손익 원장(포로·전공) — 그림자는 기록만(미반영)
  let captive = null;
  if (input.shadow !== true) {
    captive = captives.recordPnl({
      account_type: input.account_type,
      trade_date: input.trade_date,
      order_log_id: input.order_log_id || tradeRow.id,
      realized_pnl: input.pnl,
    }, opts);
  }

  return { tradeResultId: tradeRow.id, evidences, captive, shadow: tradeRow.shadow };
}

module.exports = { closeTrade };
