# 허도 관문 작업 스케줄러 등록 스크립트 (TSK-017 / ARC-009 — 지령 006에서 보관용으로 재작성)
#
# ※ 회사 보안 PC 정책으로 자동 시작은 '보류' — 이 스크립트는 보관만 하고 실행하지 않는다.
#    평시 기동은 bin\gujiga-start.ps1 (군주가 매일 1줄). 이 파일은 정책이 풀리는 날을 위한 보관본.
#    '군주가 직접' 1회 실행한다 — 장수(Claude)는 작성만 하고 실행하지 않는다.
#    실행 전 GUJIGA_KIS_KEYS 환경변수(.enc 키 파일 경로)가 사용자 환경변수로 등록되어 있어야 한다.
#
# 동작: Register-ScheduledTask로 '로그온 시 시작'(현재 사용자 권한) 등록.
#       schtasks /TR의 경로 띄어쓰기 버그를 피해 인자를 분리해 넘긴다.
#       배터리 상태에서도 중지되지 않게 하고, 실행 시간 제한을 0(무제한)으로 둔다.
# 해제: bin\gatekeeper-task-unregister.ps1
# 확인: Get-ScheduledTask -TaskName "gujiga-gatekeeper"  /  curl http://127.0.0.1:62910/ping

$taskName = "gujiga-gatekeeper"
$nodeExe  = (Get-Command node).Source
$repo     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $repo "bin\run-gatekeeper.js"

# 실행 파일·인자 분리 — 경로에 띄어쓰기가 있어도 안전
$action  = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 배터리 중지 해제(-DontStopIfGoingOnBatteries·-AllowStartIfOnBatteries) + 실행 시간 제한 0(무제한)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force

Write-Host "등록 완료: $taskName (로그온 시 시작, 현재 사용자 권한, 배터리 중지 해제, 시간 제한 없음)"
Write-Host "지금 바로 켜려면: Start-ScheduledTask -TaskName $taskName"
