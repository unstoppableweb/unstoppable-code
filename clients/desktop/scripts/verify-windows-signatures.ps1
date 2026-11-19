param(
  [Parameter(Mandatory = $true)]
  [string]$PublisherName,

  [Parameter(Mandatory = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = 'Stop'
$supportedExtensions = @('.exe', '.dll', '.node')
$filesByPath = @{}

foreach ($inputPath in $Paths) {
  $items = @(Get-Item -Path $inputPath -ErrorAction SilentlyContinue)
  if ($items.Count -eq 0) {
    throw "Signature verification path did not match anything: $inputPath"
  }

  foreach ($item in $items) {
    $files = if ($item.PSIsContainer) {
      Get-ChildItem -LiteralPath $item.FullName -Recurse -File
    } else {
      @($item)
    }

    foreach ($file in $files) {
      if ($supportedExtensions -contains $file.Extension.ToLowerInvariant()) {
        $filesByPath[$file.FullName] = $file
      }
    }
  }
}

$filesToVerify = @($filesByPath.Values | Sort-Object FullName)
if ($filesToVerify.Count -eq 0) {
  throw 'No Windows PE files matched the signature verification paths.'
}

$failures = @()
foreach ($file in $filesToVerify) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
    $failures += "$($file.FullName): signature status is $($signature.Status)"
    continue
  }

  $actualPublisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if ($actualPublisher -ne $PublisherName) {
    $failures += "$($file.FullName): expected publisher '$PublisherName', got '$actualPublisher'"
    continue
  }

  if ($null -eq $signature.TimeStamperCertificate) {
    $failures += "$($file.FullName): signature is missing an RFC 3161 timestamp"
    continue
  }

  Write-Host "Valid: $($file.FullName) [$actualPublisher]"
}

if ($failures.Count -gt 0) {
  $summary = $failures -join [Environment]::NewLine
  throw "Windows signature verification failed:`n$summary"
}

Write-Host "Verified $($filesToVerify.Count) signed Windows PE file(s)."
