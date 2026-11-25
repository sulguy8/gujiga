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

  const message = (opts && opts.message) || `state: update ${name}`;
  const committed = gitCommit(dataDir, file, message);

  return { file, committed };
}

// --- Git 커밋 전략 (군사 검토 반영) ---
//
// 운영 장부는 "데이터 폴더 자체의 로컬 전용 저장소"에만 커밋한다.
//   1) dataDir가 공유 저장소 gujiga 안이면        → 커밋 금지, 경고만(사고 방지).
//   2) dataDir가 자체 git 저장소면                → 거기에 커밋.
//   3) dataDir가 어떤 git 저장소도 아니면          → git init(원격 설정 금지) 후 커밋.
// 전역 git 설정에 의존하지 않도록 user.name/email을 -c로 주입한다.
//
// '원격 설정 금지' 예외(군주 결정, 2026-11-25 지령 005): 비공개 백업 원격 1개
// (GitHub sulguy8/gujiga-data, PRIVATE)에 한해 해제 — push는 src/backup.js가
// 이미 연결된 origin으로만 한다. 코드가 원격을 만들거나 바꾸는 것은 여전히 금지
// (원격 생성·연결은 사람이 수동 1회). 이 모듈(state.js)의 동작은 변경 없음.

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

// 주어진 디렉터리를 포함하는 git 저장소의 최상위 경로(없으면 null).
function topLevel(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// 이 코드가 들어있는 공유 저장소(gujiga)의 최상위 — 운영 장부가 여기 커밋되면 안 된다.
let _sharedRoot;
function sharedRoot() {
  if (_sharedRoot === undefined) _sharedRoot = topLevel(__dirname);
  return _sharedRoot;
}

function gitCommit(dataDir, file, message) {
  const dataTop = topLevel(dataDir);
  const shared = sharedRoot();

  // 1) dataDir가 공유 저장소 안(최상위가 gujiga) → 커밋하지 않고 경고.
  if (dataTop && samePath(dataTop, shared)) {
    console.warn(
      `[상태 커밋 생략] 데이터 폴더가 공유 저장소(${shared}) 안에 있어 커밋하지 않습니다 — ` +
      `운영 장부를 저장소 밖에 두세요(GUJIGA_DATA_DIR). 파일은 저장됨: ${path.resolve(file)}`
    );
    return false;
  }

  const base = ['-c', 'user.name=gujiga', '-c', 'user.email=gujiga@local'];
  const run = (args) => git(dataDir, [...base, ...args]);
  try {
    // 3) 자체 저장소가 아니면 로컬 전용으로 초기화(원격 설정 금지).
    if (!dataTop) {
      git(dataDir, ['init', '-q']);
    }
    // 2)/3) 자체(또는 방금 만든) 저장소에 커밋.
    run(['add', '--', path.resolve(file)]);
    run(['commit', '-q', '-m', message, '--', path.resolve(file)]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { read, write };
