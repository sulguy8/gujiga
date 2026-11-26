// 차트 판단 템플릿 자동 채점기 v2. 규칙 설명: trading\playbook\chart.md
// 사용: const cc = eval(await fs.readFile('<ASIDE_ROOT>\\trading\\chart_check.js','utf8')); const r = await cc.check('476830');
// 데이터: 한투 KIS 일봉(KRX 정규장 공식 가격, NXT 미포함). 실패 시 네이버 일봉(NXT 섞임, 경고 표시). REPL fetch 전 탭 하나 열기.
(() => {
  const ROOT = '<ASIDE_ROOT>';
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const ma = (c, n, i) => (i + 1 >= n ? avg(c.slice(i + 1 - n, i + 1)) : null);
  const ymd = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  let lastCall = 0;
  const pace = async () => { const w = lastCall + 1200 - Date.now(); if (w > 0) await sleep(w); lastCall = Date.now(); };

  // 2026-11-25 허도 관문 경유판: 키를 직접 읽지 않고 gujiga 관문(127.0.0.1:62910)의 dailyCandle을 부른다.
  async function loadKIS(code) {
    let tok;
    try { tok = (await fs.readFile(ROOT + '\\secrets\\gujiga_broker.token', 'utf8')).trim(); } catch (e) { throw new Error('[정지] 관문 꺼짐: 관문 토큰 파일 없음'); }
    await pace();
    let r;
    try { r = await fetch('http://127.0.0.1:62910/call', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'x-gate-token': tok }, body: JSON.stringify({ env: 'real', fn: 'dailyCandle', args: [code, 160] }) }); }
    catch (e) { throw new Error('[정지] 관문 꺼짐: 접속 불가'); }
    if (r.status === 401) throw new Error('[정지] 관문 토큰 불일치');
    const j = await r.json();
    if (!j.ok) throw new Error('KIS 일봉 실패(관문) ' + (j.error || ''));
    return (j.result || []).map(x => ({ d: String(x.date).replace(/-/g, ''), o: x.open, h: x.high, l: x.low, c: x.close, v: x.vol }));
  }
  async function loadNaver(code) {
    const end = new Date(), start = new Date(Date.now() - 400 * 864e5);
    const d = await (await fetch(`https://api.stock.naver.com/chart/domestic/item/${code}/day?startDateTime=${ymd(start)}0000&endDateTime=${ymd(end)}2359`)).json();
    return d.map(x => ({ d: x.localDate, o: x.openPrice, h: x.highPrice, l: x.lowPrice, c: x.closePrice, v: x.accumulatedTradingVolume }));
  }
  async function load(code) {
    try { return { bars: await loadKIS(code), src: 'KIS(KRX)' }; } catch (e) { return { bars: await loadNaver(code), src: '네이버(NXT 포함, 종가 판정에 쓰지 말 것): ' + e.message }; }
  }
  async function indexChg(code) {
    try {
      const b = await (await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`)).json();
      const idx = b.stockExchangeType?.code === 'KQ' ? 'KOSDAQ' : 'KOSPI';
      const ib = await (await fetch(`https://m.stock.naver.com/api/index/${idx}/basic`)).json();
      return { idx, chg: parseFloat(ib.fluctuationsRatio) };
    } catch (e) { return null; }
  }

  function analyze(bars, mkt) {
    const n = bars.length, i = n - 1, b = bars[i], p = bars[i - 1], pp = bars[i - 2];
    const C = bars.map(x => x.c), V = bars.map(x => x.v);
    const young = n < 60;
    const out = { mode: young ? `신규상장 모드(거래일 ${n}일)` : '일반', trend: [], candle: [], pattern: [], volume: [], rel: [], score: 0, filters: [] };
    const add = (sec, pts, txt) => { out[sec].push(`${pts > 0 ? '+' : ''}${pts} ${txt}`); out.score += pts; };
    const note = (sec, txt) => out[sec].push(`0 ${txt}`);
    const vBase = young ? avg(V.slice(Math.max(0, i - 5), i)) : avg(V.slice(Math.max(0, i - 20), i));
    const vx = b.v / vBase;
    const chg = (b.c - p.c) / p.c * 100;

    // 1. 추세
    const m5 = ma(C, 5, i), m20 = ma(C, 20, i), m60 = ma(C, 60, i);
    const longN = young ? 5 : 60, longNow = ma(C, longN, i), longBefore = ma(C, longN, i - 5);
    if (longNow && longBefore) {
      const slope = (longNow - longBefore) / longBefore * 100;
      if (slope < -0.5) { out.filters.push(`${longN}일선 하락 중 ${slope.toFixed(1)}%/5일 -> 매수 금지`); note('trend', `${longN}일선 하락 방향`); }
      else if (slope > 0.5) add('trend', 1, `${longN}일선 상승 방향`);
      else note('trend', `${longN}일선 횡보`);
    }
    const refMA = young ? m5 : m20, refN = young ? 5 : 20;
    if (refMA) { if (b.c > refMA) add('trend', 1, `종가 > ${refN}일선(${Math.round(refMA)})`); else add('trend', -1, `종가 < ${refN}일선(${Math.round(refMA)})`); }
    if (!young && m5 && m20) {
      for (let k = 0; k < 3; k++) {
        const j = i - k, a5 = ma(C, 5, j), a20 = ma(C, 20, j), b5 = ma(C, 5, j - 1), b20 = ma(C, 20, j - 1);
        if (!b5 || !b20) break;
        if (b5 <= b20 && a5 > a20) { add('trend', 1, `골든크로스(5/20) ${bars[j].d}`); break; }
        if (b5 >= b20 && a5 < a20) { add('trend', -1, `데드크로스(5/20) ${bars[j].d}`); break; }
      }
    }
    if (m60 && b.c < m60) note('trend', `60일선(${Math.round(m60)}) 아래`);

    // 2. 캔들
    const body = x => Math.abs(x.c - x.o), range = x => x.h - x.l || 1;
    const up = x => x.c > x.o, upperW = x => x.h - Math.max(x.o, x.c), lowerW = x => Math.min(x.o, x.c) - x.l;
    const lo10 = Math.min(...bars.slice(Math.max(0, i - 10), i + 1).map(x => x.l)), hi10 = Math.max(...bars.slice(Math.max(0, i - 10), i + 1).map(x => x.h));
    const nearLow = b.l <= lo10 * 1.03, nearHigh = b.h >= hi10 * 0.97;
    const bodyPct = body(b) / p.c * 100;
    if (bodyPct >= 4 && body(b) / range(b) >= 0.6) add('candle', up(b) ? 1 : -1, `큰 ${up(b) ? '양봉' : '음봉'}(몸통 ${bodyPct.toFixed(1)}%)`);
    if (body(b) / range(b) <= 0.1) note('candle', '십자선(도지): 방향 고민, 다음 봉으로 확인');
    if (lowerW(b) >= 2 * body(b) && upperW(b) <= body(b) && nearLow) add('candle', 1, '망치형(10일 저점 부근 아래꼬리 반격)');
    if (upperW(b) >= 2 * body(b) && lowerW(b) <= body(b) && nearHigh) add('candle', -1, '유성형(10일 고점 부근 위꼬리)');
    if (!up(p) && up(b) && b.o <= p.c && b.c >= p.o && body(b) > body(p)) add('candle', 1, '상승 장악형');
    if (up(p) && !up(b) && b.o >= p.c && b.c <= p.o && body(b) > body(p)) add('candle', -1, '하락 장악형');
    if (body(p) / p.c * 100 >= 3 && Math.max(b.o, b.c) < Math.max(p.o, p.c) && Math.min(b.o, b.c) > Math.min(p.o, p.c)) note('candle', `하라미(큰 ${up(p) ? '양봉' : '음봉'} 안의 작은 봉): 추세 힘 약화`);
    if (pp && !up(pp) && body(pp) / pp.c * 100 >= 3 && body(p) <= body(pp) * 0.4 && up(b) && b.c > (pp.o + pp.c) / 2) add('candle', 2, '모닝스타');
    if (pp && up(pp) && body(pp) / pp.c * 100 >= 3 && body(p) <= body(pp) * 0.4 && !up(b) && b.c < (pp.o + pp.c) / 2) add('candle', -2, '이브닝스타');
    if (young) {
      const allLow = Math.min(...bars.map(x => x.l));
      if (b.l === allLow && up(b) && (b.c - b.l) / range(b) >= 0.6) add('candle', 1, `상장 후 최저가(${allLow})에서 양봉 반등, 고가 근처 마감`);
    }

    // 3. 패턴
    const w20 = bars.slice(Math.max(0, i - 20), i), boxHi = Math.max(...w20.map(x => x.h)), boxLo = Math.min(...w20.map(x => x.l));
    const boxW = (boxHi - boxLo) / boxLo * 100;
    if (b.c > boxHi) add('pattern', vx >= 2 ? 2 : 1, `20일 박스 상단(${boxHi}) 돌파${vx >= 2 ? ' + 거래량' : ', 거래량 부족'}`);
    else if (b.c < boxLo) add('pattern', vx >= 2 ? -2 : -1, `20일 박스 하단(${boxLo}) 이탈${vx >= 2 ? ' + 거래량' : ''}`);
    else if (boxW <= 12) note('pattern', `박스권(폭 ${boxW.toFixed(1)}%): 기다려`);
    const w40 = bars.slice(Math.max(0, i - 40), i + 1), lows = [], highs = [];
    for (let k = 2; k < w40.length - 2; k++) {
      const x = w40[k];
      if (x.l <= Math.min(w40[k - 1].l, w40[k - 2].l, w40[k + 1].l, w40[k + 2].l)) lows.push(k);
      if (x.h >= Math.max(w40[k - 1].h, w40[k - 2].h, w40[k + 1].h, w40[k + 2].h)) highs.push(k);
    }
    if (lows.length >= 2) { const [a, c2] = lows.slice(-2); if (c2 - a >= 5 && Math.abs(w40[a].l - w40[c2].l) / w40[a].l <= 0.03) { const neck = Math.max(...w40.slice(a, c2 + 1).map(x => x.h)); if (b.c > neck) add('pattern', 2, `쌍바닥 완성(넥라인 ${neck} 돌파)`); else note('pattern', `쌍바닥 진행 중(넥라인 ${neck})`); } }
    if (highs.length >= 2) { const [a, c2] = highs.slice(-2); if (c2 - a >= 5 && Math.abs(w40[a].h - w40[c2].h) / w40[a].h <= 0.03) { const neck = Math.min(...w40.slice(a, c2 + 1).map(x => x.l)); if (b.c < neck) add('pattern', -2, `쌍봉 완성(넥라인 ${neck} 이탈)`); else note('pattern', `쌍봉 경계(넥라인 ${neck})`); } }
    if (highs.length >= 2 && lows.length >= 2 && w40[highs.at(-1)].h < w40[highs.at(-2)].h && w40[lows.at(-1)].l > w40[lows.at(-2)].l) note('pattern', '삼각수렴: 방향 나올 때까지 기다려');

    // 4. 거래량
    const vLabel = young ? '최근 5일 평균' : '20일 평균';
    if (vx >= 2) note('volume', `거래량 ${vx.toFixed(1)}배(${vLabel}): 신호 신뢰도 높음`);
    else if (vx < 0.7) note('volume', `거래량 ${vx.toFixed(1)}배(${vLabel}): 신호 약함`);
    else note('volume', `거래량 ${vx.toFixed(1)}배(${vLabel})`);

    // 5. 시장 대비 상대 강도 (오늘)
    if (mkt && !isNaN(mkt.chg)) {
      const diff = chg - mkt.chg;
      if (diff >= 3) add('rel', 1, `${mkt.idx}(${mkt.chg}%) 대비 +${diff.toFixed(1)}%p 강함`);
      else if (diff <= -3) add('rel', -1, `${mkt.idx}(${mkt.chg}%) 대비 ${diff.toFixed(1)}%p 약함`);
      else note('rel', `${mkt.idx}(${mkt.chg}%) 대비 ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%p`);
    }

    const buyBan = out.filters.length > 0;
    const waitFlag = [...out.candle, ...out.pattern].some(t => /기다려|도지/.test(t));
    let verdict;
    if (out.score >= 3) verdict = buyBan ? '기다려 (점수는 매수 쪽, 추세선 하락이라 매수 금지)' : '사라 (진입 검토)';
    else if (out.score <= -3) verdict = '팔아라 (보유 중이면 정리 검토)';
    else if (waitFlag) verdict = '기다려 (방향 확인 전)';
    else verdict = out.score > 0 ? '관찰 (약한 매수 쪽)' : out.score < 0 ? '관찰 (약한 매도 쪽)' : '관찰';
    return { date: b.d, close: b.c, chg: chg.toFixed(2), score: out.score, verdict, stopRef: lo10, ...out };
  }

  async function check(code) {
    const { bars, src } = await load(code);
    if (bars.length < 8) return { code, src, error: '데이터 부족' };
    const mkt = await indexChg(code);
    return { code, src, ...analyze(bars, mkt) };
  }
  return { load, analyze, check };
})()
