'use strict';

// TST-002 — DPAPI 암호화(키·토큰 캐시) 자동 테스트 (자동 항목 1·2·4·6 + 에지)
// 상위: TSK-002 / ARC-005(B안 확정)
// 실행: node --test (Node 내장, 외부 패키지 0 — DPAPI는 PowerShell 경유)
//
// 주의: 실제 키 파일은 열지도 옮기지도 않는다. 모든 비밀값은 임시 폴더의 '가짜' 더미다.
// 시나리오 3(다른 Windows 계정 복호화 실패)·5(평문 키 0건 탐색)는 군주 수동 확인 항목.
// AC3(KIS 모의 호출 1회)은 TSK-003에서 검증.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const secret = require('../src/secret');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gujiga-tst002-'));
}
function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ===== 시나리오 1: 더미 문자열 encrypt → decrypt 원문 일치 =====
test('시나리오1: encrypt → decrypt 왕복 일치(한글·특수문자 포함)', () => {
  const dummy = '가짜-APP-SECRET-123!@#';
  const blob = secret.encrypt(dummy);
  assert.notEqual(blob, dummy);
  assert.equal(secret.decrypt(blob), dummy, '왕복 일치');
});

// ===== stdin 전달 증명: 인자로 넘기면 깨질 입력(개행·따옴표·$·백틱)도 무사 왕복 =====
test('지시: 평문은 stdin 경유 — 개행·따옴표·$()·백틱 포함 입력도 왕복', () => {
  const nasty = 'line1\nline2 "quoted" $(evil) `tick` \'single\' $env:PATH 끝';
  assert.equal(secret.decrypt(secret.encrypt(nasty)), nasty, '셸 해석되면 깨질 입력이 무사함 = 인자 미사용');
});

// ===== 시나리오 2: 암호화 파일 바이너리 열람 → 평문 패턴 미검출 =====
test('시나리오2: 암호화 파일에 평문 패턴이 없다', () => {
  const dir = makeTmpDir();
  try {
    const dummy = 'FAKE-KIS-APPKEY-PSABCDEFG';
    const file = path.join(dir, 'fake.enc');
    secret.encryptToFile(dummy, file);
    const raw = fs.readFileSync(file); // Buffer
    assert.ok(!raw.includes(Buffer.from(dummy, 'utf8')), '평문 미검출');
    assert.ok(!raw.includes(Buffer.from('APPKEY')), '부분 문자열도 미검출');
    // 왕복
    assert.equal(secret.decryptFile(file), dummy);
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 4(캐시 부분): 토큰 캐시 저장·로드가 secret 경유, 파일은 암호화 형태 =====
test('시나리오4: 토큰 캐시 저장·로드 왕복 + 디스크에는 암호문만', () => {
  const dir = makeTmpDir();
  try {
    const token = { access_token: 'FAKE-TOKEN-xyz987', expires_at: '2026-11-26T08:00:00+09:00' };
    secret.saveToken('kis_paper', token, { dataDir: dir });
    const loaded = secret.loadToken('kis_paper', { dataDir: dir });
    assert.deepEqual(loaded, token, '로드 왕복');

    // 디스크 파일에 평문 토큰 없음
    const files = fs.readdirSync(path.join(dir, 'secrets'));
    assert.equal(files.length, 1);
    const raw = fs.readFileSync(path.join(dir, 'secrets', files[0]));
    assert.ok(!raw.includes(Buffer.from('FAKE-TOKEN-xyz987')), '토큰 평문 미검출');

    // 캐시 없으면 null(예외 아님)
    assert.equal(secret.loadToken('kis_missing', { dataDir: dir }), null);

    // 재발급(덮어쓰기) 경로에서도 암호화 유지(에지)
    const token2 = { access_token: 'FAKE-TOKEN-renewed', expires_at: '2026-11-27T08:00:00+09:00' };
    secret.saveToken('kis_paper', token2, { dataDir: dir });
    assert.deepEqual(secret.loadToken('kis_paper', { dataDir: dir }), token2);
    const raw2 = fs.readFileSync(path.join(dir, 'secrets', files[0]));
    assert.ok(!raw2.includes(Buffer.from('FAKE-TOKEN-renewed')), '재발급 캐시도 암호문');
  } finally {
    rm(dir);
  }
});

// ===== 에지: 손상 파일 → 명확한 오류, 평문 폴백·재시도 없음, 메시지에 내용·경로 없음 =====
test('에지: 손상 암호화 파일은 명확한 오류(내용·경로 노출 없음)', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'broken.enc');
    fs.writeFileSync(file, 'GJDPAPI1\n@@@corrupted-not-base64@@@', 'utf8');
    let err;
    try {
      secret.decryptFile(file);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '오류가 나야 한다(조용한 실패 금지)');
    assert.ok(!err.message.includes(dir), '오류 메시지에 경로 없음');
    assert.ok(!err.message.includes('corrupted-not-base64'), '오류 메시지에 파일 내용 없음');

    // 마커 없는 파일(평문/비정상)도 복호화 거부 — 평문 폴백 금지
    const notEnc = path.join(dir, 'plain.txt');
    fs.writeFileSync(notEnc, 'just-plaintext', 'utf8');
    assert.throws(() => secret.decryptFile(notEnc), /암호화 형식|형식 아님|marker/i, '평문 폴백 없음');
  } finally {
    rm(dir);
  }
});

// ===== 시나리오 6: 키·토큰 경로가 git 추적에서 제외된다 =====
test('시나리오6: 키·토큰 경로 git ignore 확인', () => {
  const repo = path.resolve(__dirname, '..');
  const ignored = (name) => {
    try {
      execFileSync('git', ['check-ignore', '-q', name], { cwd: repo });
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(ignored('secrets/anything.enc'), 'secrets/ 제외');
  assert.ok(ignored('kis_keys.json'), 'kis*.json 제외');
  assert.ok(ignored('my_token_cache.json'), '*token*.json 제외');
  assert.ok(ignored('api.secret'), '*.secret 제외');
});

// ===== 전환 스크립트: --dry-run / 전환+왕복 검증 / 평문은 삭제하지 않고 안내만 =====
test('전환 스크립트: dry-run은 쓰기 0, 실행은 .enc 생성·왕복 검증·평문 보존·안내 출력', () => {
  const dir = makeTmpDir();
  try {
    const plain = path.join(dir, 'fake_kis_keys.json');
    fs.writeFileSync(plain, JSON.stringify({ appkey: 'FAKE-KEY', appsecret: 'FAKE-SECRET' }), 'utf8');
    const script = path.join(__dirname, '..', 'bin', 'convert-secrets.js');

    // --dry-run: 아무 파일도 생기지 않는다
    const dry = execFileSync(process.execPath, [script, '--dry-run', plain], { encoding: 'utf8' });
    assert.ok(!fs.existsSync(plain + '.enc'), 'dry-run은 쓰기 0');
    assert.match(dry, /dry-run/i);

    // 실행: .enc 생성 + 왕복 검증 통과 + 평문 파일은 그대로(삭제는 군주)
    const out = execFileSync(process.execPath, [script, plain], { encoding: 'utf8' });
    assert.ok(fs.existsSync(plain + '.enc'), '.enc 생성');
    assert.ok(fs.existsSync(plain), '평문은 삭제하지 않는다');
    assert.match(out, /군주가.*삭제|삭제.*군주/, '군주가 삭제 안내');
    assert.match(out, /왕복 검증|검증 통과/, '왕복 검증 수행');

    // 출력에 키 값·경로 미노출(지시)
    assert.ok(!out.includes('FAKE-KEY'), '출력에 키 값 없음');
    assert.ok(!out.includes('FAKE-SECRET'), '출력에 시크릿 없음');
    assert.ok(!out.includes(dir), '출력에 경로 없음');

    // .enc 내용 검증
    assert.equal(secret.decryptFile(plain + '.enc'), fs.readFileSync(plain, 'utf8'), '복호화 = 원문');
    const raw = fs.readFileSync(plain + '.enc');
    assert.ok(!raw.includes(Buffer.from('FAKE-SECRET')), '암호문에 평문 없음');
  } finally {
    rm(dir);
  }
});

// ===== 모듈 표면: 로그 함수·평문 저장 경로가 없는지 =====
test('표면: secret 모듈에 평문 저장·로그 경로가 없다', () => {
  const keys = Object.keys(secret);
  assert.ok(!keys.some((k) => /plain|log/i.test(k)), '평문 저장·로그 API 없음');
  for (const k of ['encrypt', 'decrypt', 'encryptToFile', 'decryptFile', 'saveToken', 'loadToken']) {
    assert.equal(typeof secret[k], 'function', `${k} 존재`);
  }
});
