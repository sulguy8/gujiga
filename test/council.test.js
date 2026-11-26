'use strict';

// TST-024 — 책사단 엔진(TSK-025): 의견 형식·숫자 규칙 재현성·호출 상한·폴백·종합
// 실행: node --test — AI는 스텁(문자열 반환 함수), 실계좌·관문·실서버 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const council = require('../src/council');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst024-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function readVerdicts(dir) {
  const f = path.join(dir, 'council', 'verdicts.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

// 곽가 상승 추세(last > ma5 > ma20)용 일봉 60개
function upBars() {
  return Array.from({ length: 60 }, (_, i) => ({ close: 10000 + i * 100 }));
}
function downBars() {
  return Array.from({ length: 60 }, (_, i) => ({ close: 20000 - i * 100 }));
}

function agenda(over) {
  return Object.assign({
    id: 'AG-1', date: '2026-11-26', ticker: '232140', name: '와이씨', agenda_type: 'entry',
    inputs: {
      bars: upBars(), marketForeignStreak: 3,
      stopDistPct: 10, limitRoomWon: 100000, recentViolations: 0, captiveToday: false,
    },
  }, over || {});
}

// AI 스텁: 4목소리 JSON 문자열(장송 포함 — DART 전이라 엔진이 폴백으로 대체)
function aiOk(agendas) {
  return JSON.stringify(agendas.flatMap((a) => ['노숙', '순욱', '육손', '장송'].map((adv) => ({
    agenda_id: a.id, advisor: adv, stance: '출병', confidence: 3, rationale: `${adv} 근거`,
  }))));
}

function run(dir, agendas, over) {
  return council.runCouncil(agendas, Object.assign({
    dataDir: dir, aiCall: aiOk, now: '2026-11-26T08:31:00+09:00',
  }, over || {}));
}

// ===== 1. 정상 안건 → 7건 + 종합 1건, 형식 검증 통과 =====
test('시나리오1: 안건 1건 → 의견 7건+synthesis 1건, 전부 형식 OK', async () => {
  const dir = makeTmpDir();
  try {
    await run(dir, [agenda()]);
    const rows = readVerdicts(dir);
    assert.equal(rows.length, 8, '7+1건');
    const advisors = rows.map((r) => r.advisor).sort();
    assert.deepEqual(advisors, ['가후', '곽가', '노숙', '법정', '순욱', '육손', '장송', '제갈량'].sort(), '책사 7인+제갈량');
    for (const r of rows) {
      assert.ok(['출병', '관망', '반대', '회군'].includes(r.stance), '입장 4종');
      assert.ok(Number.isInteger(r.confidence) && r.confidence >= 1 && r.confidence <= 5, '확신 1~5');
      assert.ok(typeof r.rationale === 'string' && r.rationale.trim().length > 0, '근거 비공백');
      assert.ok(r.rank_at_time && r.rank_at_time.weight >= 0, '기록 시점 관직');
    }
    const syn = rows.find((r) => r.advisor === '제갈량');
    assert.equal(syn.source, 'synthesis');
    assert.ok(typeof syn.disagreement === 'number', '불일치율 기록');
  } finally { rm(dir); }
});

// ===== 2. 규칙 책사 재현성 =====
test('시나리오2: 같은 입력 2회 — 곽가·법정·가후 의견 동일', async () => {
  const d1 = makeTmpDir(); const d2 = makeTmpDir();
  try {
    await run(d1, [agenda()]);
    await run(d2, [agenda()]);
    for (const adv of ['곽가', '법정', '가후']) {
      const a = readVerdicts(d1).find((r) => r.advisor === adv);
      const b = readVerdicts(d2).find((r) => r.advisor === adv);
      assert.equal(a.stance, b.stance, `${adv} 입장 재현`);
      assert.equal(a.confidence, b.confidence, `${adv} 확신 재현`);
      assert.equal(a.rationale, b.rationale, `${adv} 근거 재현`);
      assert.equal(a.source, 'rule');
    }
  } finally { rm(d1); rm(d2); }
});

// ===== 3. AI 호출 ≤1회 =====
test('시나리오3: 안건 1건 처리에 AI 호출 최대 1회', async () => {
  const dir = makeTmpDir();
  try {
    let calls = 0;
    await run(dir, [agenda()], { aiCall: (a) => { calls++; return aiOk(a); } });
    assert.ok(calls <= 1, `호출 ${calls} ≤ 1`);
  } finally { rm(dir); }
});

// ===== 4. 깨진 JSON → 4인 폴백, 예외 전파 없음 =====
test('시나리오4: AI 깨진 응답 — 폴백 기록·처리 완료', async () => {
  const dir = makeTmpDir();
  try {
    await run(dir, [agenda()], { aiCall: () => '이건 JSON이 아님{{{' });
    const rows = readVerdicts(dir);
    const fb = rows.filter((r) => r.source === 'fallback');
    assert.equal(fb.length, 4, 'AI 4인 폴백');
    for (const r of fb) {
      assert.equal(r.stance, '관망');
      assert.equal(r.confidence, 1);
    }
  } finally { rm(dir); }
});

// ===== 5. 상한 소진 → AI 미호출·폴백 =====
test('시나리오5: 상한 소진 — callCount 0·4인 폴백', async () => {
  const dir = makeTmpDir();
  try {
    let calls = 0;
    await run(dir, [agenda()], { aiCall: (a) => { calls++; return aiOk(a); }, aiBudgetExhausted: true });
    assert.equal(calls, 0, 'AI 미호출');
    assert.equal(readVerdicts(dir).filter((r) => r.source === 'fallback').length, 4);
  } finally { rm(dir); }
});

// ===== 6. 가중 다수결·동률 보수 =====
test('시나리오6: 군사중랑장 출병 1 vs 종사 관망 2 → 출병 / 동률 → 보수', () => {
  const mk = (advisor, stance, weight, source) => ({ advisor, stance, confidence: 3, source: source || 'rule', rank_at_time: { rank: 'r', weight } });
  const r1 = council.synthesize([
    mk('곽가', '출병', 3), mk('법정', '관망', 1), mk('가후', '관망', 1), mk('노숙', '반대', 1, 'ai'),
  ]);
  assert.equal(r1.stance, '출병', '군사중랑장 3 > 종사 관망 2');
  // 동률: 출병 2 vs 관망 2 → 보수(관망)
  const r2 = council.synthesize([
    mk('곽가', '출병', 1), mk('노숙', '출병', 1, 'ai'), mk('법정', '관망', 1), mk('가후', '관망', 1),
  ]);
  assert.equal(r2.stance, '관망', '동률 보수 우선');
});

// ===== 7. 폴백 가중 0 =====
test('시나리오7: 폴백은 가중·머릿수 모두 0 — 결론을 흔들지 못함', () => {
  const mk = (advisor, stance, weight, source) => ({ advisor, stance, confidence: 3, source: source || 'rule', rank_at_time: { rank: 'r', weight } });
  // 유효 3건뿐이면 종합 생략(REQ-032 — 폴백은 유효 수에도 안 들어감)
  const r0 = council.synthesize([
    mk('곽가', '관망', 1), mk('법정', '관망', 1), mk('가후', '반대', 1),
    mk('노숙', '출병', 1, 'fallback'), mk('순욱', '출병', 1, 'fallback'), mk('육손', '출병', 1, 'fallback'), mk('장송', '출병', 1, 'fallback'),
  ]);
  assert.ok(r0.insufficient, '유효 3건 — 의견 불충분');
  // 유효 4건 + 폴백 3건(전부 출병) — 폴백은 tally 0 기여, 유효 쪽 결론 유지
  const r1 = council.synthesize([
    mk('곽가', '관망', 1), mk('법정', '관망', 1), mk('가후', '반대', 1), mk('노숙', '관망', 1, 'ai'),
    mk('순욱', '출병', 1, 'fallback'), mk('육손', '출병', 1, 'fallback'), mk('장송', '출병', 1, 'fallback'),
  ]);
  assert.equal(r1.stance, '관망', '폴백 출병 3이 유효 관망 3을 못 이김');
  assert.equal(r1.tally['출병'], 0, '폴백 가중 0');
});

// ===== 8. 가후 항상 포함 =====
test('시나리오8: 종합 출력에 가후 의견 항상 포함', async () => {
  const dir = makeTmpDir();
  try {
    const res = await run(dir, [agenda()]);
    assert.ok(res.results[0].gahu, '가후 영역 존재');
    assert.equal(res.results[0].gahu.advisor, '가후');
  } finally { rm(dir); }
});

// ===== 9. 주문 경로 0(정적 검사) =====
test('시나리오9: council 소스에 주문 모듈·실행 플래그 접근 없음', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'council.js'), 'utf8');
  for (const mod of ['./gate', './kis_adapter', './gatekeeper', './order_draft']) {
    assert.ok(!src.includes(`require('${mod}')`), `주문 모듈 금지: ${mod}`);
  }
  assert.ok(!/\.(order|submit|amend|revoke)\s*\(/.test(src), '주문류 호출 0');
  assert.ok(!src.includes('user_confirmed'), '실행 플래그 접근 0');
});

// ===== 10. 복수 아침 안건 → 호출 1회 공유 =====
test('시나리오10: 안건 3건 동시 처리 — AI 호출 ≤1회·레코드 24건', async () => {
  const dir = makeTmpDir();
  try {
    let calls = 0;
    await run(dir, [agenda(), agenda({ id: 'AG-2', ticker: '007810' }), agenda({ id: 'AG-3', ticker: '458870', agenda_type: 'hold' })],
      { aiCall: (a) => { calls++; return aiOk(a); } });
    assert.ok(calls <= 1, `호출 ${calls} ≤ 1(공유)`);
    assert.equal(readVerdicts(dir).length, 24, '안건 3 × (7+1)');
  } finally { rm(dir); }
});

// ===== 경계: 형식 위반 거부·폴백 대체 =====
test('경계1: 확신 0/6·입장 오탈자·근거 빈 문자열 → 폴백 대체', async () => {
  const dir = makeTmpDir();
  try {
    const bad = (agendas) => JSON.stringify([
      { agenda_id: agendas[0].id, advisor: '노숙', stance: '출병', confidence: 0, rationale: 'x' },
      { agenda_id: agendas[0].id, advisor: '순욱', stance: '출병입니다', confidence: 3, rationale: 'x' },
      { agenda_id: agendas[0].id, advisor: '육손', stance: '출병', confidence: 6, rationale: 'x' },
      { agenda_id: agendas[0].id, advisor: '장송', stance: '출병', confidence: 3, rationale: '   ' },
    ]);
    await run(dir, [agenda()], { aiCall: bad });
    const rows = readVerdicts(dir);
    for (const adv of ['노숙', '순욱', '육손', '장송']) {
      assert.equal(rows.find((r) => r.advisor === adv).source, 'fallback', `${adv} 폴백`);
    }
  } finally { rm(dir); }
});

// ===== 경계: 유효 3건 → 종합 생략 =====
test('경계2: 유효 의견 3건(AI 전원 폴백) → synthesis 레코드 없음·불충분 표시', async () => {
  const dir = makeTmpDir();
  try {
    const res = await run(dir, [agenda()], { aiCall: () => { throw new Error('엔진 불가'); } });
    assert.equal(res.results[0].synthesis, null, '종합 생략');
    assert.ok(res.results[0].insufficient, '의견 불충분 표시');
    const rows = readVerdicts(dir);
    assert.equal(rows.filter((r) => r.advisor === '제갈량').length, 0, 'synthesis 미기록');
    assert.equal(rows.length, 7, '의견 7건만');
  } finally { rm(dir); }
});

// ===== 경계: 미보유 안건 '회군' → '반대' 정규화 =====
test('경계3: entry 안건의 회군 응답 → 반대로 정규화', async () => {
  const dir = makeTmpDir();
  try {
    const ai = (agendas) => JSON.stringify(['노숙', '순욱', '육손', '장송'].map((adv) => ({
      agenda_id: agendas[0].id, advisor: adv, stance: '회군', confidence: 2, rationale: `${adv}`,
    })));
    await run(dir, [agenda({ agenda_type: 'entry' })], { aiCall: ai });
    const rows = readVerdicts(dir);
    for (const adv of ['노숙', '순욱', '육손']) { // 장송은 DART 전 폴백
      assert.equal(rows.find((r) => r.advisor === adv).stance, '반대', `${adv} 회군→반대`);
    }
  } finally { rm(dir); }
});

// ===== 멱등(AC6): 같은 안건 재실행 → 중복 0 =====
test('멱등: 같은 안건 2회 실행 — 레코드 8건 유지·정상 종료', async () => {
  const dir = makeTmpDir();
  try {
    await run(dir, [agenda()]);
    await run(dir, [agenda()]);
    assert.equal(readVerdicts(dir).length, 8, '중복 0');
  } finally { rm(dir); }
});

// ===== 장송: DART 수집 전 '정보 없음' =====
test('장송: DART 전 — AI 응답과 무관하게 정보 없음 폴백', async () => {
  const dir = makeTmpDir();
  try {
    await run(dir, [agenda()]);
    const j = readVerdicts(dir).find((r) => r.advisor === '장송');
    assert.equal(j.source, 'fallback');
    assert.match(j.rationale, /정보 없음|수집 전/, 'DART 전 표기');
  } finally { rm(dir); }
});
