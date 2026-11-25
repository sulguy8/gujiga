'use strict';

// 비밀값 암호화 유틸 — Windows DPAPI(CurrentUser) (TSK-002 / ARC-005 B안)
//
// - 외부 패키지 0: PowerShell 내장 [Security.Cryptography.ProtectedData] 호출.
// - 평문은 '항상 stdin'으로 전달한다(인자로 넘기면 프로세스 목록에 노출 — 군사 지시).
// - 복호화된 값은 반환값(메모리)으로만 — 이 모듈은 평문을 어디에도 저장·출력하지 않는다.
// - 보안 불변식: 로그·예외 메시지에 키 값·경로를 적지 않는다(ARC-005).
// - 손상 파일은 '명확한 오류'로 — 무한 재시도·평문 폴백 금지(TST-002 에지).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('./paths');

const MARKER = 'GJDPAPI1'; // 암호화 파일 1행 마커(평문 파일 오인 방지)

// PowerShell에 stdin으로 들어온 UTF-8 텍스트를 Protect/Unprotect 해 base64로 출력하는 스크립트.
// $input 전체를 읽어 처리 — 평문·암호문 어느 쪽도 명령줄 인자에 싣지 않는다.
const PS_ENCRYPT = [
  'Add-Type -AssemblyName System.Security;',
  '$raw = [Console]::In.ReadToEnd();',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($raw);',
  "$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser');",
  '[Console]::Out.Write([Convert]::ToBase64String($enc));',
].join(' ');

const PS_DECRYPT = [
  'Add-Type -AssemblyName System.Security;',
  '$b64 = [Console]::In.ReadToEnd().Trim();',
  '$enc = [Convert]::FromBase64String($b64);',
  "$bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser');",
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));',
].join(' ');

function runPs(script, stdinText) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(stdinText, 'utf8'),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.length === 0) {
    // 실패 상세(stderr)에 값이 섞일 수 있으므로 메시지에 포함하지 않는다.
    throw new Error('DPAPI 작업 실패(복호화 불가 또는 손상) — 같은 Windows 계정인지 확인');
  }
  return r.stdout;
}

// 평문 → DPAPI 암호문(base64). CurrentUser 귀속 — 다른 계정에서는 복호화 불가.
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') throw new Error('encrypt: 문자열만');
  // PowerShell stdin 왕복에서 손실될 수 있는 입력(끝 개행 등)을 보존하기 위해 base64로 감싼다.
  const wrapped = Buffer.from(plaintext, 'utf8').toString('base64');
  return runPs(PS_ENCRYPT, wrapped);
}

// DPAPI 암호문(base64) → 평문.
function decrypt(blobBase64) {
  if (typeof blobBase64 !== 'string' || blobBase64.length === 0) {
    throw new Error('decrypt: 암호문이 비어 있음');
  }
  const wrapped = runPs(PS_DECRYPT, blobBase64);
  try {
    return Buffer.from(wrapped, 'base64').toString('utf8');
  } catch (e) {
    throw new Error('DPAPI 작업 실패(복호화 불가 또는 손상)');
  }
}

// 파일 저장: 마커 1행 + 암호문 1행.
function encryptToFile(plaintext, filePath) {
  const blob = encrypt(plaintext);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${MARKER}\n${blob}\n`, 'utf8');
  return filePath;
}

function decryptFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error('암호화 파일을 읽을 수 없음');
  }
  const nl = raw.indexOf('\n');
  const marker = nl === -1 ? raw : raw.slice(0, nl);
  if (marker.trim() !== MARKER) {
    throw new Error('암호화 형식 아님(marker 불일치) — 평문 폴백은 하지 않는다');
  }
  const blob = raw.slice(nl + 1).trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(blob)) {
    throw new Error('DPAPI 작업 실패(복호화 불가 또는 손상) — 같은 Windows 계정인지 확인');
  }
  return decrypt(blob);
}

// --- 토큰 캐시(ARC-005: 캐시도 암호화 범위) ---
// 위치: <dataDir>/secrets/token_<name>.enc — secrets/는 .gitignore로 추적 제외.

function tokenPath(name, opts) {
  if (!/^[\w-]+$/.test(name)) throw new Error('토큰 이름은 영문·숫자·_-만');
  return path.join(paths.resolveDataDir(opts), 'secrets', `token_${name}.enc`);
}

function saveToken(name, tokenObj, opts) {
  return encryptToFile(JSON.stringify(tokenObj), tokenPath(name, opts));
}

// 캐시가 없으면 null(예외 아님). 손상은 예외 — 평문 폴백 금지.
function loadToken(name, opts) {
  const p = tokenPath(name, opts);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(decryptFile(p));
}

module.exports = { encrypt, decrypt, encryptToFile, decryptFile, saveToken, loadToken };
