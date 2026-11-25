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
const { kstParts } = require('./kst');

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
    user_confirmed: opt.confirmed === true,
    created_by: 'aside_chat',
    reason: opt.reason,
  };
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
