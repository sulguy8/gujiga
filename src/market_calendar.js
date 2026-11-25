'use strict';

// 거래일/휴장일 캘린더 (TSK-007 / ARC-004)
//
// 주말(토·일)은 자동 휴장, 평일 휴장일·개장시간 변경일(수능 등)은 설정 파일로 관리한다.
//   기본: <repo>/config/market_calendar.json (opts.calendarPath 또는 GUJIGA_CALENDAR로 교체)
// 초안 상태의 날짜는 파일 안에 '군주 확인 필요'로 표시되어 있다 — 코드가 아닌 데이터 문제로 취급.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'market_calendar.json');

function load(opts) {
  const p = (opts && opts.calendarPath) || process.env.GUJIGA_CALENDAR || DEFAULT_PATH;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// dateStr: 'YYYY-MM-DD' (KST 기준 날짜)
function isWeekend(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay();
  return day === 0 || day === 6;
}

function isTradingDay(dateStr, opts) {
  if (isWeekend(dateStr)) return false;
  const cal = load(opts);
  if (cal.holidays && cal.holidays[dateStr]) return false;
  return true;
}

// 그날의 개장 시각('HH:MM'). 수능일 등 변경일은 special_open에서.
function openTime(dateStr, opts) {
  const cal = load(opts);
  if (cal.special_open && cal.special_open[dateStr]) return cal.special_open[dateStr];
  return cal.default_open || '09:00';
}

// dateStr 이전의 가장 가까운 거래일('YYYY-MM-DD').
function prevTradingDay(dateStr, opts) {
  let d = new Date(`${dateStr}T00:00:00`);
  for (let i = 0; i < 30; i++) {
    d = new Date(d.getTime() - 24 * 3600 * 1000);
    const s = fmt(d);
    if (isTradingDay(s, opts)) return s;
  }
  throw new Error(`30일 내 거래일을 찾지 못함: ${dateStr}`);
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

module.exports = { isTradingDay, openTime, prevTradingDay, load };
