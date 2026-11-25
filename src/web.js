'use strict';

// 로컬 웹 서버 — 군영 현황판 (TSK-009 / ARC-001 확정: localhost 전용)
//
// 보안 원칙(군사 지시):
//  1) 127.0.0.1에만 바인딩(0.0.0.0 등 비루프백 설정은 거부). Host 헤더가
//     localhost/127.0.0.1이 아니면 403(DNS 리바인딩 방지).
//  3) 읽기 전용: GET만 허용(405), 쓰기 경로·API 없음. 외부 CDN·폰트 0(완전 오프라인).
//  6) 상주 등록 없음 — start()와 1회 실행 명령(bin/run-dashboard.js)만.
//
// 숫자는 장부 그대로, 화면 문구는 삼국지 용어, 이모지 금지(지시5).

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const board = require('./camp_board');
const hypothesis = require('./hypothesis');
const merit = require('./merit');
const benchmark = require('./benchmark');
const generalRank = require('./general_rank');
const paths2 = require('./paths');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'web.json');
const LOOPBACK = '127.0.0.1';

function loadConfig(opts) {
  if (opts && (opts.port != null || opts.host)) {
    return { host: (opts && opts.host) || LOOPBACK, port: opts.port != null ? opts.port : 62900 };
  }
  const p = (opts && opts.configPath) || process.env.GUJIGA_WEB_CONFIG || DEFAULT_CONFIG_PATH;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { host: cfg.host || LOOPBACK, port: cfg.port != null ? cfg.port : 62900 };
}

// Host 헤더 허용 목록: localhost / 127.0.0.1 (+포트)
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const name = String(hostHeader).split(':')[0].toLowerCase();
  return name === 'localhost' || name === LOOPBACK;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function won(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '없음';
}

// ---- 화면 렌더(서버 사이드, 외부 리소스 0) ----
function render(data, opts2) {
  const H = [];
  H.push('<!doctype html><html lang="ko"><head><meta charset="utf-8">');
  H.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  H.push('<title>군영 현황판</title>');
  H.push('<style>');
  H.push('body{font-family:system-ui,Malgun Gothic,sans-serif;margin:0;background:#f4f1ea;color:#222}');
  H.push('header{background:#3b2f2f;color:#f4f1ea;padding:12px 16px;font-size:18px;font-weight:bold}');
  H.push('main{max-width:720px;margin:0 auto;padding:12px}');
  H.push('section{background:#fff;border:1px solid #d8d2c4;border-radius:8px;padding:12px 14px;margin:10px 0}');
  H.push('h2{font-size:15px;margin:0 0 8px;border-bottom:1px solid #e5e0d4;padding-bottom:6px}');
  H.push('table{width:100%;border-collapse:collapse;font-size:14px}');
  H.push('th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eee}');
  H.push('.band-red{background:#b3261e;color:#fff;padding:8px 16px;font-weight:bold}');
  H.push('.band-amber{background:#9a6b00;color:#fff;padding:8px 16px}');
  H.push('.badge{display:inline-block;background:#1d5c2e;color:#fff;border-radius:4px;padding:2px 8px;font-size:12px;margin-left:8px}');
  H.push('.muted{color:#777}.num{font-variant-numeric:tabular-nums}');
  H.push('.ration-warn{color:#9a6b00;font-weight:bold}');
  H.push('</style></head><body>');
  H.push(`<header>군영 현황판 <span class="muted" style="font-size:12px;color:#cfc8b8">${esc(data.today)}</span></header>`);

  // 띠: 복수 출병 금지(포로 발생일)
  if (data.revengeBan) {
    H.push('<div class="band-red">오늘은 복수 출병 금지 — 포로가 발생한 날에는 신규 출병을 하지 않는다(군령)</div>');
  }
  // 위반 띠
  const rk = data.rank;
  if (rk.ok && rk.lastViolation) {
    H.push(`<div class="band-amber">군령 위반 기록: ${esc(rk.lastViolation.violation_date)} ${esc(rk.lastViolation.code)} — 승진 카운트 초기화됨</div>`);
  }

  H.push('<main>');

  // 1) 관직 카드
  H.push('<section><h2>관직</h2>');
  if (!rk.ok) {
    H.push('<p>집계 실패</p>');
  } else {
    H.push(`<p><b>${esc(rk.label)}</b>${rk.eligible ? '<span class="badge">승진 가능 — 확정은 군주 수락</span>' : ''}</p>`);
    H.push(`<p class="num">한 성 최대 병력 ${won(rk.perStockLimitWon)}원 · 동시 ${rk.concurrentMax == null ? '재량' : rk.concurrentMax + '성'}</p>`);
    H.push(`<p class="num muted">승진 진행 — 출병 ${rk.sortie}/5 · 무위반 ${rk.clean}주 · 주간 복기 ${rk.review}/4주 · 위반 ${rk.violationCount}건</p>`);
  }
  H.push('</section>');

  // 2) 병력 요약
  const fc = data.forces;
  H.push('<section><h2>병력 요약</h2>');
  if (!fc.ok) {
    H.push('<p>집계 실패</p>');
  } else if (fc.empty) {
    H.push('<p class="muted">계좌 스냅샷 없음 — 병력 집계는 08:30 스냅샷 이후 표시된다</p>');
  } else {
    H.push(`<p class="num">총 병력 ${fc.totalTroops}명 (총평가 ${won(fc.totalEval)}원, ${esc(fc.date)} ${fc.accountType === 'real' ? '실전' : '모의'})</p>`);
    const cls = fc.rationWarn ? ' class="ration-warn"' : '';
    H.push(`<p${cls}>군량(현금) ${won(fc.cash)}원 · 비중 ${fc.cashRatioPct == null ? '없음' : fc.cashRatioPct + '%'}${fc.rationWarn ? ' — 군량 30% 경계 접근' : ''}</p>`);
  }
  H.push('</section>');

  // 3) 출병 중인 성
  const cs = data.castles;
  H.push('<section><h2>출병 중인 성</h2>');
  if (!cs.ok) {
    H.push('<p>집계 실패</p>');
  } else if (cs.none || cs.rows.length === 0) {
    H.push('<p class="muted">전군 주둔 중 — 출병한 성 없음</p>');
  } else {
    H.push('<table><tr><th>성(종목)</th><th>병사</th><th>투입</th><th>성벽(손절선)</th><th>성벽까지</th></tr>');
    for (const r of cs.rows) {
      H.push(`<tr><td>${esc(r.name)}(${esc(r.symbol)})${r.nation ? ` <span class="muted">${esc(r.nation)}</span>` : ''}</td>` +
        `<td class="num">${r.troops}명</td><td class="num">${won(r.amount)}원</td>` +
        `<td class="num">${won(r.stopPrice)}원</td><td>${r.stopDistance == null ? '없음(시세 미연결)' : esc(r.stopDistance)}</td></tr>`);
    }
    H.push('</table>');
  }
  H.push('</section>');

  // 4) 포로·전공
  const cp = data.captives;
  H.push('<section><h2>포로·전공</h2>');
  if (!cp.ok) {
    H.push('<p>집계 실패</p>');
  } else {
    for (const [key, label] of [['real', '실전'], ['paper', '모의']]) {
      const s = cp[key];
      H.push(`<p class="num">${label}: 포로 ${s.captives}명 · 구출까지 ${won(s.lossOutstanding)}원 · 누적 전공 ${won(s.meritTotal)}원</p>`);
    }
  }
  H.push('</section>');

  // 비교 기준선 요약 1줄(TSK-022 — SCR-005 보강)
  try {
    const bs = benchmark.summary(opts2 || {});
    if (bs) {
      H.push('<section><h2>천시 - 비교 기준선(KODEX 200)</h2>');
      if (bs.warn4w) H.push('<p style="color:#b3261e"><b>경고: 4주 연속 초과수익 마이너스 - 지수 보유보다 못함</b></p>');
      H.push(`<p class="num">우리 ${bs.ours.returnPct == null ? '없음' : bs.ours.returnPct + '%'} · 기준선 ${bs.bench.returnPct == null ? '없음' : bs.bench.returnPct + '%'} · 초과 ${bs.excessPp == null ? '없음' : bs.excessPp + '%p'} · 낙폭 ${bs.ours.mddPct}%/${bs.bench.mddPct}%${bs.missingDays ? ' · 결측 ' + bs.missingDays + '일' : ''}</p>`);
      H.push('</section>');
    }
  } catch (e) { /* 집계 실패 시 생략 */ }

  // 출사표 실행 창(관문 62910 제공)으로 가는 링크만 — 현황판 자체는 계속 읽기 전용
  H.push(`<p><a href="http://127.0.0.1:${gatePort()}/drafts">출사표 확인·실행 창 열기 (관문)</a></p>`);
  H.push('<p class="muted" style="font-size:12px">읽기 전용 현황판 — 숫자는 장부 값 그대로. 참고용, 최종 결정은 본인.</p>');
  H.push('</main></body></html>');
  return H.join('\n');
}

// ====================== 병법서(SCR-007)·논공행상(SCR-006) — 읽기 전용(TSK-021) ======================
// 조회는 현황판(62900)에서, '군주 판정 대기' 확정은 관문(62910) POST+CSRF에서만.

const STATUS_KO = { hypothesis: '가설', testing: '검증 중', verified: '검증됨', discarded: '폐기' };
const QUAD_KO = { merit: '전공', fluke: '요행', honorable_defeat: '명예로운 패배', true_failure: '진짜 실패', draw: '무승부' };

function bar(n, max) {
  const filled = Math.max(0, Math.min(max, n));
  return '■'.repeat(filled) + '□'.repeat(Math.max(0, max - filled));
}

// 등급별 병력 상한(REQ-023와 동일 규칙 — 안내 전용)
function gradeCapText(status, opts) {
  const lim = generalRank.getLimits(opts);
  const base = lim.perStockTroopsMax;
  const rankLabel = lim.label || lim.rank;
  if (status === 'verified') return base == null ? `${rankLabel} 기준 재량(전부)` : `${rankLabel} 기준 ${base}명(전부)`;
  if (status === 'testing') return base == null ? `${rankLabel} 기준 재량` : `${rankLabel} 기준 ${Math.floor(base / 2)}명(절반 버림)`;
  if (status === 'hypothesis') return '정찰대 10명(고정)';
  return '출병 불가(폐기)';
}

function renderHypList(opts) {
  const items = hypothesis.list(opts);
  const H = pageHead('병법서 — 가설 장부');
  H.push('<section><table><tr><th>가설</th><th>분류</th><th>상태</th><th>표본</th><th>출병</th><th></th></tr>');
  for (const h of items) {
    H.push(`<tr><td>${esc(h.code)}</td><td>${esc(h.category)}</td><td>${STATUS_KO[h.status] || esc(h.status)}</td>` +
      `<td class="num">${h.evidence_count}/10</td><td class="num">${h.trade_count}/3</td>` +
      `<td><a href="/hypothesis?id=${encodeURIComponent(h.id)}">열기</a></td></tr>`);
  }
  H.push('</table></section>');
  H.push('<p class="muted">판정 대기 확정은 관문 창에서: <a href="http://127.0.0.1:' + gatePort() + '/judgments">군주 판정 대기</a></p>');
  H.push('</main></body></html>');
  return H.join('\n');
}

function renderHypDetail(h, opts) {
  const cfgMin = 10;
  const tradeMin = 3;
  const H = pageHead(`병법서 — ${h.code}`);
  H.push('<section>');
  H.push(`<h3>${esc(h.code)} <span class="muted">(${STATUS_KO[h.status] || esc(h.status)})</span></h3>`);
  H.push(`<p>${esc(h.statement)}</p>`);
  H.push(`<p class="num">표본 진행 ${bar(h.evidence_count, cfgMin)} ${h.evidence_count}/${cfgMin}</p>`);
  H.push(`<p class="num">출병 증거 ${bar(h.trade_count, tradeMin)} ${h.trade_count}/${tradeMin}</p>`);
  if (h.evidence_count >= cfgMin && h.trade_count >= tradeMin && h.status === 'testing') {
    H.push('<p><b>승격 가능</b> — 표본 완료(검증됨 전이는 군주 결정)</p>');
  }
  if (h.reference_only) H.push('<p class="muted">참고 수준(표본 10건 미만)</p>');
  H.push(`<p>판정식: ${h.judge_expr ? `<code>${esc(h.judge_expr)}</code>` : '없음 — 논공행상 군주 판정'}</p>`);
  H.push(`<p>등급별 병력 상한: ${gradeCapText(h.status, opts)}</p>`);
  H.push('</section>');
  // 증거 목록
  const evs = hypothesis.evidences(h.id, opts);
  H.push('<section><h3>증거</h3><table><tr><th>날짜</th><th>결과</th><th>종류</th><th>판정</th><th>내용</th></tr>');
  for (const e of evs) {
    H.push(`<tr><td>${esc(e.evidence_date)}</td><td>${e.outcome === 'success' ? '적중' : '빗나감'}</td>` +
      `<td>${e.kind === 'trade' ? '출병' : '관찰'}</td><td>${esc(e.judged_by)}</td><td>${esc(e.note)}</td></tr>`);
  }
  H.push('</table></section>');
  H.push('<p><a href="/hypotheses">목록으로</a></p></main></body></html>');
  return H.join('\n');
}

function readTradeResults(opts) {
  const fsLocal = fs;
  const d = path.join(paths2.resolveDataDir(opts), 'ledger', 'trade_result');
  if (!fsLocal.existsSync(d)) return [];
  const out = [];
  for (const f of fsLocal.readdirSync(d)) {
    for (const line of fsLocal.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

function renderMerit(opts) {
  const trades = readTradeResults(opts);
  const r = merit.report(trades);
  const H = pageHead('논공행상 — 성적표 4분면');
  H.push('<section><h3>성적표 4분면 (손익 × 근거 준수)</h3>');
  H.push('<table><tr><th></th><th>준수</th><th>위반</th></tr>');
  H.push(`<tr><th>수익</th><td class="q-merit">전공 ${r.counts.merit}</td><td class="q-fluke">요행 (경고) ${r.counts.fluke}</td></tr>`);
  H.push(`<tr><th>손실</th><td class="q-honor">명예로운 패배 <span class="badge" style="background:#1d5c2e">명예</span> ${r.counts.honorable_defeat}</td>` +
    `<td class="q-fail" style="color:#b3261e">진짜 실패 ${r.counts.true_failure}</td></tr>`);
  H.push('</table>');
  H.push(`<p class="num">무승부(0원) ${r.counts.draw}건 · 근거 준수율 ${r.compliantRatePct == null ? '해당 없음' : r.compliantRatePct + '%'} (${r.compliantCount}/${r.total})</p>`);
  H.push('</section>');
  // 비교 기준선(KODEX 200) — 4종 지표(TSK-022 / REQ-027)
  const bs = benchmark.summary(opts);
  H.push('<section><h3>비교 기준선 - KODEX 200 보유 시</h3>');
  if (!bs) {
    H.push('<p class="muted">기준선 원장 없음</p>');
  } else {
    if (bs.warn4w) H.push('<p class="q-fail" style="color:#b3261e"><b>경고: 4주 연속 초과수익 마이너스 - 지수 보유보다 못함</b></p>');
    H.push(`<p class="num">우리 ${bs.ours.returnPct == null ? '없음' : bs.ours.returnPct + '%'} · 기준선 ${bs.bench.returnPct == null ? '없음' : bs.bench.returnPct + '%'} · 초과 ${bs.excessPp == null ? '없음' : bs.excessPp + '%p'} · 최대 낙폭 우리 ${bs.ours.mddPct}% / 기준선 ${bs.bench.mddPct}%</p>`);
    if (bs.missingDays > 0) H.push(`<p class="muted">결측 ${bs.missingDays}일 - 직전 종가 유지로 계산</p>`);
  }
  H.push('</section>');

  // 거래 목록(손익 열과 별도로 분면 표기)
  H.push('<section><h3>거래별</h3><table><tr><th>날짜</th><th>종목</th><th>손익</th><th>분면</th></tr>');
  for (const t of trades) {
    const q = merit.quadrantOf(Object.assign({}, t, { compliant: merit.isCompliant(t) }));
    const cls = q === 'honorable_defeat' ? 'q-honor' : q === 'true_failure' ? 'q-fail' : `q-${q}`;
    H.push(`<tr><td>${esc(t.date || '')}</td><td>${esc(t.symbol || '')}</td><td class="num">${won(t.pnl)}원</td><td class="${cls}">${QUAD_KO[q]}</td></tr>`);
  }
  H.push('</table></section>');
  H.push('<p class="muted">판정 대기 확정: <a href="http://127.0.0.1:' + gatePort() + '/judgments">군주 판정 대기(관문)</a></p>');
  H.push('</main></body></html>');
  return H.join('\n');
}

function pageHead(title) {
  const H = [];
  H.push(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`);
  H.push('<style>body{font-family:system-ui,Malgun Gothic,sans-serif;margin:0;background:#f4f1ea;color:#222}header{background:#3b2f2f;color:#f4f1ea;padding:12px 16px;font-weight:bold}main{max-width:720px;margin:0 auto;padding:12px}section{background:#fff;border:1px solid #d8d2c4;border-radius:8px;padding:12px 14px;margin:10px 0}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eee}.muted{color:#777}.num{font-variant-numeric:tabular-nums}.badge{display:inline-block;border-radius:4px;padding:1px 6px;font-size:11px;color:#fff}.q-honor{background:#e8f4ee}.q-fail{background:#fbeaea}</style></head><body>');
  H.push(`<header>${esc(title)}</header><main>`);
  return H;
}

// 관문 포트(설정 파일 — 기본 62910)
function gatePort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'gatekeeper.json'), 'utf8'));
    return cfg.port != null ? cfg.port : 62910;
  } catch (e) {
    return 62910;
  }
}

// ---- 서버 ----
// opts: { dataDir, port, host, configPath, today }
// 반환: { port, address, close() }
function start(opts) {
  opts = opts || {};
  const cfg = loadConfig(opts);

  // 루프백 외 바인딩 거부(지시1 — 0.0.0.0 금지)
  if (cfg.host !== LOOPBACK && cfg.host !== 'localhost') {
    return Promise.reject(new Error(`비루프백 바인딩 금지: ${cfg.host} — 127.0.0.1만 허용`));
  }

  const server = http.createServer((req, res) => {
    // DNS 리바인딩 방지: Host 헤더 검증
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 — localhost 전용');
      return;
    }
    // 읽기 전용: GET만
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
      res.end('405 — 읽기 전용(GET만 허용)');
      return;
    }
    const url = req.url.split('?')[0];
    // 병법서·논공행상(TSK-021) — 읽기 전용 조회
    if (url === '/hypotheses') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHypList(opts));
      return;
    }
    if (url === '/hypothesis') {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      const h = hypothesis.get(id, opts);
      if (!h) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('가설 없음');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHypDetail(h, opts));
      return;
    }
    if (url === '/merit') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderMerit(opts));
      return;
    }
    if (url === '/' || url === '/index.html') {
      let html;
      try {
        html = render(board.gather(opts), opts);
      } catch (e) {
        // 조립 실패도 500 텍스트로만 — 쓰기 없음
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('집계 실패');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, LOOPBACK, () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        address: addr.address,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { start, render, loadConfig };
