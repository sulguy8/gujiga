'use strict';

// 지령 005 — gujiga-data 비공개 원격 백업 테스트
//
// 원격 정책(군주 결정, 2026-11-25): TSK-001의 '원격 설정 금지'는 비공개 백업 원격
// 1개(GitHub sulguy8/gujiga-data, PRIVATE)에 한해 해제됐다. 단 코드는 이미 연결된
// origin으로 push만 한다 — 원격을 만들거나 바꾸는 코드는 여전히 금지라서, 이 테스트도
// '사람이 미리 연결해 둔 origin'(로컬 bare 저장소로 대역)만 쓴다. 실제 GitHub 호출 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const backup = require('../src/backup');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-backup-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function initRepo(dir) {
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@local']);
}
function backupRows(dir) {
  const d = paths.ledgerDir(dir, 'backup_log');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}

test('git 저장소가 아니면 건너뜀(기록만) — 장부 영향 0', () => {
  const dir = makeTmpDir();
  try {
    const r = backup.runBackup({ dataDir: dir });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'no_repo');
    const rows = backupRows(dir);
    assert.equal(rows.length, 1, '기록만 남는다');
  } finally {
    rm(dir);
  }
});

test('원격이 없으면 커밋만 하고 조용히 건너뜀(no_remote 기록)', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const r = backup.runBackup({ dataDir: dir });
    assert.equal(r.committed, true, '변경분 커밋');
    assert.equal(r.pushed, false);
    assert.equal(r.reason, 'no_remote');
    assert.match(git(dir, ['log', '--oneline', '-1']), /backup/);
  } finally {
    rm(dir);
  }
});

test('origin(사람이 연결한 비공개 원격 대역)이 있으면 push — 실패해도 던지지 않음', () => {
  const dir = makeTmpDir();
  const bare = makeTmpDir();
  try {
    git(bare, ['init', '--bare']);
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'ledger.txt'), 'row');
    git(dir, ['remote', 'add', 'origin', bare]); // 테스트 준비 행위 — 제품 코드는 원격을 만들지 않는다
    const r = backup.runBackup({ dataDir: dir });
    assert.equal(r.committed, true);
    assert.equal(r.pushed, true, 'origin으로 push');
    assert.ok(git(bare, ['log', '--oneline', '-1']).includes('backup'), '원격에 도달');
    // 변경 없음 재실행 — 커밋 없이 push만 시도(멱등)
    const r2 = backup.runBackup({ dataDir: dir });
    assert.equal(r2.pushed, true);
  } finally {
    rm(dir); rm(bare);
  }
});

test('제품 코드는 원격을 만들거나 바꾸지 않는다(정규식 경계)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'backup.js'), 'utf8');
  assert.ok(!/remote['"]?\s*,\s*['"](add|set-url|remove)/.test(src), 'git remote add/set-url/remove 호출 0');
  assert.ok(!src.includes('repo create'), 'gh repo create 호출 0');
});
