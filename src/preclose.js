'use strict';

// 15:05 마감 전 점검 (REQ-007 / TSK-008)
//
// 보유 종목별 현재가와 손절선·목표선의 거리(%)를 계산해
//  - 거리 ≤ 3%  : "판정 필요"(needJudgment)
//  - 거리 ≤ 0.5%: "동시호가 반전 가능" 경고 추가(auctionWarning)
//  - 3% 초과    : 조용히 지나감(목록에 없음)
//  - 기준선 미등록 보유 종목: "기준선 누락"(missingLine)
// 결과는 한 묶음(preclose_log 1행)으로 기록한다. 알림은 훅 자리만(TSK-011).

const crypto = require('node:crypto');
const ledger = require('./ledger');
const paths = require('./paths');
const state = require('./state');
const { kstParts } = require('./kst');

const NEED_PCT = 3;      // 판정 필요(이하 기준)
const AUCTION_PCT = 0.5; // 동시호가 경고(이하 기준)

// opts: { dataDir, now, providers:{quote}, notify }
// 반환: { date, items }
function check(opts) {
  const notify = opts.notify || (() => {});
  const { date } = kstParts(opts.now || new Date());
  const nowIso = (opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now())).toISOString();

  const positions = (state.read('positions', opts) || []).filter((p) => p.status === 'open');
  const items = [];

  for (const p of positions) {
    // 기준선 누락(정상 흐름이면 있을 수 없는 상태) — 경고
    if (p.stop_price == null && p.target_price == null) {
      items.push({ symbol: p.symbol, name: p.name, missingLine: true });
      continue;
    }
    let price;
    try {
      price = opts.providers.quote(p.symbol).price;
    } catch (e) {
      items.push({ symbol: p.symbol, name: p.name, quoteFailed: true });
      continue;
    }

    // 거리(%) = |현재가 − 기준선| ÷ 기준선 × 100, 손절선·목표선 각각
    const dists = [];
    for (const [line, lineName] of [[p.stop_price, 'stop'], [p.target_price, 'target']]) {
      if (line == null) continue;
      dists.push({ lineName, line, dist: (Math.abs(price - line) / line) * 100 });
    }
    const nearest = dists.reduce((a, b) => (a.dist <= b.dist ? a : b));
    if (nearest.dist > NEED_PCT) continue; // 3% 초과 — 침묵

    items.push({
      symbol: p.symbol,
      name: p.name,
      price,
      line: nearest.line,
      lineName: nearest.lineName,
      distPct: Math.round(nearest.dist * 10) / 10,
      needJudgment: true,
      auctionWarning: nearest.dist <= AUCTION_PCT,
    });
  }

  // 한 메시지에 모아서 — 장부 1행 + 알림 훅
  ledger.append('preclose_log', { id: crypto.randomUUID(), date, items, created_at: nowIso }, opts);
  notify({ kind: 'preclose', date, items });
  return { date, items };
}

module.exports = { check };
