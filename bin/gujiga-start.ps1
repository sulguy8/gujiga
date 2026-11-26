# 아침 기동 명령 (지령 006 / ARC-009 개정 — 회사 보안 PC: 자동 시작 보류, 군주가 매일 1줄)
#
# 실행: powershell -ExecutionPolicy Bypass -File C:\workspace\gujiga\bin\gujiga-start.ps1
#       (또는 npm start — 단, 운영 기동은 본 저장소(C:\workspace\gujiga)에서만. worktree에서 실행하면 worktree 코드로 데몬이 뜬다)
# 동작: 관문(run-gatekeeper)·그림자(run-shadow)·현황판(run-dashboard)을 창 없이(Hidden) 띄운다(2026-11-26 군주 명).
#       출력은 gujiga-data\logs\<이름>-<기동시각>.log(.err.log)로 — node가 UTF-8로 직접 쓴다
#       (PowerShell 파이프 경유 한글 깨짐 회피). 같은 날 재기동은 새 파일(덮어쓰기 방지).
#       작업 스케줄러·서비스 등록 없음(보관용 등록 스크립트는 별도, 실행 안 함).
#       관문이 이미 떠 있으면(62910 /ping 응답) 관문은 건너뛴다.
# 종료: bin\gujiga-stop.ps1 · 상태: npm run status
# 기동 확인 규칙 불변(군령 10): ping 200은 생존만 — 정상 확인은 관문 경유 모의 잔고 조회까지.

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

# 로그 폴더(운영 데이터 쪽 — 저장소 밖). 백업 레포에는 올리지 않음(gujiga-data\.gitignore의 logs/).
$logsDir = Join-Path $env:USERPROFILE "gujiga-data\logs"
New-Item -ItemType Directory -Force $logsDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# 30일 지난 로그는 정리(무기한 증가 방지 — 군사 검토 2026-11-26. 백업 레포에는 logs 미포함)
Get-ChildItem $logsDir -Filter '*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  ForEach-Object { try { Remove-Item $_.FullName -Force -Confirm:$false } catch {} }

function Start-Hidden([string]$scriptPath, [string]$label, [string]$logName, [switch]$NoKeys) {
  $out = Join-Path $logsDir "$logName-$stamp.log"
  $err = Join-Path $logsDir "$logName-$stamp.err.log"
  # GUJIGA_KIS_KEYS는 자식 프로세스에만 상속. 군주가 세션에 미리 설정해 둔 값은 보존(군사 지적 —
  # 설정 → 기동 → 원래 값 복원. 사용자 환경변수 등록 안 함). 키 불필요 프로세스는 -NoKeys(최소 권한).
  $prevKeys = $env:GUJIGA_KIS_KEYS
  if (-not $NoKeys) { $env:GUJIGA_KIS_KEYS = $keys }
  try {
    Start-Process node -WindowStyle Hidden -ArgumentList "`"$scriptPath`"" `
      -RedirectStandardOutput $out -RedirectStandardError $err
  } finally {
    if (-not $NoKeys) {
      if ($null -ne $prevKeys) { $env:GUJIGA_KIS_KEYS = $prevKeys }
      else { Remove-Item Env:GUJIGA_KIS_KEYS -ErrorAction SilentlyContinue }
    }
  }
  Write-Host "기동: $label (창 없음, 로그 $out)"
}

# 현황판 포트(설정 파일 — 기본 62900, 안내 문구용. 기동 자체는 web.js가 config를 읽는다)
$dashPort = 62900
$webCfgPath = Join-Path $repo "config\web.json"
if (Test-Path $webCfgPath) {
  try {
    $webCfg = Get-Content $webCfgPath -Raw | ConvertFrom-Json
    if ($null -ne $webCfg.port) { $dashPort = $webCfg.port }
  } catch {}
}

# 그림자·현황판 생존 확인(프로세스) — 이미 떠 있으면 건너뜀(npm start 반복 대비)
$shadowAlive = $false
$dashAlive = $false
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
  foreach ($p in $procs) {
    if ($p.CommandLine -match 'run-shadow\.js') { $shadowAlive = $true }
    if ($p.CommandLine -match 'run-dashboard\.js') { $dashAlive = $true }
  }
} catch {}

if ($gateAlive) {
  Write-Host "관문 이미 가동 중(127.0.0.1:$gatePort /ping 응답) - 건너뜀"
} else {
  Start-Hidden (Join-Path $repo "bin\run-gatekeeper.js") "허도 관문(gatekeeper, $gatePort)" "gatekeeper"
}

if ($shadowAlive) {
  Write-Host "그림자 이미 가동 중(run-shadow.js) - 건너뜀"
} else {
  Start-Hidden (Join-Path $repo "bin\run-shadow.js") "그림자 데몬(shadow, 주문 0건)" "shadow"
}

if ($dashAlive) {
  Write-Host "현황판 이미 가동 중(run-dashboard.js) - 건너뜀"
} else {
  Start-Hidden (Join-Path $repo "bin\run-dashboard.js") "군영 현황판($dashPort, 읽기 전용)" "dashboard" -NoKeys
}

Write-Host "완료. 상태: npm run status · 확인: http://127.0.0.1:$gatePort/ping · 현황판 http://127.0.0.1:$dashPort/"
Write-Host "기동 확인은 ping만으로 부족 - 관문 경유 모의 잔고 조회까지(군사 루틴이 확인)"
