'use strict';

// TST-027 — Aside council 시범 기록 이관(TSK-028): 스키마 변환·멱등·원본 보존
// 실행: node --test — fixture 사본만 사용, 실파일·네트워크 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const migrate = require('../src/council_migrate');
const council = require('../src/council');
const scorer = require('../src/council_score');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst027-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function lines(dir) {
  const f = path.join(dir, 'council', 'verdicts.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

// 2026-11-26 와이씨 표본과 같은 구조(7건 — 장송 '정보 없음'·conf 0 포함)
function sampleReport() {
  const topic = '232140 오군 진입(15:05)';
  return {
    date: '2026-11-26', weather: '방어', note: 'x',
    council: [
      { advisor: '곽가', topic, view: '관망', conf: 2 },
      { advisor: '노숙', topic, view: '반대', conf: 3 },
      { advisor: '순욱', topic, view: '출병', conf: 3 },
      { advisor: '법정', topic, view: '관망', conf: 2 },
      { advisor: '육손', topic, view: '관망', conf: 3 },
      { advisor: '장송', topic, view: '정보 없음', conf: 0 },
      { advisor: '가후', topic, view: '반대', conf: 3 },
    ],
    council_time: '2026-11-26 09:06',
  };
}

function writeReports(dir, files) {
  const rp = path.join(dir, 'aside-reports');
  fs.mkdirSync(rp, { recursive: true });
  for (const [name, obj] of Object.entries(files)) {
    fs.writeFileSync(path.join(rp, name), JSON.stringify(obj, null, 2), 'utf8');
  }
  return rp;
}

// ===== 1·2·3. 스키마 변환·종사 x1·확신 보정 =====
test('시나리오1·2·3: 표본 7건 이관 — 스키마·전원 종사 x1·conf 0→1 보정·장송 정보 없음 폴백', () => {
  const dir = makeTmpDir();
  try {
    const rp = writeReports(dir, { '2026-11-26.json': sampleReport() });
    const r = migrate.migrateCouncilReports(rp, { dataDir: dir });
    assert.equal(r.migrated, 7);
    const rows = lines(dir);
    assert.equal(rows.length, 7);
    for (const row of rows) {
      assert.ok(['출병', '관망', '반대', '회군'].includes(row.stance), '입장 4종');
      assert.ok(Number.isInteger(row.confidence) && row.confidence >= 1 && row.confidence <= 5, '확신 1~5');
      assert.deepEqual(row.rank_at_time, { rank: 'jongsa', weight: 1 }, '전원 종사 x1');
      assert.equal(row.ticker, '232140', 'topic에서 종목코드 추출');
      assert.equal(row.migrated, true, '이관 표시');
      assert.equal(row.score_result, 'pending');
    }
    const jang = rows.find((x) => x.advisor === '장송');
    assert.equal(jang.stance, '관망', '정보 없음 → 관망');
    assert.equal(jang.confidence, 1, 'conf 0 → 1 보정');
    assert.equal(jang.source, 'fallback');
    assert.equal(rows.find((x) => x.advisor === '곽가').source, 'rule', '규칙 책사 source');
    assert.equal(rows.find((x) => x.advisor === '노숙').source, 'ai', 'AI 책사 source');
  } finally { rm(dir); }
});

// ===== 4·5. 멱등·원본 보존 =====
test('시나리오4·5: 2회 실행 레코드 동일·원본 해시 불변', () => {
  const dir = makeTmpDir();
  try {
    const rp = writeReports(dir, { '2026-11-26.json': sampleReport() });
    const file = path.join(rp, '2026-11-26.json');
    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    migrate.migrateCouncilReports(rp, { dataDir: dir });
    const r2 = migrate.migrateCouncilReports(rp, { dataDir: dir });
    assert.equal(r2.migrated, 0, '재실행 이관 0');
    assert.equal(lines(dir).length, 7, '레코드 수 동일');
    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(hashBefore, hashAfter, '원본 읽기 전용');
  } finally { rm(dir); }
});

// ===== 6·7. 채점 연계·공적판 집계 반영 =====
test('시나리오6·7: 이관분이 5거래일 뒤 채점되고 관직 집계에 반영', async () => {
  const dir = makeTmpDir();
  try {
    const rp = writeReports(dir, { '2026-11-16.json': Object.assign(sampleReport(), { date: '2026-11-16' }) });
    migrate.migrateCouncilReports(rp, { dataDir: dir });
    const calP = path.join(dir, 'cal.json');
    fs.writeFileSync(calP, JSON.stringify({ holidays: {}, special_open: {} }), 'utf8');
    const KRX = (close) => ({ close, source: 'krx_official' });
    const closes = (symbol, date) => ({
      '232140|2026-11-16': KRX(10000), '232140|2026-11-23': KRX(9000),
      '069500|2026-11-16': KRX(100), '069500|2026-11-23': KRX(101),
    })[`${symbol}|${date}`] || null;
    await scorer.scoreVerdicts('2026-11-24', { dataDir: dir, closes, calendarPath: calP });
    const ev = lines(dir).filter((r) => r.type === 'score');
    assert.ok(ev.length >= 7, '이관분 채점');
    // 반대(노숙·가후)는 hit(-10% vs +1%), 출병(순욱) miss, 관망 excluded
    const ranks = scorer.recomputeRanks({ dataDir: dir });
    assert.equal(ranks['가후'].counted, 1, '공적판 집계 반영');
    assert.equal(ranks['가후'].hits, 1);
    assert.equal(ranks['순욱'].hits, 0);
  } finally { rm(dir); }
});

// ===== 에지 =====
test('에지: council 없는 파일 건너뜀·모르는 책사/입장 보류 목록·같은 안건 두 파일 1회', () => {
  const dir = makeTmpDir();
  try {
    const weird = sampleReport();
    weird.council.push({ advisor: '사마의', topic: '232140 x', view: '관망', conf: 2 });
    weird.council.push({ advisor: '곽가', topic: '007810 보유 점검', view: '존버', conf: 2 });
    const rp = writeReports(dir, {
      '2026-11-25.json': { date: '2026-11-25', note: 'council 없음' },
      '2026-11-26.json': weird,
      '2026-11-27.json': Object.assign(sampleReport(), { date: '2026-11-27' }), // 같은 topic·같은 날짜 필드? 다른 날짜 — agenda는 date+ticker로 다름
    });
    const r = migrate.migrateCouncilReports(rp, { dataDir: dir });
    assert.equal(r.deferred.length, 2, '모르는 책사·입장 보류 기록');
    assert.ok(r.deferred.every((d) => d.reason), '보류 사유');
    // 같은 안건(동일 날짜 파일 재등장) → 1회만: 2026-11-26 표본을 다른 파일명으로 복제
    writeReports(dir, { '2026-11-26-copy.json': sampleReport() });
    const before = lines(dir).length;
    migrate.migrateCouncilReports(rp, { dataDir: dir });
    assert.equal(lines(dir).length, before, 'agenda 유일성 — 중복 0');
  } finally { rm(dir); }
});

// ===== 지령 015: 2차 회의(중첩 형식)·원본 보존·amend 보정 =====
function nestedReport() {
  const r = sampleReport();
  r.council.push({
    agenda: '위군 두 번째 자리: 상=비움, 중=와이씨 13,900 매복, 하=알지노믹스 상향',
    time: '2026-11-26 15:40',
    source: 'Aside 군사 임시 회의(시범)',
    opinions: [
      { advisor: '곽가', view: '출병', conf: 3, why: '와이씨 20일선 위 눌림' },
      { advisor: '노숙', view: '관망', conf: 3, why: '외부 변수 큼' },
      { advisor: '순욱', view: '출병', conf: 2, why: '실적 상향 유효' },
      { advisor: '법정', view: '관망', conf: 2, why: '외국인 순매도' },
      { advisor: '육손', view: '관망', conf: 3, why: '기한 불일치' },
      { advisor: '장송', view: '정보 없음', conf: 0, why: 'DART 미수집' },
      { advisor: '가후', view: '반대', conf: 4, why: '이중 집계·쏠림' },
    ],
    synthesis: { by: '제갈량', tally: '출병 2, 관망 3, 반대 1, 정보 없음 1', pick: '상책(비움)' },
    decision: { by: '군주', pick: '상책', time: '2026-11-26 15:45' },
  });
  return r;
}

test('지령015-1: 중첩 형식 이관 — 시각 기반 안건·why 보존·정보 없음 raw_view·시범 종합/군주 결정', () => {
  const dir = makeTmpDir();
  try {
    const rp = writeReports(dir, { '2026-11-26.json': nestedReport() });
    const r = migrate.migrateCouncilReports(rp, { dataDir: dir });
    assert.equal(r.migrated, 14, '1차 7 + 2차 7');
    assert.equal(r.synth, 1, '시범 종합 보조 행');
    const rows = lines(dir);
    const second = rows.filter((x) => !x.type && x.agenda_id === 'ASIDE-2026-11-26-1540');
    assert.equal(second.length, 7, '2차 회의 7건');
    assert.equal(second[0].ticker, null, '복합 안건 — 종목코드 없음');
    assert.match(second.find((x) => x.advisor === '곽가').rationale, /20일선 위 눌림/, '원본 why 보존');
    const jang = second.find((x) => x.advisor === '장송');
    assert.equal(jang.raw_view, '정보 없음', '원문 의견 보존');
    assert.equal(jang.stance, '관망');
    const syn = rows.find((x) => x.type === 'aside_synthesis');
    assert.match(syn.pick, /상책/, '시범 종합');
    assert.equal(syn.decision_pick, '상책', '군주 결정');
    // 멱등 재실행 — 추가 0
    const r2 = migrate.migrateCouncilReports(rp, { dataDir: dir });
    assert.equal(r2.migrated + r2.amended + r2.synth, 0, '재실행 쓰기 0');
  } finally { rm(dir); }
});

test('지령015-2: 구버전으로 이관된 기존 행 — amend 보조 행으로 원본 보존 보강(멱등)', () => {
  const dir = makeTmpDir();
  try {
    // 구버전 이관 흉내: 장송이 raw_view 없이 고정 문구로 들어간 상태
    council.appendLines([{
      id: 'CV-OLD-1', date: '2026-11-26', agenda_id: 'ASIDE-2026-11-26-232140', ticker: '232140',
      agenda_type: 'entry', advisor: '장송', stance: '관망', confidence: 1,
      rationale: '시범 기록 이관(Aside reports) — 232140 오군 진입(15:05)',
      source: 'fallback', rank_at_time: { rank: 'jongsa', weight: 1 },
      score_result: 'pending', rel_return: null, scored_at: null, disagreement: null,
      created_at: 'x', migrated: true,
    }], { dataDir: dir });
    const rp = writeReports(dir, { '2026-11-26.json': sampleReport() });
    const r = migrate.migrateCouncilReports(rp, { dataDir: dir });
    assert.equal(r.amended, 1, '장송 raw_view 보강 1건');
    const am = lines(dir).filter((x) => x.type === 'amend');
    assert.equal(am.length, 1);
    assert.equal(am[0].raw_view, '정보 없음');
    // 원본 의견 행은 불변
    assert.equal(lines(dir).find((x) => x.id === 'CV-OLD-1').rationale.includes('시범 기록 이관'), true);
    // 멱등
    migrate.migrateCouncilReports(rp, { dataDir: dir });
    assert.equal(lines(dir).filter((x) => x.type === 'amend').length, 1, 'amend 중복 0');
  } finally { rm(dir); }
});
