'use strict';

// 종목 사전(지령 015) — 화면 표시용 이름 해석.
// 우선순위: 장부의 name → config/symbols.json → 코드만.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'symbols.json');
let _cache = null;

function dict(opts) {
  if (opts && opts.symbolsDict) return opts.symbolsDict;
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync((opts && opts.symbolsPath) || DEFAULT_PATH, 'utf8'));
    _cache = raw;
  } catch (e) {
    _cache = {};
  }
  return _cache;
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
