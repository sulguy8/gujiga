'use strict';

// TST-005 통과 대조군 — 모의계좌 실제 접수 1건 + 즉시 취소 (지령 006)
//
// ※ 장중(09:05 이후)에만 실행한다. 지령 006은 '만들어만 두고 지금은 실행하지 말 것'.
//    실행도 군주(또는 군주 지시)로만: node bin/tst005-pass-case.js
//
// 동작: 모의(VTS)계좌에 1주짜리 지정가 매수 출사표를 관문(gate.submit) 7단계 전부
// 통과시켜 실제 접수 → 접수 직후 gate.revoke로 즉시 취소. 체결을 노리지 않도록
// 현재가보다 한참 낮은 지정가(현재가의 약 80%, 호가 단위 절사)로 낸다.
// 대상: KODEX 200(069500) 1주 — 최저 단가권 ETF(진짜 체결돼도 25만 미만·세력전 한도 내).
//
// 키·토큰 값 출력 0. 증거는 %USERPROFILE%\gujiga-data-tst006 order_log에 남는다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gate = require('../src/gate');
const state = require('../src/state');

const DATA = path.join(os.homedir(), 'gujiga-data-tst006');
const opts = { dataDir: DATA, keysPath: process.env.GUJIGA_KIS_KEYS || 'C:\\Users\\조용수\\.aside\\u\\1\\secrets\\kis.json.enc' };
const SYMBOL = '069500'; // KODEX 200

function kstMinutes() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
// 호가 단위 절사(2천원 이상 ETF권: 5원 단위면 충분 — 보수적으로 roundTick 대체)
function tickFloor(p) {
  const unit = p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
  return Math.floor(p / unit) * unit;
}

(async () => {
  if (kstMinutes() < 9 * 60 + 5) {
    console.log('장 시작 전(09:05 이전) — 실행하지 않음. 내일 09:05 이후 다시.');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(DATA, 'state'))) {
    console.log('검증 폴더 미준비 — 먼저 node bin/tst005-live-verify.js 를 실행해 시드하라.');
    process.exit(1);
  }
  // 포로일 시드(전수 검증의 revenge 재현용)가 남아 있으면 통과 대조군이 막힌다 — 안내 후 중단
  const posFree = (state.read('positions', opts) || []).filter((p) => p.status === 'open');
  console.log(`보유 성 ${posFree.length}개 (세력전 동시 2성 한도 내 확인)`);

  const q = await gate.query('mock', 'price', [SYMBOL], opts);
  if (!q || !q.price) {
    console.log('시세 조회 실패 — 중단');
    process.exit(1);
  }
  const limitPrice = tickFloor(Math.floor(q.price * 0.8)); // 체결 회피용 저가 지정가
  console.log(`현재가 ${q.price} → 지정가 ${limitPrice} (체결 회피 저가)`);

  const draft = {
    account_type: 'paper', nation: 'chok', symbol: SYMBOL, side: 'buy',
    entry_low: Math.floor(limitPrice * 0.9), entry_high: Math.ceil(q.price * 1.05),
    stop_price: Math.floor(limitPrice * 0.8), target_price: Math.ceil(q.price * 1.2),
    deadline: '2026-12-05', troops: Math.max(1, Math.round(limitPrice / 10000)),
    qty: 1, price: limitPrice,
    user_confirmed: true, created_by: 'human', reason: 'TST-005 통과 대조군(1주, 즉시 취소)', hypothesis_ids: ['HYP-V'],
  };
  const r = await gate.submit(draft, opts);
  if (!r.ok) {
    console.log(`접수 실패/차단: ${r.reason || r.error}`);
    process.exit(1);
  }
  console.log(`접수 성공 — 주문번호 ${r.result.odno} (조직 ${r.result.orgno})`);

  // 즉시 취소(수량 전체)
  try {
    const c = await gate.revoke('mock', [r.result.orgno, r.result.odno, 1], opts);
    console.log(`취소: rt=${c.rt} ${c.msg}${c.odno ? ' 취소번호 ' + c.odno : ''}`);
  } catch (e) {
    console.log('취소 실패 — 저가 지정가라 체결 가능성 낮음, 당일 만료 예정:', e.message);
  }
  console.log('완료 — 증거: gujiga-data-tst006 order_log + 모의계좌 당일 주문내역');
})();
