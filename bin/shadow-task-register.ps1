# 그림자 운용 작업 스케줄러 등록 스크립트 (TSK-018 / ARC-009 방식)
#
# ※ '군주가 직접' 1회 실행한다 — 장수(Claude)는 작성만 하고 실행하지 않는다.
#    실행 전 GUJIGA_KIS_KEYS 환경변수(.enc 키 파일 경로)가 사용자 환경변수로 등록되어 있어야 한다.
#
# 동작: '로그온 시 시작'(현재 사용자 권한)으로 그림자 데몬(run-shadow)을 등록한다.
# 해제: bin\shadow-task-unregister.ps1

$taskName = "gujiga-shadow"
$nodeExe  = (Get-Command node).Source
$repo     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $repo "bin\run-shadow.js"

schtasks /Create /F /TN $taskName /SC ONLOGON /RL LIMITED `
  /TR "`"$nodeExe`" `"$script`""

Write-Host "등록 완료: $taskName (로그온 시 시작, 현재 사용자 권한, 주문 0건 그림자 모드)"
