# 아침 기동 명령 (지령 006 / ARC-009 개정 — 회사 보안 PC: 자동 시작 보류, 군주가 매일 1줄)
#
# 실행: powershell -ExecutionPolicy Bypass -File C:\workspace\gujiga\bin\gujiga-start.ps1
#       (또는 npm start — 단, 운영 기동은 본 저장소(C:\workspace\gujiga)에서만. worktree에서 실행하면 worktree 코드로 데몬이 뜬다)
# 동작: 관문(run-gatekeeper)과 그림자(run-shadow)를 각각 최소화된 별도 창으로 띄운다.
#       작업 스케줄러·서비스 등록 없음(보관용 등록 스크립트는 별도, 실행 안 함).
#       관문이 이미 떠 있으면(62910 /ping 응답) 관문은 건너뛴다.
# 종료: bin\gujiga-stop.ps1

$repo = Split-Path -Parent $PSScriptRoot
$keys = $env:GUJIGA_KIS_KEYS
if (-not $keys) { $keys = "C:\Users\조용수\.aside\u\1\secrets\kis.json.enc" }

# 관문 포트(설정 파일 — 기본 62910)
$gatePort = 62910
$cfgPath = Join-Path $repo "config\gatekeeper.json"
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($null -ne $cfg.port) { $gatePort = $cfg.port }
  } catch {}
}

# 관문 생존 확인(/ping) — 이미 떠 있으면 건너뜀
$gateAlive = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$gatePort/ping" -UseBasicParsing -TimeoutSec 2
  if ($r.StatusCode -eq 200) { $gateAlive = $true }
} catch {}

function Start-Minimized([string]$scriptPath, [string]$label) {
  # GUJIGA_KIS_KEYS는 '그 창에만' 설정(사용자 환경변수 등록 안 함)
  $cmd = "`$env:GUJIGA_KIS_KEYS='$keys'; node '$scriptPath'"
  Start-Process powershell -WindowStyle Minimized -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd
  Write-Host "기동: $label (최소화 창)"
}

# 그림자 생존 확인(run-shadow.js 프로세스) — 이미 떠 있으면 건너뜀(npm start 반복 대비)
$shadowAlive = $false
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
  foreach ($p in $procs) { if ($p.CommandLine -match 'run-shadow\.js') { $shadowAlive = $true; break } }
} catch {}

if ($gateAlive) {
  Write-Host "관문 이미 가동 중(127.0.0.1:$gatePort /ping 응답) - 건너뜀"
} else {
  Start-Minimized (Join-Path $repo "bin\run-gatekeeper.js") "허도 관문(gatekeeper, $gatePort)"
}

if ($shadowAlive) {
  Write-Host "그림자 이미 가동 중(run-shadow.js) - 건너뜀"
} else {
  Start-Minimized (Join-Path $repo "bin\run-shadow.js") "그림자 데몬(shadow, 주문 0건)"
}

Write-Host "완료. 확인: http://127.0.0.1:$gatePort/ping · 현황판 http://127.0.0.1:62900/"
