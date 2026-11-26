'use strict';

// 가설 장부·증거 엔진 (TSK-019 / DAT-008·DAT-009 / REQ-011·012·024·025)
//
//  - 가설: 분류(A~E)·"조건 → 기대 결과" 진술 필수. 전이 hypothesis→testing→(verified|discarded)만.
//  - 증거: 날짜+한 줄. 손익 무관 — "가설이 예측한 일이 일어났는가"만(success/fail).
//    kind=trade(출병)/observation(관찰) 동등 1건. judged_by=app(판정식)/군주(논공행상).
//  - 승격(verified): 증거 ≥10 그리고 출병 ≥3(설정 config/hypothesis.json).
//  - 판정식(judge_expr): 화이트리스트 변수·연산만 허용하는 안전 평가 — 임의 코드 실행 불가.
//    판정식 없음/시세 결측 → '판정 대기'(3거래일 후 수동 전환).
//  - patterns.md 이관: 원본 읽기 전용, 상태 원본 그대로, 대사 리포트.
//
// 저장: 가설·증거·대기 = 상태 파일(수정·삭제 가능 — 재계산 동반). 규칙 승격 이력 = rule_change 원장.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const state = require('./state');
const ledger = require('./ledger');
const paths = require('./paths');
const calendar = require('./market_calendar');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'hypothesis.json');
const CATEGORIES = new Set(['A', 'B', 'C', 'D', 'E']);
const STATUSES = ['hypothesis', 'testing', 'verified', 'discarded', 'rule']; // rule=군령류(걸러내기) — 인용 불가·전이 없음

function cfg(opts) {
  if (opts && opts.hypConfig) return opts.hypConfig;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function book(opts) {
  return state.read('hypothesis_book', opts) || { items: [] };
}
function saveBook(b, opts) {
  state.write('hypothesis_book', b, opts);
}
function evBook(opts) {
  return state.read('evidence_book', opts) || { items: [] };
}
function saveEv(b, opts) {
  state.write('evidence_book', b, opts);
}
function pendBook(opts) {
  return state.read('pending_judgments', opts) || { items: [] };
}
function savePend(b, opts) {
  state.write('pending_judgments', b, opts);
}

// 집계 재계산(DAT-008: evidence_count·trade_count·reference_only는 증거 삽입·삭제 시 재계산)
function recount(hypId, opts) {
  const b = book(opts);
  const h = b.items.find((x) => x.id === hypId);
  if (!h) return null;
  const evs = evBook(opts).items.filter((e) => e.hypothesis_id === hypId);
  h.evidence_count = evs.length;
  h.trade_count = evs.filter((e) => e.kind === 'trade').length;
  h.reference_only = h.evidence_count < cfg(opts).evidence_min;
  saveBook(b, opts);
  return h;
}

// ---------- CRUD ----------
function register(input, opts) {
  if (!input || !CATEGORIES.has(input.category)) throw new Error('분류(category A~E) 필수');
  if (typeof input.statement !== 'string' || !input.statement.trim()) throw new Error('진술(statement "조건 → 기대 결과") 필수');
  const b = book(opts);
  const code = input.code || `H${b.items.length + 1}`;
  const id = input.id || `HYP-${code}`;
  if (b.items.some((x) => x.id === id)) throw new Error(`이미 존재: ${id}`);
  // verified는 등록으로 만들 수 없다 — 승격은 전이(testing→verified, 표본 조건)로만(증거 0 verified 경로 봉쇄)
  if (input.status === 'verified') throw new Error('등록으로 verified 생성 불가 — 전이로만 승격(표본 10·출병 3 필요)');
  const h = {
    id, code, category: input.category, statement: input.statement.trim(),
    judge_expr: input.judge_expr || null,
    original_status: input.original_status || null,
    status: input.status || 'hypothesis',
    // rule(군령류)은 출병 근거로 인용 불가(citable=false 고정)
    citable: input.status === 'rule' ? false : input.citable !== false,
    evidence_count: 0, trade_count: 0, reference_only: true,
    created_at: new Date().toISOString(), status_changed_at: null,
  };
  b.items.push(h);
  saveBook(b, opts);
  return h;
}

function get(id, opts) {
  return book(opts).items.find((x) => x.id === id) || null;
}
function list(opts) {
  return book(opts).items.slice(); // 폐기 포함 전체(REQ-011 — 삭제 금지)
}
function evidences(hypId, opts) {
  return evBook(opts).items.filter((e) => e.hypothesis_id === hypId);
}

// 상태 전이(REQ-011·012·025): 순서 강제 + verified 조건
function transition(id, next, opts) {
  const b = book(opts);
  const h = b.items.find((x) => x.id === id);
  if (!h) throw new Error('가설 없음');
  const allowed = { hypothesis: ['testing'], testing: ['verified', 'discarded'], verified: [], discarded: [], rule: [] };
  if (!(allowed[h.status] || []).includes(next)) {
    throw new Error(`허용되지 않은 전이(직행·역행 금지): ${h.status} → ${next} — 순서는 가설→검증 중→(검증됨|폐기)`);
  }
  if (next === 'verified') {
    const c = cfg(opts);
    if (h.evidence_count < c.evidence_min || h.trade_count < c.trade_min) {
      throw new Error(`승격 차단: 증거 ${h.evidence_count}/${c.evidence_min} · 출병 ${h.trade_count}/${c.trade_min}`);
    }
  }
  h.status = next;
  h.status_changed_at = new Date().toISOString();
  saveBook(b, opts);
  return h;
}

// 증거 추가(REQ-011: 날짜·내용 필수, 성공·실패 동일 기록)
function addEvidence(input, opts) {
  if (!input.hypothesis_id || !get(input.hypothesis_id, opts)) throw new Error('가설 없음');
  if (!input.evidence_date) throw new Error('날짜(evidence_date) 없는 증거는 거부');
  if (!input.note) throw new Error('내용(note) 필수');
  if (!['success', 'fail'].includes(input.outcome)) throw new Error('outcome은 success/fail');
  if (!['trade', 'observation'].includes(input.kind)) throw new Error('kind는 trade/observation');
  const row = {
    id: crypto.randomUUID(),
    hypothesis_id: input.hypothesis_id,
    evidence_date: input.evidence_date,
    note: input.note, outcome: input.outcome, kind: input.kind,
    judged_by: input.judged_by || '군주',
    symbol: input.symbol || null, basis: input.basis || null,
    created_at: new Date().toISOString(),
  };
  const b = evBook(opts);
  b.items.push(row);
  saveEv(b, opts);
  recount(input.hypothesis_id, opts);
  return row;
}

// 증거 삭제 — 재계산 동반. verified 미달 복귀는 자동 강등 없이 경고만(REQ-012·025)
function removeEvidence(evidenceId, opts) {
  const b = evBook(opts);
  const idx = b.items.findIndex((e) => e.id === evidenceId);
  if (idx === -1) throw new Error('증거 없음');
  const [row] = b.items.splice(idx, 1);
  saveEv(b, opts);
  const h = recount(row.hypothesis_id, opts);
  let warning = null;
  const c = cfg(opts);
  if (h && h.status === 'verified' && (h.evidence_count < c.evidence_min || h.trade_count < c.trade_min)) {
    warning = `경고: 검증됨 가설 ${h.id}의 표본이 미달로 복귀(증거 ${h.evidence_count}/${c.evidence_min} · 출병 ${h.trade_count}/${c.trade_min}) — 자동 강등하지 않음`;
  }
  return { removed: true, warning };
}

// 숫자 규칙 승격 이력(REQ-011 AC5) — rule_change 원장에 가설 ID
function promoteToRule(hypId, note, opts) {
  if (!get(hypId, opts)) throw new Error('가설 없음');
  ledger.append('rule_change', {
    id: crypto.randomUUID(), hypothesis_id: hypId, note,
    created_at: new Date().toISOString(),
  }, opts);
  return { ok: true };
}

// ---------- 판정식 평가기(REQ-024 — 안전) ----------
// 허용: 변수(화이트리스트)·숫자·HH:MM 시각 리터럴·비교/논리/산술 연산·괄호. 그 외 토큰은 전부 거부.
const VAR_WHITELIST = new Set([
  'open', 'close', 'high', 'low', 'prev_close',
  'high_time', 'low_time', 'gap_pct', 'first_rebound', 'first_rebound_min',
  'high_time_min', 'low_time_min', 'volume', 'vol_ratio',
]);
const TOKEN_RE = /^\s*(\d{2}:\d{2}|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||<=|>=|==|!=|[<>()+\-*/])/;

function toMinVal(v) {
  if (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) {
    const [h, m] = v.split(':').map(Number);
    return h * 60 + m;
  }
  return v;
}

function evaluateExpr(expr, vars) {
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('판정식 없음');
  vars = vars || {};
  let rest = expr;
  const out = [];
  while (rest.trim().length > 0) {
    const m = rest.match(TOKEN_RE);
    if (!m) throw new Error(`판정식 거부: 허용되지 않은 토큰 근처 "${rest.trim().slice(0, 12)}"`);
    const tok = m[1];
    rest = rest.slice(m[0].length);
    if (/^\d{2}:\d{2}$/.test(tok)) {
      out.push(String(toMinVal(tok)));
    } else if (/^\d/.test(tok)) {
      out.push(tok);
    } else if (/^[A-Za-z_]/.test(tok)) {
      if (!VAR_WHITELIST.has(tok)) throw new Error(`판정식 거부: 화이트리스트 밖 변수 "${tok}"`);
      let v = vars[tok];
      // *_min 변형: HH:MM 변수의 분 환산을 자동 지원
      if (v == null && tok.endsWith('_min')) v = vars[tok.replace(/_min$/, '')];
      v = toMinVal(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`판정식 입력 결측: ${tok}`);
      out.push(String(v));
    } else {
      out.push(tok); // 검증된 연산자
    }
  }
  // 모든 토큰이 숫자·연산자뿐 — 안전하게 평가
  // eslint-disable-next-line no-new-func
  const result = new Function(`return (${out.join(' ')});`)();
  return !!result;
}

// ---------- 증거 엔진(REQ-024·025) ----------
// vars가 null(시세 결측)이거나 판정식이 없으면 '판정 대기'로 쌓는다.
function recordJudged(hypId, vars, meta, kind, opts) {
  const h = get(hypId, opts);
  if (!h) throw new Error('가설 없음');
  if (h.judge_expr && vars) {
    let ok;
    try {
      ok = evaluateExpr(h.judge_expr, vars);
    } catch (e) {
      // 문법 오류·입력 결측 → 수동 폴백 + 결함 기록
      return pendIt(h, meta, kind, e.message.includes('결측') ? 'auto_retry' : 'manual', opts);
    }
    const outcome = ok ? 'success' : 'fail';
    const basis = `판정식 [${h.judge_expr}] · 입력 ${JSON.stringify(Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, toMinVal(v)])))}`;
    const row = addEvidence({
      hypothesis_id: hypId, evidence_date: meta.evidence_date, note: meta.note,
      outcome, kind, judged_by: 'app', symbol: meta.symbol, basis,
    }, opts);
    return { recorded: true, outcome, evidence: row };
  }
  return pendIt(h, meta, kind, h.judge_expr ? 'auto_retry' : 'manual', opts);
}
function pendIt(h, meta, kind, mode, opts) {
  const b = pendBook(opts);
  const row = {
    id: crypto.randomUUID(), hypothesis_id: h.id,
    evidence_date: meta.evidence_date, note: meta.note, symbol: meta.symbol || null,
    kind, mode, first_date: meta.evidence_date,
    created_at: new Date().toISOString(),
  };
  b.items.push(row);
  savePend(b, opts);
  return { pending: true, mode, id: row.id };
}

// 출병 증거(회군/기한 시 — 출사표 인용 가설마다)
function recordTradeEvidence(hypId, vars, meta, opts) {
  return recordJudged(hypId, vars, meta, 'trade', opts);
}
// 관찰 증거(출병 없는 조건 발생일 — REQ-025)
function recordObservation(hypId, vars, meta, opts) {
  return recordJudged(hypId, vars, meta, 'observation', opts);
}

function pendingJudgments(opts) {
  return pendBook(opts).items.slice();
}
// 논공행상: 군주 확정 → 증거로 승격(judged_by='군주')
function confirmPending(pendingId, outcome, opts) {
  const b = pendBook(opts);
  const idx = b.items.findIndex((p) => p.id === pendingId);
  if (idx === -1) throw new Error('판정 대기 항목 없음');
  const [p] = b.items.splice(idx, 1);
  savePend(b, opts);
  return addEvidence({
    hypothesis_id: p.hypothesis_id, evidence_date: p.evidence_date, note: p.note,
    outcome, kind: p.kind, judged_by: '군주', symbol: p.symbol,
  }, opts);
}

// 결측 자동 재시도 대기 → 3거래일 경과 시 수동 전환(REQ-024 AC4)
function tradingDaysBetween(from, to, opts) {
  let d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  let n = 0;
  while (d < end) {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (calendar.isTradingDay(s, opts)) n++;
  }
  return n;
}
function escalatePending(today, opts) {
  const limit = cfg(opts).pending_manual_after_trading_days;
  const b = pendBook(opts);
  let changed = 0;
  for (const p of b.items) {
    if (p.mode === 'auto_retry' && tradingDaysBetween(p.first_date, today, opts) >= limit) {
      p.mode = 'manual';
      changed++;
    }
  }
  if (changed) savePend(b, opts);
  return { escalated: changed };
}

// ---------- patterns.md 이관(원본 읽기 전용·상태 그대로) ----------
const STATUS_MAP = [
  [/검증 중/, 'testing'],
  [/^가설/, 'hypothesis'],
  [/사용 중/, 'rule'], // 군사 검토(2026-11-25): D계열 '사용 중'은 걸러내기 군령 — 출병 근거가 아님(citable=false)
];
// 시세로 잴 수 있는 판정식만 등록(군사 지시) — 나머지는 비워서 군주 판정.
const JUDGE_EXPRS = {
  A1: 'high_time >= 09:00 && high_time <= 09:30 && close < open',
  A3: 'gap_pct <= -3 && first_rebound_min < 10:30',
  A6: 'low_time >= 11:30 && low_time <= 11:50',
};

function mapStatus(label) {
  for (const [re, s] of STATUS_MAP) {
    if (re.test(label)) return s;
  }
  return 'hypothesis';
}
function firstDate(text) {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/); // ISO 날짜 우선(예: 2026-11-26)
  if (iso) return iso[0];
  const m = text.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return '2026-11-25'; // 날짜 없는 증거 셀은 이관일
  return `2026-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function migratePatterns(srcPath, opts) {
  const marker = state.read('patterns_migration', opts);
  if (marker && marker.done) return { skipped: true, hypotheses: marker.hypotheses, evidences: marker.evidences };

  const raw = fs.readFileSync(srcPath, 'utf8'); // 읽기만 — 원본 수정 금지
  const lines = raw.split('\n');
  let hypN = 0;
  let evN = 0;
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^\|\s*([A-E]\d)\s*\|/);
    if (!m) continue;
    const cells = line.split('|').map((c) => c.trim());
    // | # | 패턴 | 상태 | 쓰는 법 | 증거 |  또는  | # | 규칙 | 상태 |
    const code = cells[1];
    const statement = cells[2];
    const statusLabel = cells[3] || '';
    const evidenceCell = cells.length >= 6 ? cells[5] : '';
    rows.push({ code, statement, statusLabel, evidenceCell });
  }
  for (const r of rows) {
    const h = register({
      code: r.code, category: r.code[0],
      statement: r.statement,
      judge_expr: JUDGE_EXPRS[r.code] || null,
      status: mapStatus(r.statusLabel),
      original_status: r.statusLabel,
    }, opts);
    hypN++;
    const ev = (r.evidenceCell || '').trim();
    if (ev && !/기록 예정/.test(ev)) {
      addEvidence({
        hypothesis_id: h.id, evidence_date: firstDate(ev), note: ev,
        outcome: 'success', kind: 'observation', judged_by: '군주',
      }, opts);
      evN++;
    }
  }

  // 이관 리포트(대사)
  const dir = path.join(paths.resolveDataDir(opts), 'hypothesis');
  fs.mkdirSync(dir, { recursive: true });
  const L = [
    '# patterns.md 이관 리포트 (TSK-019)',
    '',
    `- 이관 가설 ${hypN}건(${rows.map((r) => r.code).join('·')}) · 증거 ${evN}건(증거 칸 1개 = 1건, '기록 예정' 제외)`,
    `- 상태 매핑: 검증 중→testing · 가설→hypothesis · 사용 중→rule(걸러내기 군령, citable=false) (원문 라벨은 original_status 보존 — 임의 승격·강등 없음)`,
    `- 판정식 등록(시세 측정 가능만): ${Object.keys(JUDGE_EXPRS).join(', ')} — 나머지는 비움(논공행상 군주 판정)`,
    `- 원본 ${srcPath} 는 수정하지 않음(읽기 전용)`,
  ];
  fs.writeFileSync(path.join(dir, 'migration_report.md'), L.join('\n') + '\n', 'utf8');

  state.write('patterns_migration', { done: true, hypotheses: hypN, evidences: evN, at: new Date().toISOString() }, opts);
  return { hypotheses: hypN, evidences: evN };
}

module.exports = {
  register, get, list, evidences, transition,
  addEvidence, removeEvidence, promoteToRule,
  evaluateExpr, recordTradeEvidence, recordObservation,
  pendingJudgments, confirmPending, escalatePending,
  migratePatterns,
};
