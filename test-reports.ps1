# Login to get token
$body = @{username='jbsadmin'; password='Omeesha@19'} | ConvertTo-Json
$loginResp = Invoke-RestMethod -Uri 'http://localhost:3001/api/auth/login' -Method POST -Body $body -ContentType 'application/json'
$token = $loginResp.token
Write-Host "Token: $token"

# Call reports endpoint
$headers = @{ Authorization = "Bearer $token" }
$reports = Invoke-RestMethod -Uri 'http://localhost:3001/api/reports/summary' -Method GET -Headers $headers
$reports | ConvertTo-Json -Depth 5
