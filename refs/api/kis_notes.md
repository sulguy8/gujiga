# 한투 KIS API 사용 메모 (검증됨 2026-11-23)

- 키: <SECRETS_DIR> (real.appkey/appsecret/account "8자리-01"). 절대 출력 금지.
- 토큰 캐시: <SECRETS_DIR> {token, expires "YYYY-MM-DD HH:MM:SS"}. 만료 30분 전까지는 재사용. 발급은 1분 1회, 발급마다 사용자에게 알림톡이 가므로 하루 1회만.
- 발급: POST https://openapi.koreainvestment.com:9443/oauth2/tokenP body {grant_type:"client_credentials", appkey, appsecret}
- 공통 헤더: content-type application/json; charset=utf-8, authorization "Bearer "+token, appkey, appsecret, tr_id, custtype "P"
- REPL fetch 전 openTab 하나 필요, 끝나면 closeTab.
- 호출 간격: 연속 호출 시 '초당 거래건수 초과'(HTTP 500, rt_cd 1) 발생. 호출 사이 최소 1.2초 sleep.
- 잔고: GET /uapi/domestic-stock/v1/trading/inquire-balance tr_id TTTC8434R, params CANO, ACNT_PRDT_CD, AFHR_FLPR_YN=N, OFL_YN='', INQR_DVSN=02, UNPR_DVSN=01, FUND_STTL_ICLD_YN=N, FNCG_AMT_AUTO_RDPT_YN=N, PRCS_DVSN=00, CTX_AREA_FK100='', CTX_AREA_NK100=''. output1 보유종목(prdt_name, pdno, hldg_qty, pchs_avg_pric, prpr, evlu_pfls_amt, evlu_pfls_rt), output2[0] dnca_tot_amt(예수금), prvs_rcdl_excc_amt(D+2), tot_evlu_amt.
- 현재가: GET /uapi/domestic-stock/v1/quotations/inquire-price tr_id FHKST01010100, FID_COND_MRKT_DIV_CODE=J, FID_INPUT_ISCD=코드. output.stck_prpr, prdy_ctrt.
- 매수가능: GET /uapi/domestic-stock/v1/trading/inquire-psbl-order tr_id TTTC8908R, PDNO, ORD_UNPR='', ORD_DVSN=01, CMA_EVLU_AMT_ICLD_YN=N, OVRS_ICLD_YN=N. output.ord_psbl_cash.
- 클라이언트: trading\kis_client.js 를 eval로 로드. make('mock'|'real') -> balance(), price(code), order(side, code, qty, price, {confirmed, reason}), modify(orgno, odno, qty, price), cancel(orgno, odno, qty), fills(YYYYMMDD). 토큰 캐시, 호출 간격, 주문 로그(trading\order_log.jsonl), 안전장치(trading\guard.json, trading\STOP) 내장. 주의: 이 환경에서 fs.appendFile 없음.
- 2026-11-23 모의 검증 완료: VTTC8434R 잔고, VTTC0012U/VTTC0011U 지정가 매수/매도(ORD_DVSN 00) 체결, VTTC0013U 정정(RVSE_CNCL_DVSN_CD 01)/취소(02), VTTC0081R 일별체결(output1 ord_gno_brno=주문조직번호, odno, tot_ccld_qty, avg_prvs, rmn_qty). 모의계좌 예수금 1,000만원. 실전 TR(TTTC0012U/0011U/0013U/0081R)은 미검증.
- 모의 도메인 https://openapivts.koreainvestment.com:29443. 모의 시세 대신 실전 키로 시세 조회 사용.
- 2026-11-24 확인: 모의 주문은 08:27에 '모의투자 장시작전 입니다'(rt_cd 1)로 거부, 08:30:43에는 접수됨. 장전 주문은 08:30 이후. 아침 루틴을 08:31로 옮김.
- 2026-11-24 구현: 하루 손실 한도(실전 매수 시 당일 시작 총평가 대비 -5만원 이하면 차단, 기준은 trading\data\real_day_start.json). 모의 1회 한도는 guard.mockMaxOrderKRW(50만), 실전은 maxOrderKRW(현령 20만).
- 실전 주문은 사용자 '실행' 확인 없이 절대 호출 금지. 지정가만.
