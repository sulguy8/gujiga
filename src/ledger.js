'use strict';

// 원장 유틸 — append-only(추가 전용)
//
// 불변식(ARC-002 / DAT-002): 원장은 "추가만" 한다. 수정·삭제 API는
// 아예 존재하지 않는다(감사 추적을 깨지 않기 위함). 이 모듈은 append 하나만
// 노출하며, 읽기/집계는 정합성 검사 쪽(integrity)에서 fs로 직접 수행한다.
//
// 저장 형식: jsonl — 1행 = 1이벤트. 월별 파일로 분할한다.
//   <dataDir>/ledger/<name>/<YYYY-MM>.jsonl

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

// name  : 원장 이름(order_log·violation·rule_change·captive_ledger)
// record: 기록할 이벤트 객체(1행이 됨)
// opts  : { dataDir, now } — now는 record.created_at이 없을 때의 월 분할 기준
// 반환  : 기록된 파일의 절대경로
function append(name, record, opts) {
  if (!name || typeof name !== 'string') {
    throw new Error('원장 이름(name)이 필요합니다.');
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('기록 대상(record)은 객체여야 합니다.');
  }

  const dataDir = paths.resolveDataDir(opts);
  const month = paths.monthKey(record, opts && opts.now);
  const file = paths.ledgerFile(dataDir, name, month);

  // 디렉터리가 없으면 생성(파일 없을 때 첫 append = 생성 후 기록).
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // JSON.stringify는 문자열 값 안의 개행(\n·\r)을 이스케이프하므로
  // 입력에 개행이 있어도 물리적으로 1행이 유지된다(jsonl 불변식).
  const line = JSON.stringify(record) + '\n';

  // appendFileSync: 기존 내용을 건드리지 않고 끝에만 덧붙인다(덮어쓰기 없음).
  fs.appendFileSync(file, line, 'utf8');

  return file;
}

// 의도적으로 append만 노출한다 — 수정·삭제 함수는 두지 않는다(AC1·TST-001 시나리오3).
module.exports = { append };
