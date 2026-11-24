'use strict';

// 기동 시 정합성 검사 (뼈대) — 원장 재계산과 상태 값 대조 (TSK-001 / AC3)
//
// 원장(append-only)은 진실의 원천이고, 상태 파일은 그 집계의 "현재 값 캐시"다.
// 사람이 상태 파일을 손으로 고치는 등으로 둘이 어긋날 수 있으므로, 기동 시
// 원장을 다시 합산해 상태 값과 대조하고 어긋나면 경고한다.
//
// 대조 규칙(reconciliation):
//   { ledger, field, state, stateField }
//   → ledger의 모든 월별 jsonl에서 field 값을 합산한 값이
//     state 파일의 stateField 값과 같아야 한다.
//
// 읽기는 여기서 fs로 직접 한다 — 원장 모듈(ledger)의 표면을 append만으로 유지하기 위함.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

// 한 원장의 모든 월별 파일을 스캔해 이벤트 배열로 반환한다.
function readLedger(dataDir, name) {
  const dir = paths.ledgerDir(dataDir, name);
  if (!fs.existsSync(dir)) return [];
  const events = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

// opts: { dataDir, reconciliations }
// 반환: { ok, warnings }  — 어긋남은 warnings에 쌓고 console.warn으로도 출력한다.
function check(opts) {
  const dataDir = paths.resolveDataDir(opts);
  const recons = (opts && opts.reconciliations) || [];
  const warnings = [];

  for (const r of recons) {
    const events = readLedger(dataDir, r.ledger);
    const sum = events.reduce((acc, e) => acc + (Number(e[r.field]) || 0), 0);

    const statePath = paths.stateFile(dataDir, r.state);
    let stateVal = null;
    if (fs.existsSync(statePath)) {
      const obj = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      stateVal = obj[r.stateField];
    }

    if (Number(stateVal) !== sum) {
      const msg =
        `[정합성 경고] ${r.state}.${r.stateField}=${stateVal} 이지만 ` +
        `원장 ${r.ledger}.${r.field} 합계=${sum} — 어긋남`;
      warnings.push(msg);
      console.warn(msg);
    }
  }

  return { ok: warnings.length === 0, warnings };
}

module.exports = { check };
