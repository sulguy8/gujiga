#!/usr/bin/env node
'use strict';

// 평문 비밀 파일 → DPAPI 암호화 파일 1회 전환 (TSK-002)
//
// 사용: node bin/convert-secrets.js [--dry-run] <평문파일> [<평문파일> ...]
//  - 각 파일을 읽어 <파일>.enc 로 암호화 저장하고, 복호화 왕복 검증까지 수행한다.
//  - 평문 파일은 삭제하지 않는다 — 삭제는 군주가 .enc 동작을 확인한 뒤 직접 한다.
//  - --dry-run: 읽기·검사만 하고 아무 것도 쓰지 않는다.
//  - 보안: 출력·오류에 키 값·경로를 찍지 않는다(파일은 번호로만 지칭).

const fs = require('node:fs');
const secret = require('../src/secret');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const files = args.filter((a) => a !== '--dry-run');

if (files.length === 0) {
  console.log('사용법: node bin/convert-secrets.js [--dry-run] <평문파일> ...');
  process.exit(1);
}

let failed = 0;
files.forEach((file, i) => {
  const no = `${i + 1}번 파일`;
  let plain;
  try {
    plain = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`${no}: 읽기 실패 — 경로를 확인하십시오`);
    failed++;
    return;
  }

  if (dryRun) {
    console.log(`${no}: [dry-run] 읽기 가능(${plain.length}자) — 실제 전환 시 .enc 생성 예정, 쓰기 없음`);
    return;
  }

  try {
    const encPath = `${file}.enc`;
    secret.encryptToFile(plain, encPath);
    // 복호화 왕복 검증
    const back = secret.decryptFile(encPath);
    if (back !== plain) {
      console.error(`${no}: 왕복 검증 불일치 — 전환 실패, .enc를 사용하지 마십시오`);
      failed++;
      return;
    }
    console.log(`${no}: 전환 완료 + 복호화 왕복 검증 통과(.enc 생성)`);
  } catch (e) {
    console.error(`${no}: 전환 실패 — ${e.message}`);
    failed++;
  }
});

if (!dryRun && failed === 0) {
  console.log('');
  console.log('평문 파일은 삭제하지 않았습니다 — .enc 동작 확인 후 평문 삭제는 군주가 직접 수행하십시오.');
  console.log('(확인 방법: 앱 기동이 .enc로 정상 동작하는지 본 뒤 평문을 지우고, 휴지통도 비울 것)');
}
process.exit(failed ? 1 : 0);
