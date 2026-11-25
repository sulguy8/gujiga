'use strict';

// 논공행상 4분면 집계 (TSK-021 / REQ-026)
//
// 축: 손익(수익/손실) × 근거 준수(준수/위반). 준수 = 근거 인용 + 성벽·기한 이행 + 위반 0.
//  전공(merit)            = 수익 + 준수
//  요행(fluke, 경고)      = 수익 + 위반 — 운으로 번 돈은 다음에 잃는다
//  명예로운 패배(honorable_defeat) = 손실 + 준수 — 규칙을 지킨 손실은 명예다(군주 의도)
//  진짜 실패(true_failure) = 손실 + 위반
//  무승부(draw)           = 손익 0원(4분면 밖 — REQ-026 예외)
// 근거 준수율 = 준수 거래 / 전체 거래(무승부 포함). 0건이면 '해당 없음'(null).

function isCompliant(t) {
  return t.rationale_cited === true && t.wall_deadline_respected === true && (t.violation_count || 0) === 0;
}

function quadrantOf(t) {
  if (t.pnl === 0) return 'draw';
  const compliant = t.compliant != null ? t.compliant : isCompliant(t);
  if (t.pnl > 0) return compliant ? 'merit' : 'fluke';
  return compliant ? 'honorable_defeat' : 'true_failure';
}

function report(trades) {
  const counts = { merit: 0, fluke: 0, honorable_defeat: 0, true_failure: 0, draw: 0 };
  let compliant = 0;
  for (const t of trades) {
    counts[quadrantOf(Object.assign({}, t, { compliant: isCompliant(t) }))]++;
    if (isCompliant(t)) compliant++;
  }
  const total = trades.length;
  return {
    counts, total,
    compliantCount: compliant,
    compliantRatePct: total === 0 ? null : Math.round((compliant / total) * 100), // 0건 — 해당 없음
  };
}

module.exports = { isCompliant, quadrantOf, report };
