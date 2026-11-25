'use strict';

// 세력 장부 — 촉·위·오 (TSK-023 / DAT-007 / REQ-009·010)
//
// 원칙: 저장값을 신뢰하지 않는다 — 현금·실현손익·보유는 항상 모의 order_log(체결)에서
// 재계산한다. 저장(state nation_ledger)은 표시·정합성 대조용 스냅샷일 뿐이다.
//  - 배정: 촉 100만 / 위 50만 / 오 50만(합 200만 — config/nations.json, 어긋나면 기동 거부)
//  - 귀속: 모의 체결(account_type=paper)은 nation이 있어야 한다 — 무소속은 위반으로 보고(AC1)
//  - 정합성: 재계산 vs 저장 스냅샷이 다르면 나라·수치와 함께 경고(AC2)
//  - 주간 논공행상(REQ-010): 손익·출병 수(매수 체결)·매복 성공률(위 전용 — 체결 예약 ÷ 걸어둔 예약)
//  - 이관: Aside mock_portfolio.md 1회(읽기 전용) — 미체결→submitted, 만료→cancelled,
//    '테스트' 트랙은 세력전 밖 connection_test 원장으로 분리

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const state = require('./state');
const ledger = require('./ledger');
const paths = require('./paths');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'nations.json');
const NATIONS = ['chok', 'wi', 'o'];

function allocations(opts) {
  const cfg = (opts && opts.nationsConfig) || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const a = cfg.allocations;
  const sum = NATIONS.reduce((s, n) => s + a[n], 0);
  if (sum !== 2000000) throw new Error(`배정 합계 오류: ${sum} ≠ 2,000,000`);
  return a;
}

function readOrderLog(opts) {
  const d = paths.ledgerDir(paths.resolveDataDir(opts), 'order_log');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// --- 재계산(저장값 신뢰 금지): 체결 흐름에서 나라별 현금·보유·실현손익 복원 ---
// quotes(선택): {symbol: price} — 있으면 평가액, 없으면 평단(원가) 기준.
function computeLedger(opts, quotes) {
  const alloc = allocations(opts);
  const ledgers = {};
  for (const n of NATIONS) {
    ledgers[n] = { nation: n, allocated: alloc[n], cash: alloc[n], position_value: 0, realized_pnl: 0, positions: {} };
  }
  const violations = [];

  const fills = readOrderLog(opts).filter((r) => r.account_type === 'paper' && ['filled', 'partial'].includes(r.status));
  for (const r of fills) {
    if (!r.nation || !NATIONS.includes(r.nation)) {
      violations.push(`무소속 모의 체결(nation 없음): ${r.symbol} ${r.side} ${r.amount}원 (${r.id})`);
      continue;
    }
    const L = ledgers[r.nation];
    const pos = L.positions[r.symbol] || { qty: 0, cost: 0 };
    if (r.side === 'buy') {
      L.cash -= r.amount;
      pos.qty += r.qty;
      pos.cost += r.amount;
    } else {
      const avg = pos.qty > 0 ? pos.cost / pos.qty : r.price;
      L.cash += r.amount;
      L.realized_pnl += Math.round(r.amount - avg * r.qty);
      pos.cost -= Math.round(avg * r.qty);
      pos.qty -= r.qty;
      if (pos.qty <= 0) { pos.qty = 0; pos.cost = 0; }
    }
    L.positions[r.symbol] = pos;
  }

  for (const n of NATIONS) {
    const L = ledgers[n];
    L.position_value = Object.entries(L.positions).reduce((s, [sym, p]) => {
      if (p.qty <= 0) return s;
      const px = quotes && quotes[sym] != null ? quotes[sym] : p.cost / p.qty;
      return s + Math.round(px * p.qty);
    }, 0);
    L.return_rate = (L.cash + L.position_value - L.allocated) / L.allocated;
    L.updated_at = new Date().toISOString();
  }
  return { ledgers, violations };
}

// 저장(표시용 스냅샷 — DAT-007 3행)
function saveLedger(opts, quotes) {
  const { ledgers } = computeLedger(opts, quotes);
  const out = {};
  for (const n of NATIONS) {
    const { positions, ...row } = ledgers[n];
    out[n] = row;
  }
  state.write('nation_ledger', out, opts);
  return out;
}

// 일일 정합성 검사(AC2): 재계산 vs 저장 스냅샷 + 배정 합계
function checkIntegrity(opts) {
  const warnings = [];
  const { ledgers, violations } = computeLedger(opts);
  for (const v of violations) warnings.push(v);
  const stored = state.read('nation_ledger', opts);
  if (stored) {
    for (const n of NATIONS) {
      for (const f of ['cash', 'position_value', 'realized_pnl', 'allocated']) {
        if (stored[n] && stored[n][f] !== ledgers[n][f]) {
          warnings.push(`[정합성 경고] ${n}.${f} 저장 ${stored[n][f]} ≠ 재계산 ${ledgers[n][f]} — 장부 어긋남(차이 ${stored[n][f] - ledgers[n][f]})`);
        }
      }
    }
  }
  for (const w of warnings) console.warn(w);
  return { ok: warnings.length === 0, warnings };
}

// --- 주간 논공행상(REQ-010): from~to(날짜 문자열 경계 포함) ---
// 손익 = 기간 내 실현손익(체결 재계산). 출병 수 = 매수 '체결' 횟수.
// 매복 성공률 = 위나라만: 체결 예약 ÷ 걸어둔 예약(submitted·filled·cancelled 전부 분모) × 100.
function weeklyReport(range, opts) {
  const { from, to } = range;
  const rows = readOrderLog(opts).filter((r) => {
    const d = String(r.created_at).slice(0, 10);
    return r.account_type === 'paper' && r.nation && d >= from && d <= to;
  });
  const nations = {};
  for (const n of NATIONS) {
    const mine = rows.filter((r) => r.nation === n);
    const buys = mine.filter((r) => r.side === 'buy');
    const filledBuys = buys.filter((r) => ['filled', 'partial'].includes(r.status));
    // 기간 내 실현손익(매도 체결 기준 — computeLedger 전체 재계산에서 기간분만 단순 합산)
    let realized = 0;
    // 평단 복원을 위해 전체 이력에서 재계산하되 기간 내 매도만 집계
    const all = readOrderLog(opts).filter((r) => r.account_type === 'paper' && r.nation === n && ['filled', 'partial'].includes(r.status));
    const pos = {};
    for (const r of all) {
      const p = pos[r.symbol] || { qty: 0, cost: 0 };
      if (r.side === 'buy') {
        p.qty += r.qty; p.cost += r.amount;
      } else {
        const avg = p.qty > 0 ? p.cost / p.qty : r.price;
        const pnl = Math.round(r.amount - avg * r.qty);
        const d = String(r.created_at).slice(0, 10);
        if (d >= from && d <= to) realized += pnl;
        p.cost -= Math.round(avg * r.qty); p.qty -= r.qty;
        if (p.qty <= 0) { p.qty = 0; p.cost = 0; }
      }
      pos[r.symbol] = p;
    }
    // 매복(위 전용): 분모 = 걸어둔 예약 전부(체결·미체결·취소), 분자 = 체결
    let ambush = null;
    if (n === 'wi') {
      const denom = buys.length;
      ambush = denom === 0 ? null : Math.round((filledBuys.length / denom) * 1000) / 10;
    }
    nations[n] = {
      pnl: realized,
      sorties: filledBuys.length,
      ambush_rate: ambush,
      reserved: n === 'wi' ? buys.length : null,
    };
  }
  return { from, to, nations };
}

function saveWeeklyReport(range, opts) {
  const r = weeklyReport(range, opts);
  ledger.append('nation_weekly', Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, r), opts);
  return r;
}

// --- Aside mock_portfolio.md 이관(1회·읽기 전용) ---
// 미체결 주문 → order_log submitted(wi 예약 — 매복 분모). 만료 예약 → cancelled.
// '테스트' 트랙(연결 테스트) → 세력전 밖 connection_test 원장. 보유 (없음) → 0.
function migrateMockPortfolio(srcPath, opts) {
  const marker = state.read('mock_migration', opts);
  if (marker && marker.done) return Object.assign({ skipped: true }, marker.counts);

  const raw = fs.readFileSync(srcPath, 'utf8'); // 읽기만 — 원본 수정 금지
  const lines = raw.split('\n');
  const counts = { holdings: 0, pending: 0, expired: 0, connection_test: 0 };
  const num = (s) => Number(String(s).replace(/,/g, ''));

  let section = '';
  for (const line of lines) {
    if (line.startsWith('## ')) {
      section = line;
      continue;
    }
    // 미체결 주문: "- 날짜 | 위군(B-예약형) | 매수 | 종목(코드) N주 @가격 | 조직 X 주문번호 Y | ..."
    if (/미체결 주문/.test(section) && line.startsWith('- ') && !line.includes('(참고)')) {
      const m = line.match(/\|\s*([^|]*?)군[^|]*\|\s*매수\s*\|\s*.*?\((\d{6})\)\s*(\d+)주\s*@([\d,]+)\s*\|.*?주문번호\s*(\d+)/);
      if (m) {
        const nationKo = { '위': 'wi', '촉': 'chok', '오': 'o' }[m[1].trim()] || 'wi';
        const qty = Number(m[3]);
        const price = num(m[4]);
        ledger.append('order_log', {
          id: crypto.randomUUID(), account_type: 'paper', nation: nationKo,
          symbol: m[2], side: 'buy', order_type: 'limit', price, qty, amount: price * qty,
          status: 'submitted', block_reason: null, broker_order_no: m[5], filled_at: null,
          created_at: '2026-11-25T08:30:00+09:00', // 원본 '08:3x' 근사(이관 리포트에 명기)
          migrated: true,
        }, opts);
        counts.pending++;
      }
      continue;
    }
    // (참고) 만료 예약: 주문번호 나열 — cancelled 예약으로(매복 분모)
    if (/미체결 주문/.test(section) && line.includes('(참고)') && /만료/.test(line)) {
      for (const no of (line.match(/\d{10}/g) || [])) {
        ledger.append('order_log', {
          id: crypto.randomUUID(), account_type: 'paper', nation: 'wi',
          symbol: null, side: 'buy', order_type: 'limit', price: null, qty: null, amount: 0,
          status: 'cancelled', block_reason: null, broker_order_no: no, filled_at: null,
          created_at: '2026-11-24T08:30:00+09:00', migrated: true, note: '예약 당일 만료(원본 참고 행)',
        }, opts);
        counts.expired++;
      }
      continue;
    }
    // 매매 기록의 '테스트' 트랙 → 세력전 밖 분리
    if (/매매 기록/.test(section) && /\|\s*테스트\s*\|/.test(line)) {
      const pnl = (line.match(/(-?\d+)원/) || [])[1];
      ledger.append('connection_test', {
        id: crypto.randomUUID(), note: line.replace(/^-\s*/, ''),
        pnl: pnl != null ? Number(pnl) : null,
        created_at: '2026-11-23T13:51:00+09:00', source: 'mock_portfolio.md',
      }, opts);
      counts.connection_test++;
      continue;
    }
    // 보유: "- (없음)" → 0 (행이 있으면 세겠지만 2026-11-25 현재 0이 정상)
    if (/보유 \(모의\)/.test(section) && line.startsWith('- ') && !/없음/.test(line)) {
      counts.holdings++;
    }
  }

  // 이관 리포트(대사)
  const dir = path.join(paths.resolveDataDir(opts), 'nations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'migration_report.md'), [
    '# mock_portfolio.md 이관 리포트 (TSK-023)',
    '',
    `- 보유 ${counts.holdings}건(0이 정상) · 미체결 예약 ${counts.pending}건(submitted) · 만료 예약 ${counts.expired}건(cancelled) · 연결 테스트 ${counts.connection_test}건(세력전 밖 connection_test 분리)`,
    '- 미체결 시각 원본 "08:3x" → 08:30 근사. 만료 예약은 종목 미기재(주문번호만 — 매복 분모용).',
    '- 원본은 읽기만(쓰기 0). 재이관 방지 마커 기록.',
  ].join('\n') + '\n', 'utf8');

  state.write('mock_migration', { done: true, counts, at: new Date().toISOString() }, opts);
  return Object.assign({}, counts);
}

module.exports = { NATIONS, allocations, computeLedger, saveLedger, checkIntegrity, weeklyReport, saveWeeklyReport, migrateMockPortfolio };
