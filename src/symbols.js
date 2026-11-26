'use strict';

// 종목 사전(지령 015) — 화면 표시용 이름 해석.
// 우선순위: 장부의 name → config/symbols.json → 코드만.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'symbols.json');
const _cache = new Map(); // 경로별 캐시 — 사전 파일을 고치면 프로세스 재기동 후 반영(장수명 데몬 주의)

function dict(opts) {
  if (opts && opts.symbolsDict) return opts.symbolsDict;
  const p = (opts && opts.symbolsPath) || DEFAULT_PATH;
  if (_cache.has(p)) return _cache.get(p);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    raw = {};
  }
  _cache.set(p, raw);
  return raw;
}

function nameOf(symbol, opts) {
  const n = dict(opts)[symbol];
  return typeof n === 'string' ? n : null;
}

// '씨어스테크놀로지(458870)' 형식. 이름이 없으면 코드만.
function label(symbol, name, opts) {
  const n = name || nameOf(symbol, opts);
  return n ? `${n}(${symbol})` : String(symbol || '');
}

module.exports = { nameOf, label };
