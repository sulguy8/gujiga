'use strict';

// 관직 표(설정) — REQ-013 / NTE-005
//
// 관직에 따라 한 종목 최대 병력(종목당 투자 상한)·동시 종목 수·실전 1회 한도가 정해진다.
// 비기능 요구에 따라 표는 코드가 아닌 설정(JSON)으로 관리한다 — 수치 조정에 배포 불필요.
//   기본 경로: <repo>/config/rank_table.json  (opts.rankTablePath 또는 GUJIGA_RANK_TABLE로 교체 가능)

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'rank_table.json');
const RANK_ORDER = ['hyeonryeong', 'taesu', 'jasa', 'daejanggun', 'seungsang'];

function tablePath(opts) {
  return (opts && opts.rankTablePath) || process.env.GUJIGA_RANK_TABLE || DEFAULT_PATH;
}

function loadRankTable(opts) {
  const raw = JSON.parse(fs.readFileSync(tablePath(opts), 'utf8'));
  const table = {};
  for (const k of RANK_ORDER) {
    if (!raw[k]) throw new Error(`관직 표에 ${k}가 없습니다: ${tablePath(opts)}`);
    table[k] = raw[k];
  }
  return table;
}

// 한 관직의 한도 묶음을 반환한다.
// perStockLimitWon = 병력 한도 × 1만원. 승상(재량)은 null 그대로 둔다.
function rankLimits(rank, opts) {
  const table = loadRankTable(opts);
  const r = table[rank];
  if (!r) throw new Error(`알 수 없는 관직: ${rank}`);
  const troops = r.per_stock_troops_max;
  return {
    rank,
    label: r.label,
    perStockTroopsMax: troops,
    concurrentMax: r.concurrent_max,
    perStockLimitWon: troops == null ? null : troops * 10000,
    perOrderLimitReal: r.per_order_limit_real,
  };
}

module.exports = { loadRankTable, rankLimits, RANK_ORDER };
