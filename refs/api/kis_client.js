// KIS 클라이언트 (REPL에서 eval로 로드). 키/토큰 값은 절대 출력하지 않는다.
// 사용: const kis = eval(await fs.readFile('<ASIDE_ROOT>\\trading\\kis_client.js','utf8'));
//       const api = await kis.make('mock' | 'real');
(() => {
  const ROOT = '<ASIDE_ROOT>';
  const CFG = ROOT + '\\secrets\\kis.json';
  const GUARD = ROOT + '\\trading\\guard.json';
  const STOP = ROOT + '\\trading\\STOP';
  const LOG = ROOT + '\\trading\\order_log.jsonl';
  const BASE = { real: 'https://openapi.koreainvestment.com:9443', mock: 'https://openapivts.koreainvestment.com:29443' };
  const TR = {
    real: { buy: 'TTTC0012U', sell: 'TTTC0011U', rvse: 'TTTC0013U', bal: 'TTTC8434R', ccld: 'TTTC0081R', psbl: 'TTTC8908R' },
    mock: { buy: 'VTTC0012U', sell: 'VTTC0011U', rvse: 'VTTC0013U', bal: 'VTTC8434R', ccld: 'VTTC0081R', psbl: 'VTTC8908R' },
  };
  let last = 0;
  const pace = async (ms) => { const w = last + ms - Date.now(); if (w > 0) await sleep(w); last = Date.now(); };
  const exists = async (p) => { try { await fs.stat(p); return true; } catch (e) { return false; } };
  const tick = (p, etf) => { if (etf) return 5; if (p < 2000) return 1; if (p < 5000) return 5; if (p < 20000) return 10; if (p < 50000) return 50; if (p < 200000) return 100; if (p < 500000) return 500; return 1000; };
  const roundTick = (p, etf, dir) => { const t = tick(p, etf); return dir === 'up' ? Math.ceil(p / t) * t : Math.floor(p / t) * t; };

  async function make(env) {
    const cfg = JSON.parse(await fs.readFile(CFG, 'utf8'))[env];
    const account = /^\d{8}$/.test(cfg.account) ? cfg.account + '-01' : cfg.account;
    const [CANO, PRDT] = account.split('-');
    const base = BASE[env], tr = TR[env];
    const gap = env === 'mock' ? 1100 : 400;
    const tokPath = ROOT + `\\secrets\\kis_token_${env}.json`;

    async function token() {
      try { const c = JSON.parse(await fs.readFile(tokPath, 'utf8')); if (new Date(c.expires.replace(' ', 'T') + '+09:00') > new Date(Date.now() + 30 * 60 * 1000)) return c.token; } catch (e) {}
      await pace(gap);
      const r = await fetch(base + '/oauth2/tokenP', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ grant_type: 'client_credentials', appkey: cfg.appkey, appsecret: cfg.appsecret }) });
      const j = await r.json();
      if (!j.access_token) throw new Error('token fail ' + (j.error_code || '') + ' ' + (j.error_description || j.msg1 || ''));
      await fs.writeFile(tokPath, JSON.stringify({ token: j.access_token, expires: j.access_token_token_expired }));
      // 토큰 발급 기록: 한투 알림톡 시각과 대조해 키 유출 여부를 확인하는 용도(토큰 값은 기록하지 않음)
      try {
        const TL = ROOT + '\\trading\\token_log.jsonl';
        let prev = ''; try { prev = await fs.readFile(TL, 'utf8'); } catch (e) {}
        let who = 'unknown'; try { const s = aside.sessions.current(); who = (s?.title || s?.id || 'unknown'); } catch (e) {}
        await fs.writeFile(TL, prev + JSON.stringify({ issuedAt: new Date().toISOString(), issuedAtKST: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), env, expires: j.access_token_token_expired, by: who }) + '\n');
      } catch (e) {}
      return j.access_token;
    }
    async function call(method, path, trId, data, retry = 2) {
      const t = await token();
      await pace(gap);
      const headers = { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + t, appkey: cfg.appkey, appsecret: cfg.appsecret, tr_id: trId, custtype: 'P' };
      const url = base + path + (method === 'GET' ? '?' + new URLSearchParams(data).toString() : '');
      const r = await fetch(url, method === 'GET' ? { headers } : { method: 'POST', headers, body: JSON.stringify(data) });
      const j = await r.json();
      if (j.msg1 && /초당/.test(j.msg1) && retry > 0) { await sleep(1500); return call(method, path, trId, data, retry - 1); }
      return j;
    }
    async function guardCheck(side, code, qty, price, confirmed) {
      if (await exists(STOP)) throw new Error('STOP 파일 존재: 모든 주문 중단');
      const g = JSON.parse(await fs.readFile(GUARD, 'utf8'));
      if (env === 'real' && !confirmed) throw new Error('실전 주문은 사용자 확인(confirmed=true) 필요');
      if (!Number.isInteger(price) || price <= 0) throw new Error('지정가만 허용 (가격 필요)');
      const amt = qty * price;
      const lim = env === 'real' ? g.maxOrderKRW : (g.mockMaxOrderKRW || 500000);
      if (amt > lim) throw new Error(`1회 주문 한도 초과: ${amt} > ${lim}`);
      if (env === 'real' && side === 'buy' && g.whitelist.length && !g.whitelist.includes(code)) throw new Error('화이트리스트에 없는 종목 매수 금지');
      if (env === 'real' && side === 'buy' && g.dailyLossLimitKRW) {
        // 하루 손실 한도: 당일 첫 조회 총평가를 기준으로 저장, 기준 대비 -한도 이하면 매수 차단
        const DS = ROOT + '\\trading\\data\\real_day_start.json';
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
        const b = await api.balance();
        let ds = null; try { ds = JSON.parse(await fs.readFile(DS, 'utf8')); } catch (e) {}
        if (!ds || ds.date !== today) { ds = { date: today, total: b.total }; await fs.writeFile(DS, JSON.stringify(ds)); }
        if (b.total - ds.total <= -g.dailyLossLimitKRW) throw new Error(`하루 손실 한도 도달(${b.total - ds.total}원): 오늘 실전 매수 차단`);
      }
      return g;
    }
    async function log(o) { let prev = ''; try { prev = await fs.readFile(LOG, 'utf8'); } catch (e) {} await fs.writeFile(LOG, prev + JSON.stringify({ ts: new Date().toISOString(), env, ...o }) + '\n'); }

    const api = {
      env, account: CANO.slice(0, 2) + '******' + '-' + PRDT,
      roundTick,
      async balance() {
        const j = await call('GET', '/uapi/domestic-stock/v1/trading/inquire-balance', tr.bal, { CANO, ACNT_PRDT_CD: PRDT, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '' });
        const o2 = (j.output2 || [])[0] || {};
        return { rt: j.rt_cd, msg: (j.msg1 || '').trim(), holdings: (j.output1 || []).filter(x => +x.hldg_qty > 0).map(x => ({ name: x.prdt_name, code: x.pdno, qty: +x.hldg_qty, avg: +x.pchs_avg_pric, price: +x.prpr, pnl: +x.evlu_pfls_amt, pnlPct: +x.evlu_pfls_rt })), cash: +o2.dnca_tot_amt, cashD2: +o2.prvs_rcdl_excc_amt, total: +o2.tot_evlu_amt };
      },
      async price(code) {
        const j = await call('GET', '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
        const o = j.output || {};
        return { rt: j.rt_cd, msg: (j.msg1 || '').trim(), price: +o.stck_prpr, chg: +o.prdy_ctrt, open: +o.stck_oprc, high: +o.stck_hgpr, low: +o.stck_lwpr, vol: +o.acml_vol, volVsPrev: +o.prdy_vrss_vol_rate };
      },
      async order(side, code, qty, price, { confirmed = false, reason = '' } = {}) {
        await guardCheck(side, code, qty, price, confirmed);
        const j = await call('POST', '/uapi/domestic-stock/v1/trading/order-cash', tr[side], { CANO, ACNT_PRDT_CD: PRDT, PDNO: code, ORD_DVSN: '00', ORD_QTY: String(qty), ORD_UNPR: String(price) });
        const res = { rt: j.rt_cd, msg: (j.msg1 || '').trim(), orgno: j.output?.KRX_FWDG_ORD_ORGNO, odno: j.output?.ODNO };
        await log({ type: 'order', side, code, qty, price, reason, ...res });
        return res;
      },
      async modify(orgno, odno, qty, newPrice) {
        if (await exists(STOP)) throw new Error('STOP 파일 존재');
        const j = await call('POST', '/uapi/domestic-stock/v1/trading/order-rvsecncl', tr.rvse, { CANO, ACNT_PRDT_CD: PRDT, KRX_FWDG_ORD_ORGNO: orgno, ORGN_ODNO: odno, ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '01', ORD_QTY: String(qty), ORD_UNPR: String(newPrice), QTY_ALL_ORD_YN: 'Y' });
        const res = { rt: j.rt_cd, msg: (j.msg1 || '').trim(), orgno: j.output?.KRX_FWDG_ORD_ORGNO, odno: j.output?.ODNO };
        await log({ type: 'modify', from: odno, newPrice, ...res });
        return res;
      },
      async cancel(orgno, odno, qty) {
        const j = await call('POST', '/uapi/domestic-stock/v1/trading/order-rvsecncl', tr.rvse, { CANO, ACNT_PRDT_CD: PRDT, KRX_FWDG_ORD_ORGNO: orgno, ORGN_ODNO: odno, ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '02', ORD_QTY: String(qty), ORD_UNPR: '0', QTY_ALL_ORD_YN: 'Y' });
        const res = { rt: j.rt_cd, msg: (j.msg1 || '').trim(), odno: j.output?.ODNO };
        await log({ type: 'cancel', from: odno, ...res });
        return res;
      },
      async fills(dateYYYYMMDD) {
        const d = dateYYYYMMDD;
        const j = await call('GET', '/uapi/domestic-stock/v1/trading/inquire-daily-ccld', tr.ccld, { CANO, ACNT_PRDT_CD: PRDT, INQR_STRT_DT: d, INQR_END_DT: d, SLL_BUY_DVSN_CD: '00', INQR_DVSN: '00', PDNO: '', CCLD_DVSN: '00', ORD_GNO_BRNO: '', ODNO: '', INQR_DVSN_3: '00', INQR_DVSN_1: '', CTX_AREA_FK100: '', CTX_AREA_NK100: '' });
        return { rt: j.rt_cd, msg: (j.msg1 || '').trim(), rows: (j.output1 || []).map(x => ({ orgno: x.ord_gno_brno, odno: x.odno, orgOdno: x.orgn_odno, side: x.sll_buy_dvsn_cd_name, name: x.prdt_name, ordQty: +x.ord_qty, ordPrice: +x.ord_unpr, filled: +x.tot_ccld_qty, avgFill: +x.avg_prvs, remain: +x.rmn_qty, cancelled: x.cncl_yn, time: x.ord_tmd })) };
      },
    };
    return api;
  }
  return { make, roundTick };
})()
