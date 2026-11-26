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
const nation = require('./nation');
const hypothesis = require('./hypothesis');
const merit = require('./merit');
const benchmark = require('./benchmark');
const generalRank = require('./general_rank');
const paths2 = require('./paths');
const council = require('./council');
const councilScore = require('./council_score');

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

  // 입금 확인 대기 배지만(출사표 003) — 확정은 관문(62910)에서
  try {
    const dd = paths2.resolveDataDir(opts2 || {});
    const readL = (name) => {
      const d = path.join(dd, 'ledger', name);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
    };
    const decided = new Set(readL('flow_decision').map((r) => r.flow_id));
    const pendingFlows = readL('flow_pending').filter((r) => !decided.has(r.id)).length;
    if (pendingFlows > 0) {
      H.push(`<p><span class="badge" style="background:#9a6b00">입금 확인 대기 ${pendingFlows}건</span> <a href="http://127.0.0.1:${gatePort()}/flows">관문에서 확인</a></p>`);
    }
  } catch (e) { /* 집계 실패 시 생략 */ }

  // 출사표 실행 창(관문 62910 제공)으로 가는 링크만 — 현황판 자체는 계속 읽기 전용
  H.push('<p><a href="/nations">세력전 대시보드 (촉·위·오)</a></p>');
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

// 손자약해 정본 규칙(지령 005): mode=practice인 동안 병법서는 '연습장'임을 띠로 표시
function practiceBand() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'hypothesis.json'), 'utf8'));
    if (cfg.mode === 'practice') {
      return '<div style="background:#9a6b00;color:#fff;padding:8px 16px">연습장 — 정본은 Aside 병법서(이관 전)</div>';
    }
  } catch (e) { /* 설정 없으면 띠 생략 */ }
  return null;
}

function renderHypList(opts) {
  const items = hypothesis.list(opts);
  const H = pageHead('병법서 — 가설 장부');
  const band = practiceBand();
  if (band) H.splice(2, 0, band);
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
  const band = practiceBand();
  if (band) H.splice(2, 0, band);
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

// ====================== 세력전 대시보드(SCR-006 / TSK-023) — 읽기 전용 ======================

const NATION_KO = { chok: '촉', wi: '위', o: '오' };
const TRACK_KO = { chok: '트랙A(규칙 그대로)', wi: 'B-예약형(매복)', o: 'B-확인형' };

// 주의 월요일(KST 날짜 문자열 기준)
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=일
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function pct(x, digits) {
  return (x * 100).toFixed(digits == null ? 1 : digits);
}

// 기준선 원장에서 나라별 최신 수익률(%): (value − invested) ÷ invested
function benchNationReturns(opts) {
  try {
    const d = path.join(paths2.resolveDataDir(opts), 'ledger', 'benchmark');
    if (!fs.existsSync(d)) return null;
    const rows = fs.readdirSync(d)
      .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse))
      .filter((r) => r.nations && !r.missing)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const last = rows[rows.length - 1];
    if (!last) return null;
    const out = {};
    for (const n of nation.NATIONS) {
      const b = last.nations[n];
      out[n] = b && b.invested ? (b.value - b.invested) / b.invested : null;
    }
    return out;
  } catch (e) {
    return null;
  }
}

function renderNations(opts, weekParam) {
  const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
  const from = weekParam || mondayOf(today);
  const to = addDays(from, 4);
  const { ledgers, violations } = nation.computeLedger(opts);
  const integ = nation.checkIntegrity(opts);
  const weekly = nation.weeklyReport({ from, to }, opts);
  const bench = benchNationReturns(opts);

  const H = pageHead('세력전 — 촉·위·오');
  if (!integ.ok) {
    const n = integ.warnings.length;
    H.splice(2, 0, `<div style="background:#b3261e;color:#fff;padding:8px 16px;font-weight:bold">장부 어긋남 — 정합성 경고 ${n}건: 저장 장부와 체결 재계산이 다르다. 일일 점검 필요</div>`);
  }
  if (violations.length) {
    H.push(`<section><h3>귀속 위반</h3><p style="color:#b3261e">${violations.map(esc).join('<br>')}</p></section>`);
  }

  // 빈 상태: 세력전 기록 자체가 없음
  const anyRows = nation.NATIONS.some((n) => weekly.nations[n].sorties > 0) ||
    Object.values(ledgers).some((L) => L.cash !== L.allocated || L.position_value > 0 || L.realized_pnl !== 0);
  const hasAnyHistory = (() => {
    try {
      const d = path.join(paths2.resolveDataDir(opts), 'ledger', 'order_log');
      return fs.existsSync(d) && fs.readdirSync(d).length > 0;
    } catch (e) { return false; }
  })();
  if (!anyRows && !hasAnyHistory) {
    H.push('<section><p class="muted">출병 전 — 월요일 군의에서 개전합니다</p></section>');
  }

  // 나라별 카드
  const perStockLimit = 250000;
  const posLists = {};
  for (const n of nation.NATIONS) {
    posLists[n] = Object.entries(ledgers[n].positions || {}).filter(([, p]) => p.qty > 0);
  }
  for (const n of nation.NATIONS) {
    const L = ledgers[n];
    const open = posLists[n];
    H.push(`<section><h2>${NATION_KO[n]} <span class="muted" style="font-size:12px">${TRACK_KO[n]}</span></h2>`);
    H.push(`<p class="num">배정 ${won(L.allocated)}원 · 군량(현금) ${won(L.cash)}원 · 평가 ${won(L.position_value)}원</p>`);
    const rPct = pct(L.return_rate);
    let exText = '기준선 없음';
    if (bench && bench[n] != null) {
      const ex = L.return_rate - bench[n];
      exText = `${(ex * 100).toFixed(1)}%p`;
    }
    H.push(`<p class="num">수익률 ${rPct}% · 기준선(KODEX 200 보유) 대비 초과 ${exText}</p>`);
    H.push(`<p class="num">보유 성 ${open.length}/2성 · 실현손익 ${won(L.realized_pnl)}원</p>`);
    if (open.length) {
      H.push('<table><tr><th>성(종목)</th><th>투입</th><th>종목당 25만 사용률</th></tr>');
      for (const [sym, p] of open) {
        H.push(`<tr><td>${esc(sym)}</td><td class="num">${won(p.cost)}원</td><td class="num">${pct(p.cost / perStockLimit, 0)}%</td></tr>`);
      }
      H.push('</table>');
    }
    H.push('</section>');
  }

  // 주간 순위표(논공행상 — 월요일 군의용)
  const ranked = nation.NATIONS.slice().sort((a, b) => weekly.nations[b].pnl - weekly.nations[a].pnl);
  H.push(`<section><h2>주간 순위표 <span class="muted" style="font-size:12px">${esc(from)} ~ ${esc(to)}</span></h2>`);
  H.push('<table><tr><th>순위</th><th>나라</th><th>손익</th><th>출병 수</th><th>매복 성공률</th></tr>');
  ranked.forEach((n, i) => {
    const w = weekly.nations[n];
    const ambush = n !== 'wi' ? '해당 없음' : (w.ambush_rate == null ? '해당 없음(예약 0건)' : `${w.ambush_rate.toFixed(1)}%`);
    H.push(`<tr><td>${i + 1}</td><td>${NATION_KO[n]}</td><td class="num">${won(w.pnl)}원</td><td class="num">${w.sorties}회</td><td>${ambush}</td></tr>`);
  });
  H.push('</table>');
  H.push('<p class="muted" style="font-size:12px">손익: 그 주에 매도로 확정한 금액. 출병 수: 매수가 체결된 횟수. 매복 성공률: 걸어둔 예약 주문 중 실제 체결된 비율(예약 전술을 쓰는 위나라만 해당).</p>');
  const prevWeek = addDays(from, -7);
  const nextWeek = addDays(from, 7);
  H.push(`<p><a href="/nations?week=${prevWeek}">이전 주</a> · <a href="/nations?week=${nextWeek}">다음 주</a> · <a href="/nations">이번 주</a></p>`);
  H.push('</section>');

  H.push('<p><a href="/">군영 현황판으로</a> · <a href="/merit">논공행상</a></p>');
  H.push('<p class="muted" style="font-size:12px">읽기 전용 — 숫자는 모의 체결 장부에서 매번 재계산(저장값 신뢰 안 함).</p>');
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
// ====================== 책사단 의견판(SCR-009)·공적판(SCR-010) — 읽기 전용(TSK-027) ======================
const STANCE_BADGE = { '출병': '출병', '관망': '관망', '반대': '반대', '회군': '회군' };

// 의견판: 안건별 7인 의견 표 + 제갈량 종합 박스(가중합·불일치율) + 가후 고정 영역
function renderCouncil(opts, agendaFilter) {
  let rows = council.readVerdicts(opts).filter((r) => !r.type);
  if (agendaFilter) rows = rows.filter((r) => r.agenda_id === agendaFilter);
  const H = pageHead('책사단 — 의견판');
  const byAgenda = new Map();
  for (const r of rows) {
    if (!byAgenda.has(r.agenda_id)) byAgenda.set(r.agenda_id, []);
    byAgenda.get(r.agenda_id).push(r);
  }
  if (byAgenda.size === 0) {
    H.push('<section><p class="muted">오늘 안건 없음 — 결정할 것이 있는 날에만 책사단이 열린다</p></section>');
  } else {
    const agendas = [...byAgenda.entries()].sort((a, b) => String(b[1][0].date).localeCompare(String(a[1][0].date)));
    for (const [agendaId, items] of agendas) {
      const first = items[0];
      const syn = items.find((r) => r.advisor === '제갈량');
      const gahu = items.find((r) => r.advisor === '가후');
      const opinions = items.filter((r) => r.advisor !== '제갈량');
      H.push(`<section><h2>${esc(first.date)} · ${esc(first.name || first.ticker)}(${esc(first.ticker)}) · ${first.agenda_type === 'hold' ? '보유 점검' : '진입 검토'} <span class="muted">${esc(agendaId)}</span></h2>`);
      H.push('<table><tr><th>책사</th><th>의견</th><th>확신</th><th>근거</th><th>관직(기록 시점)</th><th>생성</th></tr>');
      for (const o of opinions) {
        const rankKo = o.rank_at_time ? `${o.rank_at_time.rank === 'jongsa' ? '종사' : o.rank_at_time.rank === 'chamgun' ? '참군' : '군사중랑장'} x${o.rank_at_time.weight}` : '-';
        const src = o.source === 'fallback' ? '<span class="muted">폴백</span>' : o.source === 'rule' ? '숫자 규칙' : 'AI';
        H.push(`<tr><td>${esc(o.advisor)}</td><td>${esc(STANCE_BADGE[o.stance] || o.stance)}</td><td class="num">${o.confidence}</td><td>${esc(o.rationale)}</td><td>${rankKo}</td><td>${src}</td></tr>`);
      }
      H.push('</table>');
      if (syn) {
        H.push(`<p><b>제갈량 종합: ${esc(syn.stance)}</b> (확신 ${syn.confidence}) — ${esc(syn.rationale)}` +
          (syn.disagreement != null ? ` · 불일치율 ${syn.disagreement}%` : '') + '</p>');
      } else {
        H.push('<p class="muted">종합 없음 — 의견 불충분(유효 의견 4건 미만)</p>');
      }
      if (gahu) H.push(`<p><b>가후(반대 전담 — 항상 표시)</b>: ${esc(gahu.stance)} · ${esc(gahu.rationale)}</p>`);
      H.push('</section>');
    }
  }
  H.push('<p class="muted">참고용, 최종 결정은 군주 — 이 화면에는 실행 기능이 없다</p></main></body></html>');
  return H.join('\n');
}

// 공적판: 책사별 관직·적중률·표본·최근 10건·승강 이력 + 한목소리 경고
function renderCouncilMerit(opts) {
  // 캐시(ranks.json) 결손이어도 장부에서 순수 재계산(쓰기 없음) — 500 금지
  const ranks = council.readRanks(opts) || councilScore.computeRanks(opts);
  const dw = councilScore.disagreementWarning(opts);
  const H = pageHead('책사단 — 공적판');
  if (dw.warn) {
    H.push(`<div style="background:#9a2b00;color:#fff;padding:8px 16px">한목소리 경고 — 최근 ${dw.count}안건 불일치율 평균 ${dw.avg}% (20% 미만: 책사단이 사실상 한 명)</div>`);
  }
  const names = Object.keys(ranks);
  if (names.length === 0 || names.every((n) => ranks[n].counted === 0)) {
    H.push('<section><p class="muted">채점된 판정 없음 — 의견 후 5거래일 뒤부터 쌓인다</p></section>');
  }
  if (names.length > 0) {
    H.push('<section><table><tr><th>책사</th><th>관직</th><th>가중</th><th>판정</th><th>적중률</th><th>최근 10건</th><th>비고</th></tr>');
    for (const n of names.sort()) {
      const r = ranks[n];
      const badge = r.counted < 10 ? ' <b>[참고 수준 — 표본 10건 미만]</b>' : '';
      H.push(`<tr><td>${esc(n)}</td><td>${esc(r.label || r.rank)}</td><td class="num">x${r.weight}</td>` +
        `<td class="num">${r.counted}건</td><td class="num">${r.hit_rate != null ? r.hit_rate + '%' : '-'}</td>` +
        `<td class="num">${r.recent10_hit_rate != null ? r.recent10_hit_rate + '%' : '-'}</td><td>${badge}</td></tr>`);
    }
    H.push('</table>');
    for (const n of names.sort()) {
      const h = (ranks[n].history || []);
      if (h.length === 0) continue;
      H.push(`<p class="muted">${esc(n)} 승강 이력: ${h.map((x) => `${esc(String(x.at))} ${esc(x.from)}→${esc(x.to)}(${esc(x.reason)})`).join(' / ')}</p>`);
    }
    H.push('</section>');
  }
  H.push('<p class="muted">채점 = 의견 후 5거래일, KODEX 200 대비 방향 — 참고용, 최종 결정은 군주</p></main></body></html>');
  return H.join('\n');
}

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
    if (url === '/nations') {
      const week = new URL(req.url, 'http://x').searchParams.get('week');
      let html;
      try {
        html = renderNations(opts, week);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('집계 실패');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url === '/merit') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderMerit(opts));
      return;
    }
    // 책사단(TSK-027 / SCR-009·010) — 읽기 전용 조회
    if (url === '/council') {
      const agendaFilter = new URL(req.url, 'http://x').searchParams.get('agenda');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCouncil(opts, agendaFilter));
      return;
    }
    if (url === '/council/merit') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCouncilMerit(opts));
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
