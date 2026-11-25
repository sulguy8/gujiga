'use strict';

// notify — 알림 단일 발신처 (TSK-011 / ARC-006 확정)
//
// 브리핑·척후·점검·차단 알림은 전부 이 모듈 하나를 거친다. 채널은 설정으로 on/off:
//  - PC: Windows 기본 알림(토스트, PowerShell 내장 — 외부 패키지 0). 클릭 딥링크 포함.
//  - 모바일: 텔레그램 봇(node https 직접 호출). 본문은 '종목·조건·수치까지만' —
//    계좌번호 패턴·잔고 금액 필드는 전송 전에 제거한다(ARC-006 확정 수위, 외부 서버 경유 고려).
//  - 채널은 서로 독립: 텔레그램이 죽어도 PC 알림은 나간다(한쪽 실패가 다른 쪽을 막지 않음).
//  - 알림 '원문'은 로컬 장부(notify_log)에 기록(로컬은 외부 경유가 아니므로 필터 전 원문).
//  - 봇 토큰은 secret(DPAPI) 캐시로만 읽는다 — 이 모듈은 토큰을 인자로 받지도, 로그에 찍지도 않는다.
//  - 중복 억제는 발생원(scout 등) 책임 — notify는 전달만, 시간 게이트도 없다(STOP 등 긴급 알림 보장).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ledger = require('./ledger');
const secret = require('./secret');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'notify.json');

function loadConfig(opts) {
  if (opts && opts.config) return opts.config;
  const p = (opts && opts.configPath) || process.env.GUJIGA_NOTIFY_CONFIG || DEFAULT_CONFIG_PATH;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- 본문 필터(텔레그램 전용): 계좌번호 패턴·잔고 금액 제거, 종목·조건·수치는 유지 ---
// 계좌번호 패턴: 8자리-2자리(KIS 형식) 또는 연속 10자리 이상 숫자.
const ACCOUNT_PATTERNS = [/\b\d{8}-\d{2}\b/g, /\b\d{10,}\b/g];
// 제거할 필드명: 계좌·잔고·평가액·현금류.
const SENSITIVE_FIELD = /account|acct|balance|cash|eval|잔고|계좌|평가|예수금/i;

function sanitizeBody(body) {
  let out = String(body || '');
  for (const re of ACCOUNT_PATTERNS) out = out.replace(re, '[제거]');
  // '계좌 …' / '잔고 …원' 꼬리 문구 제거(라벨+숫자·콤마 묶음)
  out = out.replace(/(계좌|잔고|예수금|총평가)\s*[:=]?\s*[\d,.[\]제거-]*원?\s*(기준)?\.?/g, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function sanitizeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (SENSITIVE_FIELD.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// --- PC: Windows 기본 토스트(PowerShell WinRT, 외부 패키지 0) ---
// 기본 발송기. 테스트는 opts.osSender로 대체한다.
function defaultOsSender(payload) {
  const title = String(payload.title || '구지가').replace(/"/g, "'");
  const body = String(payload.body || '').replace(/"/g, "'");
  const link = String(payload.deeplink || '').replace(/"/g, "'");
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;",
    "$xml = [Windows.Data.Xml.Dom.XmlDocument]::new();",
    `$xml.LoadXml('<toast activationType="protocol" launch="${link}"><visual><binding template="ToastGeneric"><text>${title}</text><text>${body}</text></binding></visual></toast>');`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml);",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('구지가').Show($toast);",
  ].join(' ');
  // 발송은 비동기 분리 실행(데몬 흐름 비차단) — 실패해도 호출측 결과에는 영향 없음.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true, detached: true, stdio: 'ignore',
  });
  child.unref();
}

// --- 텔레그램: node http/https 직접 호출(외부 패키지 0) ---
function postTelegram(baseUrl, token, chatId, text) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(`${baseUrl}/bot${token}/sendMessage`);
    } catch (e) {
      return resolve({ ok: false, error: 'telegram_url_invalid' });
    }
    const mod = u.protocol === 'http:' ? http : https;
    const body = JSON.stringify({ chat_id: chatId, text });
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200 ? { ok: true } : { ok: false, error: `telegram_http_${res.statusCode}` }));
    });
    // 오류 메시지에 토큰이 섞이지 않도록 코드만 기록.
    req.on('error', (e) => resolve({ ok: false, error: `telegram_net_${e.code || 'error'}` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'telegram_timeout' }); });
    req.end(body);
  });
}

// --- 단일 진입: send(event, opts) ---
// event: { kind, title, body, fields?, deeplink? }
// opts : { dataDir, config, configPath, telegramUrl, osSender, now }
// 반환 : { os: {ok|skipped}, telegram: {ok|skipped, error?} }
async function send(event, opts) {
  opts = opts || {};
  const cfg = loadConfig(opts);
  const nowIso = (opts.now ? new Date(opts.now) : new Date()).toISOString();
  const result = { os: { skipped: true }, telegram: { skipped: true } };

  // ① PC OS 알림 (원문 그대로 — 로컬) — 채널 독립: 실패해도 아래로 진행
  if (cfg.channels && cfg.channels.os) {
    try {
      const sender = opts.osSender || defaultOsSender;
      sender({ title: event.title, body: event.body, deeplink: event.deeplink, kind: event.kind });
      result.os = { ok: true };
    } catch (e) {
      result.os = { ok: false, error: 'os_sender_failed' };
    }
  }

  // ② 텔레그램 (필터 적용 — 종목·조건·수치만)
  if (cfg.channels && cfg.channels.telegram) {
    try {
      const tokenName = (cfg.telegram && cfg.telegram.token_name) || 'telegram_bot';
      const cred = secret.loadToken(tokenName, opts); // DPAPI 캐시로만 — 평문 수수 금지
      if (!cred || !cred.token || !cred.chat_id) {
        result.telegram = { ok: false, error: 'telegram_token_missing' };
      } else {
        const cleanBody = sanitizeBody(event.body);
        const clean = sanitizeFields(event.fields);
        const text = [`[${event.title || event.kind}]`, cleanBody,
          Object.entries(clean).map(([k, v]) => `${k}=${v}`).join(' ')].filter(Boolean).join('\n');
        const base = opts.telegramUrl || 'https://api.telegram.org';
        result.telegram = await postTelegram(base, cred.token, cred.chat_id, text);
      }
    } catch (e) {
      result.telegram = { ok: false, error: 'telegram_failed' }; // 토큰·상세 미노출
    }
  }

  // ③ 로컬 장부: 알림 원문 + 채널 결과(토큰 없음)
  ledger.append('notify_log', {
    id: crypto.randomUUID(),
    kind: event.kind,
    title: event.title,
    body: event.body, // 원문(필터 전) — 로컬 장부는 외부 경유가 아니다
    fields: event.fields || null,
    deeplink: event.deeplink || null,
    channels: result,
    created_at: nowIso,
  }, opts);

  return result;
}

module.exports = { send, sanitizeBody, sanitizeFields };
