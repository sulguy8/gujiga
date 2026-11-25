'use strict';

// TST-006 — 정시 엔진(캘린더·실행 기록·미실행 감지)·08:31 브리핑 자동 테스트
// 상위: TSK-007 / ARC-004 / REQ-005 / DAT-004·DAT-005 / SCR-002
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 군사 지시 반영:
//  1) 데이터 공급자(계좌·시세·관심종목)는 인터페이스 주입 — 여기서는 가짜 공급자만 사용(증권사 API·키 0).
//  3) 미실행은 '기록만' — 어제 15:05 회차가 다음 날 아침에 돌면 안 된다(사고 재현 테스트 포함).
//  4) 산출물은 dataDir(gujiga-data 구조) 아래만 — Aside trading 폴더 접근 없음.
// 시각은 전부 주입(now) — 실관찰 2일(거래일·휴장일)은 군주 수동 확인 몫.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schedule = require('../src/schedule');
const calendar = require('../src/market_calendar');
const paths = require('../src/paths');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst006-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function rows(dir, name) {
  const d = paths.ledgerDir(dir, name);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}
function briefingPath(dir, date) {
  return path.join(dir, 'briefings', `${date}.md`);
}

// 가짜 공급자(지시1): 실제 증권사 연결 없음.
function fakeProviders(overrides) {
  return Object.assign(
    {
      watchlist: () => [
        { id: 'w1', symbol: '005930', name: '삼성전자', status: 'ready', entry_low: 61000, entry_high: 62000, stop_price: 59000, target_price: 66000, deadline: '2026-12-05' },
        { id: 'w2', symbol: '000660', name: 'SK하이닉스', status: 'observing', stop_price: null, target_price: null },
      ],
      quote: (symbol) => ({ symbol, prevClose: symbol === '005930' ? 61500 : 450000 }),
      accountSnapshot: (accountType) => ({ account_type: accountType, start_total_eval: 787000, start_cash: 300000 }),
    },
    overrides || {}
  );
}

function opts(dir, now, extra) {
  return Object.assign({ dataDir: dir, now, providers: fakeProviders() }, extra || {});
}

// 2026-11-25(수) = 거래일, 2026-11-28(토) = 휴장, 2026-11-23(월) = 거래일(월요일)

// ===== 캘린더 =====
test('캘린더: 주말·공휴일은 휴장, 평일은 거래일', () => {
  assert.equal(calendar.isTradingDay('2026-11-25'), true, '수요일 거래일');
  assert.equal(calendar.isTradingDay('2026-11-28'), false, '토요일 휴장');
  assert.equal(calendar.isTradingDay('2026-11-29'), false, '일요일 휴장');
  assert.equal(calendar.isTradingDay('2026-12-25'), false, '성탄절 휴장(캘린더 파일)');
  assert.equal(calendar.isTradingDay('2026-01-01'), false, '신정 휴장');
});

test('캘린더: 임시 공휴일(예외일)·개장시간 변경일을 캘린더 파일로 처리', () => {
  const dir = makeTmpDir();
  try {
    // 테스트용 캘린더: 임시 공휴일 1일 + 개장 지연일(수능 모사) 1일
    const calPath = path.join(dir, 'cal.json');
    fs.writeFileSync(calPath, JSON.stringify({
      holidays: { '2026-11-26': '임시 공휴일(테스트)' },
      special_open: { '2026-11-27': '10:00' },
      default_open: '09:00',
    }), 'utf8');
    assert.equal(calendar.isTradingDay('2026-11-26', { calendarPath: calPath }), false, '임시 공휴일 휴장');
    assert.equal(calendar.openTime('2026-11-27', { calendarPath: calPath }), '10:00', '개장시간 변경일');
    assert.equal(calendar.openTime('2026-11-25', { calendarPath: calPath }), '09:00', '평일 기본 개장');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 1: 거래일 08:31 기동 → 08:30 스냅샷 + 08:31 브리핑 생성 =====
test('시나리오1: 거래일 08:31 기동 시 스냅샷·브리핑 생성', () => {
  const dir = makeTmpDir();
  try {
    const res = schedule.runOnce(opts(dir, '2026-11-25T08:31:30+09:00'));
    assert.ok(res.ran.includes('snapshot_0830'), '스냅샷 실행');
    assert.ok(res.ran.includes('briefing_0831'), '브리핑 실행');

    // DAT-004 스냅샷 기록(계좌별)
    const snaps = rows(dir, 'daily_account_snapshot').filter((r) => r.snapshot_date === '2026-11-25');
    assert.ok(snaps.length >= 1, '스냅샷 1건 이상');
    assert.equal(snaps[0].start_total_eval, 787000);

    // 브리핑 파일(dataDir 아래 — Aside와 분리)
    const bp = briefingPath(dir, '2026-11-25');
    assert.ok(fs.existsSync(bp), '브리핑 파일 생성');
    assert.ok(path.resolve(bp).startsWith(path.resolve(dir)), '산출물은 dataDir 아래(지시4)');

    // 실행 기록
    const log = rows(dir, 'job_log');
    assert.ok(log.some((r) => r.job === 'briefing_0831' && r.date === '2026-11-25' && r.status === 'run'));
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 2: 브리핑 3요소 포함 =====
test('시나리오2: 브리핑에 관심 종목·전일 결과·오늘 규칙 3요소 포함', () => {
  const dir = makeTmpDir();
  try {
    schedule.runOnce(opts(dir, '2026-11-25T08:31:30+09:00'));
    const md = fs.readFileSync(briefingPath(dir, '2026-11-25'), 'utf8');
    // ① 관심 종목 상태(전일 종가·성벽/목표 거리)
    assert.match(md, /관심 종목/);
    assert.match(md, /삼성전자/);
    assert.match(md, /61,?500/, '전일 종가 표시');
    // ② 전일 결과
    assert.match(md, /전일 결과|전황/);
    // ③ 오늘 규칙 숫자
    assert.match(md, /오늘의 군령|오늘 규칙/);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 3: 휴장일 → 브리핑 미생성 =====
test('시나리오3: 휴장일(토)에는 브리핑이 생성되지 않는다', () => {
  const dir = makeTmpDir();
  try {
    const res = schedule.runOnce(opts(dir, '2026-11-28T08:31:30+09:00'));
    assert.equal(res.ran.length, 0, '휴장일 실행 0건');
    assert.ok(!fs.existsSync(briefingPath(dir, '2026-11-28')), '브리핑 없음');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 4: 시세 1종목 조회 실패 → 해당 칸만 "조회 실패", 브리핑은 생성 =====
test('시나리오4: 일부 시세 실패 시 해당 칸만 조회 실패 표시', () => {
  const dir = makeTmpDir();
  try {
    const providers = fakeProviders({
      quote: (symbol) => {
        if (symbol === '000660') throw new Error('시세 응답 없음');
        return { symbol, prevClose: 61500 };
      },
    });
    schedule.runOnce(opts(dir, '2026-11-25T08:31:30+09:00', { providers }));
    const md = fs.readFileSync(briefingPath(dir, '2026-11-25'), 'utf8');
    assert.match(md, /SK하이닉스.*조회 실패/, '실패 종목 칸에 조회 실패');
    assert.match(md, /삼성전자.*61,?500/, '정상 종목은 그대로');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 4b: 계좌 스냅샷 공급 실패 → 브리핑은 생성, 해당 칸 조회 실패 =====
test('시나리오4b: 계좌 조회 실패에도 브리핑은 생성된다', () => {
  const dir = makeTmpDir();
  try {
    const providers = fakeProviders({ accountSnapshot: () => { throw new Error('계좌 연결 실패'); } });
    const res = schedule.runOnce(opts(dir, '2026-11-25T08:31:30+09:00', { providers }));
    assert.ok(res.ran.includes('briefing_0831'));
    const md = fs.readFileSync(briefingPath(dir, '2026-11-25'), 'utf8');
    assert.match(md, /조회 실패/);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 5: 월요일 → 논공행상 섹션 포함 =====
test('시나리오5: 월요일 브리핑에 논공행상 섹션이 포함된다', () => {
  const dir = makeTmpDir();
  try {
    schedule.runOnce(opts(dir, '2026-11-23T08:31:30+09:00'));
    const md = fs.readFileSync(briefingPath(dir, '2026-11-23'), 'utf8');
    assert.match(md, /논공행상/, '월요일 논공행상 섹션');
    // 수요일엔 없음
    const dir2 = makeTmpDir();
    try {
      schedule.runOnce(opts(dir2, '2026-11-25T08:31:30+09:00'));
      const md2 = fs.readFileSync(briefingPath(dir2, '2026-11-25'), 'utf8');
      assert.ok(!/논공행상/.test(md2), '평일(월요일 아님)엔 섹션 없음');
    } finally {
      rm(dir2);
    }
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 6: 같은 날 2회 기동 → 브리핑 2중 생성 0 (RISK-004) =====
test('시나리오6: 같은 날 2회 기동해도 브리핑은 1회만 생성', () => {
  const dir = makeTmpDir();
  try {
    schedule.runOnce(opts(dir, '2026-11-25T08:31:30+09:00'));
    const first = fs.readFileSync(briefingPath(dir, '2026-11-25'), 'utf8');
    const res2 = schedule.runOnce(opts(dir, '2026-11-25T08:40:00+09:00'));
    assert.ok(!res2.ran.includes('briefing_0831'), '2회차는 실행 안 함');
    const second = fs.readFileSync(briefingPath(dir, '2026-11-25'), 'utf8');
    assert.equal(second, first, '파일 내용 불변(덮어쓰기 없음)');
    const runs = rows(dir, 'job_log').filter((r) => r.job === 'briefing_0831' && r.date === '2026-11-25' && (r.status === 'run' || r.status === 'late'));
    assert.equal(runs.length, 1, '실행 기록 1건');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 7 + 지시3 사고 재현: 어제 회차는 다음 날 실행 금지, 미실행 기록만 =====
test('시나리오7: 어제 15:05 회차가 다음 날 08:18에 실행되지 않고 미실행 기록만 남는다', () => {
  const dir = makeTmpDir();
  try {
    // 전제: 2026-11-24(화·거래일)에 엔진이 한 번도 돌지 않았다(PC 꺼짐).
    // 다음 날 08:18 기동.
    const res = schedule.runOnce(opts(dir, '2026-11-25T08:18:00+09:00'));

    // 오늘 회차는 아직 시각 전(08:18 < 08:30) → 실행 0
    assert.equal(res.ran.length, 0, '08:18에는 아무 작업도 실행하지 않는다');

    // 어제(2026-11-24) 회차들은 '미실행'으로 기록만
    const missed = rows(dir, 'job_log').filter((r) => r.status === 'missed' && r.date === '2026-11-24');
    const missedJobs = missed.map((r) => r.job);
    assert.ok(missedJobs.includes('preclose_1505'), '어제 15:05 미실행 기록');
    assert.ok(missedJobs.includes('briefing_0831'), '어제 브리핑 미실행 기록');

    // 사고 재현 핵심: 어제 15:05 작업이 '실행'되지 않았다
    const yesterdayRuns = rows(dir, 'job_log').filter((r) => r.date === '2026-11-24' && (r.status === 'run' || r.status === 'late'));
    assert.equal(yesterdayRuns.length, 0, '어제 회차 자동 따라잡기 실행 0건');
    assert.ok(!fs.existsSync(briefingPath(dir, '2026-11-24')), '어제 브리핑을 늦게 만들지 않는다');

    // 멱등: 다시 기동해도 미실행 기록이 중복되지 않는다
    schedule.runOnce(opts(dir, '2026-11-25T08:20:00+09:00'));
    const missed2 = rows(dir, 'job_log').filter((r) => r.status === 'missed' && r.date === '2026-11-24' && r.job === 'preclose_1505');
    assert.equal(missed2.length, 1, '미실행 기록 멱등');
  } finally {
    rm(dir);
  }
});

// ===== 에지: 08:29 기동 → 실행 0 / 09:00 기동 → 지각 1회 생성 + "지연" 표시 =====
test('에지: 08:29는 실행 전, 09:00 지각 기동은 1회 생성 + 지연 표시', () => {
  const dir = makeTmpDir();
  try {
    const r1 = schedule.runOnce(opts(dir, '2026-11-25T08:29:00+09:00'));
    assert.equal(r1.ran.length, 0, '08:29 실행 0');

    const r2 = schedule.runOnce(opts(dir, '2026-11-25T09:00:00+09:00'));
    assert.ok(r2.ran.includes('briefing_0831'), '지각이어도 당일은 1회 생성(보고성)');
    const md = fs.readFileSync(briefingPath(dir, '2026-11-25'), 'utf8');
    assert.match(md, /지연/, '지연 표시');
    const log = rows(dir, 'job_log').filter((r) => r.job === 'briefing_0831' && r.date === '2026-11-25');
    assert.equal(log.filter((r) => r.status === 'late').length, 1, 'late 기록');

    // 재기동 시 중복 생성 없음
    const r3 = schedule.runOnce(opts(dir, '2026-11-25T09:10:00+09:00'));
    assert.ok(!r3.ran.includes('briefing_0831'));
  } finally {
    rm(dir);
  }
});

// ===== 캘린더 파일 자체 검증: 2026~2027 초안 + 군주 확인 필요 표시 =====
test('캘린더 파일: 2026~2027 초안과 군주 확인 필요 표시가 있다', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'market_calendar.json'), 'utf8'));
  assert.ok(raw.holidays['2026-01-01'], '신정 2026');
  assert.ok(raw.holidays['2026-12-25'], '성탄절 2026');
  assert.ok(raw.holidays['2027-01-01'], '신정 2027');
  assert.match(JSON.stringify(raw), /군주 확인 필요/, '군주 확인 필요 표시');
});
