# 기동 상태 확인 (2026-11-26 군주 명) — npm run status
# 보여주는 것: ① 관문 /ping 응답 ② 관문·그림자 프로세스 수 ③ 마지막 그림자 회차 시각
# 주의: ping 200은 '생존'만 증명한다 — 정상 확인(키 복호화)은 관문 경유 모의 잔고 조회까지(군령 10).

$repo = Split-Path -Parent $PSScriptRoot

# 관문 포트(설정 파일 — 기본 62910)
$gatePort = 62910
$cfgPath = Join-Path $repo "config\gatekeeper.json"
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($null -ne $cfg.port) { $gatePort = $cfg.port }
  } catch {}
}

# 1. 관문 응답
$gate = "응답 없음"
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$gatePort/ping" -UseBasicParsing -TimeoutSec 2
  if ($r.StatusCode -eq 200) { $gate = "200 OK" }
} catch {}

# 1-2. 현황판 응답(62900 — config\web.json)
$dashPort = 62900
$webCfgPath = Join-Path $repo "config\web.json"
if (Test-Path $webCfgPath) {
  try {
    $webCfg = Get-Content $webCfgPath -Raw | ConvertFrom-Json
    if ($null -ne $webCfg.port) { $dashPort = $webCfg.port }
  } catch {}
}
$dash = "응답 없음"
try {
  $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:$dashPort/" -UseBasicParsing -TimeoutSec 2
  if ($r2.StatusCode -eq 200) { $dash = "200 OK" }
} catch {}

# 2. 프로세스 수(관문·그림자·현황판 각각)
$gateProcs = 0; $shadowProcs = 0; $dashProcs = 0
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
  foreach ($p in $procs) {
    if ($p.CommandLine -match 'run-gatekeeper\.js') { $gateProcs++ }
    if ($p.CommandLine -match 'run-shadow\.js') { $shadowProcs++ }
    if ($p.CommandLine -match 'run-dashboard\.js') { $dashProcs++ }
  }
} catch {}

# 3. 마지막 그림자 회차(shadow_job_log 최신 행 — 월별 jsonl의 마지막 줄)
$lastJob = "기록 없음"
$logDir = Join-Path $env:USERPROFILE "gujiga-data\ledger\shadow_job_log"
if (Test-Path $logDir) {
  $f = Get-ChildItem $logDir -Filter '*.jsonl' | Sort-Object Name -Descending | Select-Object -First 1
  if ($f) {
    $line = Get-Content $f.FullName -Tail 1 -Encoding UTF8 # 장부는 UTF-8 — ANSI로 읽으면 한글이 깨져 파싱 실패
    try {
      $row = $line | ConvertFrom-Json
      $lastJob = "$($row.job) · $($row.date) · 기록 $($row.created_at)"
    } catch { $lastJob = "파싱 실패($($f.Name))" }
  }
}

Write-Host "관문(127.0.0.1:$gatePort /ping) : $gate"
Write-Host "현황판(127.0.0.1:$dashPort /) : $dash"
Write-Host "프로세스 : 관문 $gateProcs 개 · 그림자 $shadowProcs 개 · 현황판 $dashProcs 개"
Write-Host "마지막 그림자 회차 : $lastJob"
Write-Host "참고: ping 200은 생존만 - 정상 확인은 관문 경유 모의 잔고 조회까지(군사 루틴이 확인)"
