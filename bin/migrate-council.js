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
  // 본장부를 기준으로 '실제 이관될 건수'만 집계(쓰기 0) — 멱등 미리보기(군사 지적 2026-11-26)
  const r = migrate.migrateCouncilReports(dir, { dryRun: true });
  console.log(`[dry-run] 이관 대상 ${r.migrated}건 · 건너뜀 ${r.skipped}파일 · 보류 ${r.deferred.length}건`);
  for (const d of r.deferred) console.log(`  보류: ${d.file} ${d.advisor || ''} — ${d.reason}`);
  process.exit(0);
}

const r = migrate.migrateCouncilReports(dir, {});
console.log(`이관 완료: ${r.migrated}건 · 건너뜀 ${r.skipped}파일 · 보류 ${r.deferred.length}건`);
for (const d of r.deferred) console.log(`  보류: ${d.file} ${d.advisor || ''} — ${d.reason}`);
console.log(`장부: ${council.verdictsFile({})}`);
