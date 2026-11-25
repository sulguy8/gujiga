#!/usr/bin/env node
'use strict';

// 군영 현황판 1회 실행 명령 (TSK-009, 지시6 — 서비스·작업 스케줄러 등록 없음)
//
// 사용: node bin/run-dashboard.js
// config/web.json의 포트(기본 62900)로 127.0.0.1 전용 서버를 띄운다. Ctrl+C로 종료.

const web = require('../src/web');

web.start({}).then((srv) => {
  console.log(`[camp-board] http://127.0.0.1:${srv.port}/ (localhost 전용, 읽기 전용)`);
  console.log('종료: Ctrl+C');
}).catch((e) => {
  console.error(`[camp-board] 기동 실패: ${e.message}`);
  process.exit(1);
});
