#!/usr/bin/env node
'use strict';

// Aside council 시범 기록 이관 실행 (TSK-028 / 지령 013)
// 사용: node bin/migrate-council.js [reports 폴더] [--dry-run]
//  - 기본 폴더: %USERPROFILE%\.aside\u\1\trading\reports (읽기 전용)
//  - 멱등: 이미 이관된 (안건, 책사)는 건너뜀. 모르는 값은 보류 목록으로 출력.

const path = require('node:path');
const os = require('node:os');
const migrate = require('../src/council_migrate');
const council = require('../src/council');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dir = args.find((a) => !a.startsWith('--')) ||
  path.join(os.homedir(), '.aside', 'u', '1', 'trading', 'reports');

if (dryRun) {
  // 쓰기 없이 집계만: 임시 폴더를 dataDir로 써서 본장부를 건드리지 않는다
  const fs = require('node:fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-council-dry-'));
  const r = migrate.migrateCouncilReports(dir, { dataDir: tmp });
  console.log(`[dry-run] 이관 대상 ${r.migrated}건 · 건너뜀 ${r.skipped}파일 · 보류 ${r.deferred.length}건`);
  for (const d of r.deferred) console.log(`  보류: ${d.file} ${d.advisor || ''} — ${d.reason}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

const r = migrate.migrateCouncilReports(dir, {});
console.log(`이관 완료: ${r.migrated}건 · 건너뜀 ${r.skipped}파일 · 보류 ${r.deferred.length}건`);
for (const d of r.deferred) console.log(`  보류: ${d.file} ${d.advisor || ''} — ${d.reason}`);
console.log(`장부: ${council.verdictsFile({})}`);
