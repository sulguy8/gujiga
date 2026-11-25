# 허도 관문 작업 스케줄러 등록 스크립트 (TSK-017 / ARC-009 확정)
#
# ※ 이 스크립트는 '군주가 직접' 1회 실행한다 — 장수(Claude)는 작성만 하고 실행하지 않는다.
#    실행 전 GUJIGA_KIS_KEYS 환경변수(.enc 키 파일 경로)가 사용자 환경변수로 등록되어 있어야 한다.
#
# 동작: Windows 작업 스케줄러에 '로그온 시 시작'(현재 사용자 권한, 관리자 불필요)으로
#       gujiga 관문(run-gatekeeper)을 등록한다.
# 해제: bin\gatekeeper-task-unregister.ps1
# 확인: schtasks /Query /TN "gujiga-gatekeeper"  /  curl http://127.0.0.1:62910/ping

$taskName = "gujiga-gatekeeper"
$nodeExe  = (Get-Command node).Source
$repo     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $repo "bin\run-gatekeeper.js"

# ONLOGON: 로그온 시 시작, 현재 사용자 권한(/RL LIMITED — 관리자 권한 불필요)
schtasks /Create /F /TN $taskName /SC ONLOGON /RL LIMITED `
  /TR "`"$nodeExe`" `"$script`""

Write-Host "등록 완료: $taskName (로그온 시 시작, 현재 사용자 권한)"
Write-Host "지금 바로 켜려면: schtasks /Run /TN $taskName"
