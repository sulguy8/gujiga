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
