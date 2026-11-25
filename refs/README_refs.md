# refs (원재료, 게이트 없음)

군주가 Aside와 운용 중인 실물 매매 체계의 원재료 사본. 2026-11-24 군사가 복사.
키·토큰·계좌번호·잔고·주문 기록은 넣지 않았다. 경로는 <ASIDE_ROOT>, <SECRETS_DIR>로 가렸다.

- api/: kis_client.js(한투 KIS 클라이언트, 검증됨), kis_notes.md(TR·파라미터·호출 간격), chart_check.js(차트 채점, KIS 일봉)
- research/: 병법서.md(세계관·군령·관직), patterns.md(패턴 가설 장부), chart.md(차트 채점 기준), retro.md(시행착오)
- ops/: spec_morning(08:31 군의), spec_preclose(15:05 전황), spec_scout(5분 척후), spec_mock(세력전), spec_weekly(논공행상), guard.json(한도·화이트리스트)

장수(Claude Code)는 구현 시 `octet context`와 함께 이 폴더를 참고한다. 원본이 바뀌면 군사가 다시 복사한다.
