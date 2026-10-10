$proc = Start-Process -FilePath "D:\Programs\ZenBrowser\zen.exe" -ArgumentList "file:///D:/DocumentosDiscoD/Zen/zenKev/test-page.html" -PassThru
Write-Output "ZEN_STARTED_PID: $($proc.Id)"
$proc.WaitForExit()
Write-Output "ZEN_EXITED"
