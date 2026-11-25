'use strict';

// TST-008 — 로컬 웹 서버·군영 현황판(SCR-005) 자동 테스트
// 상위: TSK-009 / SCR-005 / ARC-001 / DAT-006·011·012
// 실행: node --test (Node 내장, 외부 패키지 0)
//
// 군사 지시 반영:
//  1) 127.0.0.1 전용 바인딩 + Host 헤더 검증(DNS 리바인딩 방지)
//  3) GET만 허용(쓰기 경로·API 없음), 외부 CDN·폰트 0(오프라인)
//  4) 장부 없는 구역은 '없음' 표시, 오류 없음
//  5) 숫자는 장부 그대로, 포로 반올림은 TSK-004 함수 재사용
// 시나리오 2(다른 기기에서 접속 불가)는 수동(군주 휴대폰) — 자동으로는 바인딩 주소를 검증.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const web = require('../src/web');
const state = require('../src/state');
const ledger = require('../src/ledger');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst008-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// HTTP 요청 헬퍼
function request(port, { method = 'GET', pathName = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 테스트 장부 시드
function seed(dir, o) {
  o = o || {};
  if (o.rank !== null) {
    state.write('general_rank', Object.assign({
      id: 'me', rank: 'hyeonryeong', per_stock_troops_max: 20, concurrent_max: 2,
      sortie_count: 0, clean_weeks: 0, review_weeks: 0, promoted_at: null,
      updated_at: '2026-11-25T08:00:00+09:00',
    }, o.rank || {}), { dataDir: dir });
  }
  if (o.positions) state.write('positions', o.positions, { dataDir: dir });
  if (o.snapshot) {
    ledger.append('daily_account_snapshot', Object.assign({
      id: 's1', snapshot_date: '2026-11-25', account_type: 'paper',
      start_total_eval: 1000000, start_cash: 400000, created_at: '2026-11-25T08:30:30+09:00',
    }, o.snapshot), { dataDir: dir });
  }
  for (const row of o.captiveRows || []) {
    ledger.append('captive_ledger', row, { dataDir: dir });
  }
  for (const v of o.violations || []) {
    ledger.append('violation', v, { dataDir: dir });
  }
}

async function withServer(dir, opts, fn) {
  const srv = await web.start(Object.assign({ dataDir: dir, port: 0, today: '2026-11-25' }, opts || {}));
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

// ===== 시나리오 1: localhost 접속 → 현황판 표시 =====
test('시나리오1: localhost에서 현황판이 열린다', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {});
    await withServer(dir, {}, async (srv) => {
      const res = await request(srv.port);
      assert.equal(res.status, 200);
      assert.match(res.body, /군영 현황판/);
      assert.match(res.headers['content-type'], /text\/html/);
    });
  } finally {
    rm(dir);
  }
});

// ===== AC1/지시1: 바인딩 주소는 127.0.0.1 뿐, 0.0.0.0 설정은 거부 =====
test('AC1: 127.0.0.1 전용 바인딩 — 0.0.0.0 설정은 거부', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {});
    await withServer(dir, {}, async (srv) => {
      assert.equal(srv.address, '127.0.0.1', '루프백에만 바인딩');
    });
    await assert.rejects(() => web.start({ dataDir: dir, port: 0, host: '0.0.0.0' }), /127\.0\.0\.1|루프백/, '0.0.0.0은 거부');
  } finally {
    rm(dir);
  }
});

// ===== 지시1: Host 헤더 검증(DNS 리바인딩 방지) =====
test('지시1: Host 헤더가 localhost/127.0.0.1이 아니면 403', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {});
    await withServer(dir, {}, async (srv) => {
      const ok1 = await request(srv.port, { headers: { Host: `127.0.0.1:${srv.port}` } });
      assert.equal(ok1.status, 200);
      const ok2 = await request(srv.port, { headers: { Host: 'localhost' } });
      assert.equal(ok2.status, 200);
      const bad = await request(srv.port, { headers: { Host: 'evil.example.com' } });
      assert.equal(bad.status, 403, 'DNS 리바인딩 Host는 거부');
    });
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 7/지시3: GET만 허용 — 쓰기 메서드 거부 =====
test('시나리오7: POST/PUT/DELETE는 405(읽기 전용)', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {});
    await withServer(dir, {}, async (srv) => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await request(srv.port, { method });
        assert.equal(res.status, 405, `${method} 거부`);
      }
      const nf = await request(srv.port, { pathName: '/no-such' });
      assert.equal(nf.status, 404, '미정의 경로 404');
    });
  } finally {
    rm(dir);
  }
});

// ===== 지시3: 외부 CDN·폰트 0(오프라인 무의존) =====
test('지시3: 페이지에 외부 리소스 참조가 없다', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {});
    await withServer(dir, {}, async (srv) => {
      const res = await request(srv.port);
      assert.ok(!/https?:\/\//.test(res.body), '외부 URL 0 (CDN·폰트 금지)');
      assert.ok(!/<script src=|<link [^>]*href=/.test(res.body), '외부 script/link 없음');
    });
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 3 + AC2: 다섯 구역 표시값이 장부와 일치 =====
test('시나리오3: 관직·병력·성·포로·전공 값이 장부와 일치', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {
      rank: { rank: 'taesu', per_stock_troops_max: 30, concurrent_max: 3, sortie_count: 2, clean_weeks: 1, review_weeks: 1 },
      positions: [
        { id: 'p1', account_type: 'paper', nation: 'wi', symbol: '035720', name: '카카오', qty: 4, avg_price: 48500, stop_price: 46000, target_price: 53000, deadline: '2026-12-10', status: 'open' },
      ],
      snapshot: { start_total_eval: 1000000, start_cash: 400000 },
      captiveRows: [
        { id: 'c1', account_type: 'paper', trade_date: '2026-11-20', order_log_id: 'o1', realized_pnl: -30000, loss_outstanding_after: 30000, captives_after: 3, merit_delta: 0, merit_total_after: 0, created_at: '2026-11-20T15:30:00+09:00' },
        { id: 'c2', account_type: 'paper', trade_date: '2026-11-21', order_log_id: 'o2', realized_pnl: 50000, loss_outstanding_after: 0, captives_after: 0, merit_delta: 20000, merit_total_after: 20000, created_at: '2026-11-21T15:30:00+09:00' },
      ],
    });
    await withServer(dir, {}, async (srv) => {
      const { body } = await request(srv.port);
      // 다섯 구역 존재
      for (const sec of ['관직', '병력', '출병 중인 성', '포로', '전공']) {
        assert.ok(body.includes(sec), `구역: ${sec}`);
      }
      // 관직 카드: 태수 30만/3성
      assert.match(body, /태수/);
      // 성 표: 카카오 4주×48,500 = 194,000원 → 병사 19명(1만원=1명, 반올림)
      assert.match(body, /카카오/);
      assert.match(body, /19명/, '194,000원 → 병사 19명');
      // 포로·전공: captive_ledger 재계산과 일치(TSK-004 재사용) — 포로 0, 전공 20,000
      assert.match(body, /포로 0명/);
      assert.match(body, /20,000/, '누적 전공');
      // 군량: 400,000/1,000,000 = 40%
      assert.match(body, /40%/, '군량 비중');
    });
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 4 + AC3: 포로 발생일 → 복수 출병 금지 띠 =====
test('시나리오4: 포로 발생일에 복수 출병 금지 띠가 뜬다', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {
      captiveRows: [
        { id: 'c1', account_type: 'paper', trade_date: '2026-11-25', order_log_id: 'o1', realized_pnl: -20000, loss_outstanding_after: 20000, captives_after: 2, merit_delta: 0, merit_total_after: 0, created_at: '2026-11-25T10:00:00+09:00' },
      ],
    });
    await withServer(dir, { today: '2026-11-25' }, async (srv) => {
      const { body } = await request(srv.port);
      assert.match(body, /복수 출병 금지/, '빨간 띠');
    });
    // 포로 발생일이 아니면 띠 없음
    const dir2 = makeTmpDir();
    try {
      seed(dir2, {});
      await withServer(dir2, { today: '2026-11-25' }, async (srv) => {
        const { body } = await request(srv.port);
        assert.ok(!body.includes('복수 출병 금지'), '평시엔 띠 없음');
      });
    } finally {
      rm(dir2);
    }
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 5: 현금 비중 34% → 군량 주황 경고 =====
test('시나리오5: 군량 34%면 주황 경고', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, { snapshot: { start_total_eval: 1000000, start_cash: 340000 } });
    await withServer(dir, {}, async (srv) => {
      const { body } = await request(srv.port);
      assert.match(body, /34%/);
      assert.match(body, /class="ration-warn"/, '주황 경고 마커(35% 미만)');
    });
    // 40%면 경고 없음
    const dir2 = makeTmpDir();
    try {
      seed(dir2, { snapshot: { start_total_eval: 1000000, start_cash: 400000 } });
      await withServer(dir2, {}, async (srv) => {
        const { body } = await request(srv.port);
        assert.ok(!body.includes('class="ration-warn"'), '40%는 경고 없음');
      });
    } finally {
      rm(dir2);
    }
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 6 + AC4(SCR-005 AC4): 승진 조건 충족 → "승진 가능" =====
test('시나리오6: 출병 5·위반 0·복기 4주면 승진 가능 표시(자동 승진 아님)', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, { rank: { sortie_count: 5, clean_weeks: 4, review_weeks: 4 } });
    await withServer(dir, {}, async (srv) => {
      const { body } = await request(srv.port);
      assert.match(body, /승진 가능/, '승진 가능 표시');
      assert.match(body, /현령/, '관직은 여전히 현령(자동 승진 아님)');
    });
    // 미충족이면 표시 없음
    const dir2 = makeTmpDir();
    try {
      seed(dir2, { rank: { sortie_count: 3, review_weeks: 4 } });
      await withServer(dir2, {}, async (srv) => {
        const { body } = await request(srv.port);
        assert.ok(!body.includes('승진 가능'), '미충족 시 표시 없음');
      });
    } finally {
      rm(dir2);
    }
  } finally {
    rm(dir);
  }
});

// ===== AC3(SCR-005): 위반 발생 → 카운트 0 표시 + 위반 띠 =====
test('위반 띠: 위반 기록이 있으면 띠 노출 + 카운트 0 표시', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {
      rank: { sortie_count: 0, clean_weeks: 0, review_weeks: 0 },
      violations: [
        { id: 'v1', violation_date: '2026-11-24', code: 'V2_stop_exit_missed', context: '손절 매도 기한 미이행', order_log_id: null, created_at: '2026-11-24T16:00:00+09:00' },
      ],
    });
    await withServer(dir, {}, async (srv) => {
      const { body } = await request(srv.port);
      assert.match(body, /군령 위반/, '위반 띠');
      assert.match(body, /승진 카운트 초기화/, '초기화 안내');
      assert.match(body, /출병 0/, '카운트 0 표시');
    });
  } finally {
    rm(dir);
  }
});

// ===== 에지/지시4: 장부가 전혀 없어도 오류 없이 '없음' 표시 =====
test('에지: 빈 장부 — 전군 주둔 중·없음 표시, 오류 0', async () => {
  const dir = makeTmpDir(); // 아무 것도 시드하지 않음
  try {
    await withServer(dir, {}, async (srv) => {
      const { body, status } = await request(srv.port);
      assert.equal(status, 200, '빈 장부에도 200');
      assert.match(body, /전군 주둔 중/, '출병 0건 빈 상태');
      assert.match(body, /없음/, '장부 없는 구역은 없음 표시');
      assert.match(body, /현령/, '관직 상태 없으면 안전 기본 현령');
      assert.match(body, /포로 0명/, '빈 원장도 포로 0명(화면 검수에서 발견한 undefined 회귀 방지)');
      assert.ok(!body.includes('undefined'), 'undefined 누출 없음');
    });
  } finally {
    rm(dir);
  }
});

// ===== 에지: 155,000원 포지션 → 병사 환산 표시(1만원=1명, 반올림 16명) =====
test('에지: 155,000원 포지션 병사 표시 = 16명(반올림, 소수점 없음)', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {
      positions: [
        { id: 'p1', account_type: 'paper', nation: 'chok', symbol: '005930', name: '삼성전자', qty: 5, avg_price: 31000, stop_price: 29000, target_price: 35000, deadline: '2026-12-10', status: 'open' },
      ],
    });
    await withServer(dir, {}, async (srv) => {
      const { body } = await request(srv.port);
      assert.match(body, /16명/, '155,000원 → 16명');
      assert.ok(!body.includes('15.5'), '소수점 병사 없음');
    });
  } finally {
    rm(dir);
  }
});

// ===== 지시5: 이모지 금지 =====
test('지시5: 페이지에 이모지가 없다', async () => {
  const dir = makeTmpDir();
  try {
    seed(dir, {});
    await withServer(dir, {}, async (srv) => {
      const { body } = await request(srv.port);
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(body), '이모지 0');
    });
  } finally {
    rm(dir);
  }
});

// ===== 포트 설정 파일 =====
test('설정: config/web.json 기본 포트가 62900이고 예약 포트와 겹치지 않는다', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'web.json'), 'utf8'));
  assert.equal(cfg.port, 62900);
  assert.ok(![62838, 8079, 8080].includes(cfg.port), 'OCTET·8079·8080과 충돌 없음');
});
