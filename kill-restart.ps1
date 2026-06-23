# Find and kill ALL node processes that might be our backend
$nodeProcs = Get-Process -Name 'node' -ErrorAction SilentlyContinue
foreach ($p in $nodeProcs) {
    Write-Host "Killing node PID: $($p.Id)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# Verify port 3001 is free
$conn = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue
if ($conn) {
    Write-Host "Port 3001 still in use!"
} else {
    Write-Host "Port 3001 is free"
}

# Start backend fresh
Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory 'C:\temp\AITestOpsDemo\backend' -WindowStyle Hidden
Start-Sleep -Seconds 3
Write-Host "Backend started"
