# Login as jbsadmin
$body = @{username='jbsadmin'; password='Omeesha@19'} | ConvertTo-Json
$loginResp = Invoke-RestMethod -Uri 'http://localhost:3001/api/auth/login' -Method POST -Body $body -ContentType 'application/json'
$token = $loginResp.token

# Get configurations
$headers = @{ Authorization = "Bearer $token" }
$configs = Invoke-RestMethod -Uri 'http://localhost:3001/api/configurations' -Method GET -Headers $headers
Write-Host "JBS Admin configs:"
$configs.configs | ForEach-Object { Write-Host "  $($_.integrationId) => status=$($_.status)" }

# Now login as golinadmin
$body2 = @{username='golinadmin'; password='golin@2024'} | ConvertTo-Json
$loginResp2 = Invoke-RestMethod -Uri 'http://localhost:3001/api/auth/login' -Method POST -Body $body2 -ContentType 'application/json'
$token2 = $loginResp2.token

$headers2 = @{ Authorization = "Bearer $token2" }
$configs2 = Invoke-RestMethod -Uri 'http://localhost:3001/api/configurations' -Method GET -Headers $headers2
Write-Host "`nGolin Admin configs:"
$configs2.configs | ForEach-Object { Write-Host "  $($_.integrationId) => status=$($_.status)" }
