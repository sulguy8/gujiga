// KIS 클라이언트 — 허도 관문(gujiga gatekeeper) 경유판. (REPL에서 eval로 로드)
// 키·토큰 값은 절대 출력하지 않는다. 키는 이 클라이언트에 없다 — 관문이 DPAPI로 풀어 대행한다.
// 사용: const kis = eval(await fs.readFile('<ASIDE_ROOT>\\trading\\kis_client.js','utf8'));
//       const api = await kis.make('mock' | 'real');
// 기존 kis_client.js와 같은 모양: make(env) → balance/price/order/modify/cancel/fills, roundTick.
// 관문이 꺼져 있으면 '[정지] 관문 꺼짐' 오류를 던지고 아무 것도 호출하지 않는다(조용한 실패 금지).
// ※ 모듈 로딩·자식 프로세스 호출 없음 — fetch와 fs의 readFile/writeFile만 사용(Aside REPL 제약).
(() => {
  const ROOT = (globalThis.GUJIGA_ASIDE_ROOT || '<ASIDE_ROOT>');
  const GUARD = ROOT + '\\trading\\guard.json';
  const STOP = ROOT + '\\trading\\STOP';
  const LOG = ROOT + '\\trading\\order_log.jsonl';
  const GATE = (globalThis.GUJIGA_GATE_URL || 'http://127.0.0.1:62910');
  const TOKEN_FILE = (globalThis.GUJIGA_GATE_TOKEN_FILE || ROOT + '\\secrets\\gujiga_broker.token');

  const exists = async (p) => { try { await fs.stat(p); return true; } catch (e) { return false; } };
  const tick = (p, etf) => { if (etf) return 5; if (p < 2000) return 1; if (p < 5000) return 5; if (p < 20000) return 10; if (p < 50000) return 50; if (p < 200000) return 100; if (p < 500000) return 500; return 1000; };
  const roundTick = (p, etf, dir) => { const t = tick(p, etf); return dir === 'up' ? Math.ceil(p / t) * t : Math.floor(p / t) * t; };

  // 관문 호출: 토큰 파일 읽기 → POST /call. 실패 유형별로 명확한 '[정지]' 오류.
  async function gate(env, fn, args) {
    let tok;
    try { tok = (await fs.readFile(TOKEN_FILE, 'utf8')).trim(); } catch (e) {
      throw new Error('[정지] 관문 꺼짐: 관문 토큰 파일 없음 — gujiga 관문(run-gatekeeper)을 먼저 켜라. 주문·조회 중단');
    }
    let r;
    try {
      r = await fetch(GATE + '/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-gate-token': tok },
        body: JSON.stringify({ env, fn, args }),
      });
    } catch (e) {
      throw new Error('[정지] 관문 꺼짐: ' + GATE + ' 접속 불가 — 주문·조회 중단(조용한 실패 금지)');
    }
    if (r.status === 401) throw new Error('[정지] 관문 토큰 불일치 — 관문 재기동 직후면 토큰 파일 갱신을 기다렸다 다시 로드하라');
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '관문 오류');
    return j.result;
  }

  async function make(env) {
    // --- 1차 잠금(기존 kis_client.js의 안전장치 유지): guard.json·STOP·confirmed·화이트리스트·한도·하루 손실 ---
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
        const DS = ROOT + '\\trading\\data\\real_day_start.json';
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
        const b = await api.balance();
        let ds = null; try { ds = JSON.parse(await fs.readFile(DS, 'utf8')); } catch (e) {}
        if (!ds || ds.date !== today) { ds = { date: today, total: b.total }; await fs.writeFile(DS, JSON.stringify(ds)); }
        if (b.total - ds.total <= -g.dailyLossLimitKRW) throw new Error(`하루 손실 한도 도달(${b.total - ds.total}원): 오늘 실전 매수 차단`);
      }
      return g;
    }
    async function log(o) { let prev = ''; try { prev = await fs.readFile(LOG, 'utf8'); } catch (e) {} await fs.writeFile(LOG, prev + JSON.stringify({ ts: new Date().toISOString(), env, via: 'gatekeeper', ...o }) + '\n'); }

    const api = {
      env,
      roundTick,
      async balance() { return gate(env, 'balance', []); },
      async price(code) { return gate(env, 'price', [code]); },
      async order(side, code, qty, price, { confirmed = false, reason = '' } = {}) {
        await guardCheck(side, code, qty, price, confirmed); // 1차 잠금(기존 유지)
        // 2차 잠금은 관문이 gujiga guard_config 기준으로 별도 수행(이중 잠금)
        const res = await gate(env, 'order', [side, code, qty, price, { confirmed, reason }]);
        await log({ type: 'order', side, code, qty, price, reason, rt: res.rt, msg: res.msg, orgno: res.orgno, odno: res.odno });
        return res;
      },
      async modify(orgno, odno, qty, newPrice) {
        if (await exists(STOP)) throw new Error('STOP 파일 존재');
        const res = await gate(env, 'modify', [orgno, odno, qty, newPrice]);
        await log({ type: 'modify', from: odno, newPrice, rt: res.rt, msg: res.msg, odno: res.odno });
        return res;
      },
      async cancel(orgno, odno, qty) {
        const res = await gate(env, 'cancel', [orgno, odno, qty]);
        await log({ type: 'cancel', from: odno, rt: res.rt, msg: res.msg, odno: res.odno });
        return res;
      },
      async fills(dateYYYYMMDD) { return gate(env, 'fills', [dateYYYYMMDD]); },
    };
    return api;
  }
  return { make, roundTick };
})()
