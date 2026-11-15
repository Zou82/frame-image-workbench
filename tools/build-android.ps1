$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $projectRoot 'android'
$signingRoot = Join-Path $androidRoot 'signing'
$jdkRoot = $env:JAVA_HOME
if (-not $jdkRoot) { throw 'Set JAVA_HOME to your JDK 17 installation first.' }
if (-not (Test-Path (Join-Path $jdkRoot 'bin\java.exe'))) {
    throw 'JAVA_HOME must point to a JDK 17 installation.'
}
$env:JAVA_HOME = $jdkRoot
$keyFile = Join-Path $signingRoot 'frame-release.jks'
$credentialFile = Join-Path $signingRoot 'password.xml'
New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null
if (-not (Test-Path $keyFile)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $generatedPassword = [Convert]::ToBase64String($bytes)
    & (Join-Path $jdkRoot 'bin\keytool.exe') -genkeypair -keystore $keyFile -storetype JKS -alias frame-release -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=FRAME Local Release, O=FRAME, C=US' -storepass $generatedPassword -keypass $generatedPassword
    if ($LASTEXITCODE -ne 0) { throw 'Signing key creation failed.' }
    $secret = ConvertTo-SecureString $generatedPassword -AsPlainText -Force
    [pscredential]::new('frame-release', $secret) | Export-Clixml -LiteralPath $credentialFile
}
if (-not (Test-Path $credentialFile)) { throw 'The private signing password is missing.' }
$credential = Import-Clixml -LiteralPath $credentialFile
$env:FRAME_KEYSTORE = $keyFile
$env:FRAME_STORE_PASSWORD = $credential.GetNetworkCredential().Password
try {
    Push-Location $androidRoot
    & '.\gradlew.bat' ':app:assembleRelease' ':app:lintRelease' '--console=plain' @args
    if ($LASTEXITCODE -ne 0) { throw 'Android build or lint failed.' }
    $releaseRoot = Join-Path $projectRoot 'releases'
    New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
    $apk = Join-Path $releaseRoot 'FRAME-1.0.0.apk'
    Copy-Item -LiteralPath (Join-Path $androidRoot 'app\build\outputs\apk\release\app-release.apk') -Destination $apk
    Get-FileHash -Algorithm SHA256 -LiteralPath $apk
} finally {
    Pop-Location
    Remove-Item Env:FRAME_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:FRAME_KEYSTORE -ErrorAction SilentlyContinue
}
