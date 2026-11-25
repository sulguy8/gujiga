'use strict';

// 허도 관문(gatekeeper) — 로컬 키 중계 서버 (TSK-017 / ARC-009 확정)
//
// gujiga 프로세스가 127.0.0.1 전용 HTTP 서버를 띄워 DPAPI 키를 메모리에서만 풀고
// KIS 호출(kis-adapter)을 대행한다. Aside 루틴은 키를 영영 만지지 않는다.
//
// 보안(ARC-009):
//  - 바인딩 127.0.0.1 전용(비루프백 설정 거부) + Host 헤더 검사(DNS 리바인딩 방지).
//  - 관문 토큰: 기동 때마다 무작위 생성, 지정 파일에만 기록(재기동 시 교체).
//    모든 /call 요청에 x-gate-token 필수 — 없거나 틀리면 401.
//  - 응답·로그에 키·KIS 토큰 값 기록 금지.
//
// 이중 잠금(게이트 TSK-005 완성 전): gujiga guard_config 기준 안전장치를 관문이 직접 강제 —
//  STOP·지정가·실전 confirmed 필수·1회 한도·실전 매수 화이트리스트·하루 손실(스냅샷 없으면 차단).
//  Aside 쪽 얇은 클라이언트의 guard.json 검사(1차 잠금)와 별개로 한 번 더 건다.
//  모든 주문 시도(차단 포함)는 order_log 원장에 기록한다(DAT-002).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const kis = require('./kis_adapter');
const guard = require('./guard');
const state = require('./state');
const ledger = require('./ledger');
const paths = require('./paths');

const LOOPBACK = '127.0.0.1';
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'gatekeeper.json');

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

// 실전 매수 화이트리스트: watchlist 상태 파일(status !== 'excluded'). 목록이 없으면 차단(안전).
function whitelisted(symbol, opts) {
  const list = state.read('watchlist', opts);
  if (!Array.isArray(list)) return false;
  return list.some((w) => w.symbol === symbol && w.status !== 'excluded');
}

// 하루 손실 차단(실전 매수): 당일 스냅샷 없으면 차단(DAT-004), 기준 대비 한도 이하면 차단.
async function dailyLossBlocked(api, g, opts) {
  const dataDir = paths.resolveDataDir(opts);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const snapDir = paths.ledgerDir(dataDir, 'daily_account_snapshot');
  let snap = null;
  if (fs.existsSync(snapDir)) {
    for (const f of fs.readdirSync(snapDir)) {
      for (const line of fs.readFileSync(path.join(snapDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (r.snapshot_date === today && r.account_type === 'real') snap = r;
      }
    }
  }
  if (!snap) return 'no_snapshot'; // 스냅샷 없는 날 실전 매수 차단(안전 우선)
  const b = await api.balance();
  if (b.total - snap.start_total_eval <= g.daily_loss_limit) return 'daily_loss';
  return null;
}

// 주문 전 이중 잠금 검사. 통과 시 null, 차단 시 사유 문자열.
async function orderChecks(env, side, symbol, qty, price, opt, api, opts) {
  const g = guard.loadGuard(opts);
  if (!g) return 'guard_missing';
  if (fs.existsSync(g.stop_file_path)) return 'stop_file';
  if (!Number.isInteger(price) || price <= 0) return 'market_order'; // 지정가만
  if (env === 'real' && !(opt && opt.confirmed === true)) return 'no_confirm';
  const amt = qty * price;
  const lim = env === 'real' ? g.per_order_limit_real : g.per_order_limit_paper;
  if (amt > lim) return 'per_order_limit';
  if (env === 'real' && side === 'buy') {
    if (!whitelisted(symbol, opts)) return 'not_whitelisted';
    const dl = await dailyLossBlocked(api, g, opts);
    if (dl) return dl;
  }
  return null;
}

// opts: { dataDir, keysPath, port, host, tokenFile, baseUrls, gapMs, configPath }
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

  // env별 어댑터(지연 생성 — 키는 어댑터 클로저 메모리에만)
  const adapters = {};
  async function adapter(env) {
    if (!adapters[env]) {
      adapters[env] = await kis.make(env, {
        dataDir: opts.dataDir, keysPath: opts.keysPath,
        baseUrls: opts.baseUrls, gapMs: opts.gapMs,
        // 실전 주문은 어댑터 차원에서도 비활성(TSK-012 전) — 관문 검사와 별개의 3중 방벽
      });
    }
    return adapters[env];
  }

  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (!hostAllowed(req.headers.host)) return reply(403, { ok: false, error: 'localhost 전용' });

    // 기동 확인(무인증 — 데이터 없음)
    if (req.method === 'GET' && req.url === '/ping') return reply(200, { ok: true, service: 'gujiga-gatekeeper' });

    if (req.method !== 'POST' || req.url.split('?')[0] !== '/call') return reply(404, { ok: false, error: 'not_found' });
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
      const ALLOWED = new Set(['price', 'balance', 'fills', 'order', 'modify', 'cancel', 'dailyCandle']);
      if (!ALLOWED.has(fn)) return reply(400, { ok: false, error: 'bad_fn' });

      try {
        const api = await adapter(env);

        if (fn === 'order') {
          const [side, symbol, qty, price, opt] = args || [];
          const reason = await orderChecks(env, side, symbol, qty, price, opt, api, opts);
          if (reason) {
            ledger.append('order_log', {
              id: crypto.randomUUID(), draft_id: (opt && opt.draft_id) || null,
              account_type: env === 'real' ? 'real' : 'paper', nation: (opt && opt.nation) || null,
              symbol, side, order_type: 'limit', price, qty, amount: qty * price,
              status: 'blocked', block_reason: reason,
              broker_order_no: null, filled_at: null, created_at: new Date().toISOString(),
            }, opts);
            return reply(200, { ok: false, blocked: true, error: `관문 차단(${reason}) — 실전은 사용자 확인(confirmed)·화이트리스트·한도 필요` });
          }
          const r = await api.order(side, symbol, qty, price);
          ledger.append('order_log', {
            id: crypto.randomUUID(), draft_id: (opt && opt.draft_id) || null,
            account_type: env === 'real' ? 'real' : 'paper', nation: (opt && opt.nation) || null,
            symbol, side, order_type: 'limit', price, qty, amount: qty * price,
            status: r.rt === '0' ? 'submitted' : 'rejected', block_reason: null,
            broker_order_no: r.odno || null, filled_at: null, created_at: new Date().toISOString(),
          }, opts);
          return reply(200, { ok: r.rt === '0', result: r, error: r.rt === '0' ? undefined : r.msg });
        }

        // 조회·정정·취소: 어댑터 함수명 매핑(price → quote)
        const map = { price: 'quote', balance: 'balance', fills: 'fills', modify: 'modify', cancel: 'cancel', dailyCandle: 'dailyCandle' };
        const r = await api[map[fn]](...(args || []));
        return reply(200, { ok: true, result: r });
      } catch (e) {
        // 오류에 키·토큰이 섞이지 않도록 메시지만(어댑터 오류 메시지는 값 미포함 설계)
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
