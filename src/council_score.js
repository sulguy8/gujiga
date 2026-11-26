'use strict';

// 책사단 채점·관직·다양성 감시 (TSK-026 / REQ-029·030·031 / DAT-014·015, 짝 시험 TST-025)
//
// 한 줄 요약: 의견 5거래일 뒤 "지수(KODEX 200) 대비 방향"으로 채점해 score 이벤트를
// 장부에 덧붙이고, 장부 전체에서 책사 관직(가중치)을 재계산하며, 한목소리(불일치율
// 평균 20% 미만)를 경고한다. 원본 의견 줄은 영원히 불변(append-only).
//
// 규칙(2026-11-26 군주 확정):
//  - 채점: 출병=상대수익 양수 적중 / 반대·회군=음수 적중 / 관망·상대 0 = excluded.
//    종가는 종목·지수 모두 krx_official만 — 아니면 채점하지 않고 pending 유지.
//    결측이 10거래일 넘게 이어지면 excluded(사유 기록).
//  - 관직: 종사 x1 → 참군 x2(판정 10건+·적중 60%+) → 군사중랑장 x3(30건+·65%+).
//    최근 10건 적중 40% 미만이면 한 단계 강등(종사 아래 없음).
//  - 불일치율: synthesis 레코드의 최근 10안건 평균 < 20% → 한목소리 경고.

const calendar = require('./market_calendar');
const council = require('./council');

const KODEX = '069500';
const SCORE_DAYS = 5; // 5거래일 뒤 채점(REQ-030)
const GIVEUP_DAYS = 10; // 결측 지속 시 포기(excluded)
const DISAGREE_WINDOW = 10; // 최근 10안건(2026-11-26 군주 확정)
const DISAGREE_WARN_PCT = 20; // 평균 20% 미만이면 한목소리 경고

// dateStr로부터 n거래일 뒤 날짜. 달력 오염(전일 휴장 판정) 시 무한 루프 방지 상한.
function addTradingDays(dateStr, n, opts) {
  let d = new Date(`${dateStr}T00:00:00`);
  let count = 0;
  const maxIter = n * 10 + 30; // 휴장이 아무리 많아도 이 안에 n거래일이 나와야 정상
  for (let i = 0; i < maxIter; i++) {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (calendar.isTradingDay(s, opts)) count++;
    if (count === n) return s;
  }
  throw new Error(`거래일 계산 실패: ${dateStr}부터 ${maxIter}일 안에 거래일 ${n}일이 안 나옴 — 달력 설정 확인`);
}

async function officialClose(closes, symbol, date) {
  let c;
  try {
    c = await closes(symbol, date); // 공급자는 동기·비동기 모두 허용(그림자는 관문 조회 — 비동기)
  } catch (e) {
    return null; // 조회 실패 = 결측 취급(pending 유지)
  }
  if (!c || typeof c.close !== 'number') return null;
  if (c.source !== 'krx_official') return null; // 출처 강제(REQ-030) — 비공식은 결측 취급
  return c.close;
}

// 채점 배치(멱등 — verdict_id당 score 이벤트 1건). opts: {dataDir, closes(symbol,date)→{close,source}|null, calendarPath}
async function scoreVerdicts(today, opts) {
  const rows = council.readVerdicts(opts);
  const scored = new Set(rows.filter((r) => r.type === 'score').map((r) => r.verdict_id));
  const out = [];
  for (const r of rows) {
    if (r.type || scored.has(r.id)) continue; // 의견 행만, 미채점만
    const target = addTradingDays(r.date, SCORE_DAYS, opts);
    // 채점일 '다음 날'부터 채점(target < today) — 15:45 시점 당일 봉의 종가 확정 여부가
    // 불확실해(군사 지적 2026-11-26) 보수적으로 하루 늦춘다. 판정 기준은 그대로 5거래일 종가.
    if (target >= today) continue;
    if (r.stance === '관망') {
      out.push({ type: 'score', verdict_id: r.id, score_result: 'excluded', rel_return: null, scored_at: today, reason: '관망 — 방향 판정 제외' });
      continue;
    }
    if (!r.ticker) {
      // 복합 안건(종목 없음 — 이관 2차 회의 등)은 종가 조회 자체가 무의미 — 즉시 제외(무효 조회 반복 방지, 군사 지적)
      out.push({ type: 'score', verdict_id: r.id, score_result: 'excluded', rel_return: null, scored_at: today, reason: '복합 안건 — 종목 없음, 채점 불가' });
      continue;
    }
    const base = await officialClose(opts.closes, r.ticker, r.date);
    const after = await officialClose(opts.closes, r.ticker, target);
    const ibase = await officialClose(opts.closes, KODEX, r.date);
    const iafter = await officialClose(opts.closes, KODEX, target);
    if (base == null || after == null || ibase == null || iafter == null) {
      // 결측(비공식 출처 포함) — 10거래일 넘게 이어지면 포기, 아니면 pending 유지
      const giveup = addTradingDays(r.date, GIVEUP_DAYS, opts);
      if (today > giveup) {
        out.push({ type: 'score', verdict_id: r.id, score_result: 'excluded', rel_return: null, scored_at: today, reason: '종가 결측(krx_official 기준·조회 실패 포함) 10거래일 초과' });
      }
      continue;
    }
    const rel = Math.round(((after / base) - (iafter / ibase)) * 1000) / 10; // 상대 수익률(%p)
    let result;
    if (rel === 0) result = 'excluded';
    else if (r.stance === '출병') result = rel > 0 ? 'hit' : 'miss';
    else result = rel < 0 ? 'hit' : 'miss'; // 반대·회군
    out.push({ type: 'score', verdict_id: r.id, score_result: result, rel_return: rel, scored_at: today });
  }
  council.appendLines(out, opts);
  return { scored: out.length };
}

// 관직 재계산 — "이벤트 재생" 방식(REQ-029 ↔ DAT-015 양립, 군사 검토 2026-11-26):
//   score 이벤트를 시간순으로 재생하며 매 이벤트 뒤 전이 규칙(강등 우선, 승진은 한 번에
//   한 단계)을 적용한다. 장부가 유일한 원천이므로 결정적·멱등이고, ranks.json을 지워도
//   승강 이력(history)까지 그대로 복원된다(파생 캐시).
const RANKS = [
  { rank: 'jongsa', weight: 1, label: '종사' },
  { rank: 'chamgun', weight: 2, label: '참군' },
  { rank: 'junglangjang', weight: 3, label: '군사중랑장' },
];
function pct(x) { return Math.round(x * 1000) / 10; }
// 순수 계산(쓰기 없음) — 화면(읽기 전용 현황판)이 캐시 결손 시에도 안전하게 쓴다.
function computeRanks(opts) {
  const rows = council.readVerdicts(opts);
  const byId = new Map(rows.filter((r) => !r.type).map((r) => [r.id, r]));
  const perAdvisor = {};
  const events = rows.filter((r) => r.type === 'score' && ['hit', 'miss'].includes(r.score_result));
  events.sort((a, b) => String(a.scored_at).localeCompare(String(b.scored_at)) || String(a.verdict_id).localeCompare(String(b.verdict_id)));
  for (const e of events) {
    const v = byId.get(e.verdict_id);
    if (!v) continue; // 고아 이벤트(의견 행 없음)는 집계 밖
    (perAdvisor[v.advisor] = perAdvisor[v.advisor] || []).push({ hit: e.score_result === 'hit' ? 1 : 0, at: e.scored_at });
  }
  const outRanks = {};
  const allAdvisors = new Set(rows.filter((r) => !r.type).map((r) => r.advisor));
  for (const adv of allAdvisors) {
    const seq = perAdvisor[adv] || [];
    let level = 0; // 종사에서 시작
    const history = [];
    const hitsArr = [];
    let lastAt = null;
    for (const ev of seq) {
      hitsArr.push(ev.hit);
      lastAt = ev.at;
      const counted = hitsArr.length;
      const hits = hitsArr.reduce((a, b) => a + b, 0);
      const rate = counted > 0 ? hits / counted : 0;
      const recent = hitsArr.slice(-10);
      const recentRate = recent.reduce((a, b) => a + b, 0) / recent.length;
      // 강등 우선: 판정 10건 이상이고 최근 10건 적중 40% 미만 → 한 단계(종사 하한)
      if (counted >= 10 && recentRate < 0.4) {
        if (level > 0) {
          history.push({ at: ev.at, from: RANKS[level].rank, to: RANKS[level - 1].rank, reason: `최근 10건 적중 ${pct(recentRate)}% — 40% 미만 강등` });
          level -= 1;
        }
        continue;
      }
      // 승진: 한 번에 한 단계만
      if (level === 0 && counted >= 10 && rate >= 0.6) {
        history.push({ at: ev.at, from: 'jongsa', to: 'chamgun', reason: `판정 ${counted}건·적중 ${pct(rate)}% — 참군 승진` });
        level = 1;
      } else if (level === 1 && counted >= 30 && rate >= 0.65) {
        history.push({ at: ev.at, from: 'chamgun', to: 'junglangjang', reason: `판정 ${counted}건·적중 ${pct(rate)}% — 군사중랑장 승진` });
        level = 2;
      }
    }
    const counted = hitsArr.length;
    const hits = hitsArr.reduce((a, b) => a + b, 0);
    const recent = hitsArr.slice(-10);
    outRanks[adv] = Object.assign({}, RANKS[level], {
      counted, hits, // 하위 호환 필드
      total_judged: counted, total_hits: hits,
      hit_rate: counted > 0 ? pct(hits / counted) : null,
      recent10_hit_rate: recent.length > 0 ? pct(recent.reduce((a, b) => a + b, 0) / recent.length) : null,
      history,
      updated_at: lastAt, // 마지막 판정 시점(결정적 — 재계산 멱등 유지)
    });
  }
  return outRanks;
}
// 계산 + 캐시 저장(그림자 15:45 배치용)
function recomputeRanks(opts) {
  const outRanks = computeRanks(opts);
  council.writeRanks(outRanks, opts); // <dataDir>\council\ranks.json — DAT-015 정본 경로(파생 캐시)
  return outRanks;
}

// 한목소리 경고(REQ-031): synthesis 최근 10안건 불일치율 평균 < 20% → 경고
function disagreementWarning(opts) {
  const rows = council.readVerdicts(opts)
    .filter((r) => !r.type && r.source === 'synthesis' && typeof r.disagreement === 'number')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const recent = rows.slice(-DISAGREE_WINDOW);
  if (recent.length < DISAGREE_WINDOW) return { warn: false, insufficient: true, count: recent.length };
  const avg = Math.round((recent.reduce((s, r) => s + r.disagreement, 0) / recent.length) * 10) / 10;
  return { warn: avg < DISAGREE_WARN_PCT, avg, count: recent.length };
}

module.exports = { scoreVerdicts, computeRanks, recomputeRanks, disagreementWarning, addTradingDays };
