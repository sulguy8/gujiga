'use strict';

// 허도 관문(gatekeeper) — 로컬 키 중계 서버 (TSK-017 / ARC-009, TSK-005에서 2단계 전환)
//
// gujiga 프로세스가 127.0.0.1 전용 HTTP 서버를 띄워 KIS 호출을 대행한다.
// ARC-009 2단계(TSK-005): 주문 검사 로직을 관문 자체 검사에서 **단일 주문 게이트(gate.submit)**
// 경유로 단일화했다 — 관문은 인증·전달만 하고, 7단계 검사·order_log 기록은 게이트가 한다.
// kis_adapter는 이 모듈에서 직접 require하지 않는다(AC3 — gate만이 유일 통로).
//
// 보안(ARC-009):
//  - 바인딩 127.0.0.1 전용(비루프백 설정 거부) + Host 헤더 검사(DNS 리바인딩 방지).
//  - 관문 토큰: 기동 때마다 무작위 생성, 지정 파일에만 기록(재기동 시 교체).
//    모든 /call 요청에 x-gate-token 필수 — 없거나 틀리면 401.
//  - 응답·로그에 키·KIS 토큰 값 기록 금지.
//
// Aside 클라이언트 주문(지시5): created_by='aside_chat' 출사표로 변환해 게이트에 넣는다.
//  reason은 필수(없으면 거부), confirmed 값·reason은 게이트가 order_log에 기록한다.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const gate = require('./gate');
const ledger = require('./ledger');
const paths = require('./paths');
const { kstParts } = require('./kst');

const LOOPBACK = '127.0.0.1';
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'gatekeeper.json');
const CSRF_TTL_MS = 10 * 60 * 1000; // 실행 창 CSRF 토큰 유효 10분(1회용)

function loadConfig(opts) {
  if (opts && (opts.port != null || opts.tokenFile)) {
    return {
      host: opts.host || LOOPBACK,
      port: opts.port != null ? opts.port : 62910,
      tokenFile: opts.tokenFile,
    };
  }
  const p = (opts && opts.configPath) || process.env.GUJIGA_GATE_CONFIG || DEFAULT_CONFIG_PATH;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { host: cfg.host || LOOPBACK, port: cfg.port != null ? cfg.port : 62910, tokenFile: cfg.token_file };
}

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const name = String(hostHeader).split(':')[0].toLowerCase();
  return name === 'localhost' || name === LOOPBACK;
}

// Aside 주문 호출 → 출사표(aside_chat) 변환(지시5).
// 5항목은 opt로 받는다(stop_price·target_price·deadline — 출사표 없이 출병 금지 원칙 그대로).
function asideDraft(env, side, symbol, qty, price, opt) {
  opt = opt || {};
  const today = kstParts(new Date()).date;
  return {
    account_type: env === 'real' ? 'real' : 'paper',
    nation: opt.nation != null ? opt.nation : null,
    symbol, side, qty, price,
    entry_low: price, entry_high: price,
    stop_price: opt.stop_price != null ? opt.stop_price : (opt.stop != null ? opt.stop : null),
    target_price: opt.target_price != null ? opt.target_price : (opt.target != null ? opt.target : null),
    deadline: opt.deadline || today,
    troops: Math.max(1, Math.floor((qty * price) / 10000)),
    hypothesis_ids: Array.isArray(opt.hypothesis_ids) ? opt.hypothesis_ids : null,
    user_confirmed: opt.confirmed === true,
    created_by: 'aside_chat',
    reason: opt.reason,
  };
}

// ====================== 출사표 확인·실행 창 (TSK-010 / SCR-001) ======================
// 현황판(62900)은 읽기 전용이므로, 실행 창은 관문이 같은 출처(same-origin)로 직접 제공한다.
// 보안: 페이지 로드 때 1회용 CSRF 토큰 발급, 실행/반려 POST는 CSRF + Origin(루프백) 검사.
// 이 경로의 실전 전송은 정책상 잠김(created_by='ui'/'ai'/'system' — TSK-012 전) — 모의만 실제 동작.

function readRows(dataDir, name) {
  const d = paths.ledgerDir(dataDir, name);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}
// 미결 출사표 = order_draft − 결정(draft_decision)된 것
function pendingDrafts(dataDir) {
  const decided = new Set(readRows(dataDir, 'draft_decision').map((r) => r.draft_id));
  return readRows(dataDir, 'order_draft').filter((d) => !decided.has(d.id));
}
// 주문 수량·지정가 산출: 매수는 가격대 상한, 매도는 하한. 병력(1만원=1명) → 수량.
function orderParams(d) {
  const price = d.side === 'buy' ? d.entry_high : d.entry_low;
  const qty = Math.max(1, Math.floor((d.troops * 10000) / price));
  return { price, qty };
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function won(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '없음';
}
function originAllowed(originHeader) {
  return typeof originHeader === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(originHeader);
}

const PAGE_CSS = [
  'body{font-family:system-ui,Malgun Gothic,sans-serif;margin:0;background:#f4f1ea;color:#222}',
  'header{background:#3b2f2f;color:#f4f1ea;padding:12px 16px;font-weight:bold}',
  'main{max-width:680px;margin:0 auto;padding:12px}',
  'section{background:#fff;border:1px solid #d8d2c4;border-radius:8px;padding:12px 14px;margin:10px 0}',
  'table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eee}',
  '.band-red{background:#b3261e;color:#fff;padding:8px 16px;font-weight:bold}',
  '.band-amber{background:#9a6b00;color:#fff;padding:8px 16px}',
  '.badge{display:inline-block;border-radius:4px;padding:2px 8px;font-size:12px;margin-left:6px;color:#fff}',
  '.b-real{background:#b3261e}.b-paper{background:#1d5c2e}.b-by{background:#44506b}',
  'button{font-size:15px;padding:8px 18px;border-radius:6px;border:1px solid #999;cursor:pointer}',
  '#execute{background:#1d5c2e;color:#fff;border-color:#1d5c2e}#execute[disabled]{background:#aaa;border-color:#aaa;cursor:not-allowed}',
  '#reject{background:#fff}',
  '.muted{color:#777}.num{font-variant-numeric:tabular-nums}',
].join('');

function renderList(drafts) {
  const H = [`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>출사표 목록</title><style>${PAGE_CSS}</style></head><body>`];
  H.push('<header>출사표 — 확인·실행 대기</header><main>');
  if (drafts.length === 0) {
    H.push('<section><p class="muted">대기 중인 출사표 없음</p></section>');
  } else {
    H.push('<section><table><tr><th>출사표</th><th>구분</th><th>종목</th><th>병력</th><th></th></tr>');
    for (const d of drafts) {
      H.push(`<tr><td class="num">${esc(d.id)}</td><td>${d.account_type === 'real' ? '실전' : '모의'} ${esc(d.side)}</td>` +
        `<td>${esc(d.symbol)}</td><td class="num">${d.troops}명</td>` +
        `<td><a href="/draft?id=${encodeURIComponent(d.id)}">열기</a></td></tr>`);
    }
    H.push('</table></section>');
  }
  H.push('<p class="muted">읽고 결정하는 곳 — 실행은 사람만 누른다. 참고용, 최종 결정은 본인.</p></main></body></html>');
  return H.join('\n');
}

function renderDetail(d, pre, csrf, realLocked) {
  const { price, qty } = orderParams(d);
  const blocked = pre.blocked;
  const H = [`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>출사표 ${esc(d.id)}</title><style>${PAGE_CSS}</style></head><body>`];
  if (blocked && pre.reason === 'stop_file') H.push('<div class="band-red">전군 정지 중 — STOP 파일 감지, 모든 주문 중단</div>');
  if (realLocked) H.push('<div class="band-amber">실전 잠김(TSK-012 전) — 이 창의 실전 전송은 아직 열리지 않았다(모의만 동작)</div>');
  H.push(`<header>출사표 ${esc(d.id)}` +
    `<span class="badge ${d.account_type === 'real' ? 'b-real' : 'b-paper'}">${d.account_type === 'real' ? '실전' : '모의'}</span>` +
    `<span class="badge b-by">작성: ${d.created_by === 'ai' ? 'AI' : esc(d.created_by)}</span></header><main>`);

  H.push('<section><h3>출사표 5항목</h3><table>');
  H.push(`<tr><th>진입 가격대</th><td class="num">${won(d.entry_low)} ~ ${won(d.entry_high)}원</td></tr>`);
  H.push(`<tr><th>손절선(성벽)</th><td class="num">${d.stop_price == null ? '없음 — 불성립' : won(d.stop_price) + '원'}</td></tr>`);
  H.push(`<tr><th>목표가</th><td class="num">${won(d.target_price)}원</td></tr>`);
  H.push(`<tr><th>기한</th><td class="num">${esc(d.deadline)}</td></tr>`);
  H.push(`<tr><th>병력</th><td class="num">${d.troops}명 (${won(d.troops * 10000)}원)</td></tr>`);
  H.push(`<tr><th>주문 예정</th><td class="num">${qty}주 × ${won(price)}원 지정가</td></tr>`);
  if (d.rationale) H.push(`<tr><th>근거</th><td>${esc(d.rationale)}</td></tr>`);
  H.push('</table></section>');

  H.push('<section><h3>검사 결과판 (관문 7단계)</h3>');
  if (!blocked) {
    H.push('<p>전부 통과 — 실행 가능</p>');
  } else {
    const label = pre.reason && pre.reason.startsWith('draft_invalid') ? `출사표 불성립 (${esc(pre.reason)})` : esc(pre.reason);
    H.push(`<p>차단: <b>${label}</b></p>`);
    if (pre.detail && Object.keys(pre.detail).length) H.push(`<p class="num muted">수치: ${esc(JSON.stringify(pre.detail))}</p>`);
  }
  H.push('</section>');

  H.push('<section><h3>결정</h3>');
  H.push(`<button id="execute"${blocked ? ' disabled' : ''}>실행</button> `);
  H.push('<button id="reject">반려</button> <a href="/drafts">닫기</a>');
  // 2단 확인(오터치 방지): 1단 클릭 → 확인 영역 노출 → "출병시키겠습니까?" 확정
  H.push('<div id="confirm2" style="display:none;margin-top:10px;padding:10px;border:1px solid #b3261e;border-radius:6px">');
  H.push('<p><b>2단 확인:</b> 출병시키겠습니까? 이 동작은 주문을 전송한다.</p>');
  H.push(`<button id="confirmYes" style="background:#b3261e;color:#fff;border-color:#b3261e">출병 확정</button> <button id="confirmNo">물러서기</button></div>`);
  H.push('<div id="result" class="num"></div>');
  H.push(`<input type="hidden" name="csrf" value="${csrf}">`);
  H.push('</section>');

  H.push('<script>');
  H.push(`const CSRF=${JSON.stringify(csrf)},ID=${JSON.stringify(d.id)};`);
  H.push("const $=id=>document.getElementById(id);");
  H.push("$('execute').addEventListener('click',()=>{if($('execute').disabled)return;$('confirm2').style.display='block';});");
  H.push("$('confirmNo').addEventListener('click',()=>{$('confirm2').style.display='none';});");
  H.push("$('confirmYes').addEventListener('click',async()=>{const r=await fetch('/draft/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ID,csrf:CSRF})});const j=await r.json();$('result').textContent=j.ok?('접수 완료: '+(j.result&&j.result.odno||'')):('거부: '+(j.error||r.status));$('confirm2').style.display='none';});");
  H.push("$('reject').addEventListener('click',async()=>{const why=prompt('반려 사유(선택)')||'';const r=await fetch('/draft/reject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ID,csrf:CSRF,reason:why})});const j=await r.json();$('result').textContent=j.ok?'반려 처리됨':'오류';});");
  H.push('</script>');
  H.push('<p class="muted">참고용, 최종 결정은 본인.</p></main></body></html>');
  return H.join('\n');
}

// opts: { dataDir, keysPath, port, host, tokenFile, baseUrls, gapMs, fillPollMs, fillPollMax, configPath }
function start(opts) {
  opts = opts || {};
  const cfg = loadConfig(opts);
  if (cfg.host !== LOOPBACK && cfg.host !== 'localhost') {
    return Promise.reject(new Error(`비루프백 바인딩 금지: ${cfg.host} — 127.0.0.1만 허용`));
  }
  if (!cfg.tokenFile) return Promise.reject(new Error('관문 토큰 파일 경로 미지정'));

  // 기동 시 무작위 토큰 생성 → 지정 파일에만 기록(재기동 시 교체).
  // ※ 이 파일은 Aside 폴더에서 유일하게 쓰기가 허용된 파일이다(군사 지시).
  const gateToken = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(cfg.tokenFile), { recursive: true });
  fs.writeFileSync(cfg.tokenFile, gateToken, 'utf8');

  // 게이트에 넘길 공통 옵션(어댑터 생성 정보 포함 — 키는 게이트/어댑터 안에서만)
  const gateOpts = {
    dataDir: opts.dataDir, keysPath: opts.keysPath,
    baseUrls: opts.baseUrls, gapMs: opts.gapMs,
    fillPollMs: opts.fillPollMs, fillPollMax: opts.fillPollMax,
  };

  // 실행 창 CSRF 저장소(1회용·10분 유효)
  const csrfStore = new Map();
  function issueCsrf() {
    const t = crypto.randomBytes(16).toString('hex');
    csrfStore.set(t, Date.now() + CSRF_TTL_MS);
    return t;
  }
  function consumeCsrf(t) {
    const exp = csrfStore.get(t);
    csrfStore.delete(t); // 1회용 — 맞든 틀리든 소모
    return typeof exp === 'number' && exp > Date.now();
  }

  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const html = (code, s) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(s);
    };
    if (!hostAllowed(req.headers.host)) return reply(403, { ok: false, error: 'localhost 전용' });

    // 기동 확인(무인증 — 데이터 없음)
    if (req.method === 'GET' && req.url === '/ping') return reply(200, { ok: true, service: 'gujiga-gatekeeper' });

    const urlPath = req.url.split('?')[0];

    // ---- 입금 확인 대기(출사표 003): flow_pending 확정/거부 — judgments 패턴 재사용 ----
    if (req.method === 'GET' && urlPath === '/flows') {
      const dataDir2 = paths.resolveDataDir(opts);
      const decided = new Set(readRows(dataDir2, 'flow_decision').map((r) => r.flow_id));
      const pend = readRows(dataDir2, 'flow_pending').filter((r) => !decided.has(r.id));
      const csrf = issueCsrf();
      const H = [`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>입금 확인 대기</title><style>${PAGE_CSS}</style></head><body>`];
      H.push('<header>군량 수송 확인 — 입출금 추정(현금 기준)</header><main>');
      if (pend.length === 0) {
        H.push('<section><p class="muted">확인 대기 항목 없음</p></section>');
      } else {
        H.push('<section><table><tr><th>날짜</th><th>금액</th><th>근거</th><th>결정</th></tr>');
        for (const p of pend) {
          H.push(`<tr><td>${esc(p.date)}</td><td class="num">${won(p.amount)}원</td>` +
            `<td class="num muted">현금 ${won(p.prev_cash)} → ${won(p.today_cash)} (체결 설명 ${won(p.explained_cash || 0)})</td>` +
            `<td><button onclick="flow('${esc(p.id)}','confirm')">입출금 확정</button> <button onclick="flow('${esc(p.id)}','reject')">아님(거부)</button></td></tr>`);
        }
        H.push('</table>');
        H.push(`<input type="hidden" name="csrf" value="${csrf}">`);
        H.push('<div id="result" class="num"></div></section>');
        H.push('<script>');
        H.push(`const CSRF=${JSON.stringify(csrf)};`);
        H.push("async function flow(id,act){const why=act==='reject'?(prompt('거부 사유')||''):'';const r=await fetch('/flow/'+act,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,csrf:CSRF,reason:why})});const j=await r.json();document.getElementById('result').textContent=j.ok?'처리됨 — 새로고침':'오류: '+(j.error||r.status);}");
        H.push('</script>');
      }
      H.push('<p class="muted">확정하면 기준선에 같은 금액 매매 가정으로 반영된다(benchmark.recordFlow). 참고용, 최종 결정은 본인.</p></main></body></html>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(H.join('\n'));
      return;
    }
    if (req.method === 'POST' && (urlPath === '/flow/confirm' || urlPath === '/flow/reject')) {
      if (!originAllowed(req.headers.origin)) return reply(403, { ok: false, error: '출처(Origin) 거부' });
      let fb = '';
      req.on('data', (c) => (fb += c));
      req.on('end', () => {
        let p;
        try {
          p = JSON.parse(fb);
        } catch (e) {
          return reply(400, { ok: false, error: 'bad_json' });
        }
        if (!p || !consumeCsrf(p.csrf)) return reply(403, { ok: false, error: 'CSRF 토큰 없음/불일치/재사용' });
        const dataDir2 = paths.resolveDataDir(opts);
        const decided = new Set(readRows(dataDir2, 'flow_decision').map((r) => r.flow_id));
        const row = readRows(dataDir2, 'flow_pending').find((r) => r.id === p.id && !decided.has(r.id));
        if (!row) return reply(404, { ok: false, error: '대기 항목 없음(이미 결정됐을 수 있음)' });
        try {
          if (urlPath === '/flow/confirm') {
            const benchmarkMod = require('./benchmark');
            benchmarkMod.recordFlow({ date: row.date, account: 'real', amount: row.amount }, gateOpts);
            ledger.append('flow_decision', { id: crypto.randomUUID(), flow_id: row.id, action: 'confirmed', created_at: new Date().toISOString() }, gateOpts);
            return reply(200, { ok: true, action: 'confirmed' });
          }
          ledger.append('flow_decision', { id: crypto.randomUUID(), flow_id: row.id, action: 'rejected', reason: (p.reason || '').slice(0, 200) || null, created_at: new Date().toISOString() }, gateOpts);
          return reply(200, { ok: true, action: 'rejected' });
        } catch (e) {
          return reply(500, { ok: false, error: e.message });
        }
      });
      return;
    }

    // ---- 군주 판정 대기(TSK-021 / REQ-024): 판정식 없는 증거의 success/fail 확정 ----
    // 조회는 현황판(62900)이 아니라 여기(관문)에서 — 확정 POST는 same-origin+CSRF로만.
    if (req.method === 'GET' && urlPath === '/judgments') {
      const hypMod = require('./hypothesis');
      const pend = hypMod.pendingJudgments(gateOpts);
      const csrf = issueCsrf();
      const H = [`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>군주 판정 대기</title><style>${PAGE_CSS}</style></head><body>`];
      H.push('<header>논공행상 — 군주 판정 대기</header><main>');
      if (pend.length === 0) {
        H.push('<section><p class="muted">판정 대기 증거 없음</p></section>');
      } else {
        H.push('<section><table><tr><th>가설</th><th>날짜</th><th>내용</th><th>종류</th><th>결정</th></tr>');
        for (const p of pend) {
          H.push(`<tr><td>${esc(p.hypothesis_id)}</td><td>${esc(p.evidence_date)}</td><td>${esc(p.note)}</td>` +
            `<td>${p.kind === 'trade' ? '출병' : '관찰'}</td>` +
            `<td><button onclick="judge('${esc(p.id)}','success')">적중</button> <button onclick="judge('${esc(p.id)}','fail')">빗나감</button></td></tr>`);
        }
        H.push('</table>');
        H.push(`<input type="hidden" name="csrf" value="${csrf}">`);
        H.push('<div id="result" class="num"></div></section>');
        H.push('<script>');
        H.push(`const CSRF=${JSON.stringify(csrf)};`);
        H.push("async function judge(id,outcome){const r=await fetch('/judgment/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,outcome,csrf:CSRF})});const j=await r.json();document.getElementById('result').textContent=j.ok?('확정됨(judged_by=군주) — 새로고침하여 다음 판정':'오류: '+(j.error||r.status));}");
        H.push('</script>');
      }
      H.push('<p class="muted">판정 기준: 손익이 아니라 가설의 예측 적중 여부. 참고용, 최종 결정은 본인.</p></main></body></html>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(H.join('\n'));
      return;
    }
    if (req.method === 'POST' && urlPath === '/judgment/confirm') {
      if (!originAllowed(req.headers.origin)) return reply(403, { ok: false, error: '출처(Origin) 거부' });
      let jb = '';
      req.on('data', (c) => (jb += c));
      req.on('end', () => {
        let p;
        try {
          p = JSON.parse(jb);
        } catch (e) {
          return reply(400, { ok: false, error: 'bad_json' });
        }
        if (!p || !consumeCsrf(p.csrf)) return reply(403, { ok: false, error: 'CSRF 토큰 없음/불일치/재사용' });
        if (!['success', 'fail'].includes(p.outcome)) return reply(400, { ok: false, error: 'outcome은 success/fail' });
        try {
          const hypMod = require('./hypothesis');
          const ev = hypMod.confirmPending(p.id, p.outcome, gateOpts); // judged_by='군주' 기록·집계 갱신
          return reply(200, { ok: true, evidence_id: ev.id, judged_by: ev.judged_by });
        } catch (e) {
          return reply(404, { ok: false, error: e.message });
        }
      });
      return;
    }

    // ---- 출사표 확인·실행 창(사람 전용 화면 — same-origin·CSRF·Origin 검사) ----
    if (req.method === 'GET' && urlPath === '/drafts') {
      return html(200, renderList(pendingDrafts(paths.resolveDataDir(opts))));
    }
    if (req.method === 'GET' && urlPath === '/draft') {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      const d = pendingDrafts(paths.resolveDataDir(opts)).find((x) => x.id === id);
      if (!d) return html(404, '<p>출사표 없음</p>');
      const { price, qty } = orderParams(d);
      // 검사 미리보기: 실행 시점과 같게 user_confirmed=true 가정(사람이 누르는 창이므로)
      return gate.precheck(Object.assign({}, d, { user_confirmed: true, qty, price, reason: d.rationale || '실행 창' }), gateOpts)
        .then((pre) => {
          const realLocked = d.account_type === 'real' && !pre.realAllowed;
          html(200, renderDetail(d, pre, issueCsrf(), realLocked));
        })
        .catch(() => html(200, renderDetail(d, { blocked: true, reason: 'precheck_failed', detail: {} }, issueCsrf(), d.account_type === 'real')));
    }
    if (req.method === 'POST' && (urlPath === '/draft/execute' || urlPath === '/draft/reject')) {
      // Origin(루프백 출처만) 검사 — DNS 리바인딩·외부 페이지發 요청 방지
      if (!originAllowed(req.headers.origin)) return reply(403, { ok: false, error: '출처(Origin) 거부' });
      let body2 = '';
      req.on('data', (c) => (body2 += c));
      req.on('end', async () => {
        let p;
        try {
          p = JSON.parse(body2);
        } catch (e) {
          return reply(400, { ok: false, error: 'bad_json' });
        }
        if (!p || !consumeCsrf(p.csrf)) return reply(403, { ok: false, error: 'CSRF 토큰 없음/불일치/재사용' });
        const d = pendingDrafts(paths.resolveDataDir(opts)).find((x) => x.id === p.id);
        if (!d) return reply(404, { ok: false, error: '출사표 없음(이미 결정됐을 수 있음)' });

        if (urlPath === '/draft/reject') {
          ledger.append('draft_decision', {
            id: crypto.randomUUID(), draft_id: d.id, action: 'cancelled',
            reject_reason: (p.reason || '').slice(0, 200) || null, created_at: new Date().toISOString(),
          }, gateOpts);
          return reply(200, { ok: true, action: 'cancelled' });
        }

        // 실행: 사람의 확인 행위 — user_confirmed=true, created_by는 유지. 게이트가 최종 재검사.
        const { price, qty } = orderParams(d);
        const confirmedAt = new Date().toISOString();
        const r = await gate.submit(Object.assign({}, d, {
          user_confirmed: true, confirmed_at: confirmedAt, qty, price,
          reason: d.rationale || '실행 창 확정',
        }), gateOpts);
        if (r.ok) {
          ledger.append('draft_decision', {
            id: crypto.randomUUID(), draft_id: d.id, action: 'executed',
            confirmed_at: confirmedAt, broker_order_no: (r.result && r.result.odno) || null,
            created_at: new Date().toISOString(),
          }, gateOpts);
        }
        return reply(200, r.ok ? { ok: true, result: r.result, fill: r.fill } : { ok: false, blocked: r.blocked === true, error: r.error });
      });
      return;
    }

    if (req.method !== 'POST' || urlPath !== '/call') return reply(404, { ok: false, error: 'not_found' });
    if (req.headers['x-gate-token'] !== gateToken) return reply(401, { ok: false, error: '관문 토큰 없음/불일치' });

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        return reply(400, { ok: false, error: 'bad_json' });
      }
      const { env, fn, args } = payload || {};
      if (!['mock', 'real'].includes(env)) return reply(400, { ok: false, error: 'bad_env' });

      try {
        if (fn === 'order') {
          const [side, symbol, qty, price, opt] = args || [];
          // reason 필수(지시5) — 없는 주문은 받지 않는다
          if (!opt || typeof opt.reason !== 'string' || !opt.reason.trim()) {
            return reply(200, { ok: false, blocked: true, error: '주문 거부: reason(사유) 필수 — 출사표 없는 출병 금지' });
          }
          const r = await gate.submit(asideDraft(env, side, symbol, qty, price, opt), gateOpts);
          return reply(200, r.ok
            ? { ok: true, result: r.result, fill: r.fill }
            : { ok: false, blocked: r.blocked === true, error: r.error });
        }
        if (fn === 'modify') {
          const r = await gate.amend(env, args || [], gateOpts);
          return reply(200, { ok: true, result: r });
        }
        if (fn === 'cancel') {
          const r = await gate.revoke(env, args || [], gateOpts);
          return reply(200, { ok: true, result: r });
        }
        if (['price', 'balance', 'fills', 'dailyCandle'].includes(fn)) {
          const r = await gate.query(env, fn, args || [], gateOpts);
          return reply(200, { ok: true, result: r });
        }
        return reply(400, { ok: false, error: 'bad_fn' });
      } catch (e) {
        // 오류에 키·토큰이 섞이지 않도록 메시지만(게이트·어댑터 오류는 값 미포함 설계)
        return reply(200, { ok: false, error: String(e.message || '관문 내부 오류') });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, LOOPBACK, () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        address: addr.address,
        tokenFile: cfg.tokenFile,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { start };
