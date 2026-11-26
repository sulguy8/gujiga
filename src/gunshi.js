'use strict';

// 군사 엔진 4기능 (TSK-014 / REQ-016~019 / spec_morning.md 6장 보고 형식)
//
//  counsel(군의 해석) — collect→judge→snapshot→보고 조립→LLM 해석. 숫자 변조 금지.
//  draft(출사표 초안) — 5항목 완전 + 근거 필수, ai·false 고정(strategist 코어가 강제).
//  advise(전략 건의) — 군주 상시 명령 4기준에 걸릴 때만. 같은 원인 연속 건의 금지.
//  insight(통찰) — 일화 1~2개(각 2줄 이내·오늘 숫자 연결) + 상중하책(얻는 것·잃는 것) + 추천 1 + 군주 문구.
//
// 출력 검증기: LLM 출력의 숫자는 입력 값과 100% 일치해야 한다 — 다르면 해당 기능을
// '생략'하고 gunshi_log에 기록한다(보고는 규칙 엔진 숫자만으로). 호출은 전부 strategist
// 경유라 하루 상한(8회) 집계가 유지된다.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const market = require('./market');
const judge = require('./judge');
const strategist = require('./strategist');
const state = require('./state');
const ledger = require('./ledger');
const paths = require('./paths');
const { kstParts } = require('./kst');
const council = require('./council');

// ---------- 숫자 검증기 ----------
// 입력(판정값·스냅샷)에 있는 숫자만 출력에 허용한다.
// 허용 예외: 작은 정수(≤12 — 신호 번호·개수), 관용 상수(15·20·30·60·100), 날짜·시각.
const COMMON_INTS = new Set(['15', '20', '30', '60', '100']);

function collectNumbers(obj, out) {
  out = out || new Set();
  if (obj == null) return out;
  if (typeof obj === 'number' && Number.isFinite(obj)) {
    out.add(String(obj));
    out.add(String(Math.abs(obj)));
    return out;
  }
  if (typeof obj === 'string') {
    for (const m of obj.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []) out.add(m);
    return out;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) collectNumbers(v, out);
    return out;
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) collectNumbers(v, out);
  }
  return out;
}

function verifyNumbers(text, inputs) {
  const allowed = collectNumbers(inputs);
  // 날짜·시각은 검증 대상에서 제거
  const cleaned = String(text)
    .replace(/,/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\d{8}/g, ' ')
    .replace(/\d{1,2}:\d{2}/g, ' ');
  const bad = [];
  for (const tok of cleaned.match(/\d+(?:\.\d+)?/g) || []) {
    if (allowed.has(tok)) continue;
    if (!tok.includes('.') && Number(tok) <= 12) continue; // 신호 번호·개수류
    if (COMMON_INTS.has(tok)) continue;
    bad.push(tok);
  }
  return { ok: bad.length === 0, bad };
}

function logGunshi(type, feature, extra, opts) {
  // extra가 type/feature를 덮지 못하게 기본 필드를 마지막에 둔다
  ledger.append('gunshi_log', Object.assign({}, extra || {}, {
    id: crypto.randomUUID(), type, feature, created_at: new Date().toISOString(),
  }), opts);
}

const WEATHER_KO = { defense: '방어', attack: '공격', neutral: '중립' };
const STAGE_KO = { wait: '대기', s1: '1차', s2: '2차', s3: '3차', halt: '중단' };

// ---------- 군의 해석(REQ-016): 조립 파이프라인 ----------
// market.collect → (신호 1·5 수동 입력 자리) → judge.judgeAll → recordStage → saveSnapshot
// → LLM 해석(숫자 검증) → spec_morning 6장 형식 보고 → 파일 기록.
async function morningCouncil(opts) {
  const collected = await market.collect(opts);

  // 신호 1(악재 둔화)·5(이벤트) 입력 자리: state 'signal_inputs' — 없으면 보수 꺼짐(judge가 처리)
  const manual = state.read('signal_inputs', opts) || {};
  const judgeIn = Object.assign({}, collected.judgeInputs, {
    bad_news_resilient: manual.bad_news_resilient,
    event_within_2d: manual.event_within_2d,
    post_event_drop_pct: manual.post_event_drop_pct,
  });

  const history = judge.getStageHistory(opts);
  const j = judge.judgeAll(judgeIn, history);
  judge.recordStage(j.stage, opts);
  const snapshotFile = market.saveSnapshot(collected, j, opts);

  // 책사단 편승(ARC-010 / 지령 013): 안건이 주입되면 counsel '같은 호출'에 4목소리를 함께
  // 요구한다 — 별도 AI 회차 0, 상한(8회) 집계도 이 한 번에 공유. 안건 없으면 책사단 생략.
  const agendas = Array.isArray(opts.councilAgendas) ? opts.councilAgendas : [];
  for (const a of agendas) {
    // 법정(수급) 입력: 군의가 방금 수집한 시장 전체 외국인 연속 일수를 보강(제한 판정)
    a.inputs = a.inputs || {};
    if (a.inputs.marketForeignStreak === undefined && typeof judgeIn.foreign_net_days === 'number') {
      a.inputs.marketForeignStreak = judgeIn.foreign_net_days;
    }
  }

  // LLM 해석 — 신뢰 입력은 판정값·수치만(장부·계좌 없음)
  const llmData = {
    weather: j.weather, stage: j.stage,
    night_future_pct: judgeIn.night_future_pct,
    us_summary: judgeIn.us_summary,
    kospi_close: judgeIn.kospi_close, kospi_ma20: judgeIn.kospi_ma20,
    signals: j.signals.map((s) => ({ no: s.no, on: s.on, basis: s.basis })),
  };
  if (agendas.length > 0) {
    llmData.council_agendas = agendas.map((a) => ({ id: a.id, ticker: a.ticker, name: a.name || null, agenda_type: a.agenda_type }));
  }
  let marketLines = null;
  let todayActions = null;
  let counselUsed = false;
  const res = strategist.call('counsel', { data: llmData, councilRequested: agendas.length > 0 }, opts.strategistOpts || opts);
  if (res.ok && res.data) {
    const outText = JSON.stringify([res.data.market_lines, res.data.today_actions]);
    const check = verifyNumbers(outText, llmData);
    if (check.ok) {
      marketLines = (res.data.market_lines || []).slice(0, 2);
      todayActions = (res.data.today_actions || []).slice(0, 3);
      counselUsed = true;
    } else {
      logGunshi('number_mismatch', 'counsel', { bad: check.bad }, opts);
    }
  }

  // ---- spec_morning 6장 형식(15줄 이내·이모지·em dash 금지) ----
  const onN = j.signals.filter((s) => s.on).length;
  const positions = (state.read('positions', opts) || []).filter((p) => p.status === 'open');
  const mode = positions.length > 0 ? '운용' : '대기';
  const action = judge.canSortieChok(j) || j.stage === 'halt' ? '[액션 필요]' : '[계획 유지]';

  const L = [];
  L.push(`${action} 모드 ${mode} · 날씨 ${WEATHER_KO[j.weather]}`);
  L.push(`재진입 신호등 ${onN}/6 → ${STAGE_KO[j.stage]}`);
  if (marketLines) L.push(...marketLines);
  else L.push('밤사이 해석 생략(군사 부재·숫자 불일치) — 숫자만 보고');
  for (const s of j.signals) L.push(`신호 ${s.no} ${s.on ? '켜짐' : '꺼짐'} · ${s.basis}`);
  L.push('오늘 할 일:');
  for (const a of (todayActions || ['규칙 외 행동 없음 · 관심 종목 점검'])) L.push(`- ${a}`);
  L.push('참고용, 최종 결정은 본인');

  // spec_morning 관습: 이모지·em dash 금지 — 내부 근거 문구에 섞인 em dash를 치환
  const report = L.join('\n').replace(/—/g, '-');
  const dir = path.join(paths.resolveDataDir(opts), 'briefings');
  fs.mkdirSync(dir, { recursive: true });
  const reportFile = path.join(dir, `${collected.date}-gunui.md`);
  fs.writeFileSync(reportFile, report + '\n', 'utf8');

  // 책사단 실행(편승한 응답의 council_voices 재사용 — 추가 호출 0).
  // counsel 실패·상한 초과·형식 오류면 voices가 비어 AI 4인은 폴백으로 기록된다(규칙 3인은 영향 없음).
  let councilResult = null;
  if (agendas.length > 0) {
    const voices = res.ok && res.data && Array.isArray(res.data.council_voices) ? res.data.council_voices : null;
    councilResult = await council.runCouncil(agendas, {
      dataDir: opts.dataDir,
      aiBudgetExhausted: res.reason === 'daily_cap', // 상한 소진은 그 사유로 기록(사후 분석용)
      aiCall: () => JSON.stringify(voices), // null이면 파싱 후 비배열 — 전원 폴백
    });
  }

  return { report, reportFile, snapshotFile, judgment: j, counselUsed, collected, council: councilResult };
}

// ---------- 출사표 초안(REQ-017): 근거·숫자 검증 포함 ----------
// data: { watch: {symbol, entry_low, entry_high, stop_price, target_price, deadline, troops}, signal_on }
async function draftFromSignal(data, strategistOpts) {
  const res = strategist.call('draft', { data }, strategistOpts);
  if (!res.ok || !res.saved) {
    logGunshi('draft_rejected', 'draft', { reason: res.reason || 'llm_failed' }, strategistOpts);
    return { saved: false, reason: res.reason || 'llm_failed' };
  }
  // 숫자 검증: 초안의 5항목 수치가 입력(watch)과 일치해야 한다
  const check = verifyNumbers(JSON.stringify(res.row), data);
  if (!check.ok) {
    logGunshi('number_mismatch', 'draft', { bad: check.bad, draft_id: res.row.id }, strategistOpts);
    return { saved: true, warned: true, row: res.row, bad: check.bad };
  }
  return { saved: true, row: res.row };
}

// ---------- 전략 건의(REQ-018): 군주 상시 명령 4기준 ----------
// situation: { condition_impossible_all_day, wall_breached:{symbol,close,stop}, index_move_vs_expected_pct, major_news }
function detectCriterion(situation) {
  if (situation.condition_impossible_all_day === true) {
    return { criterion: 1, cause: 'condition_impossible', evidence_value: '출병 조건 종일 충족 불가' };
  }
  if (situation.wall_breached) {
    const w = situation.wall_breached;
    return { criterion: 2, cause: `wall:${w.symbol}`, evidence_value: `${w.symbol} 종가 ${w.close} < 성벽 ${w.stop}` };
  }
  const pct = situation.index_move_vs_expected_pct;
  if (typeof pct === 'number' && Math.abs(pct) >= 2) {
    return { criterion: 3, cause: `index:${pct}`, evidence_value: `지수 예상 반대 ${pct}%` };
  }
  if (situation.major_news) {
    return { criterion: 4, cause: `news:${String(situation.major_news).slice(0, 40)}`, evidence_value: String(situation.major_news) };
  }
  return null;
}

async function advise(situation, strategistOpts) {
  const hit = detectCriterion(situation || {});
  if (!hit) return { triggered: false }; // 4기준 미해당 — 침묵(호출 0)

  // 같은 기준·같은 원인 연속 건의 금지(해소 후 재발 시에만 다시)
  const dedupKey = `${hit.criterion}:${hit.cause}`;
  const st = state.read('advise_state', strategistOpts) || {};
  if (st.lastKey === dedupKey) return { triggered: true, deduped: true };

  const res = strategist.call('advise', { data: hit }, strategistOpts);
  if (!res.ok || !res.data) {
    logGunshi('degraded', 'advise', { criterion: hit.criterion }, strategistOpts);
    return { triggered: true, degraded: true, criterion: hit.criterion };
  }
  const advice = res.data;
  // 형식: 기준 번호·근거 수치·변경안·유지안
  if (advice.criterion !== hit.criterion || !advice.evidence || !advice.change_plan || !advice.keep_plan) {
    logGunshi('format_invalid', 'advise', { criterion: hit.criterion }, strategistOpts);
    return { triggered: true, degraded: true, criterion: hit.criterion };
  }
  const check = verifyNumbers(JSON.stringify(advice), hit);
  if (!check.ok) {
    logGunshi('number_mismatch', 'advise', { bad: check.bad }, strategistOpts);
    return { triggered: true, degraded: true, criterion: hit.criterion };
  }

  state.write('advise_state', { lastKey: dedupKey, at: new Date().toISOString() }, strategistOpts);
  ledger.append('advise_log', Object.assign({
    id: crypto.randomUUID(), created_at: new Date().toISOString(),
  }, advice), strategistOpts);
  return { triggered: true, advice };
}

// ---------- 통찰(REQ-019): 형식 고정·degrade 생략 ----------
// decision: { type: 'execute_wait'|'advise'|'judgment_needed', data: {숫자…} }
// opts.councilAgendas(선택): 장중 안건 — 척후 몫의 '이 호출'에 책사단 4목소리를 편승(지령 013 2항).
//   별도 AI 회차를 만들지 않는다. insight가 degrade여도 책사단은 폴백으로 기록된다.
async function insight(decision, strategistOpts, opts) {
  opts = opts || {};
  const agendas = Array.isArray(opts.councilAgendas) ? opts.councilAgendas : [];
  const data = agendas.length > 0
    ? Object.assign({}, decision.data, { council_agendas: agendas.map((a) => ({ id: a.id, ticker: a.ticker, name: a.name || null, agenda_type: a.agenda_type })) })
    : decision.data;
  const res = strategist.call('insight', { data, councilRequested: agendas.length > 0 }, strategistOpts);
  if (agendas.length > 0) {
    const voices = res.ok && res.data && Array.isArray(res.data.council_voices) ? res.data.council_voices : null;
    await council.runCouncil(agendas, {
      dataDir: opts.dataDir,
      aiBudgetExhausted: res.reason === 'daily_cap',
      aiCall: () => JSON.stringify(voices),
    });
  }
  if (!res.ok || !res.data) return null; // degrade — 결정은 숫자만으로 가능(REQ-019 AC4)

  const d = res.data;
  const formatOk =
    Array.isArray(d.anecdotes) && d.anecdotes.length >= 1 && d.anecdotes.length <= 2 &&
    d.anecdotes.every((a) => typeof a === 'string' && a.split('\n').length <= 2) &&
    d.options && ['top', 'mid', 'low'].every((k) => d.options[k] && d.options[k].action && d.options[k].gain && d.options[k].lose) &&
    typeof d.recommend === 'string' &&
    typeof d.note === 'string' && d.note.includes('최종 선택은 군주');
  if (!formatOk) {
    logGunshi('format_invalid', 'insight', { decision_type: decision.type }, strategistOpts);
    return null;
  }
  // 숫자 검증은 통찰 고유 필드만 — 편승된 council_voices의 자유 텍스트 숫자로
  // 통찰 전체가 버려지는 것을 막는다(군사 지적 2026-11-26. voices는 위에서 이미 기록됨).
  const check = verifyNumbers(JSON.stringify({ anecdotes: d.anecdotes, options: d.options, recommend: d.recommend, note: d.note }), decision.data);
  if (!check.ok) {
    logGunshi('number_mismatch', 'insight', { bad: check.bad }, strategistOpts);
    return null;
  }
  return d;
}

module.exports = { morningCouncil, draftFromSignal, advise, insight, verifyNumbers };
