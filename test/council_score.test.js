'use strict';

// TST-025 — 판정 장부·채점·관직·다양성(TSK-026): 지수 대비 채점·승강 경계·append-only
// 실행: node --test — 종가·달력 fixture 주입, 실데이터·네트워크 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const council = require('../src/council');
const scorer = require('../src/council_score');
const state = require('../src/state');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst025-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function lines(dir) {
  const f = path.join(dir, 'council', 'verdicts.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

// 휴장 없는 달력(주말만 휴장) fixture
function calPath(dir, holidays) {
  const p = path.join(dir, 'cal.json');
  fs.writeFileSync(p, JSON.stringify({ holidays: holidays || {}, special_open: {} }), 'utf8');
  return p;
}

// 의견 행 시드(채점 대상). 2026-11-16(월) 기록 — 5거래일 후 = 11-23(월).
function seedVerdict(dir, over) {
  council.appendLines([Object.assign({
    id: 'CV-20261116-0001', date: '2026-11-16', agenda_id: 'AG-1', ticker: '232140', name: '와이씨',
    agenda_type: 'entry', advisor: '곽가', stance: '출병', confidence: 3, rationale: 'r',
    source: 'rule', rank_at_time: { rank: 'jongsa', weight: 1 },
    score_result: 'pending', rel_return: null, scored_at: null, disagreement: null,
    created_at: '2026-11-16T08:31:00+09:00',
  }, over || {})], { dataDir: dir });
}

// 종가 fixture: {'심볼|날짜': {close, source}}
function closesFn(map) {
  return (symbol, date) => map[`${symbol}|${date}`] || null;
}
const KRX = (close) => ({ close, source: 'krx_official' });

function baseCloses(stockBase, stockAfter, idxBase, idxAfter) {
  return closesFn({
    '232140|2026-11-16': KRX(stockBase), '232140|2026-11-23': KRX(stockAfter),
    '069500|2026-11-16': KRX(idxBase), '069500|2026-11-23': KRX(idxAfter),
  });
}

async function runScore(dir, closes, today, over) {
  return await scorer.scoreVerdicts(today || '2026-11-24', Object.assign({
    dataDir: dir, closes, calendarPath: calPath(dir),
  }, over || {}));
}

// ===== 1·8. append-only·원본 불변 + rank_at_time 소급 불변 =====
test('시나리오1·8: 채점은 score 이벤트 추가로만 — 원본 의견 줄·rank_at_time 불변', async () => {
  const dir = makeTmpDir();
  try {
    seedVerdict(dir);
    const before = lines(dir).map((r) => JSON.stringify(r));
    await runScore(dir, baseCloses(10000, 10300, 100, 105)); // 종목 +3% 지수 +5%
    const after = lines(dir);
    assert.deepEqual(after.slice(0, before.length).map((r) => JSON.stringify(r)), before, '원본 줄 불변');
    const ev = after.filter((r) => r.type === 'score');
    assert.equal(ev.length, 1, 'score 이벤트 1건');
    assert.equal(typeof scorer.editVerdict, 'undefined', '수정 API 없음');
    assert.equal(typeof scorer.deleteVerdict, 'undefined', '삭제 API 없음');
  } finally { rm(dir); }
});

// ===== 2. 지수 대비 채점 =====
test('시나리오2: 출병 +3% vs 지수 +5% → miss / 반대 −1% vs 지수 +1% → hit', async () => {
  const dir = makeTmpDir();
  try {
    seedVerdict(dir); // 출병
    seedVerdict(dir, { id: 'CV-20261116-0002', agenda_id: 'AG-2', advisor: '가후', stance: '반대' });
    const closes = closesFn({
      '232140|2026-11-16': KRX(10000), '232140|2026-11-23': KRX(10300),
      '069500|2026-11-16': KRX(100), '069500|2026-11-23': KRX(105),
    });
    await runScore(dir, closes);
    const ev = lines(dir).filter((r) => r.type === 'score');
    assert.equal(ev.find((e) => e.verdict_id === 'CV-20261116-0001').score_result, 'miss', '출병인데 지수에 짐');
    assert.equal(ev.find((e) => e.verdict_id === 'CV-20261116-0002').score_result, 'hit', '반대 적중(상대 음수)');
  } finally { rm(dir); }
});

// ===== 3. 관망 excluded =====
test('시나리오3: 관망 → excluded·판정 건수 미포함', async () => {
  const dir = makeTmpDir();
  try {
    seedVerdict(dir, { stance: '관망' });
    await runScore(dir, baseCloses(10000, 10300, 100, 105));
    const ev = lines(dir).filter((r) => r.type === 'score');
    assert.equal(ev[0].score_result, 'excluded');
    const ranks = scorer.recomputeRanks({ dataDir: dir });
    assert.equal(ranks['곽가'].counted, 0, '판정 건수 미포함');
  } finally { rm(dir); }
});

// ===== 4. 거래일 계산 — 중간 휴장 2일 =====
test('시나리오4: 휴장 2일 → 달력일 7일 뒤 종가로 채점', async () => {
  const dir = makeTmpDir();
  try {
    seedVerdict(dir);
    // 11-19(목)·11-20(금) 휴장 → 5거래일 후 = 11-25(수)
    const cp = calPath(dir, { '2026-11-19': '휴장', '2026-11-20': '휴장' });
    const closes = closesFn({
      '232140|2026-11-16': KRX(10000), '232140|2026-11-25': KRX(11000),
      '069500|2026-11-16': KRX(100), '069500|2026-11-25': KRX(101),
    });
    await scorer.scoreVerdicts('2026-11-26', { dataDir: dir, closes, calendarPath: cp });
    const ev = lines(dir).filter((r) => r.type === 'score');
    assert.equal(ev.length, 1, '11-25 종가로 채점됨');
    assert.equal(ev[0].score_result, 'hit', '+10% vs +1%');
  } finally { rm(dir); }
});

// ===== 5. 결측 pending·10거래일 초과 excluded =====
test('시나리오5: 지수 결측 → pending 유지, 10거래일 초과 → excluded', async () => {
  const dir = makeTmpDir();
  try {
    seedVerdict(dir);
    const closes = closesFn({ '232140|2026-11-23': KRX(10300), '232140|2026-11-16': KRX(10000) }); // 지수 없음
    await runScore(dir, closes, '2026-11-24');
    assert.equal(lines(dir).filter((r) => r.type === 'score').length, 0, 'pending 유지');
    // 10거래일 초과(11-16 + 10거래일 = 11-30) 후에도 결측 → excluded
    await runScore(dir, closes, '2026-12-01');
    const ev = lines(dir).filter((r) => r.type === 'score');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].score_result, 'excluded');
    assert.ok(ev[0].reason, '사유 기록');
  } finally { rm(dir); }
});

// ===== 11. 종가 출처 태그 =====
test('시나리오11: krx_official 아닌 종가만 있으면 채점 안 함(pending)', async () => {
  const dir = makeTmpDir();
  try {
    seedVerdict(dir);
    const closes = closesFn({
      '232140|2026-11-16': KRX(10000), '232140|2026-11-23': { close: 10300, source: 'naver' },
      '069500|2026-11-16': KRX(100), '069500|2026-11-23': KRX(105),
    });
    await runScore(dir, closes);
    assert.equal(lines(dir).filter((r) => r.type === 'score').length, 0, 'hit/miss 미발생');
  } finally { rm(dir); }
});

// ===== 6·7. 승진·강등 경계 =====
function seedScored(dir, advisor, results) {
  // results: 'h'|'m' 문자열 — 오래된 것부터
  results.split('').forEach((c, i) => {
    const id = `CV-R-${advisor}-${i}`;
    seedVerdict(dir, { id, agenda_id: `AG-${advisor}-${i}`, advisor, date: '2026-10-01' });
    council.appendLines([{ type: 'score', verdict_id: id, score_result: c === 'h' ? 'hit' : 'miss', rel_return: c === 'h' ? 1 : -1, scored_at: `2026-10-${String(2 + i).padStart(2, '0')}` }], { dataDir: dir });
  });
}

test('시나리오6: 승진 경계 — 10건 60% 참군 / 9건 100% 종사 / 30건 65% 군사중랑장', async () => {
  const dir = makeTmpDir();
  try {
    seedScored(dir, '곽가', 'hhhhhhmmmm'); // 10건 60%
    seedScored(dir, '법정', 'hhhhhhhhh'); // 9건 100%
    seedScored(dir, '가후', 'h'.repeat(20) + 'hmm'.repeat(3) + 'h'); // 30건: 20+3h+6m+1h=24h/30=80%... 아래 단언으로 확인
    const ranks = scorer.recomputeRanks({ dataDir: dir });
    assert.equal(ranks['곽가'].rank, 'chamgun', '10건 60% → 참군');
    assert.equal(ranks['곽가'].weight, 2);
    assert.equal(ranks['법정'].rank, 'jongsa', '9건은 건수 미달');
    assert.equal(ranks['가후'].rank, 'junglangjang', '30건 65%+ → 군사중랑장');
    assert.equal(ranks['가후'].weight, 3);
  } finally { rm(dir); }
});

test('시나리오7: 강등 경계 — 최근 10건 적중 3 강등·4 유지·종사 아래 없음', async () => {
  const dir = makeTmpDir();
  try {
    // 곽가: 참군 자격(20건 60%) + 최근 10건 3 hit → 강등 종사
    seedScored(dir, '곽가', 'h'.repeat(9) + 'm'.repeat(1) + 'hhhmmmmmmm');
    // 법정: 참군 자격(20건 전반 h 많음) + 최근 10건 4 hit → 유지 참군
    seedScored(dir, '법정', 'h'.repeat(10) + 'hhhhmmmmmm');
    // 가후: 종사(5건) + 최근 전부 miss → 종사 유지(더 안 내려감)
    seedScored(dir, '가후', 'mmmmm');
    const ranks = scorer.recomputeRanks({ dataDir: dir });
    assert.equal(ranks['곽가'].rank, 'jongsa', '40% 미만 — 한 단계 강등');
    assert.equal(ranks['법정'].rank, 'chamgun', '40% — 유지');
    assert.equal(ranks['가후'].rank, 'jongsa', '종사 아래 없음');
  } finally { rm(dir); }
});

// ===== 승강 이력(REQ-029 AC4·DAT-015) — 이벤트 재생으로 복원 가능 =====
test('승강 이력: 승진·강등이 일시·사유와 함께 history에 남고, 캐시 삭제 후에도 복원', async () => {
  const dir = makeTmpDir();
  try {
    // 곽가: 10건 90% 승진 → 이후 연패로 강등(시나리오7과 동일 시퀀스)
    seedScored(dir, '곽가', 'h'.repeat(9) + 'm'.repeat(1) + 'hhhmmmmmmm');
    const ranks = scorer.recomputeRanks({ dataDir: dir });
    const h = ranks['곽가'].history;
    assert.ok(Array.isArray(h) && h.length >= 2, '승진+강등 이력');
    assert.equal(h[0].to, 'chamgun');
    assert.match(h[0].reason, /승진/, '승진 사유');
    assert.equal(h[h.length - 1].to, 'jongsa');
    assert.match(h[h.length - 1].reason, /강등/, '강등 사유(지표 포함)');
    assert.ok(h[0].at, '일시 기록');
    assert.ok(ranks['곽가'].hit_rate != null && ranks['곽가'].recent10_hit_rate != null, 'DAT-015 지표 필드');
    // 파생 캐시 삭제 → history까지 동일 복원
    fs.rmSync(path.join(dir, 'council', 'ranks.json'), { force: true });
    assert.deepEqual(scorer.recomputeRanks({ dataDir: dir }), ranks, '이력 포함 복원');
  } finally { rm(dir); }
});

// ===== 9. 불일치율 경고 =====
test('시나리오9: 불일치율 — 전원 일치 0%·4:3 ≈ 43%·평균 19% 경고·21% 미경고', async () => {
  const dir = makeTmpDir();
  try {
    const mk = (s, w) => ({ advisor: 'x', stance: s, confidence: 3, source: 'rule', rank_at_time: { weight: w == null ? 1 : w } });
    assert.equal(council.synthesize([mk('출병'), mk('출병'), mk('출병'), mk('출병')]).disagreement, 0, '전원 일치 0%');
    const d43 = council.synthesize([mk('출병'), mk('출병'), mk('출병'), mk('출병'), mk('관망'), mk('관망'), mk('관망')]).disagreement;
    assert.ok(Math.abs(d43 - 42.9) < 0.2, `4:3 ≈ 43% (실제 ${d43})`);
    // 경고: 최근 10안건 평균 19% → 경고(한목소리), 21% → 미경고
    const seed = (vals) => {
      rm(dir); fs.mkdirSync(dir, { recursive: true });
      vals.forEach((v, i) => council.appendLines([{
        id: `CV-S-${i}`, agenda_id: `AG-S-${i}`, advisor: '제갈량', stance: '관망', confidence: 3,
        rationale: 'r', source: 'synthesis', rank_at_time: { weight: 1 }, date: '2026-11-16',
        disagreement: v, created_at: `2026-11-16T0${i % 10}:00:00+09:00`,
      }], { dataDir: dir }));
    };
    seed(Array(10).fill(19));
    assert.equal(scorer.disagreementWarning({ dataDir: dir }).warn, true, '평균 19% → 경고');
    seed(Array(10).fill(21));
    assert.equal(scorer.disagreementWarning({ dataDir: dir }).warn, false, '평균 21% → 미경고');
  } finally { rm(dir); }
});

// ===== 10. 배치 멱등 =====
test('시나리오10: 채점·재계산 2회 — 결과 동일·중복 score 이벤트 0', async () => {
  const dir = makeTmpDir();
  try {
    seedVerdict(dir);
    const closes = baseCloses(10000, 10300, 100, 105);
    await runScore(dir, closes);
    await runScore(dir, closes);
    assert.equal(lines(dir).filter((r) => r.type === 'score').length, 1, '이벤트 1건 유지');
    const r1 = scorer.recomputeRanks({ dataDir: dir });
    const r2 = scorer.recomputeRanks({ dataDir: dir });
    assert.deepEqual(r1, r2, '재계산 멱등');
  } finally { rm(dir); }
});

// ===== 에지 =====
test('에지: (agenda_id, advisor) 중복 append 거부 / 상대 0% excluded / ranks 삭제 후 복원', async () => {
  const dir = makeTmpDir();
  try {
    seedVerdict(dir);
    assert.throws(() => seedVerdict(dir), /중복|유일/, '중복 append 거부');
    // 상대 수익률 정확히 0 → excluded
    seedVerdict(dir, { id: 'CV-Z', agenda_id: 'AG-Z' });
    await runScore(dir, baseCloses(10000, 10500, 100, 105)); // 둘 다 +5%
    const ev = lines(dir).filter((r) => r.type === 'score' && r.verdict_id === 'CV-Z');
    assert.equal(ev[0].score_result, 'excluded', 'rel 0 → excluded');
    // ranks.json 삭제 후 재계산 → 동일 복원
    const a = scorer.recomputeRanks({ dataDir: dir });
    fs.rmSync(path.join(dir, 'council', 'ranks.json'), { force: true });
    const b = scorer.recomputeRanks({ dataDir: dir });
    assert.deepEqual(a, b, '장부에서 복원');
  } finally { rm(dir); }
});
