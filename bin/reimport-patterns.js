'use strict';

// 손자약해 재이관 (지령 005 — 이관하는 날 실행, 그 전에는 만들어만 둔다)
//
// 정본은 Aside 쪽 trading/playbook/patterns.md (이관 전까지). 이 명령은 이관일에
// 정본을 다시 읽어 gujiga 가설 장부(연습장)에 반영한다. 멱등 — 같은 입력이면 변경 0.
//
// 사용: node bin/reimport-patterns.js [patterns.md 경로] [--dry-run]
//  - 기존 가설(HYP-코드): 진술·원문 상태 라벨만 갱신. 상태(status)·증거 수·인용 가능
//    여부는 건드리지 않는다(연습장에서 쌓은 관찰 증거 보존, 임의 승격·강등 금지).
//  - 새 코드: hypothesis.register로 등록(verified 생성 봉쇄 규칙 그대로 적용).
//  - 정본에서 사라진 코드: 삭제하지 않고 보고만(REQ-011 — 삭제 금지).
//  - 원본 patterns.md 는 읽기만 한다.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const hypothesis = require('../src/hypothesis');
const state = require('../src/state');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const srcPath = args.find((a) => !a.startsWith('--')) ||
  path.join(os.homedir(), '.aside', 'u', '1', 'trading', 'playbook', 'patterns.md');

const STATUS_LABEL_MAP = [
  [/검증 중/, 'testing'],
  [/^가설/, 'hypothesis'],
  [/사용 중/, 'rule'], // D계열 걸러내기 군령 — citable=false (군사 검토 2026-11-25)
];
function mapStatus(label) {
  for (const [re, s] of STATUS_LABEL_MAP) if (re.test(label)) return s;
  return 'hypothesis';
}

const raw = fs.readFileSync(srcPath, 'utf8'); // 읽기만
const rows = [];
for (const line of raw.split('\n')) {
  const m = line.match(/^\|\s*([A-E]\d)\s*\|/);
  if (!m) continue;
  const cells = line.split('|').map((c) => c.trim());
  rows.push({ code: cells[1], statement: cells[2], statusLabel: cells[3] || '' });
}
if (!rows.length) {
  console.log('정본에서 패턴 행을 찾지 못함 — 중단(쓰기 0):', srcPath);
  process.exit(1);
}

const existing = hypothesis.list({});
const byCode = new Map(existing.map((h) => [h.code, h]));
const plan = { updated: [], added: [], missing: [], unchanged: 0 };

for (const r of rows) {
  const h = byCode.get(r.code);
  if (!h) {
    plan.added.push(r);
  } else if (h.statement !== r.statement || h.original_status !== r.statusLabel) {
    plan.updated.push(r);
  } else {
    plan.unchanged++;
  }
}
for (const h of existing) {
  if (!rows.some((r) => r.code === h.code)) plan.missing.push(h.code);
}

console.log(`재이관 계획: 갱신 ${plan.updated.length} · 신규 ${plan.added.length} · 변경 없음 ${plan.unchanged} · 정본에서 사라짐 ${plan.missing.length}(삭제 안 함)`);
for (const r of plan.updated) console.log(`  갱신: ${r.code}`);
for (const r of plan.added) console.log(`  신규: ${r.code} (${mapStatus(r.statusLabel)})`);
for (const c of plan.missing) console.log(`  사라짐(보존): ${c}`);

if (dryRun) {
  console.log('--dry-run — 쓰기 0');
  process.exit(0);
}

// 반영: 기존은 진술·원문 라벨만 직접 갱신(상태·증거 불변), 신규는 register 경유
const book = state.read('hypothesis_book', {}) || { items: [] };
for (const r of plan.updated) {
  const h = book.items.find((x) => x.code === r.code);
  h.statement = r.statement;
  h.original_status = r.statusLabel;
}
if (plan.updated.length) state.write('hypothesis_book', book, {});
for (const r of plan.added) {
  hypothesis.register({
    code: r.code, category: r.code[0], statement: r.statement,
    status: mapStatus(r.statusLabel), original_status: r.statusLabel,
  }, {});
}
state.write('patterns_reimport', { at: new Date().toISOString(), src: srcPath, updated: plan.updated.length, added: plan.added.length, missing: plan.missing }, {});
console.log('재이관 완료(원본은 읽기만).');
