$procs = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'dist/index.js' -or $_.CommandLine -match '3001' }
if ($procs) { $procs | Stop-Process -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Set-Location "C:\temp\AITestOpsDemo\backend"
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "dist/index.js"
