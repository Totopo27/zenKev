$zenProcs = Get-Process -Name zen -ErrorAction SilentlyContinue
if ($zenProcs) {
    Write-Output "MONITORING_ZEN_PROCS: $($zenProcs.Count)"
    $mainProc = $zenProcs | Sort-Object WS -Descending | Select-Object -First 1
    $mainProc.WaitForExit()
    Write-Output "ZEN_CLOSED"
} else {
    Write-Output "NO_ZEN_RUNNING"
}
