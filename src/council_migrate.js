'use strict';

// Aside council 시범 기록 이관 (TSK-028 / DAT-014, 짝 시험 TST-027)
//
// 한 줄 요약: Aside `trading/reports/날짜.json`의 council 배열(책사단 시범 의견)을
// 정식 판정 장부(verdicts.jsonl)로 1회 이관한다 — 원본은 읽기만, 멱등, 모르는 값은
// 조용히 버리지 않고 보류 목록으로 보고한다.
//
// 매핑(TST-027):
//  - view → stance. '정보 없음'(장송 DART 전 패턴)은 관망·확신 1·fallback.
//  - conf가 1~5 정수가 아니면 1로 보정. rationale은 원문 topic을 보존해 생성.
//  - source: 곽가·법정·가후 = rule, '정보 없음' = fallback, 나머지 = ai.
//  - rank_at_time은 전원 종사(x1) — 시범 기록엔 관직이 없었다(사후 소급 금지).
//  - agenda_id = ASIDE-날짜-종목코드(topic의 6자리) — 날짜 파일이 중복돼도 1회만.
//  - 모르는 책사 이름·입장 값 → deferred 목록 {file, advisor, view, reason} 기록, 진행 계속.

const fs = require('node:fs');
const path = require('node:path');

const council = require('./council');

const KNOWN_ADVISORS = new Set(['곽가', '노숙', '순욱', '법정', '육손', '장송', '가후', '제갈량']);
const RULE_ADVISORS = new Set(['곽가', '법정', '가후']);
const VIEW_MAP = { '출병': '출병', '관망': '관망', '반대': '반대', '회군': '회군' };

function normConf(v) {
  return Number.isInteger(v) && v >= 1 && v <= 5 ? v : 1;
}

function migrateCouncilReports(reportsDir, opts) {
  const out = { migrated: 0, skipped: 0, deferred: [] };
  if (!fs.existsSync(reportsDir)) return out;
  const files = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.json')).sort();

  const existing = council.readVerdicts(opts);
  const haveKey = new Set(existing.filter((r) => !r.type).map((r) => `${r.agenda_id}|${r.advisor}`));
  let seq = existing.length;
  const rows = [];

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
    for (const c of obj.council) {
      if (!KNOWN_ADVISORS.has(c.advisor)) {
        out.deferred.push({ file: f, advisor: c.advisor, view: c.view, reason: `모르는 책사 이름: ${c.advisor}` });
        continue;
      }
      const noInfo = c.view === '정보 없음';
      const stance = noInfo ? '관망' : VIEW_MAP[c.view];
      if (!stance) {
        out.deferred.push({ file: f, advisor: c.advisor, view: c.view, reason: `모르는 입장 값: ${c.view}` });
        continue;
      }
      const ticker = (String(c.topic || '').match(/\d{6}/) || [null])[0];
      if (!ticker) {
        out.deferred.push({ file: f, advisor: c.advisor, view: c.view, reason: `topic에서 종목코드 추출 실패: ${c.topic}` });
        continue;
      }
      const agendaId = `ASIDE-${date}-${ticker}`;
      if (haveKey.has(`${agendaId}|${c.advisor}`)) continue; // 멱등 — 이미 이관됨
      rows.push({
        id: `CV-${date.replace(/-/g, '')}-${String(++seq).padStart(4, '0')}`,
        date, agenda_id: agendaId, ticker, name: null,
        agenda_type: /진입/.test(String(c.topic)) ? 'entry' : 'hold',
        advisor: c.advisor, stance, confidence: normConf(c.conf),
        rationale: `시범 기록 이관(Aside reports) — ${c.topic}`,
        source: noInfo ? 'fallback' : (RULE_ADVISORS.has(c.advisor) ? 'rule' : 'ai'),
        rank_at_time: { rank: 'jongsa', weight: 1 },
        score_result: 'pending', rel_return: null, scored_at: null, disagreement: null,
        created_at: new Date(`${date}T09:06:00+09:00`).toISOString(),
        migrated: true,
      });
      haveKey.add(`${agendaId}|${c.advisor}`);
      out.migrated++;
    }
  }
  council.appendLines(rows, opts);
  return out;
}

module.exports = { migrateCouncilReports };
