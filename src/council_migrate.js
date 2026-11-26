'use strict';

// Aside council 시범 기록 이관 (TSK-028 / DAT-014, 짝 시험 TST-027 — 지령 013·015)
//
// 한 줄 요약: Aside `trading/reports/날짜.json`의 council 배열(책사단 시범 의견)을
// 정식 판정 장부(verdicts.jsonl)로 이관한다 — 원본은 읽기만, 멱등(재실행 안전),
// 모르는 값은 조용히 버리지 않고 보류 목록으로 보고한다.
//
// 원본 형식 2가지(지령 015):
//  A. 평평한 항목 {advisor, topic, view, conf[, why]} — 1차 회의(09:06) 형식.
//  B. 중첩 항목 {agenda, time, opinions:[{advisor,view,conf,why}], synthesis, decision}
//     — 2차 회의(15:40) 형식. 종목코드가 없을 수 있다(안건이 3택 등) → ticker null,
//     agenda_id는 날짜+시각 기반. 채점은 ticker 없으면 자연히 제외된다(종가 결측 → excluded).
//
// 원본 보존(지령 015):
//  - view '정보 없음'은 stance 관망·fallback으로 매핑하되 raw_view에 원문을 보존(화면 표시용).
//  - why(한 줄 근거)는 rationale로 그대로 옮긴다(없으면 '시범 기록 이관' 문구).
//  - synthesis·decision은 의견이 아니라 type='aside_synthesis' 보조 행으로 남긴다
//    (제갈량 엔진 종합과 구분 — 채점·관직 집계 밖. 집계는 전부 !type 행만 본다).
//  - 이미 이관된 의견 행은 불변(append-only). 원본 보존 정보(raw_view·why)가 빠진 기존
//    행은 type='amend' 보조 행으로 보강한다(화면이 조인해 표시. 멱등).

const fs = require('node:fs');
const path = require('node:path');

const council = require('./council');

const KNOWN_ADVISORS = new Set(['곽가', '노숙', '순욱', '법정', '육손', '장송', '가후', '제갈량']);
const RULE_ADVISORS = new Set(['곽가', '법정', '가후']);
const VIEW_MAP = { '출병': '출병', '관망': '관망', '반대': '반대', '회군': '회군' };

function normConf(v) {
  return Number.isInteger(v) && v >= 1 && v <= 5 ? v : 1;
}

// council_time "YYYY-MM-DD HH:MM …" → ISO. 파싱 실패 시 09:06 근사(첫 표본 관례).
function recordTime(timeStr, date) {
  const m = String(timeStr || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
  const [d, t] = m ? [m[1], m[2]] : [date, '09:06'];
  return new Date(`${d}T${t}:00+09:00`).toISOString();
}

// 원본 의견 1건 → 매핑 결과({stance, confidence, rationale, source, raw_view}) 또는 null(보류)
function mapOpinion(c, out, file) {
  if (!KNOWN_ADVISORS.has(c.advisor)) {
    out.deferred.push({ file, advisor: c.advisor, view: c.view, reason: `모르는 책사 이름: ${c.advisor}` });
    return null;
  }
  const noInfo = c.view === '정보 없음';
  const stance = noInfo ? '관망' : VIEW_MAP[c.view];
  if (!stance) {
    out.deferred.push({ file, advisor: c.advisor, view: c.view, reason: `모르는 입장 값: ${c.view}` });
    return null;
  }
  return {
    stance,
    confidence: normConf(c.conf),
    rationale: c.why ? String(c.why) : null, // 원본 한 줄 근거 보존(지령 015)
    source: noInfo ? 'fallback' : (RULE_ADVISORS.has(c.advisor) ? 'rule' : 'ai'),
    raw_view: noInfo ? '정보 없음' : null, // 원문 의견 보존(stance enum 밖 값)
  };
}

function migrateCouncilReports(reportsDir, opts) {
  opts = opts || {};
  const out = { migrated: 0, skipped: 0, amended: 0, synth: 0, deferred: [] };
  if (!fs.existsSync(reportsDir)) return out;
  const files = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.json')).sort();

  const existing = council.readVerdicts(opts);
  const byKey = new Map(existing.filter((r) => !r.type).map((r) => [`${r.agenda_id}|${r.advisor}`, r]));
  const haveAmend = new Set(existing.filter((r) => r.type === 'amend').map((r) => `${r.agenda_id}|${r.advisor}`));
  const haveSynth = new Set(existing.filter((r) => r.type === 'aside_synthesis').map((r) => r.agenda_id));
  let seq = existing.length;
  const rows = [];

  // 한 안건의 의견 목록을 이관(신규 append + 기존 행 amend 보정)
  function migrateAgenda(file, date, agendaId, meta, opinions) {
    for (const c of opinions) {
      const m = mapOpinion(c, out, file);
      if (!m) continue;
      const key = `${agendaId}|${c.advisor}`;
      const prev = byKey.get(key);
      if (prev) {
        // 멱등 — 이미 이관됨. 원본 보존 정보가 빠져 있으면 amend 보조 행으로 보강(1회만).
        const needRaw = m.raw_view && prev.raw_view == null;
        const needWhy = m.rationale && !(prev.rationale || '').includes(m.rationale);
        if ((needRaw || needWhy) && !haveAmend.has(key)) {
          rows.push({
            type: 'amend', agenda_id: agendaId, advisor: c.advisor,
            raw_view: m.raw_view || null, rationale: m.rationale || null,
            note: '원본 보존 보강(지령 015) — 원본 의견·근거를 화면에 함께 표시',
            created_at: new Date().toISOString(),
          });
          haveAmend.add(key);
          out.amended++;
        }
        continue;
      }
      rows.push({
        id: `CV-${date.replace(/-/g, '')}-${String(++seq).padStart(4, '0')}`,
        date, agenda_id: agendaId, ticker: meta.ticker, name: null,
        agenda_type: meta.agendaType, agenda_label: meta.label || null,
        advisor: c.advisor,
        stance: council.normalizeStance(m.stance, meta.agendaType),
        confidence: m.confidence,
        rationale: m.rationale || `시범 기록 이관(Aside reports) — ${meta.label || meta.topic || ''}`,
        raw_view: m.raw_view,
        source: c.advisor === '제갈량' ? 'synthesis' : m.source,
        rank_at_time: { rank: 'jongsa', weight: 1 },
        score_result: 'pending', rel_return: null, scored_at: null, disagreement: null,
        created_at: meta.createdAt,
        migrated: true,
      });
      byKey.set(key, rows[rows.length - 1]);
      out.migrated++;
    }
  }

  for (const f of files) {
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8')); // 읽기만 — 원본 수정 금지
    } catch (e) {
      out.deferred.push({ file: f, reason: `JSON 파싱 실패: ${e.message}` });
      continue;
    }
    if (!Array.isArray(obj.council) || obj.council.length === 0) {
      out.skipped++;
      continue;
    }
    const date = obj.date || f.replace(/\.json$/, '').slice(0, 10);

    // 평평한 항목(형식 A)과 중첩 항목(형식 B)을 분리
    const flat = obj.council.filter((c) => c && c.advisor);
    const nested = obj.council.filter((c) => c && Array.isArray(c.opinions));

    // A: topic에서 종목코드 — 같은 topic끼리 한 안건
    for (const c of flat) {
      const ticker = (String(c.topic || '').match(/\d{6}/) || [null])[0];
      if (!ticker) {
        out.deferred.push({ file: f, advisor: c.advisor, view: c.view, reason: `topic에서 종목코드 추출 실패: ${c.topic}` });
        continue;
      }
      migrateAgenda(f, date, `ASIDE-${date}-${ticker}`, {
        ticker, agendaType: /진입/.test(String(c.topic)) ? 'entry' : 'hold',
        topic: c.topic, createdAt: recordTime(obj.council_time, date),
      }, [c]);
    }

    // B: 안건 단위 — agenda_id는 날짜+시각(종목코드가 없을 수 있음)
    for (const n of nested) {
      const hhmm = (String(n.time || '').match(/(\d{2}):(\d{2})/) || [null, '00', '00']).slice(1).join('');
      const agendaId = `ASIDE-${date}-${hhmm}`;
      const ticker = (String(n.agenda || '').match(/\d{6}/) || [null])[0];
      migrateAgenda(f, date, agendaId, {
        ticker, agendaType: 'entry', label: n.agenda || null,
        createdAt: recordTime(n.time, date),
      }, n.opinions);
      // 원본 제갈량 종합·군주 결정 → 보조 행(채점·집계 밖, 화면 표시용. 멱등)
      if ((n.synthesis || n.decision) && !haveSynth.has(agendaId)) {
        rows.push({
          type: 'aside_synthesis', agenda_id: agendaId, date,
          agenda_label: n.agenda || null,
          tally: n.synthesis ? n.synthesis.tally || null : null,
          pick: n.synthesis ? n.synthesis.pick || null : null,
          decision_pick: n.decision ? n.decision.pick || null : null,
          decided_by: n.decision ? n.decision.by || null : null,
          decided_at: n.decision ? n.decision.time || null : null,
          created_at: recordTime(n.time, date),
        });
        haveSynth.add(agendaId);
        out.synth++;
      }
    }
  }
  if (!opts.dryRun) council.appendLines(rows, opts);
  return out;
}

module.exports = { migrateCouncilReports };
