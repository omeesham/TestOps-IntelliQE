<#
.SYNOPSIS
  Install or update IntelliQE in one Azure resource group (Container Apps, Azure SQL,
  Key Vault, Storage, Log Analytics). Safe to run again: every step checks first.

.DESCRIPTION
  The resource group and the container registry (holding the IntelliQE image) must exist.
  The script creates what is missing:
    - Log Analytics workspace and Container Apps environment
    - Azure SQL logical server + database (Basic), reachable from Azure services
    - Key Vault (RBAC) with the app secrets; existing secrets are never overwritten
    - Storage account + file share for test files, reports and artifacts
    - User-assigned managed identity: reads the secrets (and pulls the image with -AccessModel rbac)
    - The Container App (2 CPU, 4 GiB, exactly 1 copy), HTTPS ingress on port 80
  The Anthropic key is not created here: put it in Key Vault as "anthropic-api-key"
  (the script stops and says so when it is missing).

  Update to a new image: run again with -ImageTag <new tag>. Roll back: run with the
  previous tag. Data in SQL and the file share is not touched by either.

.EXAMPLE
  ./deploy-intelliqe.ps1 -SubscriptionId <id> -ResourceGroup rg-intelliqe-poc -Location eastus `
    -NamePrefix iqepoc -RegistryName gesacr -ImageTag poc-v1
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $Location,
  # 3-12 lowercase letters/digits; resource names are built from it.
  [Parameter(Mandatory)] [ValidatePattern('^[a-z][a-z0-9]{2,11}$')] [string] $NamePrefix,
  # Container registry in this resource group that holds the image.
  [Parameter(Mandatory)] [string] $RegistryName,
  [string] $ImageRepository = 'jbsintelliqe-app',
  [Parameter(Mandatory)] [string] $ImageTag,
  [string] $SqlAdminUser = 'intelliqeadmin',
  [string] $InitialAdminUser = 'iqeadmin',
  # Set to $false only where GES runs the AI worker elsewhere.
  [bool] $RunWorker = $true,
  # Subnet (resource id, /23 or larger, delegated to Microsoft.App/environments) with a
  # route to the on-prem app under test. Without it the app can reach only public sites.
  [string] $InfrastructureSubnetId = '',
  # rbac: needs rights to assign roles (Owner / Role Based Access Control Administrator);
  # policy: works with Contributor only (Key Vault access policies, registry admin credentials).
  [ValidateSet('policy', 'rbac')] [string] $AccessModel = 'policy'
)

$ErrorActionPreference = 'Stop'
$az = (Get-Command az -ErrorAction SilentlyContinue).Source
if (-not $az) { $az = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd' }

function Az {
  $out = & $az @args --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed" }
  return $out
}
function Exists {
  # Native stderr must not stop the script (Windows PowerShell 5.1).
  $ErrorActionPreference = 'Continue'
  & $az @args --only-show-errors 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function NewSecret([int] $bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b)
}

$names = @{
  logs     = "log-$NamePrefix"
  env      = "cae-$NamePrefix"
  sql      = "sql-$NamePrefix-$((Get-Random -Maximum 99999).ToString('00000'))"
  db       = 'JBSTestOpsAI'
  vault    = "kv-$NamePrefix-$((Get-Random -Maximum 9999).ToString('0000'))"
  storage  = "st$NamePrefix$((Get-Random -Maximum 99999).ToString('00000'))"
  share    = 'intelliqe'
  identity = "id-$NamePrefix"
  app      = "ca-$NamePrefix"
}

Step 'Subscription and resource group'
Az account set --subscription $SubscriptionId | Out-Null
if (-not (Exists group show -n $ResourceGroup)) { throw "Resource group $ResourceGroup not found." }
$registry = Az acr show -n $RegistryName -g $ResourceGroup --query '{id:id, server:loginServer}' -o json | ConvertFrom-Json
$image = "$($registry.server)/${ImageRepository}:$ImageTag"
if (-not (Exists acr repository show -n $RegistryName --image "${ImageRepository}:$ImageTag")) {
  throw "Image $image not found. Import it into $RegistryName first (az acr import)."
}
Az extension add --name containerapp --upgrade | Out-Null

# Names chosen by an earlier run are reused (resources tagged with the prefix).
function Reuse($type, $key) {
  $found = @(Az resource list -g $ResourceGroup --resource-type $type --query "[?tags.intelliqe=='$NamePrefix'].name" -o tsv)
  if ($found.Count -and $found[0]) { $names[$key] = $found[0] }
}
Reuse 'Microsoft.Sql/servers' 'sql'
Reuse 'Microsoft.KeyVault/vaults' 'vault'
Reuse 'Microsoft.Storage/storageAccounts' 'storage'
$tags = "intelliqe=$NamePrefix"

Step 'Managed identity'
if (-not (Exists identity show -g $ResourceGroup -n $names.identity)) {
  Az identity create -g $ResourceGroup -n $names.identity -l $Location --tags $tags | Out-Null
}
$identity = Az identity show -g $ResourceGroup -n $names.identity --query '{id:id, principalId:principalId}' -o json | ConvertFrom-Json

Step "Key Vault and secrets (access model: $AccessModel)"
if (-not (Exists keyvault show -g $ResourceGroup -n $names.vault)) {
  # The creator gets an access policy automatically in the policy model.
  Az keyvault create -g $ResourceGroup -n $names.vault -l $Location --enable-rbac-authorization ($AccessModel -eq 'rbac').ToString().ToLower() --tags $tags | Out-Null
}
$vault = Az keyvault show -g $ResourceGroup -n $names.vault --query '{id:id, uri:properties.vaultUri}' -o json | ConvertFrom-Json
if ($AccessModel -eq 'rbac') {
  # A guest account may not read its own directory entry; then it needs Key Vault Secrets Officer already.
  $me = & $az ad signed-in-user show --query id -o tsv --only-show-errors 2>$null
  if ($LASTEXITCODE -eq 0 -and $me) {
    Az role assignment create --assignee-object-id $me --assignee-principal-type User --role 'Key Vault Secrets Officer' --scope $vault.id | Out-Null
  }
  Az role assignment create --assignee-object-id $identity.principalId --assignee-principal-type ServicePrincipal --role 'Key Vault Secrets User' --scope $vault.id | Out-Null
  Az role assignment create --assignee-object-id $identity.principalId --assignee-principal-type ServicePrincipal --role 'AcrPull' --scope $registry.id | Out-Null
  $registryYaml = "      - server: $($registry.server)`n        identity: $($identity.id)"
  $registrySecret = ''
} else {
  # Contributor alone cannot assign roles: the identity reads secrets through an access
  # policy, and the image is pulled with the registry's admin credentials.
  Az keyvault set-policy -n $names.vault --object-id $identity.principalId --secret-permissions get list | Out-Null
  Az acr update -n $RegistryName --admin-enabled true | Out-Null
  $cred = Az acr credential show -n $RegistryName --query '{u:username, p:passwords[0].value}' -o json | ConvertFrom-Json
  $registryYaml = "      - server: $($registry.server)`n        username: $($cred.u)`n        passwordSecretRef: registry-password"
  $registrySecret = "      - { name: registry-password, value: '$($cred.p)' }"
}

function EnsureSecret($name, $value) {
  $ErrorActionPreference = 'Continue'
  # Never overwrite: a new encryption key would make stored credentials unreadable.
  for ($i = 0; $i -lt 12; $i++) {
    if (Exists keyvault secret show --vault-name $names.vault -n $name) { return }
    & $az keyvault secret set --vault-name $names.vault -n $name --value $value --only-show-errors 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "  created $name"; return }
    Start-Sleep 10   # the role assignment above can take a minute to apply
  }
  throw "Could not write secret $name to $($names.vault)."
}
$sqlPassword = 'Iq1!' + (NewSecret 24)
EnsureSecret 'sqlpassword' $sqlPassword
EnsureSecret 'jwtsecret' (NewSecret 48)
EnsureSecret 'encryptionkey' (NewSecret 32)
EnsureSecret 'workersecret' (NewSecret 32)
EnsureSecret 'initial-admin-password' ('Adm1!' + (NewSecret 18))
if (-not (Exists keyvault secret show --vault-name $names.vault -n 'anthropic-api-key')) {
  Write-Host "`nKey Vault $($names.vault) has no 'anthropic-api-key'. Add it, then run this script again:" -ForegroundColor Yellow
  Write-Host "  az keyvault secret set --vault-name $($names.vault) -n anthropic-api-key --value <key>"
  exit 2
}
$sqlPassword = Az keyvault secret show --vault-name $names.vault -n 'sqlpassword' --query value -o tsv

Step 'Azure SQL'
if (-not (Exists sql server show -g $ResourceGroup -n $names.sql)) {
  Az sql server create -g $ResourceGroup -n $names.sql -l $Location --admin-user $SqlAdminUser --admin-password $sqlPassword --minimal-tls-version 1.2 | Out-Null
  Az resource tag --ids (Az sql server show -g $ResourceGroup -n $names.sql --query id -o tsv) --tags $tags | Out-Null
  # 0.0.0.0 = allow Azure services (the Container App); no public client addresses.
  Az sql server firewall-rule create -g $ResourceGroup -s $names.sql -n AllowAzureServices --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 | Out-Null
}
if (-not (Exists sql db show -g $ResourceGroup -s $names.sql -n $names.db)) {
  Az sql db create -g $ResourceGroup -s $names.sql -n $names.db --edition Basic --backup-storage-redundancy Local | Out-Null
}
$sqlFqdn = Az sql server show -g $ResourceGroup -n $names.sql --query fullyQualifiedDomainName -o tsv

Step 'Storage (test files, reports, artifacts)'
if (-not (Exists storage account show -g $ResourceGroup -n $names.storage)) {
  Az storage account create -g $ResourceGroup -n $names.storage -l $Location --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false --tags $tags | Out-Null
}
$storageKey = Az storage account keys list -g $ResourceGroup -n $names.storage --query '[0].value' -o tsv
if (-not (Exists storage share-rm show -g $ResourceGroup --storage-account $names.storage -n $names.share)) {
  Az storage share-rm create -g $ResourceGroup --storage-account $names.storage -n $names.share --quota 100 | Out-Null
}
# Mounted with a sub-path below, so it must exist before the app starts.
Az storage directory create --account-name $names.storage --account-key $storageKey --share-name $names.share --name allure-results | Out-Null

Step 'Container Apps environment'
if (-not (Exists monitor log-analytics workspace show -g $ResourceGroup -n $names.logs)) {
  Az monitor log-analytics workspace create -g $ResourceGroup -n $names.logs -l $Location | Out-Null
}
$logs = Az monitor log-analytics workspace show -g $ResourceGroup -n $names.logs --query '{id:customerId}' -o json | ConvertFrom-Json
$logsKey = Az monitor log-analytics workspace get-shared-keys -g $ResourceGroup -n $names.logs --query primarySharedKey -o tsv
if (-not (Exists containerapp env show -g $ResourceGroup -n $names.env)) {
  $subnet = if ($InfrastructureSubnetId) { @('--infrastructure-subnet-resource-id', $InfrastructureSubnetId) } else { @() }
  Az containerapp env create -g $ResourceGroup -n $names.env -l $Location --logs-workspace-id $logs.id --logs-workspace-key $logsKey @subnet | Out-Null
}
Az containerapp env storage set -g $ResourceGroup -n $names.env --storage-name iqefiles --azure-file-account-name $names.storage `
  --azure-file-account-key $storageKey --azure-file-share-name $names.share --access-mode ReadWrite | Out-Null
$envId = Az containerapp env show -g $ResourceGroup -n $names.env --query id -o tsv

Step "Container App ($image)"
$kv = $vault.uri.TrimEnd('/')
$yaml = @"
location: $Location
identity:
  type: UserAssigned
  userAssignedIdentities:
    $($identity.id): {}
properties:
  managedEnvironmentId: $envId
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 80
      transport: auto
    registries:
$registryYaml
    secrets:
$registrySecret
      - { name: sqlpassword, keyVaultUrl: $kv/secrets/sqlpassword, identity: $($identity.id) }
      - { name: jwtsecret, keyVaultUrl: $kv/secrets/jwtsecret, identity: $($identity.id) }
      - { name: encryptionkey, keyVaultUrl: $kv/secrets/encryptionkey, identity: $($identity.id) }
      - { name: workersecret, keyVaultUrl: $kv/secrets/workersecret, identity: $($identity.id) }
      - { name: anthropic-api-key, keyVaultUrl: $kv/secrets/anthropic-api-key, identity: $($identity.id) }
      - { name: initial-admin-password, keyVaultUrl: $kv/secrets/initial-admin-password, identity: $($identity.id) }
  template:
    scale: { minReplicas: 1, maxReplicas: 1 }
    volumes:
      - { name: files, storageType: AzureFile, storageName: iqefiles }
    containers:
      - name: intelliqe
        image: $image
        resources: { cpu: 2, memory: 4Gi }
        env:
          - { name: NODE_ENV, value: production }
          - { name: AZURE_SQL_SERVER, value: $sqlFqdn }
          - { name: AZURE_SQL_PORT, value: '1433' }
          - { name: AZURE_SQL_DATABASE, value: $($names.db) }
          - { name: AZURE_SQL_USER, value: $SqlAdminUser }
          - { name: AZURE_SQL_PASSWORD, secretRef: sqlpassword }
          - { name: DB_SSL, value: 'true' }
          - { name: JWT_SECRET, secretRef: jwtsecret }
          - { name: ENCRYPTION_KEY, secretRef: encryptionkey }
          - { name: WORKER_SECRET, secretRef: workersecret }
          - { name: ANTHROPIC_API_KEY, secretRef: anthropic-api-key }
          - { name: INITIAL_ADMIN_USERNAME, value: $InitialAdminUser }
          - { name: INITIAL_ADMIN_PASSWORD, secretRef: initial-admin-password }
          - { name: RUN_WORKER, value: '$($RunWorker.ToString().ToLower())' }
          - { name: TEST_DATA_DIR, value: /mnt/iqe/test-data }
          - { name: STORAGE_LOCAL_DIR, value: /mnt/iqe/artifacts }
        volumeMounts:
          - { volumeName: files, mountPath: /mnt/iqe }
          - { volumeName: files, mountPath: /app/backend/allure-results-store, subPath: allure-results }
        probes:
          - { type: Startup, tcpSocket: { port: 80 }, periodSeconds: 10, failureThreshold: 30 }
          - { type: Liveness, tcpSocket: { port: 80 }, periodSeconds: 30 }
          - { type: Readiness, tcpSocket: { port: 80 }, periodSeconds: 10 }
"@
$yamlPath = Join-Path ([IO.Path]::GetTempPath()) "intelliqe-$NamePrefix.yaml"
Set-Content -Path $yamlPath -Value $yaml -Encoding utf8
if (Exists containerapp show -g $ResourceGroup -n $names.app) {
  Az containerapp update -g $ResourceGroup -n $names.app --yaml $yamlPath | Out-Null
} else {
  Az containerapp create -g $ResourceGroup -n $names.app --yaml $yamlPath | Out-Null
}
Remove-Item $yamlPath
$fqdn = Az containerapp show -g $ResourceGroup -n $names.app --query properties.configuration.ingress.fqdn -o tsv
Az containerapp update -g $ResourceGroup -n $names.app --set-env-vars "ALLOWED_ORIGINS=https://$fqdn" | Out-Null

Step 'Health check'
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  try { $ok = (Invoke-RestMethod "https://$fqdn/api/health" -TimeoutSec 10).status -eq 'ok' } catch { Start-Sleep 10 }
}
Write-Host ''
Write-Host "IntelliQE: https://$fqdn  (health: $(if ($ok) { 'OK' } else { 'NOT READY - see: az containerapp logs show -g ' + $ResourceGroup + ' -n ' + $names.app }))"
Write-Host "First sign-in: user '$InitialAdminUser', password in Key Vault $($names.vault) secret 'initial-admin-password'."
Write-Host "Resources: SQL $sqlFqdn/$($names.db), Key Vault $($names.vault), storage $($names.storage), app $($names.app)"
