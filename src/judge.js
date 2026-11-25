'use strict';

// 날씨·신호등·단계 판정 엔진 (TSK-016 / REQ-020·REQ-021)
//
// 정의 정본: refs/ops/spec_morning.md 22~23행 — 숫자 그대로 순수 함수로 옮겼다.
// 순수 함수 원칙: 입력→출력, 외부 호출 0 (updateBaseLow만 장부 수정 — 판정 함수와 분리).
// 결측은 보수 판정: 날씨=방어, 해당 신호=꺼짐(+missing 표시).

const state = require('./state');

const DEFENSE_FUTURE_PCT = -2; // 야간선물 -2% 이하 → 방어
const ATTACK_FUTURE_PCT = 1;   // +1% 이상(그리고 20일선 위) → 공격
const VIX_MAX = 30;            // 2번: VIX 종가 < 30
const REBOUND_DROP_PCT = -1.5; // 5번: 이벤트 통과 후 다음 날 -1.5% 이상 하락이면 꺼짐

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// --- 날씨 (REQ-020 / spec 22행) ---
// 야간선물 ≤ -2% 또는 (코스피 20일선 아래 그리고 외국인 순매도) = 방어
// 야간선물 ≥ +1% 그리고 20일선 위 = 공격. 그 외 중립. 결측 = 방어(보수).
function judgeWeather(inp) {
  const missing = [];
  const nf = inp.night_future_pct;
  const close = inp.kospi_close;
  const ma20 = inp.kospi_ma20;
  const fnd = inp.foreign_net_days;

  if (!isNum(nf)) missing.push('night_future_pct');
  if (!isNum(close)) missing.push('kospi_close');
  if (!isNum(ma20)) missing.push('kospi_ma20');
  if (!isNum(fnd)) missing.push('foreign_net_days');

  // 결측이면 방어(모르면 보수) — 단, 방어 조건이 이미 확정 가능한 경우는 그대로 방어.
  if (isNum(nf) && nf <= DEFENSE_FUTURE_PCT) {
    return { weather: 'defense', missing, basis: `야간선물 ${nf}% ≤ ${DEFENSE_FUTURE_PCT}%` };
  }
  if (missing.length > 0) {
    return { weather: 'defense', missing, basis: `결측(${missing.join(',')}) — 보수 판정` };
  }
  if (close < ma20 && fnd < 0) {
    return { weather: 'defense', missing, basis: `코스피 ${close} < 20일선 ${ma20} + 외국인 순매도` };
  }
  if (nf >= ATTACK_FUTURE_PCT && close > ma20) {
    return { weather: 'attack', missing, basis: `야간선물 +${nf}% ≥ +1% + 20일선 위` };
  }
  return { weather: 'neutral', missing, basis: `야간선물 ${nf}%, 코스피 ${close} vs 20일선 ${ma20}` };
}

// --- 신호등 6개 (REQ-021 / spec 23행) — 켜짐/꺼짐 + 근거 수치. 결측은 꺼짐 ---
function judgeSignals(inp) {
  const signals = [];
  const vix = inp.us_summary && isNum(inp.us_summary.vix) ? inp.us_summary.vix : null;
  const sox = inp.us_summary && isNum(inp.us_summary.sox) ? inp.us_summary.sox : null;

  // 1. 악재 둔화 — 악재 뉴스에도 보합 이상 마감(애매하면 꺼짐 — 보수)
  signals.push(inp.bad_news_resilient === true
    ? { no: 1, on: true, basis: '악재에도 보합 이상 마감' }
    : { no: 1, on: false, basis: '악재 둔화 미확인(보수)', missing: inp.bad_news_resilient == null || undefined });

  // 2. VIX 종가 < 30
  if (vix == null) signals.push({ no: 2, on: false, basis: 'VIX 결측(보수 꺼짐)', missing: true });
  else signals.push({ no: 2, on: vix < VIX_MAX, basis: `VIX ${vix} ${vix < VIX_MAX ? '<' : '≥'} ${VIX_MAX}` });

  // 3. SOX가 장부 기준 저점을 최근 3거래일 안 깨고 반등
  const base = isNum(inp.sox_base_low) ? inp.sox_base_low : null;
  const r3low = isNum(inp.sox_recent3_low) ? inp.sox_recent3_low : null;
  if (base == null || r3low == null || sox == null) {
    signals.push({ no: 3, on: false, basis: 'SOX·기준 저점 결측(보수 꺼짐)', missing: true });
  } else {
    const held = r3low > base;         // 최근 3거래일 최저가 기준 저점 위
    const rebound = sox > r3low;       // 종가가 3일 최저 위로 반등
    signals.push({
      no: 3, on: held && rebound,
      basis: `3일 최저 ${r3low} ${held ? '>' : '≤'} 기준 저점 ${base}, 종가 ${sox} ${rebound ? '반등' : '미반등'}`,
    });
  }

  // 4. 코스피 외국인 순매수 2일 연속
  if (!isNum(inp.foreign_net_days)) {
    signals.push({ no: 4, on: false, basis: '외국인 동향 결측(보수 꺼짐)', missing: true });
  } else {
    signals.push({ no: 4, on: inp.foreign_net_days >= 2, basis: `외국인 순매수 연속 ${inp.foreign_net_days}일` });
  }

  // 5. 큰 이벤트: 2거래일 내 남아 있으면 꺼짐. 통과 후 다음 날 -1.5% 이상 하락 없으면 켜짐.
  if (inp.event_within_2d === true) {
    signals.push({ no: 5, on: false, basis: '2거래일 내 큰 이벤트 잔존' });
  } else if (inp.event_within_2d === false) {
    const drop = isNum(inp.post_event_drop_pct) ? inp.post_event_drop_pct : null;
    if (drop == null) signals.push({ no: 5, on: false, basis: '이벤트 후 등락 결측(보수 꺼짐)', missing: true });
    else signals.push({ no: 5, on: drop > REBOUND_DROP_PCT, basis: `이벤트 통과 후 ${drop}% (${REBOUND_DROP_PCT}% 기준)` });
  } else {
    signals.push({ no: 5, on: false, basis: '이벤트 캘린더 결측(보수 꺼짐)', missing: true });
  }

  // 6. 코스피 종가 > 20일선
  if (!isNum(inp.kospi_close) || !isNum(inp.kospi_ma20)) {
    signals.push({ no: 6, on: false, basis: '종가·20일선 결측(보수 꺼짐)', missing: true });
  } else {
    signals.push({
      no: 6, on: inp.kospi_close > inp.kospi_ma20,
      basis: `코스피 ${inp.kospi_close} ${inp.kospi_close > inp.kospi_ma20 ? '>' : '≤'} 20일선 ${inp.kospi_ma20}`,
    });
  }

  return signals;
}

// --- 단계 (REQ-021): 1~5 중 켜진 수 0~1 대기 / 2~3 1차 / 4+ 2차, 6번 켜짐 3차.
//     1차 이상 진입 후 기준 저점 재이탈 = 중단(회복 판정 전 유지). ---
function judgeStage(signals, history) {
  history = history || {};
  const on15 = signals.filter((s) => s.no >= 1 && s.no <= 5 && s.on).length;
  const sig6 = signals.some((s) => s.no === 6 && s.on);

  // 중단: 이전 1차 이상 + 재이탈, 또는 중단 상태 회복 전 유지
  const wasActive = ['s1', 's2', 's3'].includes(history.prevStage);
  if (wasActive && history.reentryBreak === true) {
    return { stage: 'halt', basis: '1차 진입 후 기준 저점 재이탈' };
  }
  if (history.prevStage === 'halt' && history.recovered !== true) {
    return { stage: 'halt', basis: '중단 유지(기준 저점 회복 전)' };
  }

  if (sig6) return { stage: 's3', basis: '6번(20일선 회복) 켜짐' };
  if (on15 >= 4) return { stage: 's2', basis: `1~5 중 ${on15}개 켜짐` };
  if (on15 >= 2) return { stage: 's1', basis: `1~5 중 ${on15}개 켜짐` };
  return { stage: 'wait', basis: `1~5 중 ${on15}개 켜짐` };
}

// --- 촉군(트랙A) 출병 조건: 단계 1차 이상 + 날씨가 방어가 아닐 것(NTE-003 연동) ---
function canSortieChok(j) {
  return ['s1', 's2', 's3'].includes(j.stage) && j.weather !== 'defense';
}

// --- 통합 판정(순수): 수집 입력 → {weather, signals, stage, missing} ---
function judgeAll(inputs, history) {
  const w = judgeWeather(inputs);
  const signals = judgeSignals(inputs);
  const st = judgeStage(signals, history);
  const missing = [...new Set([...w.missing, ...signals.filter((s) => s.missing).map((s) => `signal_${s.no}`)])];
  return { weather: w.weather, weatherBasis: w.basis, signals, stage: st.stage, stageBasis: st.basis, missing };
}

// --- 기준 저점 갱신(장부 '재진입 기록' 수정 — 판정 함수와 분리된 유일한 쓰기) ---
function updateBaseLow(newLow, date, opts) {
  const cur = state.read('reentry_record', opts) || {};
  if (cur.sox_base_low != null && !(newLow < cur.sox_base_low)) {
    return { updated: false, base: cur.sox_base_low };
  }
  state.write('reentry_record', { sox_base_low: newLow, sox_base_low_date: date }, opts);
  return { updated: true, base: newLow };
}

module.exports = { judgeWeather, judgeSignals, judgeStage, judgeAll, canSortieChok, updateBaseLow };
