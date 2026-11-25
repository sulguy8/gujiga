'use strict';

// KST 시각 유틸 — now(ISO|Date)를 한국 날짜('YYYY-MM-DD')와 분(minute of day)으로.

function kstParts(now) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error(`시각 해석 불가: ${now}`);
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  const [date, time] = s.split(' ');
  const [hh, mm] = time.split(':').map(Number);
  return { date, minutes: hh * 60 + mm };
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

module.exports = { kstParts, toMin };
