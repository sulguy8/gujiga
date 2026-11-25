'use strict';

// kis-adapter — 한국투자증권(KIS) 호출 어댑터 (TSK-003 / ARC-003 / ARC-005)
//
// refs/api/kis_client.js(2026-11-23 모의 검증 완료)의 호출 방식을 그대로 계승한다:
// TR ID·파라미터·토큰 캐시·호출 간격·'초당 건수 초과' 재시도·roundTick.
//
// 안전 원칙:
//  - 키·토큰은 secret.js(DPAPI) 경유로만 읽고 쓴다. 이 모듈 밖으로 토큰·키를 반환하지 않는다.
//  - 토큰 발급은 1분 1회 제한 + 발급마다 군주에게 알림톡이 간다 → 캐시가 유효하면(만료 30분 전까지)
//    '절대' 재발급하지 않는다. 만료 시 1회 발급, 실패하면 즉시 보고(무한 재시도 금지).
//    발급 기록은 token_log 원장에 남긴다(알림톡 대조용 — 토큰 값은 기록하지 않음).
//  - 모의/실전 도메인 분기는 어댑터 안에서만. **실전 주문·정정·취소는 비활성**(TSK-012에서 활성화) —
//    네트워크 이전 단계에서 거부한다.
//  - 오류·로그에 키 값·경로를 적지 않는다.

const crypto = require('node:crypto');
const ledger = require('./ledger');
const secret = require('./secret');

const BASE = {
  real: 'https://openapi.koreainvestment.com:9443',
  mock: 'https://openapivts.koreainvestment.com:29443',
};
const TR = {
  real: { buy: 'TTTC0012U', sell: 'TTTC0011U', rvse: 'TTTC0013U', bal: 'TTTC8434R', ccld: 'TTTC0081R', psbl: 'TTTC8908R' },
  mock: { buy: 'VTTC0012U', sell: 'VTTC0011U', rvse: 'VTTC0013U', bal: 'VTTC8434R', ccld: 'VTTC0081R', psbl: 'VTTC8908R' },
};
const GAP_MS = 1200;        // 호출 간격(kis_notes: 최소 1.2초 — '초당 거래건수 초과' 방지)
const RETRY_WAIT_MS = 1500; // 초과 응답 시 재시도 대기
const TOKEN_MARGIN_MS = 30 * 60 * 1000; // 만료 30분 전까지 재사용

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 호가 단위(kis_client.js 그대로)
function tickOf(p, etf) {
  if (etf) return 5;
  if (p < 2000) return 1;
  if (p < 5000) return 5;
  if (p < 20000) return 10;
  if (p < 50000) return 50;
  if (p < 200000) return 100;
  if (p < 500000) return 500;
  return 1000;
}
function roundTick(p, etf, dir) {
  const t = tickOf(p, etf);
  return dir === 'up' ? Math.ceil(p / t) * t : Math.floor(p / t) * t;
}

// env('mock'|'real') 어댑터 생성.
// opts: { dataDir, keysPath(암호화 키 파일 .enc), baseUrls?, gapMs?, retryWaitMs?, enableRealOrders? }
async function make(env, opts) {
  if (env !== 'mock' && env !== 'real') throw new Error(`env는 mock/real (받음: ${env})`);
  opts = opts || {};

  // 키 로드: DPAPI 암호화 파일로만. 복호화 값은 이 클로저 밖으로 나가지 않는다.
  const keysPath = opts.keysPath || process.env.GUJIGA_KIS_KEYS;
  if (!keysPath) throw new Error('키 파일 경로 미지정(GUJIGA_KIS_KEYS 또는 opts.keysPath)');
  let cfg;
  try {
    cfg = JSON.parse(secret.decryptFile(keysPath))[env];
  } catch (e) {
    throw new Error('키 파일 복호화 실패 — convert-secrets 전환·계정 확인'); // 경로·내용 미노출
  }
  if (!cfg || !cfg.appkey || !cfg.appsecret || !cfg.account) throw new Error('키 파일 형식 오류');

  const account = /^\d{8}$/.test(cfg.account) ? cfg.account + '-01' : cfg.account;
  const [CANO, PRDT] = account.split('-');
  const base = (opts.baseUrls && opts.baseUrls[env]) || BASE[env];
  const tr = TR[env];
  const gap = opts.gapMs != null ? opts.gapMs : GAP_MS;
  const retryWait = opts.retryWaitMs != null ? opts.retryWaitMs : RETRY_WAIT_MS;
  const tokenName = `kis_token_${env}`;

  // 호출 간격 보장(1.2초) — 토큰 발급 포함 전 호출 공용 큐
  let last = 0;
  async function pace() {
    const w = last + gap - Date.now();
    if (w > 0) await sleep(w);
    last = Date.now();
  }

  // 토큰: 캐시 유효(만료 30분 전) → 재사용. 아니면 1회 발급, 실패 즉시 보고.
  async function token() {
    const cached = secret.loadToken(tokenName, opts);
    if (cached && cached.token && cached.expires) {
      const exp = new Date(cached.expires.replace(' ', 'T') + '+09:00');
      if (exp.getTime() > Date.now() + TOKEN_MARGIN_MS) return cached.token;
    }
    await pace();
    const r = await fetch(base + '/oauth2/tokenP', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: cfg.appkey, appsecret: cfg.appsecret }),
    });
    const j = await r.json();
    if (!j.access_token) {
      // 무한 재시도 금지 — 즉시 실패 보고(키·상세 미노출)
      throw new Error(`토큰 발급 실패(${j.error_code || r.status}) — 재시도하지 않음`);
    }
    secret.saveToken(tokenName, { token: j.access_token, expires: j.access_token_token_expired }, opts);
    // 발급 기록(알림톡 대조용) — 토큰 값은 기록하지 않는다
    ledger.append('token_log', {
      id: crypto.randomUUID(), env,
      issuedAt: new Date().toISOString(),
      issuedAtKST: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      expires: j.access_token_token_expired,
    }, opts);
    return j.access_token;
  }

  // 공통 호출: 간격 보장 + '초당 건수 초과' 재시도(kis_client.js 관습, 최대 2회)
  async function call(method, pathName, trId, data, retry = 2) {
    const t = await token();
    await pace();
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      authorization: 'Bearer ' + t,
      appkey: cfg.appkey, appsecret: cfg.appsecret,
      tr_id: trId, custtype: 'P',
    };
    const url = base + pathName + (method === 'GET' ? '?' + new URLSearchParams(data).toString() : '');
    const r = await fetch(url, method === 'GET' ? { headers } : { method: 'POST', headers, body: JSON.stringify(data) });
    const j = await r.json();
    if (j.msg1 && /초당/.test(j.msg1) && retry > 0) {
      await sleep(retryWait);
      return call(method, pathName, trId, data, retry - 1);
    }
    return j;
  }

  // 실전 주문 경로 비활성(AC4) — TSK-012에서 게이트 경유로만 활성화한다.
  function assertOrderEnabled() {
    if (env === 'real' && !opts.enableRealOrders) {
      throw new Error('실전 주문 경로 비활성(TSK-012 전) — 네트워크 호출 없이 거부');
    }
  }

  const api = {
    env,
    account: CANO.slice(0, 2) + '******-' + PRDT, // 마스킹 — 전체 계좌번호 미노출
    roundTick,

    // 현재가(FHKST01010100·J)
    async quote(code) {
      const j = await call('GET', '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
        FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
      });
      const o = j.output || {};
      return {
        rt: j.rt_cd, msg: (j.msg1 || '').trim(),
        symbol: code, price: +o.stck_prpr, chg: +o.prdy_ctrt,
        open: +o.stck_oprc, high: +o.stck_hgpr, low: +o.stck_lwpr,
        vol: +o.acml_vol, volVsPrev: +o.prdy_vrss_vol_rate,
      };
    },

    // 일봉(FHKST03010100·J = KRX 정규장 공식, NXT 미포함) → source='krx_official' 태그.
    // stop_judgment는 이 태그가 있는 종가만 판정에 수용한다(chart_check.js 교훈).
    async dailyCandle(code, days) {
      const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      const end = new Date();
      const start = new Date(Date.now() - (days || 160) * 864e5);
      const j = await call('GET', '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
        FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: ymd(start), FID_INPUT_DATE_2: ymd(end),
        FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0',
      });
      if (j.rt_cd !== '0') throw new Error('일봉 조회 실패 ' + (j.msg1 || '').trim());
      return (j.output2 || []).filter((x) => x.stck_bsop_date).map((x) => ({
        date: `${x.stck_bsop_date.slice(0, 4)}-${x.stck_bsop_date.slice(4, 6)}-${x.stck_bsop_date.slice(6, 8)}`,
        open: +x.stck_oprc, high: +x.stck_hgpr, low: +x.stck_lwpr, close: +x.stck_clpr, vol: +x.acml_vol,
        source: 'krx_official',
      })).reverse(); // 과거→최신 오름차순
    },

    // 잔고
    async balance() {
      const j = await call('GET', '/uapi/domestic-stock/v1/trading/inquire-balance', tr.bal, {
        CANO, ACNT_PRDT_CD: PRDT, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
      });
      const o2 = (j.output2 || [])[0] || {};
      return {
        rt: j.rt_cd, msg: (j.msg1 || '').trim(),
        holdings: (j.output1 || []).filter((x) => +x.hldg_qty > 0).map((x) => ({
          name: x.prdt_name, code: x.pdno, qty: +x.hldg_qty, avg: +x.pchs_avg_pric,
          price: +x.prpr, pnl: +x.evlu_pfls_amt, pnlPct: +x.evlu_pfls_rt,
        })),
        cash: +o2.dnca_tot_amt, cashD2: +o2.prvs_rcdl_excc_amt, total: +o2.tot_evlu_amt,
      };
    },

    // 지정가 주문(ORD_DVSN 00). 검사(한도·화이트리스트 등)는 게이트(TSK-005) 소관 —
    // 어댑터는 전송만. 실전은 비활성(TSK-012 전).
    async order(side, code, qty, price) {
      assertOrderEnabled();
      const j = await call('POST', '/uapi/domestic-stock/v1/trading/order-cash', tr[side], {
        CANO, ACNT_PRDT_CD: PRDT, PDNO: code, ORD_DVSN: '00', ORD_QTY: String(qty), ORD_UNPR: String(price),
      });
      return { rt: j.rt_cd, msg: (j.msg1 || '').trim(), orgno: j.output && j.output.KRX_FWDG_ORD_ORGNO, odno: j.output && j.output.ODNO };
    },

    // 정정(01)
    async modify(orgno, odno, qty, newPrice) {
      assertOrderEnabled();
      const j = await call('POST', '/uapi/domestic-stock/v1/trading/order-rvsecncl', tr.rvse, {
        CANO, ACNT_PRDT_CD: PRDT, KRX_FWDG_ORD_ORGNO: orgno, ORGN_ODNO: odno, ORD_DVSN: '00',
        RVSE_CNCL_DVSN_CD: '01', ORD_QTY: String(qty), ORD_UNPR: String(newPrice), QTY_ALL_ORD_YN: 'Y',
      });
      return { rt: j.rt_cd, msg: (j.msg1 || '').trim(), orgno: j.output && j.output.KRX_FWDG_ORD_ORGNO, odno: j.output && j.output.ODNO };
    },

    // 취소(02)
    async cancel(orgno, odno, qty) {
      assertOrderEnabled();
      const j = await call('POST', '/uapi/domestic-stock/v1/trading/order-rvsecncl', tr.rvse, {
        CANO, ACNT_PRDT_CD: PRDT, KRX_FWDG_ORD_ORGNO: orgno, ORGN_ODNO: odno, ORD_DVSN: '00',
        RVSE_CNCL_DVSN_CD: '02', ORD_QTY: String(qty), ORD_UNPR: '0', QTY_ALL_ORD_YN: 'Y',
      });
      return { rt: j.rt_cd, msg: (j.msg1 || '').trim(), odno: j.output && j.output.ODNO };
    },

    // 일별 체결조회
    async fills(dateYYYYMMDD) {
      const d = dateYYYYMMDD;
      const j = await call('GET', '/uapi/domestic-stock/v1/trading/inquire-daily-ccld', tr.ccld, {
        CANO, ACNT_PRDT_CD: PRDT, INQR_STRT_DT: d, INQR_END_DT: d, SLL_BUY_DVSN_CD: '00', INQR_DVSN: '00',
        PDNO: '', CCLD_DVSN: '00', ORD_GNO_BRNO: '', ODNO: '', INQR_DVSN_3: '00', INQR_DVSN_1: '',
        CTX_AREA_FK100: '', CTX_AREA_NK100: '',
      });
      return {
        rt: j.rt_cd, msg: (j.msg1 || '').trim(),
        rows: (j.output1 || []).map((x) => ({
          orgno: x.ord_gno_brno, odno: x.odno, orgOdno: x.orgn_odno, side: x.sll_buy_dvsn_cd_name,
          name: x.prdt_name, ordQty: +x.ord_qty, ordPrice: +x.ord_unpr, filled: +x.tot_ccld_qty,
          avgFill: +x.avg_prvs, remain: +x.rmn_qty, cancelled: x.cncl_yn, time: x.ord_tmd,
        })),
      };
    },
  };

  return api;
}

module.exports = { make, roundTick };
