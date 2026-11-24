'use strict';

// 상태 유틸 — 덮어쓰기 + Git 커밋 (ARC-002)
//
// 상태류(guard_config·nation_ledger·general_rank·watchlist 등)는 "현재 값"이라
// 덮어쓰기로 저장하되, 변경 이력은 Git 커밋으로 남긴다. 원장(append-only)과 달리
// 수정이 허용되지만, 모든 수정은 커밋으로 추적된다.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('./paths');

// name  : 상태 이름(확장자 없이)
// opts  : { dataDir }
// 반환  : 파싱된 객체 / 파일이 없으면 null
function read(name, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const file = paths.stateFile(dataDir, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// name  : 상태 이름
// value : 저장할 객체
// opts  : { dataDir, gitRoot, message } — gitRoot 미지정 시 dataDir를 사용
// 반환  : { file, committed }
function write(name, value, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const file = paths.stateFile(dataDir, name);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 사람이 읽을 수 있도록 들여쓰기 + 끝 개행.
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');

  const gitRoot = (opts && opts.gitRoot) || dataDir;
  const message = (opts && opts.message) || `state: update ${name}`;
  const committed = gitCommit(gitRoot, file, message);

  return { file, committed };
}

// 상태 파일 1개를 스테이징하고 커밋한다.
// 전역 git 설정에 의존하지 않도록 user.name/email을 -c로 주입한다.
// git 저장소가 아니거나 변경이 없으면 조용히 false를 반환한다(상태 저장 자체는 성공).
function gitCommit(gitRoot, file, message) {
  const base = ['-c', 'user.name=gujiga', '-c', 'user.email=gujiga@local'];
  const run = (args) => execFileSync('git', [...base, ...args], { cwd: gitRoot, stdio: 'pipe' });
  try {
    run(['add', '--', path.resolve(file)]);
    // 변경이 없으면 커밋하지 않는다(--allow-empty를 쓰지 않음).
    run(['commit', '-q', '-m', message, '--', path.resolve(file)]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { read, write };
