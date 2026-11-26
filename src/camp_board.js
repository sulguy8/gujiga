'use strict';

// 군영 현황판 데이터 조립 (SCR-005 / TSK-009)
//
// 장부 '읽기 전용' — 이 모듈은 아무 것도 쓰지 않는다.
// 숫자는 장부 값 그대로(1만원=병사 1명). 포로 반올림은 TSK-004의 captivesOf를 재사용한다.
// 장부가 아직 없는 구역은 '없음'으로 — 오류를 내지 않는다(안전 표시).

const fs = require('node:fs');
const path = require('node:path');

const state = require('./state');
const paths = require('./paths');
const ranks = require('./ranks');
const generalRank = require('./general_rank');
const captives = require('./captives');
const symbols = require('./symbols');

// 원장 전체 행 읽기(없으면 빈 배열)
function readLedgerRows(dataDir, name) {
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

// 병사 환산: 금액(원) → 명. 병법서 1조 — 1만원당 1명, '소수점 버림'(155,000원 → 15명, 9,999원 → 0명).
// 반올림은 포로 환산(captivesOf)에만 쓴다 — 두 규칙을 섞지 않는다(군주 명 2026-11-25).
function troopsOf(amountWon) {
  return Math.floor(amountWon / 10000);
}

// 관직 카드: 현재 관직·한도·승진 진행. 승진 조건 충족 시 eligible(표시만 — 확정은 군주 수락).
function rankCard(opts) {
  try {
    const r = generalRank.getRank(opts);
    const lim = generalRank.getLimits(opts);
    const sortie = r ? r.sortie_count : 0;
    const clean = r ? r.clean_weeks : 0;
    const review = r ? r.review_weeks : 0;
    const violations = readLedgerRows(paths.resolveDataDir(opts), 'violation');

    // 승진 조건(REQ-013 관직 표): 현령→태수 = 출병 5 + 위반 0 + 주간 복기 4주.
    // 상위 관직 조건(자사·대장군)은 손절 준수율 등 추가 데이터가 필요해 후속 TSK에서 확장.
    let eligible = false;
    if ((lim.rank || 'hyeonryeong') === 'hyeonryeong') {
      eligible = sortie >= 5 && review >= 4 && violations.length === 0;
    }

    return {
      ok: true,
      rank: lim.rank,
      label: lim.label || lim.rank,
      perStockLimitWon: lim.perStockLimitWon,
      concurrentMax: lim.concurrentMax,
      sortie, clean, review,
      violationCount: violations.length,
      lastViolation: violations.length ? violations[violations.length - 1] : null,
      eligible,
    };
  } catch (e) {
    return { ok: false, error: '집계 실패' };
  }
}

// 병력 요약: 당일(또는 최신) 계좌 스냅샷에서 총 병력·군량 비중.
function forcesCard(opts) {
  try {
    const rows = readLedgerRows(paths.resolveDataDir(opts), 'daily_account_snapshot');
    if (rows.length === 0) return { ok: true, empty: true };
    const latest = rows[rows.length - 1];
    const total = latest.start_total_eval;
    const cash = latest.start_cash;
    const cashRatio = total > 0 ? cash / total : null;
    return {
      ok: true,
      empty: false,
      date: latest.snapshot_date,
      accountType: latest.account_type,
      totalEval: total,
      totalTroops: troopsOf(total),
      cash,
      cashRatioPct: cashRatio == null ? null : Math.round(cashRatio * 100),
      rationWarn: cashRatio != null && cashRatio < 0.35, // 35% 미만 주황 경고(SCR-005)
    };
  } catch (e) {
    return { ok: false, error: '집계 실패' };
  }
}

// 그림자가 남긴 최근 시세 캐시(지령 015 — 읽기 전용). 없으면 null.
function quotesCache(opts) {
  try {
    const f = path.join(paths.resolveDataDir(opts), 'market_cache', 'quotes_latest.json');
    if (!fs.existsSync(f)) return null;
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    return c && c.quotes ? c : null;
  } catch (e) {
    return null;
  }
}

// 출병 중인 성 표: positions 상태 파일(open 행).
// 현재가는 그림자 시세 캐시(읽기 전용)로 — 평가·성벽까지 거리·기준 시각을 함께 준다.
function castles(opts) {
  try {
    const list = state.read('positions', opts);
    if (!Array.isArray(list)) return { ok: true, rows: [], none: true };
    const cache = quotesCache(opts);
    const open = list.filter((p) => p.status === 'open');
    return {
      ok: true,
      none: false,
      quoteAt: cache ? cache.updated_at : null, // 기준 시각(없으면 시세 미연결)
      rows: open.map((p) => {
        const amount = p.qty * p.avg_price;
        const price = cache && typeof cache.quotes[p.symbol] === 'number' ? cache.quotes[p.symbol] : null;
        return {
          symbol: p.symbol,
          name: p.name || symbols.nameOf(p.symbol, opts) || p.symbol,
          nation: p.nation || null,
          qty: p.qty,
          amount,
          troops: troopsOf(amount),
          stopPrice: p.stop_price,
          price,
          evalAmount: price != null ? price * p.qty : null,
          returnPct: price != null && p.avg_price > 0 ? Math.round(((price / p.avg_price) - 1) * 1000) / 10 : null,
          stopDistance: price != null && p.stop_price != null && p.stop_price > 0
            ? Math.round(((price - p.stop_price) / p.stop_price) * 1000) / 10
            : null,
        };
      }),
    };
  } catch (e) {
    return { ok: false, error: '집계 실패' };
  }
}

// 포로·전공: TSK-004 computeState 재사용(원장 재계산 — 최신 행과 일치 보장).
function captivesCard(opts) {
  try {
    const paper = captives.computeState('paper', opts);
    const real = captives.computeState('real', opts);
    return { ok: true, paper, real };
  } catch (e) {
    return { ok: false, error: '집계 실패' };
  }
}

// 포로 발생일(오늘 확정 손실 존재) → 복수 출병 금지(REQ-015 입력).
function revengeBanToday(opts, today) {
  try {
    const rows = readLedgerRows(paths.resolveDataDir(opts), 'captive_ledger');
    return rows.some((r) => r.trade_date === today && r.realized_pnl < 0);
  } catch (e) {
    return false;
  }
}

// 현황판 전체 데이터(읽기 전용).
function gather(opts) {
  const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
  return {
    today,
    rank: rankCard(opts),
    forces: forcesCard(opts),
    castles: castles(opts),
    captives: captivesCard(opts),
    revengeBan: revengeBanToday(opts, today),
  };
}

module.exports = { gather, troopsOf, quotesCache };
