'use strict';

// TST-001 — 원장 유틸(append-only)·상태 유틸·정합성 검사 자동 테스트
// 상위: TSK-001 / DAT-001·DAT-002 / ARC-002
// 실행: node --test  (Node 내장 test runner, 외부 패키지 0)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ledger = require('../src/ledger');
const state = require('../src/state');
const integrity = require('../src/integrity');
const paths = require('../src/paths');

// --- 테스트용 임시 데이터 디렉터리(실데이터와 분리) ---
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst001-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// DAT-002 예시 1행(차단된 주문)
function dat002Example() {
  return {
    id: '01JD8YR3M1', draft_id: '01JD8XQ2K9',
    account_type: 'real', nation: null,
    symbol: '005930', side: 'buy', order_type: 'limit',
    price: 61500, qty: 3, amount: 184500,
    status: 'blocked', block_reason: 'no_confirm',
    broker_order_no: null, filled_at: null,
    created_at: '2026-11-24T09:12:05+09:00',
  };
}

// --- 시나리오 1: DAT-002 예시 1행 append → jsonl 끝에 1행 추가 ---
test('시나리오1: DAT-002 예시 1행 append → jsonl 1행 추가', () => {
  const dir = makeTmpDir();
  try {
    const rec = dat002Example();
    const file = ledger.append('order_log', rec, { dataDir: dir });

    assert.ok(fs.existsSync(file), '원장 파일이 생성되어야 한다');
    // 월별 분할: created_at(2026-11) 기준 파일명
    assert.equal(path.basename(file), '2026-11.jsonl');

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, '1행만 있어야 한다');
    assert.deepEqual(JSON.parse(lines[0]), rec, '쓴 레코드가 그대로 보존되어야 한다');
  } finally {
    rm(dir);
  }
});

// --- 시나리오 2: 같은 파일에 2번째 append → 2행째로 이어 붙음(덮어쓰기 없음) ---
test('시나리오2: 2번째 append → 2행째로 append(기존 행 불변)', () => {
  const dir = makeTmpDir();
  try {
    const rec1 = dat002Example();
    const rec2 = Object.assign(dat002Example(), { id: '01JD8YR3M2', status: 'submitted', block_reason: null });

    const file = ledger.append('order_log', rec1, { dataDir: dir });
    ledger.append('order_log', rec2, { dataDir: dir });

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2, '2행이어야 한다');
    assert.deepEqual(JSON.parse(lines[0]), rec1, '1행째(기존)는 불변이어야 한다');
    assert.deepEqual(JSON.parse(lines[1]), rec2, '2행째가 이어 붙어야 한다');
  } finally {
    rm(dir);
  }
});

// --- 시나리오 3: 공개 API 목록 검사 → 수정·삭제 함수 미존재(append만 노출) ---
test('시나리오3: 원장 유틸 공개 API = append만 노출', () => {
  const keys = Object.keys(ledger);
  assert.deepEqual(keys.sort(), ['append'], '원장 모듈은 append만 노출해야 한다');

  const forbidden = /update|modify|edit|delete|remove|rewrite|overwrite|truncate|unlink|patch/i;
  for (const k of keys) {
    assert.ok(!forbidden.test(k), `수정·삭제류 API가 없어야 한다: ${k}`);
  }
  assert.equal(typeof ledger.append, 'function', 'append는 함수여야 한다');
});

// --- 시나리오 4: 상태 파일 write 후 read → 쓴 값 그대로 반환 + Git 커밋 생성 ---
test('시나리오4: state.write → read 동일 + Git 커밋 생성', () => {
  const dir = makeTmpDir();
  try {
    // 임시 git 저장소 초기화(전역 설정에 의존하지 않도록 로컬 user 설정)
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'tst@gujiga.local'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'tst'], { cwd: dir });

    const countCommits = () => {
      try {
        return execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir }).toString().trim();
      } catch { return '0'; }
    };
    const before = Number(countCommits());

    const value = { nation: 'chok', cash: 1000000, positions: 2 };
    state.write('nation_ledger', value, { dataDir: dir, gitRoot: dir });

    const readBack = state.read('nation_ledger', { dataDir: dir });
    assert.deepEqual(readBack, value, '쓴 값이 그대로 반환되어야 한다');

    const after = Number(countCommits());
    assert.equal(after, before + 1, 'write마다 Git 커밋이 1개 생성되어야 한다');
  } finally {
    rm(dir);
  }
});

// --- 시나리오 5: 상태 파일을 어긋난 값으로 수정 후 정합성 검사 → 어긋남 감지·경고 출력 ---
test('시나리오5: 정합성 검사가 어긋난 상태를 감지·경고', () => {
  const dir = makeTmpDir();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'tst@gujiga.local'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'tst'], { cwd: dir });

    // 원장(추가 전용): 포로 delta 이벤트 2건 = 합계 5
    ledger.append('captive_ledger', { id: 'c1', delta: 3, created_at: '2026-11-24T10:00:00+09:00' }, { dataDir: dir });
    ledger.append('captive_ledger', { id: 'c2', delta: 2, created_at: '2026-11-24T11:00:00+09:00' }, { dataDir: dir });

    // 정합성 대조 규칙: captive_ledger의 delta 합계 == captive_state.total
    const recon = [{ ledger: 'captive_ledger', field: 'delta', state: 'captive_state', stateField: 'total' }];

    // 정상 상태 → 경고 없음
    state.write('captive_state', { total: 5 }, { dataDir: dir, gitRoot: dir });
    let ok = integrity.check({ dataDir: dir, reconciliations: recon });
    assert.equal(ok.ok, true, '정상 상태에서는 경고가 없어야 한다');
    assert.equal(ok.warnings.length, 0);

    // 일부러 어긋남: total을 99로 수정
    state.write('captive_state', { total: 99 }, { dataDir: dir, gitRoot: dir });

    // 경고 출력 캡처
    const printed = [];
    const orig = console.warn;
    console.warn = (...a) => printed.push(a.join(' '));
    let bad;
    try {
      bad = integrity.check({ dataDir: dir, reconciliations: recon });
    } finally {
      console.warn = orig;
    }

    assert.equal(bad.ok, false, '어긋남을 감지해야 한다');
    assert.equal(bad.warnings.length, 1, '경고가 1건이어야 한다');
    assert.match(bad.warnings[0], /captive_state/);
    assert.ok(printed.some((l) => /captive_state/.test(l)), '경고가 출력(console.warn)되어야 한다');
  } finally {
    rm(dir);
  }
});

// --- 에지: 파일이 없을 때 append(생성 후 기록) / 빈 디렉터리 첫 append ---
test('에지: 파일/디렉터리 없을 때 첫 append가 생성 후 기록', () => {
  const dir = makeTmpDir();
  try {
    const sub = path.join(dir, 'nonexistent', 'nested'); // 아직 없는 경로
    const rec = { id: 'v1', kind: 'order_limit', created_at: '2026-11-24T09:00:00+09:00' };
    const file = ledger.append('violation', rec, { dataDir: sub });
    assert.ok(fs.existsSync(file), '중첩 경로까지 생성하며 기록해야 한다');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), rec);
  } finally {
    rm(dir);
  }
});

// --- 에지: 개행 포함 입력도 jsonl 1행 불변식 유지(이스케이프) ---
test('에지: 개행 포함 값도 jsonl 1행으로 유지(이스케이프)', () => {
  const dir = makeTmpDir();
  try {
    const rec = { id: 'n1', note: '첫째 줄\n둘째 줄\r복귀', created_at: '2026-11-24T12:00:00+09:00' };
    const file = ledger.append('violation', rec, { dataDir: dir });

    const raw = fs.readFileSync(file, 'utf8');
    // 레코드를 표현하는 물리 라인은 정확히 1줄이어야 한다(끝 개행 1개 제외)
    assert.equal(raw.split('\n').filter(Boolean).length, 1, '물리 라인은 1줄이어야 한다');
    // 그 1줄을 파싱하면 원본 개행이 복원된다
    const parsed = JSON.parse(raw.trim());
    assert.deepEqual(parsed, rec, '개행이 이스케이프되어 값이 보존되어야 한다');
    assert.ok(parsed.note.includes('\n'), '파싱 후 개행이 복원되어야 한다');
  } finally {
    rm(dir);
  }
});

// --- AC4(보조): 외부 의존 0 — src가 Node 내장 모듈만 require 하는지 ---
test('AC4: 소스가 Node 내장 모듈만 사용(외부 패키지 0)', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const builtins = new Set(require('node:module').builtinModules.flatMap((m) => [m, `node:${m}`]));
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const f of files) {
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    let m;
    while ((m = reqRe.exec(src))) {
      const mod = m[1];
      if (mod.startsWith('.') || mod.startsWith('/')) continue; // 내부 상대 경로 허용
      assert.ok(builtins.has(mod), `외부 패키지 금지: ${f} → ${mod}`);
    }
  }
});

// =========================================================================
// 군사 검토 보완(TSK-001): 데이터 폴더를 공유 저장소 밖으로 분리
// =========================================================================

// gujiga 공유 저장소 최상위 경로
function gujigaRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname }).toString().trim();
}
function commitCount(repo) {
  try {
    return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo }).toString().trim());
  } catch { return 0; }
}

// 보완1: resolveDataDir 기본값이 저장소 밖(홈\gujiga-data) ---
test('보완1: 기본 데이터 폴더는 홈\\gujiga-data (저장소 밖)', () => {
  const saved = process.env.GUJIGA_DATA_DIR;
  delete process.env.GUJIGA_DATA_DIR;
  try {
    const def = paths.resolveDataDir();
    assert.equal(def, path.join(os.homedir(), 'gujiga-data'), '기본값은 홈\\gujiga-data여야 한다');

    // 공유 저장소 밖이어야 한다
    const root = path.resolve(gujigaRoot());
    assert.ok(!path.resolve(def).toLowerCase().startsWith(root.toLowerCase()), '기본 폴더가 저장소 안이면 안 된다');

    // 우선순위 유지: opts > env > 기본
    assert.equal(paths.resolveDataDir({ dataDir: 'X:/explicit' }), 'X:/explicit', 'opts가 최우선');
    process.env.GUJIGA_DATA_DIR = 'Y:/env';
    assert.equal(paths.resolveDataDir(), 'Y:/env', 'env가 기본보다 우선');
  } finally {
    if (saved === undefined) delete process.env.GUJIGA_DATA_DIR;
    else process.env.GUJIGA_DATA_DIR = saved;
  }
});

// 보완2a: git 저장소가 아닌 데이터 폴더 → git init(원격 없음) 후 커밋 ---
test('보완2a: git 아닌 데이터 폴더는 로컬 전용으로 init 후 커밋', () => {
  const dir = makeTmpDir(); // git 저장소 아님
  try {
    const res = state.write('watchlist', { items: ['005930'] }, { dataDir: dir });
    assert.equal(res.committed, true, '커밋되어야 한다');

    // 자체 git 저장소가 되었고 커밋 1개
    assert.ok(fs.existsSync(path.join(dir, '.git')), 'git init 되어야 한다');
    assert.equal(commitCount(dir), 1, '커밋 1개여야 한다');

    // 원격 설정 금지
    const remotes = execFileSync('git', ['remote'], { cwd: dir }).toString().trim();
    assert.equal(remotes, '', '원격이 없어야 한다(로컬 전용)');

    // 값 보존
    assert.deepEqual(state.read('watchlist', { dataDir: dir }), { items: ['005930'] });
  } finally {
    rm(dir);
  }
});

// 보완2b: 데이터 폴더가 공유 저장소 gujiga 안이면 커밋 금지·경고 + gujiga 커밋 불변 ---
test('보완2b: 공유 저장소 안 데이터는 커밋 안 하고 경고(gujiga 커밋 불변)', () => {
  const root = gujigaRoot();
  const sub = path.join(root, `.tmp-tst001-data-${process.pid}`); // 저장소 안의 임시 데이터 폴더
  const before = commitCount(root);
  const printed = [];
  const orig = console.warn;
  console.warn = (...a) => printed.push(a.join(' '));
  try {
    const res = state.write('nation_ledger', { cash: 1 }, { dataDir: sub });
    assert.equal(res.committed, false, '공유 저장소 안에서는 커밋하면 안 된다');
    assert.ok(printed.some((l) => /커밋 생략|공유 저장소/.test(l)), '경고가 출력되어야 한다');

    // 핵심: gujiga 저장소에 새 커밋이 생기지 않아야 한다
    assert.equal(commitCount(root), before, 'gujiga 저장소 커밋 수가 변하면 안 된다');
  } finally {
    console.warn = orig;
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

// 보완3: .gitignore에 data/ 가 포함되어 있다 ---
test('보완3: .gitignore에 data/ 포함', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(gi, /^data\/$/m, '.gitignore에 data/ 가 있어야 한다');
});

// paths 헬퍼가 일관된 레이아웃을 주는지(보조)
test('보조: paths 레이아웃 규칙', () => {
  const dir = '/tmp/x';
  assert.equal(
    paths.ledgerFile(dir, 'order_log', '2026-11'),
    path.join(dir, 'ledger', 'order_log', '2026-11.jsonl')
  );
  assert.equal(
    paths.stateFile(dir, 'nation_ledger'),
    path.join(dir, 'state', 'nation_ledger.json')
  );
});
