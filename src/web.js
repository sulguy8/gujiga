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
const symbols = require('./symbols');
const terms = require('./ui_terms');

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

// ---- 화면 렌더(서버 사이드, 외부 리소스 0 — 지령 016 '주군의 군영': 카드·칩·게이지) ----
// NATION_KO는 아래(세력전 렌더부)의 기존 선언을 공용으로 쓴다.
const NATION_COLOR = { chok: '#2f8f5b', wi: '#3b6fb6', o: '#c0453a' }; // 촉 초록·위 파랑·오 빨강(지령 016)

function render(data, opts2, extras) {
  extras = extras || {};
  const H = [];
  H.push('<!doctype html><html lang="ko"><head><meta charset="utf-8">');
  H.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  H.push(`<title>${terms.TERMS.home_title}</title>`);
  H.push('<style>');
  H.push(':root{--fg:#2b2420;--mutefg:#7a6f66;--mute:#e6dfd6;--card:#fffdf9;--border:#e0d8cd;--ok:#2f8f5b;--bad:#c0453a;--r:10px}');
  H.push('body{font:14px/1.5 system-ui,Malgun Gothic,sans-serif;margin:0;background:#f4f0ea;color:var(--fg)}');
  H.push('main{max-width:760px;margin:0 auto;padding:16px;display:grid;gap:22px}');
  H.push('.h1{font-size:24px;font-weight:600}.m{color:var(--mutefg);font-size:12px}');
  H.push('.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{background:var(--card);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:12px}.chip b{font-weight:600}');
  H.push('.sec{display:grid;gap:10px}.st{font-size:12px;color:var(--mutefg);border-bottom:1px solid var(--border);padding-bottom:6px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px}');
  H.push('.nations{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}');
  H.push('.n{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:14px;display:grid;gap:8px}.n .nm{font-size:18px;font-weight:600}.n .nm small{font-size:11px;color:var(--mutefg);font-weight:400;margin-left:6px}');
  H.push('.big{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}');
  H.push('.bar{height:6px;border-radius:3px;background:var(--mute);overflow:hidden}.bar i{display:block;height:100%}');
  H.push('.line{font-size:12px;color:var(--mutefg)}');
  H.push('.castle{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;display:grid;gap:8px}');
  H.push('.gauge{position:relative;height:30px}.track{position:absolute;top:13px;left:0;right:0;height:4px;background:var(--mute);border-radius:2px}');
  H.push('.mk{position:absolute;top:0;font-size:10px;color:var(--mutefg);transform:translateX(-50%);white-space:nowrap}.dot{position:absolute;top:9px;width:12px;height:12px;border-radius:50%;background:#3b6fb6;transform:translateX(-50%)}');
  H.push('.rows{display:grid;gap:6px}.row{display:flex;justify-content:space-between;gap:12px;font-size:13px;flex-wrap:wrap}');
  H.push('.pos{color:var(--ok)}.neg{color:var(--bad)}');
  H.push('.votes{display:flex;gap:4px;flex-wrap:wrap}.v{font-size:11px;padding:2px 8px;border-radius:999px;background:#f1ebe3}.v.go{background:#cde7d8}.v.no{background:#eecfcb}');
  H.push('.band-red{background:#b3261e;color:#fff;padding:8px 16px;font-weight:bold}.band-amber{background:#9a6b00;color:#fff;padding:8px 16px}');
  H.push('.badge{display:inline-block;background:#1d5c2e;color:#fff;border-radius:4px;padding:2px 8px;font-size:12px;margin-left:8px}');
  H.push('.muted{color:var(--mutefg)}.num{font-variant-numeric:tabular-nums}.ration-warn{color:#9a6b00;font-weight:bold}');
  H.push('</style></head><body>');

  // 띠: 복수 출병 금지(포로 발생일) — 보안·경고 문구는 줄이지 않는다
  if (data.revengeBan) {
    H.push('<div class="band-red">오늘은 복수 출병 금지 — 포로가 발생한 날에는 신규 출병을 하지 않는다(군령)</div>');
  }
  const rk = data.rank;
  if (rk.ok && rk.lastViolation) {
    H.push(`<div class="band-amber">군령 위반 기록: ${esc(rk.lastViolation.violation_date)} ${esc(rk.lastViolation.code)} — 승진 카운트 초기화됨</div>`);
  }

  H.push('<main>');

  // 1) 머리: 날짜·벼슬·다음 벼슬까지
  H.push('<div>');
  H.push(`<div class="h1">${terms.TERMS.home_title}</div>`);
  H.push(`<div class="m">${esc(data.today)}${rk.ok ? ` · ${esc(terms.TERMS.rank_progress(rk.label, rk.sortie))} · 한 성 최대 ${won(rk.perStockLimitWon)}원 · 동시 ${rk.concurrentMax == null ? '재량' : rk.concurrentMax + '성'}` : ''}${rk.ok && rk.eligible ? '<span class="badge">승진 가능 — 확정은 군주 수락</span>' : ''}</div>`);
  H.push('</div>');

  // 2) 상태 칩: 천하 정세·봉화·코스피·관문
  const mk2 = data.market;
  H.push('<div class="chips">');
  if (mk2) {
    H.push(`<span class="chip">${esc(terms.weatherTerm(mk2.weather))}</span>`);
    if (mk2.signalsOn != null) H.push(`<span class="chip">${esc(terms.TERMS.beacon(mk2.signalsOn))} 켜짐</span>`);
    if (mk2.kospiClose != null) H.push(`<span class="chip">코스피 <b>${won(mk2.kospiClose)}</b></span>`);
  } else {
    H.push(`<span class="chip">${esc(terms.TERMS.no_snapshot)}</span>`);
  }
  if (extras.gateOpen != null) H.push(`<span class="chip">${extras.gateOpen ? esc(terms.TERMS.gate_open) : esc(terms.TERMS.gate_closed)}</span>`);
  H.push('</div>');

  // 3) 삼국 정립(나라 카드 3장) — 데이터는 extras.nations(렌더 호출부에서 computeLedger)
  if (extras.nations) {
    H.push(`<div class="sec"><div class="st"><span>${terms.TERMS.nations_title}</span><span>${terms.TERMS.weekly_merit}${extras.weeklyTop ? `: ${esc(extras.weeklyTop)} 1위` : ''}</span></div><div class="nations">`);
    for (const nkey of ['chok', 'wi', 'o']) {
      const L = extras.nations[nkey];
      if (!L) continue;
      const pnl = Math.round((L.cash + L.position_value) - L.allocated);
      const usedPct = L.allocated > 0 ? Math.round(((L.allocated - L.cash) / L.allocated) * 100) : 0;
      const castleCount = (data.castles.ok ? data.castles.rows : []).filter((r) => r.nation === nkey).length;
      H.push(`<div class="n"><div class="nm" style="color:${NATION_COLOR[nkey]}">${NATION_KO[nkey]}<small>${esc(extras.nationTag && extras.nationTag[nkey] || '')}</small></div>` +
        `<div class="big ${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${pnl > 0 ? '+' : ''}${won(pnl)}원</div>` +
        `<div class="bar"><i style="width:${usedPct}%;background:${NATION_COLOR[nkey]}"></i></div>` +
        `<div class="line">군량 ${won(L.cash)}원 · 점령 성 ${castleCount}/2${extras.nationNote && extras.nationNote[nkey] ? ` · ${esc(extras.nationNote[nkey])}` : ''}</div></div>`);
    }
    H.push('</div></div>');
  }

  // 4) 점령 중인 성: 게이지(성벽 ─ 입성 ─ 깃발, 현재가 점)
  const cs = data.castles;
  H.push(`<div class="sec"><div class="st"><span>${terms.TERMS.castles_title}</span><span>${terms.TERMS.wall} = 손절선 · ${terms.TERMS.flag} = 목표</span></div>`);
  if (!cs.ok) {
    H.push('<p>집계 실패</p>');
  } else if (cs.none || cs.rows.length === 0) {
    H.push('<p class="muted">전군 주둔 중 — 점령한 성 없음</p>');
  } else {
    for (const r of cs.rows) {
      const nm = r.name && r.name !== r.symbol ? `${esc(r.name)}` : esc(r.symbol);
      const natKo = r.nation ? `${NATION_KO[r.nation] || esc(r.nation)}군 · ` : '';
      const hyp = (r.hypothesisIds || [])[0];
      H.push('<div class="castle">');
      H.push(`<div class="row"><span><b>${nm}</b> <span class="m">${natKo}${r.qty}주 · 병사 ${r.troops}명 · ${terms.TERMS.castle_enter} ${won(r.avgPrice)}원${hyp ? ` · 근거 ${esc(hyp.replace('HYP-', ''))}` : ''}</span></span>` +
        `<span class="${r.returnPct > 0 ? 'pos' : r.returnPct < 0 ? 'neg' : ''}">${r.returnPct != null ? (r.returnPct > 0 ? '+' : '') + esc(String(r.returnPct)) + '%' : '-'}</span></div>`);
      // 게이지: 성벽(0%) ~ 깃발(100%), 입성·현재가 위치 보간
      if (r.stopPrice != null && r.targetPrice != null && r.targetPrice > r.stopPrice) {
        const pct = (v) => Math.max(0, Math.min(100, Math.round(((v - r.stopPrice) / (r.targetPrice - r.stopPrice)) * 100)));
        H.push(`<div class="gauge"><div class="track"></div>` +
          `<span class="mk" style="left:0;transform:none">${terms.TERMS.wall} ${won(r.stopPrice)}</span>` +
          `<span class="mk" style="left:${pct(r.avgPrice)}%">${terms.TERMS.castle_enter} ${won(r.avgPrice)}</span>` +
          `<span class="mk" style="left:100%;transform:translateX(-100%)">${terms.TERMS.flag} ${won(r.targetPrice)}</span>` +
          (r.price != null ? `<div class="dot" style="left:${pct(r.price)}%"></div>` : '') + '</div>');
      }
      const dday = r.deadline ? Math.ceil((new Date(`${r.deadline}T00:00:00`) - new Date(`${data.today}T00:00:00`)) / 86400000) : null;
      H.push(`<div class="line">${terms.TERMS.wall}까지 ${r.stopDistance != null ? esc(String(-r.stopDistance)) + '% 여유' : `${terms.TERMS.no_quotes}`}` +
        `${r.flagDistance != null ? ` · ${terms.TERMS.flag}까지 ${r.flagDistance > 0 ? '+' : ''}${esc(String(r.flagDistance))}%` : ''}` +
        `${r.deadline ? ` · 퇴각 기한 ${esc(r.deadline)}${dday != null ? ` (D-${dday})` : ''}` : ''}</div>`);
      H.push('</div>');
    }
    H.push(cs.quoteAt
      ? `<p class="m">시세 기준: ${esc(String(cs.quoteAt))} (그림자 최근 조회 — 실시간 아님)</p>`
      : `<p class="m">${terms.TERMS.no_quotes} — 그림자 기동 후 연결</p>`);
  }
  H.push('</div>');

  // 5) 오늘의 군막 회의: 안건별 7인 의견 칩 + 군주 결정
  const cc = data.council;
  H.push(`<div class="sec"><div class="st"><span>${terms.TERMS.council_today}</span><span><a href="/council">${terms.TERMS.council_title} 전체</a></span></div>`);
  if (!cc || cc.none || cc.agendas.length === 0) {
    H.push('<p class="muted">오늘 안건 없음 — 결정할 것이 있는 날에만 열린다</p>');
  } else {
    H.push('<div class="rows">');
    for (const a of cc.agendas) {
      H.push(`<div class="row"><span>${esc(a.label)}</span><span class="m">${a.decision ? `주군 결정: ${esc(a.decision)}` : a.synthesis ? `제갈량: ${esc(a.synthesis)}` : ''}</span></div>`);
      H.push('<div class="votes">' + a.votes.map((v) => {
        const cls = v.stance === '출병' ? ' go' : (v.stance === '반대' || v.stance === '회군') ? ' no' : '';
        return `<span class="v${cls}">${esc(v.advisor)} ${esc(v.stance)}</span>`;
      }).join('') + '</div>');
    }
    H.push('</div>');
  }
  H.push('</div>');

  // 6) 전리품과 포로(실전·모의) + 병력 요약 + 천하 대세 대비
  const cp = data.captives;
  const fc = data.forces;
  H.push(`<div class="sec"><div class="st"><span>${terms.TERMS.loot_title}</span><span>${terms.TERMS.benchmark} 대비</span></div><div class="rows">`);
  if (cp.ok) {
    for (const [key, label] of [['real', '실전'], ['paper', '모의']]) {
      const s = cp[key];
      H.push(`<div class="row"><span>${label} · 포로 ${s.captives}명 · 구출까지 ${won(s.lossOutstanding)}원</span><span class="num ${s.meritTotal > 0 ? 'pos' : s.meritTotal < 0 ? 'neg' : ''}">누적 전공 ${won(s.meritTotal)}원</span></div>`);
    }
  }
  if (fc.ok && !fc.empty) {
    const cls = fc.rationWarn ? ' class="ration-warn"' : '';
    H.push(`<div class="row"><span${cls}>총 병력 ${fc.totalTroops}명 (${esc(fc.date)} ${fc.accountType === 'real' ? '실전' : '모의'}) · 군량 ${won(fc.cash)}원(${fc.cashRatioPct == null ? '-' : fc.cashRatioPct + '%'})${fc.rationWarn ? ' — 군량 30% 경계 접근' : ''}</span></div>`);
  } else if (fc.ok && fc.empty) {
    H.push(`<div class="row"><span class="muted">${terms.TERMS.no_snapshot}</span></div>`);
  }
  try {
    const bs = benchmark.summary(opts2 || {});
    if (bs) {
      if (bs.warn4w) H.push('<div class="row"><span class="neg"><b>경고: 4주 연속 초과수익 마이너스 - 지수 보유보다 못함</b></span></div>');
      H.push(`<div class="row"><span class="num">우리 ${bs.ours.returnPct == null ? '-' : bs.ours.returnPct + '%'} · ${terms.TERMS.benchmark} ${bs.bench.returnPct == null ? '-' : bs.bench.returnPct + '%'} · 초과 ${bs.excessPp == null ? '-' : bs.excessPp + '%p'}${bs.missingDays ? ' · 결측 ' + bs.missingDays + '일' : ''}</span></div>`);
    }
  } catch (e) { /* 집계 실패 시 생략 */ }
  H.push('</div></div>');

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

  // 옥새 찍는 곳(관문 62910 제공)으로 가는 링크만 — 이 화면 자체는 계속 읽기 전용
  H.push(`<p><a href="/nations">${terms.TERMS.nations_title} (촉·위·오)</a> · <a href="/council">${terms.TERMS.council_title}</a> · ` +
    `<a href="/council/merit">${terms.TERMS.merit_board}</a> · <a href="/hypotheses">병법서</a> · <a href="/merit">논공행상</a></p>`);
  H.push(`<p><a href="http://127.0.0.1:${gatePort()}/drafts">${terms.TERMS.gate_exec} 열기 (관문 — 출사표 확인·실행)</a></p>`);
  H.push(`<p class="m">읽기 전용 — 숫자는 장부 값 그대로. ${terms.TERMS.reference_note}.</p>`);
  H.push('</main></body></html>');
  return H.join('\n');
}

// 홈 부가 데이터(지령 016): 삼국 카드·이번 주 논공 1위·관문 열림 — 조회 전용(ping GET 1초)
async function homeExtras(opts) {
  const extras = {
    nationTag: { chok: '정공법 · 규칙대로', wi: '매복 전문', o: '확인 후 돌격' },
  };
  try {
    const qc = board.quotesCache(opts);
    extras.nations = nation.computeLedger(opts, qc ? qc.quotes : undefined).ledgers;
  } catch (e) { /* 세력 장부 없음 — 카드 생략 */ }
  try {
    const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
    const w = nation.weeklyReport({ from: mondayOf(today), to: addDays(mondayOf(today), 4) }, opts);
    const best = ['chok', 'wi', 'o'].map((n) => [n, w.nations[n].pnl]).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] !== 0) extras.weeklyTop = NATION_KO[best[0]];
  } catch (e) { /* 생략 */ }
  extras.gateOpen = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: gatePort(), path: '/ping', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
  return extras;
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
  H.push('<section><h3>천하 대세(KODEX 200) 보유 시 — 비교 기준선</h3>');
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
  // 평가는 그림자 시세 캐시(읽기 전용)로 — 없으면 원가 기준. 정합성 검사는 원가끼리 비교(캐시와 무관).
  const qc = board.quotesCache(opts);
  const { ledgers, violations } = nation.computeLedger(opts, qc ? qc.quotes : undefined);
  const integ = nation.checkIntegrity(opts);
  const weekly = nation.weeklyReport({ from, to }, opts);
  const bench = benchNationReturns(opts);

  const H = pageHead('삼국 정립 — 촉·위·오');
  H.push(qc
    ? `<p class="muted">평가 기준: ${esc(String(qc.updated_at))} 시세(그림자 최근 조회 — 실시간 아님)</p>`
    : '<p class="muted">시세 캐시 없음 — 평가는 원가(평단) 기준</p>');
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
  H.push(`<section><h2>이번 주 논공(주간 순위표) <span class="muted" style="font-size:12px">${esc(from)} ~ ${esc(to)}</span></h2>`);
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
function renderCouncil(opts, agendaFilter, dateFilter) {
  const everything = council.readVerdicts(opts);
  const all = everything.filter((r) => !r.type);
  // 보조 행(지령 015): amend(원본 보존 보강 — 의견에 조인), aside_synthesis(시범 종합·군주 결정)
  const amends = new Map(everything.filter((r) => r.type === 'amend').map((r) => [`${r.agenda_id}|${r.advisor}`, r]));
  const asideSynth = new Map(everything.filter((r) => r.type === 'aside_synthesis').map((r) => [r.agenda_id, r]));
  let rows = all;
  if (agendaFilter) rows = rows.filter((r) => r.agenda_id === agendaFilter);
  // 날짜 이동(SCR-009): ?date=YYYY-MM-DD — 기본은 최신 날짜(장부 누적 시 무한 나열 방지)
  if (!agendaFilter) {
    const dates = [...new Set(all.map((r) => r.date))].sort().reverse();
    const target = dateFilter || dates[0];
    if (target) rows = rows.filter((r) => r.date === target);
  }
  const H = pageHead('군막 회의 — 책사단 의견판');
  {
    const dates = [...new Set(all.map((r) => r.date))].sort().reverse();
    if (dates.length > 1) {
      H.push(`<p class="muted">날짜 이동: ${dates.map((d) => `<a href="/council?date=${esc(d)}">${esc(d)}</a>`).join(' · ')}</p>`);
    }
  }
  const byAgenda = new Map();
  for (const r of rows) {
    if (!byAgenda.has(r.agenda_id)) byAgenda.set(r.agenda_id, []);
    byAgenda.get(r.agenda_id).push(r);
  }
  if (byAgenda.size === 0) {
    H.push(agendaFilter || dateFilter
      ? '<section><p class="muted">해당 안건 없음 — 조건에 맞는 기록이 없다(전체는 /council)</p></section>'
      : '<section><p class="muted">오늘 안건 없음 — 결정할 것이 있는 날에만 책사단이 열린다</p></section>');
  } else {
    const agendas = [...byAgenda.entries()].sort((a, b) => String(b[1][0].date).localeCompare(String(a[1][0].date)));
    for (const [agendaId, items] of agendas) {
      const first = items[0];
      const syn = items.find((r) => r.advisor === '제갈량' && r.source === 'synthesis');
      const gahu = items.find((r) => r.advisor === '가후');
      const opinions = items.filter((r) => r.advisor !== '제갈량');
      const title = first.ticker
        ? `${esc(first.name || symbols.nameOf(first.ticker, opts) || first.ticker)}(${esc(first.ticker)})`
        : esc(first.agenda_label || '복합 안건');
      H.push(`<section><h2>${esc(first.date)} · ${title} · ${first.agenda_type === 'hold' ? '보유 점검' : '진입 검토'} <span class="muted">${esc(agendaId)}</span></h2>`);
      if (first.agenda_label && first.ticker) H.push(`<p class="muted">${esc(first.agenda_label)}</p>`);
      H.push('<table><tr><th>책사</th><th>의견</th><th>확신</th><th>근거</th><th>관직(기록 시점)</th><th>생성</th></tr>');
      for (const o of opinions) {
        const am = amends.get(`${agendaId}|${o.advisor}`);
        const rawView = o.raw_view || (am && am.raw_view) || null; // 원본 의견('정보 없음' 등) 보존 표시
        const rationale = (am && am.rationale) || o.rationale;
        const RANK_KO = { jongsa: '종사', chamgun: '참군', junglangjang: '군사중랑장' };
        const rankKo = o.rank_at_time ? `${RANK_KO[o.rank_at_time.rank] || esc(String(o.rank_at_time.rank))} x${esc(String(o.rank_at_time.weight))}` : '-';
        const src = o.source === 'fallback' ? '<span class="muted">폴백</span>' : o.source === 'rule' ? '숫자 규칙' : 'AI';
        const stanceCell = rawView ? `<span class="muted">${esc(rawView)}</span>` : esc(STANCE_BADGE[o.stance] || o.stance);
        H.push(`<tr><td>${esc(o.advisor)}</td><td>${stanceCell}</td><td class="num">${esc(String(o.confidence))}</td><td>${esc(rationale)}</td><td>${rankKo}</td><td>${src}</td></tr>`);
      }
      H.push('</table>');
      const aSyn = asideSynth.get(agendaId);
      if (syn) {
        H.push(`<p><b>제갈량 종합${syn.migrated ? '(시범 기록)' : ''}: ${esc(syn.stance)}</b> (확신 ${esc(String(syn.confidence))}) — ${esc(syn.rationale)}` +
          (syn.disagreement != null ? ` · 불일치율 ${esc(String(syn.disagreement))}%` : '') + '</p>');
      } else if (aSyn) {
        H.push(`<p><b>제갈량 종합(시범 기록)</b>: ${esc(aSyn.tally || '')} → ${esc(aSyn.pick || '')}</p>`);
      } else if (items.some((r) => r.migrated)) {
        H.push('<p class="muted">엔진 종합 없음 — 시범 기록 이관분(원본에 종합 미기재)</p>');
      } else if (opinions.filter((r) => r.source !== 'fallback').length < 4) {
        H.push('<p class="muted">종합 없음 — 의견 불충분(유효 의견 4건 미만)</p>');
      } else {
        H.push('<p class="muted">종합 미기록</p>');
      }
      if (aSyn && aSyn.decision_pick) {
        H.push(`<p><b>군주 결정</b>: ${esc(aSyn.decision_pick)}${aSyn.decided_at ? ` <span class="muted">(${esc(String(aSyn.decided_at))})</span>` : ''}</p>`);
      }
      if (gahu) {
        const gahuAm = amends.get(`${agendaId}|가후`);
        H.push(`<p><b>가후(반대 전담 — 항상 표시)</b>: ${esc(gahu.raw_view || (gahuAm && gahuAm.raw_view) || gahu.stance)} · ${esc((gahuAm && gahuAm.rationale) || gahu.rationale)}</p>`);
      }
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
  const H = pageHead('책사 공적부');
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
      H.push(`<tr><td>${esc(n)}</td><td>${esc(r.label || r.rank)}</td><td class="num">x${esc(String(r.weight))}</td>` +
        `<td class="num">${esc(String(r.counted))}건</td><td class="num">${r.hit_rate != null ? esc(String(r.hit_rate)) + '%' : '-'}</td>` +
        `<td class="num">${r.recent10_hit_rate != null ? esc(String(r.recent10_hit_rate)) + '%' : '-'}</td><td>${badge}</td></tr>`);
    }
    H.push('</table>');
    // 최근 판정 목록(SCR-010 3항): 안건·책사·입장·결과·상대 수익률 — 최근 20건
    const allRows = council.readVerdicts(opts);
    const byId = new Map(allRows.filter((x) => !x.type).map((x) => [x.id, x]));
    const recentScores = allRows.filter((x) => x.type === 'score')
      .sort((a, b) => String(b.scored_at).localeCompare(String(a.scored_at))).slice(0, 20);
    if (recentScores.length > 0) {
      H.push('<h3>최근 판정</h3><table><tr><th>채점일</th><th>안건</th><th>책사</th><th>입장</th><th>결과</th><th>상대 수익률</th></tr>');
      for (const ev of recentScores) {
        const v = byId.get(ev.verdict_id);
        if (!v) continue;
        H.push(`<tr><td>${esc(String(ev.scored_at))}</td><td>${esc(v.name || v.ticker)}(${esc(String(v.ticker))})</td>` +
          `<td>${esc(v.advisor)}</td><td>${esc(v.stance)}</td><td>${esc(ev.score_result)}</td>` +
          `<td class="num">${ev.rel_return != null ? esc(String(ev.rel_return)) + '%p' : '-'}</td></tr>`);
      }
      H.push('</table>');
    }
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
      const q = new URL(req.url, 'http://x').searchParams;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCouncil(opts, q.get('agenda'), q.get('date')));
      return;
    }
    if (url === '/council/merit') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCouncilMerit(opts));
      return;
    }
    if (url === '/' || url === '/index.html') {
      (async () => {
        let html;
        try {
          html = render(board.gather(opts), opts, await homeExtras(opts));
        } catch (e) {
          // 조립 실패도 500 텍스트로만 — 쓰기 없음
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('집계 실패');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      })();
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
