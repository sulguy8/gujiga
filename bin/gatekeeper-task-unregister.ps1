# 허도 관문 작업 스케줄러 해제 스크립트 (TSK-017)
#
# ※ '군주가 직접' 실행한다 — 장수(Claude)는 작성만 하고 실행하지 않는다.

$taskName = "gujiga-gatekeeper"
schtasks /Delete /F /TN $taskName
Write-Host "해제 완료: $taskName"
