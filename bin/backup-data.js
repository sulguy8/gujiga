'use strict';

// gujiga-data 변경분 커밋 + 비공개 원격(origin) push (지령 005)
// 사용: node bin/backup-data.js
// 실패해도 장부 기록에는 영향 없음 — backup_log에 기록만. 원격 없으면 조용히 건너뜀.

const backup = require('../src/backup');

const r = backup.runBackup({});
console.log(`백업: 커밋 ${r.committed ? '있음' : '없음'} · push ${r.pushed ? '완료' : '안 함'}${r.reason ? ' · ' + r.reason : ''}`);
