# 외국인 순매수(투자자 동향) KIS TR id 제안서

상태(2026-11-25 갱신): **TR 확정 — `FHPTJ04040000`** (군주 확정, 한투 공식 GitHub 예제 기준)
- 경로 `GET /uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market`
- 파라미터 `FID_COND_MRKT_DIV_CODE='U'`, `FID_INPUT_ISCD='0001'`, `FID_INPUT_DATE_1/2=조회일`, `FID_INPUT_ISCD_1='KSP'`, `FID_INPUT_ISCD_2='0001'`
- **잔여 확인 항목(실관찰 1일)**: 응답의 외국인 순매수 **필드명**(현재 `frgn_ntby_tr_pbmn` 가정 — 가짜 서버 fixture 기준).
  확인 전까지 이 값·신호 4번은 **'미검증' 태그**로 표기된다.
- 지수 일봉 `FHKUP03500100`(U·0001)도 함께 **확정**.

---
(이하 원제안 — 이력 보존)

## refs/api 확인 결과

`refs/api/kis_notes.md`·`kis_client.js`·`chart_check.js` 전수 확인 —
**투자자 동향(외국인 순매수) TR의 실검증 기록은 없다.**
검증된 TR은 잔고(TTTC8434R/VTTC8434R)·현재가(FHKST01010100)·주문 계열(TTTC/VTTC 0011~0013U)·
일별체결(0081R)·매수가능(8908R)·일봉(FHKST03010100, chart_check.js)뿐이다.
따라서 아래 후보는 KIS 공식 OpenAPI 문서 기억에 근거한 **제안**이며, 추측으로 확정하지 않는다.
확정 전까지 수집기(investor-kis)는 **결측 처리**한다(대체 출처 금지 — ARC-008).

## 후보 TR (군사 검토 요청)

| 순위 | 후보 | 경로(추정) | 용도 | 확신도·근거 |
|---|---|---|---|---|
| 1 | `FHKST01010900` | `/uapi/domestic-stock/v1/quotations/inquire-investor` | **종목별** 투자자 매매동향(개인/외국인/기관 순매수) | 중상 — KIS 공식 GitHub 예제에 수 차례 등장하는 조회 TR. 다만 '종목' 단위라 코스피 전체 외국인 순매수에는 지수 코드 입력 가능 여부 확인 필요 |
| 2 | `FHPTJ04030000` | `/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market` (추정) | **시장별** 투자자 매매동향(코스피 전체) | 중하 — '시장별 투자자매매동향' 계열로 기억하나 TR id·경로 모두 불확실 |
| 3 | 코스피 지수에 1번 TR 적용 | 동일 | 지수 코드(`0001`)+시장구분 `U`로 1번을 호출 | 낮음 — 지원 여부 자체가 미확인 |

## 검토·확정 절차 (ARC-008 미결 1)

1. 군사(Aside)가 KIS 공식 문서/실호출로 후보 1·2를 확인(모의 또는 조회 전용 — 주문 아님).
2. 확정되면 `refs/api/kis_notes.md`에 검증 기록 추가(군사) → 군주 승인 → REQ-022·ARC-008 개정.
3. 장수가 investor-kis 수집기를 확정 TR로 구현(결측 해제), `foreign_net_days` 산출 로직 추가.

## 함께 확인 요청(부수)

- 지수 일봉 TR `FHKUP03500100`(`/uapi/.../inquire-daily-indexchartprice`, `FID_COND_MRKT_DIV_CODE=U`)도
  refs에 실검증 기록이 없다(코스피 종가·20일선 수집에 사용 — TSK-015). TST-014 실수집 관찰 1일에서 함께 검증 요망.
