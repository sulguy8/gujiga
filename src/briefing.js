'use strict';

// 08:31 아침 브리핑(군의) 생성 (REQ-005 / SCR-002)
//
// 3요소: ① 관심 종목 상태(전일 종가·성벽/목표 거리) ② 전일 결과 ③ 오늘 규칙 숫자.
// 일부 조회 실패는 해당 칸만 "조회 실패"로 표시하고 브리핑 자체는 생성한다(REQ-005 AC4).
// 월요일에는 논공행상 섹션 자리를 포함한다(데이터 채움은 후속 TSK — REQ-010).
// 데이터 공급자는 주입(providers) — 실제 증권사 연결은 TSK-003에서.

const fs = require('node:fs');
const path = require('node:path');
const calendar = require('./market_calendar');
const guard = require('./guard');
const generalRank = require('./general_rank');
const paths = require('./paths');

const FAIL = '조회 실패';

function won(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : FAIL;
}
function pct(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return FAIL;
  return `${(((to - from) / from) * 100).toFixed(1)}%`;
}

// ① 관심 종목 표 — 종목별 실패는 그 칸만 FAIL.
function watchlistSection(providers) {
  let list;
  try {
    list = providers.watchlist().filter((w) => w.status !== 'excluded');
  } catch (e) {
    return [`- 관심 종목: ${FAIL} (${e.message})`];
  }
  if (list.length === 0) return ['- 척후 보낼 성이 없습니다 — 관심 종목을 등록하세요'];

  const lines = ['| 종목 | 상태 | 전일 종가 | 성벽(손절)까지 | 목표까지 |', '|---|---|---|---|---|'];
  for (const w of list) {
    let close = null;
    let closeCell = FAIL;
    try {
      const q = providers.quote(w.symbol);
      close = q.prevClose;
      closeCell = won(close);
    } catch (e) {
      // 해당 칸만 조회 실패
    }
    const stopCell = close != null && w.stop_price != null ? pct(close, w.stop_price) : w.stop_price == null ? '-' : FAIL;
    const targetCell = close != null && w.target_price != null ? pct(close, w.target_price) : w.target_price == null ? '-' : FAIL;
    lines.push(`| ${w.name}(${w.symbol}) | ${w.status} | ${closeCell} | ${stopCell} | ${targetCell} |`);
  }
  return lines;
}

// ② 전일 결과 — 자체 장부(captive_ledger)에서 전일 확정 손익 집계.
function prevDaySection(date, opts) {
  try {
    const prev = calendar.prevTradingDay(date, opts);
    const summary = [];
    for (const acct of ['real', 'paper']) {
      const rows = readPnlRows(acct, prev, opts);
      const pnl = rows.reduce((a, r) => a + r.realized_pnl, 0);
      const captived = rows.some((r) => r.realized_pnl < 0);
      summary.push(`- ${acct === 'real' ? '실전' : '모의'}: 전일(${prev}) 확정 손익 ${won(pnl)}원${captived ? ' · 포로 발생' : ''}${rows.length === 0 ? ' (매매 없음)' : ''}`);
    }
    return summary;
  } catch (e) {
    return [`- 전일 결과: ${FAIL} (${e.message})`];
  }
}

function readPnlRows(accountType, date, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const dir = paths.ledgerDir(dataDir, 'captive_ledger');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.account_type === accountType && r.trade_date === date) out.push(r);
    }
  }
  return out;
}

// ③ 오늘 규칙 숫자 — guard_config + 관직 한도. 설정 없으면 '차단' 안내(안전 동작 그대로 알림).
function rulesSection(opts) {
  const lines = [];
  try {
    const lim = generalRank.getLimits(opts);
    lines.push(`- 관직 ${lim.label || lim.rank}: 한 종목 최대 ${won(lim.perStockLimitWon)}원 · 동시 ${lim.concurrentMax}종목`);
  } catch (e) {
    lines.push(`- 관직 한도: ${FAIL}`);
  }
  const g = guard.loadGuard(opts);
  if (!g) {
    lines.push(`- 군율(guard_config): ${FAIL} — 설정 없음, 모든 주문 차단 상태`);
  } else {
    lines.push(`- 1회 한도: 실전 ${won(g.per_order_limit_real)}원 / 모의 ${won(g.per_order_limit_paper)}원`);
    lines.push(`- 하루 손실 한도: ${won(g.daily_loss_limit)}원 · 군량(현금) 최소 ${Math.round(g.cash_ratio_min * 100)}%`);
    lines.push('- 손절 판정: KRX 종가 기준(장중 이탈 무시)');
  }
  return lines;
}

// 브리핑 마크다운을 조립한다.
// info: { date, late(지각 여부), providers }
function build(info, opts) {
  const { date, late, providers } = info;
  const isMonday = new Date(`${date}T00:00:00`).getDay() === 1;

  const md = [];
  md.push(`# 아침 군의 — ${date}${late ? ' (지연 생성)' : ''}`);
  md.push('');
  md.push('## 전황 요약 (전일 결과)');
  md.push(...prevDaySection(date, opts));
  md.push('');
  md.push('## 관심 종목');
  md.push(...watchlistSection(providers));
  md.push('');
  md.push('## 오늘의 군령 (오늘 규칙)');
  md.push(...rulesSection(opts));
  if (isMonday) {
    md.push('');
    md.push('## 논공행상 (매주 월요일)');
    md.push('| 나라 | 손익 | 출병 수 | 매복 성공률 |');
    md.push('|---|---|---|---|');
    md.push('| (집계 예정 — REQ-010 구현 시 채움) | | | |');
  }
  md.push('');
  md.push('참고용, 최종 결정은 본인.');
  return md.join('\n') + '\n';
}

// 브리핑 파일 경로(dataDir 아래 — Aside trading 폴더와 완전 분리).
function filePath(date, opts) {
  return path.join(paths.resolveDataDir(opts), 'briefings', `${date}.md`);
}

// 생성(이미 있으면 건너뜀 — 2중 생성 0, RISK-004). 반환: { created, file }
function generate(info, opts) {
  const file = filePath(info.date, opts);
  if (fs.existsSync(file)) return { created: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, build(info, opts), 'utf8');
  return { created: true, file };
}

module.exports = { build, generate, filePath };
