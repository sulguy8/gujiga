'use strict';

// 책사단 엔진 (TSK-025 / ARC-010 / REQ-028·032, 짝 시험 TST-024)
//
// 한 줄 요약: 매매 안건을 넣으면 책사 7인(규칙 3 + AI 4)의 의견과 제갈량 종합이
// 판정 장부(verdicts.jsonl, append-only)에 쌓인다. 최종 결정은 언제나 군주.
//
// 불변식:
//  - 주문 경로(gate·kis_adapter·gatekeeper·order_draft) 미접근 — 읽기 + 장부 append만(REQ-002).
//  - 곽가·법정·가후는 숫자 규칙(AI 0회, 같은 입력 → 같은 의견).
//  - AI 4인(노숙·순욱·육손·장송)은 한 번에 묶음 — 별도 회차 없음(편승, 2026-11-26 군주 확정).
//    aiCall은 호출자가 주입(군의·척후 호출에 실어 보냄). 상한 소진이면 호출 0·폴백.
//  - 폴백은 가중 0, 유효(비폴백) 4건 미만이면 종합 생략("의견 불충분").
//  - 멱등: (agenda_id, advisor) 조합당 레코드 1건 — 재실행 시 중복 0.
//  - 장송은 DART 공시 수집(TSK-029) 전까지 '정보 없음' 폴백 고정.
//
// 파일 구조 메모: ARC-010은 advisor별 파일 분리를 예시했으나, 한글 파일명의
// Windows 인코딩 위험을 피해 한 모듈 안의 함수로 구현한다(결정은 카드에 되먹임).

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths');

const ADVISORS_RULE = ['곽가', '법정', '가후'];
const ADVISORS_AI = ['노숙', '순욱', '육손', '장송'];
const STANCES = ['출병', '관망', '반대', '회군'];
// 동률 시 보수 우선(REQ-032): 회군 > 반대 > 관망 > 출병
const CONSERVATIVE_ORDER = ['회군', '반대', '관망', '출병'];

// ---------- 장부(append-only — DAT-014) ----------
function verdictsFile(opts) {
  return path.join(paths.resolveDataDir(opts), 'council', 'verdicts.jsonl');
}
function readVerdicts(opts) {
  const f = verdictsFile(opts);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}
function appendLines(rows, opts) {
  if (rows.length === 0) return;
  // 유일성(DAT-014): 의견 행은 (agenda_id, advisor) 조합당 1건 — 위반 append는 거부
  const key = (r) => `${r.agenda_id}|${r.advisor}`;
  const have = new Set(readVerdicts(opts).filter((r) => !r.type).map(key));
  for (const r of rows) {
    if (r.type) continue; // score 이벤트 행은 별도(verdict_id당 1건 — 채점 배치가 보장)
    if (have.has(key(r))) throw new Error(`중복 거부(유일성): ${key(r)} — (agenda_id, advisor)당 의견 1건`);
    have.add(key(r));
  }
  const f = verdictsFile(opts);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// ---------- 관직(가중치) — <dataDir>\council\ranks.json(DAT-015 정본 경로, 없으면 전원 종사 x1) ----------
const DEFAULT_RANK = { rank: 'jongsa', weight: 1 };
function ranksFile(opts) {
  return path.join(paths.resolveDataDir(opts), 'council', 'ranks.json');
}
function readRanks(opts) {
  const f = ranksFile(opts);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function writeRanks(ranks, opts) {
  const f = ranksFile(opts);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(ranks, null, 2) + '\n', 'utf8'); // 파생 캐시 — 장부에서 언제든 복원
  return f;
}
function rankOf(advisor, opts) {
  const ranks = readRanks(opts);
  const r = ranks && ranks[advisor];
  return r ? { rank: r.rank, weight: r.weight } : Object.assign({}, DEFAULT_RANK);
}

// ---------- 숫자 규칙 책사 3인(결정적 — AI 0회) ----------
function ma(closes, n) {
  if (closes.length < n) return null;
  const s = closes.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}

// 곽가 — 차트·타이밍: KIS 일봉에서 이동평균 직접 산출(ARC-010)
function adviseGwakga(agenda) {
  const bars = agenda.inputs && agenda.inputs.bars;
  if (!Array.isArray(bars) || bars.length < 20) return null; // 결측 → 폴백
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const ma5 = ma(closes, 5);
  const ma20 = ma(closes, 20);
  const hold = agenda.agenda_type === 'hold';
  if (last > ma5 && ma5 > ma20) {
    return hold
      ? { stance: '관망', confidence: 3, rationale: `추세 양호(현재가>5일선>20일선) — 보유 유지` }
      : { stance: '출병', confidence: 4, rationale: `정배열(현재가>5일선>20일선) — 진입 시점 양호` };
  }
  if (last < ma20) {
    return hold
      ? { stance: '회군', confidence: 3, rationale: `20일선 아래(${Math.round(last)} < ${Math.round(ma20)}) — 추세 이탈` }
      : { stance: '반대', confidence: 3, rationale: `20일선 아래 — 진입 시점 아님` };
  }
  return { stance: '관망', confidence: 2, rationale: '추세 혼조(5·20일선 사이) — 신호 대기' };
}

// 법정 — 수급: 종목별 수급 TR 확정 전까지 제한 판정(시장 전체 외국인 + 종목 5일 추세)
function adviseBeopjeong(agenda) {
  const inp = agenda.inputs || {};
  const streak = inp.marketForeignStreak;
  const bars = inp.bars;
  if (typeof streak !== 'number' || !Array.isArray(bars) || bars.length < 6) return null;
  const closes = bars.map((b) => b.close);
  const trend5 = closes[closes.length - 1] - closes[closes.length - 6];
  const hold = agenda.agenda_type === 'hold';
  if (streak >= 2 && trend5 > 0) {
    return { stance: '출병', confidence: 2, rationale: `제한 판정(시장 전체 수급): 외국인 ${streak}일 연속 순매수 + 5일 추세 상승` };
  }
  if (streak <= -2 && trend5 < 0) {
    return hold
      ? { stance: '회군', confidence: 2, rationale: `제한 판정: 외국인 ${-streak}일 연속 순매도 + 5일 추세 하락` }
      : { stance: '반대', confidence: 2, rationale: `제한 판정: 외국인 ${-streak}일 연속 순매도 + 5일 추세 하락` };
  }
  return { stance: '관망', confidence: 2, rationale: '제한 판정(시장 전체 수급): 뚜렷한 쏠림 없음' };
}

// 가후 — 리스크·반대 전담: "왜 하면 안 되나" 체크리스트
function adviseGahu(agenda) {
  const inp = agenda.inputs || {};
  const known = ['stopDistPct', 'limitRoomWon', 'recentViolations', 'captiveToday'].some((k) => inp[k] !== undefined);
  if (!known) return null; // 확인 불가 — 폴백
  const risks = [];
  if (inp.captiveToday === true) risks.push('포로일(복수 매매 금지)');
  if (typeof inp.stopDistPct === 'number' && inp.stopDistPct <= 3) risks.push(`성벽(손절선) ${inp.stopDistPct}% 이내`);
  if (typeof inp.limitRoomWon === 'number' && inp.limitRoomWon <= 0) risks.push('병력 한도 소진');
  if (typeof inp.recentViolations === 'number' && inp.recentViolations > 0) risks.push(`군령 위반 이력 ${inp.recentViolations}건`);
  const hold = agenda.agenda_type === 'hold';
  if (risks.length > 0) {
    const stance = hold && risks.some((r) => r.includes('성벽')) ? '회군' : '반대';
    return { stance, confidence: Math.min(5, 2 + risks.length), rationale: `반대 사유: ${risks.join(' · ')}` };
  }
  return { stance: '관망', confidence: 2, rationale: '반대 사유 없음(리스크 체크리스트 통과) — 그래도 긍정은 남의 몫' };
}

const RULE_FNS = { '곽가': adviseGwakga, '법정': adviseBeopjeong, '가후': adviseGahu };

// ---------- AI 4인 — 묶음 호출·형식 검증·폴백 ----------
function fallbackVoice(reason) {
  return { stance: '관망', confidence: 1, rationale: reason, source: 'fallback' };
}
function validVoice(v) {
  return v && STANCES.includes(v.stance)
    && Number.isInteger(v.confidence) && v.confidence >= 1 && v.confidence <= 5
    && typeof v.rationale === 'string' && v.rationale.trim().length > 0;
}

async function aiVoices(agendas, opts) {
  const out = new Map(); // `${agenda_id}|${advisor}` → voice
  const fallbackAll = (reason) => {
    for (const a of agendas) {
      for (const adv of ADVISORS_AI) out.set(`${a.id}|${adv}`, fallbackVoice(reason));
    }
    return out;
  };
  if (opts.aiBudgetExhausted === true) return fallbackAll('군사 엔진 상한 소진(폴백)');
  if (typeof opts.aiCall !== 'function') return fallbackAll('군사 엔진 미연결(폴백)');
  let parsed;
  try {
    const raw = await opts.aiCall(agendas); // 동기·비동기 공급자 모두 허용(군의·척후 실호출은 비동기)
    parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  } catch (e) {
    return fallbackAll('군사 엔진 불가(폴백)');
  }
  if (!Array.isArray(parsed)) return fallbackAll('군사 엔진 응답 형식 오류(폴백)');
  for (const a of agendas) {
    for (const adv of ADVISORS_AI) {
      const v = parsed.find((x) => x && x.agenda_id === a.id && x.advisor === adv);
      out.set(`${a.id}|${adv}`, validVoice(v)
        ? { stance: v.stance, confidence: v.confidence, rationale: v.rationale, source: 'ai' }
        : fallbackVoice('군사 엔진 응답 형식 오류(폴백)'));
    }
  }
  return out;
}

// ---------- 제갈량 종합(REQ-032 — 결정적·AI 0회) ----------
// verdicts: [{advisor, stance, confidence, source, rank_at_time:{weight}}]
// 반환: {stance, confidence, tally, disagreement, insufficient}
function synthesize(verdicts) {
  const valid = verdicts.filter((v) => v.source !== 'fallback' && v.source !== 'synthesis');
  if (valid.length < 4) return { insufficient: true, stance: null, tally: null, disagreement: null };
  const tally = {};
  for (const s of STANCES) tally[s] = 0;
  let confWeighted = 0;
  let weightSum = 0;
  for (const v of valid) {
    const w = v.rank_at_time ? v.rank_at_time.weight : 1;
    tally[v.stance] += w;
    confWeighted += v.confidence * w;
    weightSum += w;
  }
  const max = Math.max(...STANCES.map((s) => tally[s]));
  // 동률이면 보수 쪽(회군 > 반대 > 관망 > 출병)
  const stance = CONSERVATIVE_ORDER.find((s) => tally[s] === max);
  // 불일치율 = 유효 의견 중 최다 입장이 아닌 비율(머릿수 기준, 폴백 제외 — REQ-031)
  const counts = {};
  for (const v of valid) counts[v.stance] = (counts[v.stance] || 0) + 1;
  const maxCount = Math.max(...Object.values(counts));
  const disagreement = Math.round((1 - maxCount / valid.length) * 1000) / 10;
  return {
    insufficient: false, stance, tally,
    confidence: weightSum > 0 ? Math.round((confWeighted / weightSum) * 10) / 10 : null,
    disagreement,
  };
}

// ---------- 오케스트레이터 ----------
// agendas: [{id, date, ticker, name, agenda_type:'entry'|'hold', inputs:{...}}]
// opts: {dataDir, aiCall(agendas)→JSON문자열, aiBudgetExhausted, now}
// 반환: {results:[{agenda_id, written, synthesis, gahu, insufficient}]}
async function runCouncil(agendas, opts) {
  opts = opts || {};
  const existing = readVerdicts(opts);
  const haveKey = new Set(existing.filter((r) => !r.type).map((r) => `${r.agenda_id}|${r.advisor}`));
  const nowIso = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();

  for (const a of agendas) {
    if (!a || !a.id || !/^\d{4}-\d{2}-\d{2}$/.test(a.date || '')) throw new Error('안건에 id·date(YYYY-MM-DD) 필수');
  }
  // 멱등: 이미 전부 기록된 안건은 AI 호출 대상에서도 제외.
  // 장송은 DART 수집 전(dartEnabled !== true) 어차피 폴백이므로 호출 필요 판정에서 뺀다.
  const fresh = agendas.filter((a) => !['곽가', '법정', '가후', ...ADVISORS_AI, '제갈량'].every((adv) => haveKey.has(`${a.id}|${adv}`)));
  const aiAdvs = opts.dartEnabled === true ? ADVISORS_AI : ADVISORS_AI.filter((x) => x !== '장송');
  const needAi = fresh.filter((a) => aiAdvs.some((adv) => !haveKey.has(`${a.id}|${adv}`)));
  const voices = needAi.length > 0 ? await aiVoices(needAi, opts) : new Map();

  const results = [];
  // 순번은 기존 줄 수 기반(score 이벤트 포함이라 건너뜀 있음 — 유일성만 보장하면 충분).
  // 단일 프로세스 전제(그림자 데몬 1개) — 동시 실행 잠금은 두지 않는다.
  let seq = existing.length;
  for (const a of agendas) {
    const rows = [];
    const mkRow = (advisor, voice) => ({
      id: `CV-${(a.date || '').replace(/-/g, '')}-${String(++seq).padStart(4, '0')}`,
      date: a.date, agenda_id: a.id, ticker: a.ticker, name: a.name || null,
      agenda_type: a.agenda_type, advisor,
      stance: normalizeStance(voice.stance, a.agenda_type),
      confidence: voice.confidence, rationale: voice.rationale,
      source: voice.source, rank_at_time: rankOf(advisor, opts),
      score_result: 'pending', rel_return: null, scored_at: null,
      disagreement: voice.disagreement !== undefined ? voice.disagreement : null,
      created_at: nowIso,
    });

    // 규칙 3인
    for (const adv of ADVISORS_RULE) {
      if (haveKey.has(`${a.id}|${adv}`)) continue;
      const v = RULE_FNS[adv](a);
      rows.push(mkRow(adv, v ? Object.assign({ source: 'rule' }, v) : fallbackVoice('입력 결측(폴백)')));
    }
    // AI 4인 — 장송은 DART 수집 전까지 '정보 없음' 고정(지령 012)
    for (const adv of ADVISORS_AI) {
      if (haveKey.has(`${a.id}|${adv}`)) continue;
      if (adv === '장송' && opts.dartEnabled !== true) {
        rows.push(mkRow(adv, fallbackVoice('공시 수집 전 — 정보 없음(DART, TSK-029 대기)')));
        continue;
      }
      rows.push(mkRow(adv, voices.get(`${a.id}|${adv}`) || fallbackVoice('군사 엔진 미연결(폴백)')));
    }

    // 제갈량 종합(이번에 새로 쓴 행 + 기존 행 합산 — 멱등 재실행 대비)
    const all = existing.filter((r) => !r.type && r.agenda_id === a.id).concat(rows);
    const opinions = all.filter((r) => r.advisor !== '제갈량');
    const syn = synthesize(opinions);
    let synRow = null;
    if (!syn.insufficient && !haveKey.has(`${a.id}|제갈량`)) {
      synRow = mkRow('제갈량', {
        stance: syn.stance, confidence: Math.max(1, Math.min(5, Math.round(syn.confidence || 1))),
        rationale: `가중 다수결: ${STANCES.map((s) => `${s} ${syn.tally[s]}`).join(' · ')}`,
        source: 'synthesis', disagreement: syn.disagreement,
      });
      rows.push(synRow);
    }
    appendLines(rows, opts);
    for (const r of rows) haveKey.add(`${r.agenda_id}|${r.advisor}`);

    results.push({
      agenda_id: a.id, written: rows.length,
      // 완전 멱등 재실행이면 이번에 쓴 행이 없어도 기존 제갈량 행을 실어준다(호출자 오해 방지)
      synthesis: synRow || all.find((r) => r.advisor === '제갈량') || null,
      gahu: opinions.find((r) => r.advisor === '가후') || null, // 항상 별도 표시(REQ-032)
      insufficient: syn.insufficient === true,
    });
  }
  return { results };
}

// 미보유(entry) 안건의 '회군'은 '반대'로 정규화(REQ-028)
function normalizeStance(stance, agendaType) {
  if (stance === '회군' && agendaType !== 'hold') return '반대';
  return stance;
}

module.exports = {
  runCouncil, synthesize, readVerdicts, appendLines, verdictsFile,
  readRanks, writeRanks, ranksFile,
  ADVISORS_RULE, ADVISORS_AI, STANCES,
};
