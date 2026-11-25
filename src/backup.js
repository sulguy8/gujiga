'use strict';

// gujiga-data 비공개 원격 백업 (지령 005 / ARC-002 보강)
//
// 군주 결정(2026-11-25): TSK-001의 '원격 설정 금지'는 비공개 백업 원격 1개
// (GitHub sulguy8/gujiga-data, PRIVATE)에 한해 해제됐다. 단 이 모듈은 이미
// 연결된 origin으로 push만 한다 — 원격을 만들거나 바꾸는 코드는 여전히 금지
// (원격 생성·연결은 군주/장수가 수동으로 1회).
//
// 동작: 변경분 커밋 → origin 있으면 push. 어떤 실패도 장부에 영향 없음 — 기록만.
// 비밀은 gujiga-data/.gitignore(secrets/·*.enc·*.token·*.lock·tmp/)가 막는다.

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ledger = require('./ledger');
const paths = require('./paths');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// 백업 1회. 반환: { committed, pushed, skipped, reason } — 절대 던지지 않는다.
function runBackup(opts) {
  opts = opts || {};
  const dir = paths.resolveDataDir(opts);
  const out = { committed: false, pushed: false, skipped: false, reason: null };
  try {
    git(dir, ['rev-parse', '--git-dir']);
  } catch (e) {
    out.skipped = true;
    out.reason = 'no_repo';
    record(out, opts);
    return out;
  }
  try {
    const status = git(dir, ['status', '--porcelain']);
    if (status) {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-m', 'backup: 장부·상태 변경분 백업(자동, 15:50 회차)']);
      out.committed = true;
    }
  } catch (e) {
    out.reason = 'commit_failed';
    record(out, opts);
    return out;
  }
  let hasOrigin = false;
  try {
    hasOrigin = git(dir, ['remote']).split('\n').includes('origin');
  } catch (e) { /* 기록만 */ }
  if (!hasOrigin) {
    // 원격이 없으면 조용히 건너뜀(기록만) — 지령 005
    out.skipped = true;
    out.reason = 'no_remote';
    record(out, opts);
    return out;
  }
  try {
    git(dir, ['push', 'origin', 'HEAD']);
    out.pushed = true;
  } catch (e) {
    out.reason = 'push_failed';
  }
  record(out, opts);
  return out;
}

function record(out, opts) {
  try {
    ledger.append('backup_log', Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, out), opts);
  } catch (e) { /* 백업 기록 실패도 본 장부에 영향 주지 않는다 */ }
}

module.exports = { runBackup };
