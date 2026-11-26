'use strict';

// 그림자 08:30 계좌 스냅샷 연결(군주 승인 2026-11-26) — 비동기 공급자 허용·멱등·실패 생존
// 실행: node --test — 가짜 공급자만, 실서버·실키 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shadow = require('../src/shadow');
const paths = require('../src/paths');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-snap-')); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function rows(dir) {
  const d = paths.ledgerDir(dir, 'daily_account_snapshot');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
}

test('비동기 공급자 — real·paper 스냅샷 각 1행(total·cash) 기록', async () => {
  const dir = makeTmpDir();
  try {
    const opts = {
      dataDir: dir, now: '2026-11-27T08:30:30+09:00',
      providers: {
        accountSnapshot: async (acct) => (acct === 'real'
          ? { start_total_eval: 500000, start_cash: 261500 }
          : { start_total_eval: 2000000, start_cash: 1761500 }),
      },
    };
    const r = await shadow.runSnapshot('2026-11-27', opts);
    assert.deepEqual(r.errors, [], '오류 0');
    const all = rows(dir);
    assert.equal(all.length, 2, 'real·paper 각 1행');
    const real = all.find((x) => x.account_type === 'real');
    assert.equal(real.start_total_eval, 500000);
    assert.equal(real.start_cash, 261500);
    assert.equal(real.snapshot_date, '2026-11-27');
  } finally { rm(dir); }
});

test('멱등 — 재실행 중복 0', async () => {
  const dir = makeTmpDir();
  try {
    const opts = {
      dataDir: dir, now: '2026-11-27T08:30:30+09:00',
      providers: { accountSnapshot: async () => ({ start_total_eval: 1, start_cash: 1 }) },
    };
    await shadow.runSnapshot('2026-11-27', opts);
    await shadow.runSnapshot('2026-11-27', opts);
    assert.equal(rows(dir).length, 2, '계좌별 1행 유지');
  } finally { rm(dir); }
});

test('공급자 실패(한쪽) — 해당 계좌만 생략·생존, 다음 실행에서 보완', async () => {
  const dir = makeTmpDir();
  try {
    let realFails = true;
    const opts = {
      dataDir: dir, now: '2026-11-27T08:30:30+09:00',
      providers: {
        accountSnapshot: async (acct) => {
          if (acct === 'real' && realFails) throw new Error('잔고 조회 실패');
          return { start_total_eval: 9, start_cash: 9 };
        },
      },
    };
    const r1 = await shadow.runSnapshot('2026-11-27', opts);
    assert.deepEqual(r1.errors, ['real'], 'real만 실패 기록');
    assert.equal(rows(dir).length, 1, 'paper만 기록');
    realFails = false;
    await shadow.runSnapshot('2026-11-27', opts); // 다음 틱 보완
    assert.equal(rows(dir).length, 2, 'real 보완 기록');
  } finally { rm(dir); }
});

test('기존 동기 공급자 호환', async () => {
  const dir = makeTmpDir();
  try {
    const opts = {
      dataDir: dir, now: '2026-11-27T08:30:30+09:00',
      providers: { accountSnapshot: (acct) => ({ account_type: acct, start_total_eval: 7, start_cash: 3 }) },
    };
    const r = await shadow.runSnapshot('2026-11-27', opts);
    assert.deepEqual(r.errors, []);
    assert.equal(rows(dir).length, 2, '동기 공급자도 기록');
  } finally { rm(dir); }
});
