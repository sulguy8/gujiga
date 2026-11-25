# 그림자 운용 작업 스케줄러 등록 스크립트 (TSK-018 / ARC-009 — 지령 006에서 보관용으로 재작성)
#
# ※ 회사 보안 PC 정책으로 자동 시작은 '보류' — 이 스크립트는 보관만 하고 실행하지 않는다.
#    평시 기동은 bin\gujiga-start.ps1. '군주가 직접' 1회 실행한다 — 장수는 작성만.
#    실행 전 GUJIGA_KIS_KEYS 환경변수(.enc 키 파일 경로)가 사용자 환경변수로 등록되어 있어야 한다.
#
# 동작: Register-ScheduledTask로 '로그온 시 시작'(현재 사용자 권한) 등록(경로 띄어쓰기 안전).
#       배터리 중지 해제 + 실행 시간 제한 0(무제한).
# 해제: bin\shadow-task-unregister.ps1

$taskName = "gujiga-shadow"
$nodeExe  = (Get-Command node).Source
$repo     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $repo "bin\run-shadow.js"

$action  = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force

Write-Host "등록 완료: $taskName (로그온 시 시작, 현재 사용자 권한, 배터리 중지 해제, 시간 제한 없음, 주문 0건 그림자 모드)"
