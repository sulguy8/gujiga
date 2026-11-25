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
function render(data) {
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

  H.push('<p class="muted" style="font-size:12px">읽기 전용 현황판 — 숫자는 장부 값 그대로. 참고용, 최종 결정은 본인.</p>');
  H.push('</main></body></html>');
  return H.join('\n');
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
    if (url === '/' || url === '/index.html') {
      let html;
      try {
        html = render(board.gather(opts));
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
