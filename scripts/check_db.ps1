$dbPath = "$env:USERPROFILE\.local\share\opencode\opencode.db"
if (Test-Path $dbPath) {
    $time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-Output "DB path exists at $dbPath"
} else {
    Write-Output "DB not found at $dbPath"
}
