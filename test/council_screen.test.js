'use strict';

// TST-026 — 책사단 화면(TSK-027): 의견판(/council)·공적판(/council/merit)
// 실행: node --test — fixture 장부, 현황판 62900 서버 핸들러 검사. 실데이터·네트워크 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const web = require('../src/web');
const council = require('../src/council');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst026-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function request(port, pathName, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: method || 'GET', path: pathName }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ADVISORS = ['곽가', '노숙', '순욱', '법정', '육손', '장송', '가후'];
function seedAgenda(dir, agendaId, over) {
  over = over || {};
  const rows = ADVISORS.map((adv, i) => ({
    id: `CV-S-${agendaId}-${i}`, date: over.date || '2026-11-26', agenda_id: agendaId,
    ticker: '232140', name: '와이씨', agenda_type: 'entry', advisor: adv,
    stance: over.stances ? over.stances[i] : '관망', confidence: 2, rationale: `${adv} 근거`,
    source: over.sources ? over.sources[i] : (['곽가', '법정', '가후'].includes(adv) ? 'rule' : 'ai'),
    rank_at_time: { rank: 'jongsa', weight: 1 },
    score_result: 'pending', rel_return: null, scored_at: null, disagreement: null,
    created_at: `${over.date || '2026-11-26'}T09:00:00+09:00`,
  }));
  if (over.synthesis !== false) {
    rows.push({
      id: `CV-S-${agendaId}-syn`, date: over.date || '2026-11-26', agenda_id: agendaId,
      ticker: '232140', name: '와이씨', agenda_type: 'entry', advisor: '제갈량',
      stance: over.synStance || '관망', confidence: 2, rationale: '가중 다수결: 관망 6',
      source: 'synthesis', rank_at_time: { rank: 'jongsa', weight: 1 },
      score_result: 'pending', rel_return: null, scored_at: null,
      disagreement: over.disagreement != null ? over.disagreement : 14.3,
      created_at: `${over.date || '2026-11-26'}T09:00:01+09:00`,
    });
  }
  council.appendLines(rows, { dataDir: dir });
}

async function boot(dir) {
  return web.start({ dataDir: dir, port: 0, today: '2026-11-26' });
}

// ===== 1·2·5. 의견판: 7인 표·종합·불일치율·가후 고정·폴백 표시 =====
test('시나리오1·2·5: 의견판 — 7인 표·종합 박스·불일치율·가후 고정 영역·폴백 표시', async () => {
  const dir = makeTmpDir();
  let srv;
  try {
    // 가후는 반대(종합 관망과 다름), 장송은 폴백
    seedAgenda(dir, 'AG-1', {
      stances: ['관망', '관망', '관망', '관망', '관망', '관망', '반대'],
      sources: ['rule', 'ai', 'ai', 'rule', 'ai', 'fallback', 'rule'],
    });
    srv = await boot(dir);
    const r = await request(srv.port, '/council');
    assert.equal(r.status, 200);
    for (const adv of ADVISORS) assert.ok(r.body.includes(adv), `${adv} 표에 존재`);
    assert.match(r.body, /제갈량|종합/, '종합 박스');
    assert.match(r.body, /14\.3/, '불일치율 수치');
    assert.match(r.body, /가후.*반대|반대.*가후/s, '가후 고정 영역(소수 의견)');
    assert.match(r.body, /폴백|fallback/i, '폴백 표시');
    assert.match(r.body, /종사|x1/, '기록 시점 관직 표시');
  } finally { if (srv) await srv.close(); rm(dir); }
});

// ===== 3·8. 공적판: 참고 수준 배지·ranks 결손 시 재계산 =====
test('시나리오3·8: 공적판 — 판정 10건 미만 참고 수준·ranks.json 없이 200', async () => {
  const dir = makeTmpDir();
  let srv;
  try {
    seedAgenda(dir, 'AG-1');
    // 채점 1건(판정 1건 — 10건 미만)
    council.appendLines([{ type: 'score', verdict_id: 'CV-S-AG-1-0', score_result: 'hit', rel_return: 1, scored_at: '2026-11-26' }], { dataDir: dir });
    assert.ok(!fs.existsSync(path.join(dir, 'council', 'ranks.json')), 'ranks 캐시 없음');
    srv = await boot(dir);
    const r = await request(srv.port, '/council/merit');
    assert.equal(r.status, 200, '결손에도 500 아님(장부 재계산)');
    assert.match(r.body, /참고 수준/, '표본 부족 배지');
    assert.match(r.body, /곽가/, '책사별 행');
  } finally { if (srv) await srv.close(); rm(dir); }
});

// ===== 4. 한목소리 경고 배너 =====
test('시나리오4: 최근 10안건 평균 불일치율 19% → 경고 배너', async () => {
  const dir = makeTmpDir();
  let srv;
  try {
    for (let i = 0; i < 10; i++) seedAgenda(dir, `AG-${i}`, { disagreement: 19, date: '2026-11-2' + (i % 6) });
    srv = await boot(dir);
    const r = await request(srv.port, '/council/merit');
    assert.match(r.body, /한목소리|경고/, '경고 배너');
  } finally { if (srv) await srv.close(); rm(dir); }
});

// ===== 6. 읽기 전용 =====
test('시나리오6: 쓰기·주문 액션 없음 — POST 405·form 0', async () => {
  const dir = makeTmpDir();
  let srv;
  try {
    seedAgenda(dir, 'AG-1');
    srv = await boot(dir);
    assert.equal((await request(srv.port, '/council', 'POST')).status, 405, 'POST 거부');
    for (const p of ['/council', '/council/merit']) {
      const r = await request(srv.port, p);
      assert.ok(!/<form|<button|user_confirmed|주문 실행/i.test(r.body), `${p} 쓰기 액션 0`);
    }
  } finally { if (srv) await srv.close(); rm(dir); }
});

// ===== 7. 빈 장부 =====
test('시나리오7: 빈 장부 — 안건 없음·채점된 판정 없음', async () => {
  const dir = makeTmpDir();
  let srv;
  try {
    srv = await boot(dir);
    assert.match((await request(srv.port, '/council')).body, /안건 없음/, '의견판 빈 상태');
    assert.match((await request(srv.port, '/council/merit')).body, /채점된 판정 없음/, '공적판 빈 상태');
  } finally { if (srv) await srv.close(); rm(dir); }
});

// ===== 에지: 의견 불충분·없는 안건 =====
test('에지: 유효 4건 미만 안건 — 의견 불충분 표시 / 없는 agenda_id 정상 빈 응답', async () => {
  const dir = makeTmpDir();
  let srv;
  try {
    seedAgenda(dir, 'AG-1', {
      sources: ['rule', 'fallback', 'fallback', 'rule', 'fallback', 'fallback', 'rule'],
      synthesis: false,
    });
    srv = await boot(dir);
    const r = await request(srv.port, '/council');
    assert.match(r.body, /의견 불충분/, '종합 대신 불충분 상태');
    const r2 = await request(srv.port, '/council?agenda=NOPE');
    assert.equal(r2.status, 200, '없는 안건 — 정상');
    assert.match(r2.body, /안건 없음/, '빈 응답');
  } finally { if (srv) await srv.close(); rm(dir); }
});
