# 기동 종료 (지령 006) — 관문·그림자 둘 다 내린다.
# 실행: powershell -ExecutionPolicy Bypass -File C:\workspace\gujiga\bin\gujiga-stop.ps1

$targets = @('run-gatekeeper.js', 'run-shadow.js')
$stopped = 0
foreach ($t in $targets) {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$t*" }
  foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force -Confirm:$false
    Write-Host "종료: $t (PID $($p.ProcessId))"
    $stopped++
  }
}
if ($stopped -eq 0) { Write-Host "떠 있는 관문·그림자 없음" } else { Write-Host "완료: $stopped 개 종료" }
