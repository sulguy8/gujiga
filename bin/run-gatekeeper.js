#!/usr/bin/env node
'use strict';

// 허도 관문 기동 명령 (TSK-017 / ARC-009)
//
// 사용: node bin/run-gatekeeper.js
//  - config/gatekeeper.json 설정(127.0.0.1:62910)으로 기동한다.
//  - 기동마다 무작위 관문 토큰을 새로 만들어 token_file에 기록한다(값은 출력하지 않음).
//  - 기동 확인: 브라우저/curl로 http://127.0.0.1:62910/ping → {"ok":true}
//  - KIS 키 경로는 환경변수 GUJIGA_KIS_KEYS(.enc — convert-secrets로 전환한 파일).
//  - 종료: Ctrl+C. 상주 등록은 bin/gatekeeper-task-register.ps1 (군주가 직접 1회 실행).

const gatekeeper = require('../src/gatekeeper');

gatekeeper.start({}).then((srv) => {
  console.log(`[gatekeeper] http://127.0.0.1:${srv.port}/ (127.0.0.1 전용)`);
  console.log('[gatekeeper] 관문 토큰 발급·기록 완료(재기동 시 교체, 값 미출력)');
  console.log('[gatekeeper] 기동 확인: GET /ping');
}).catch((e) => {
  console.error(`[gatekeeper] 기동 실패: ${e.message}`);
  process.exit(1);
});
