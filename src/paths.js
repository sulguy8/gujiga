'use strict';

// 데이터 저장소 레이아웃 (ARC-002: 파일(md·jsonl)+Git)
//  <dataDir>/
//    ledger/<name>/<YYYY-MM>.jsonl   ← 원장(추가 전용, 월별 분할)
//    state/<name>.json               ← 상태(덮어쓰기, 변경은 Git 커밋)
//
// 모든 경로는 한 곳에서만 계산한다 — 저장 구조가 바뀌면 여기만 고친다.

const path = require('node:path');
const os = require('node:os');

// 데이터 디렉터리 결정: 명시 opts > 환경변수 > 기본(홈\gujiga-data)
//
// 기본값을 '저장소 밖'(홈 디렉터리)으로 둔다 — 운영 장부가 공유 저장소 gujiga에
// 섞여 커밋되는 사고를 구조적으로 막기 위함(군사 검토 반영). 윈도우에서는
// os.homedir()가 %USERPROFILE%(예: C:\Users\...\gujiga-data)를 가리킨다.
function resolveDataDir(opts) {
  if (opts && opts.dataDir) return opts.dataDir;
  if (process.env.GUJIGA_DATA_DIR) return process.env.GUJIGA_DATA_DIR;
  return path.join(os.homedir(), 'gujiga-data');
}

// 월 키(YYYY-MM): created_at(ISO) 우선, 없으면 주어진 now, 그마저 없으면 현재 시각
function monthKey(record, now) {
  const src = (record && record.created_at) || now;
  const d = src ? new Date(src) : new Date();
  if (Number.isNaN(d.getTime())) {
    throw new Error(`월 분할 키를 만들 수 없는 created_at: ${String(src)}`);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function ledgerDir(dataDir, name) {
  return path.join(dataDir, 'ledger', name);
}

function ledgerFile(dataDir, name, month) {
  return path.join(ledgerDir(dataDir, name), `${month}.jsonl`);
}

function stateDir(dataDir) {
  return path.join(dataDir, 'state');
}

function stateFile(dataDir, name) {
  return path.join(stateDir(dataDir), `${name}.json`);
}

module.exports = {
  resolveDataDir,
  monthKey,
  ledgerDir,
  ledgerFile,
  stateDir,
  stateFile,
};
