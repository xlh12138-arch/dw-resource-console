function Set-LinuxZipPermissions {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $bytes = [System.IO.File]::ReadAllBytes($resolved)

  $eocd = -1
  $minOffset = [Math]::Max(0, $bytes.Length - 65557)
  for ($i = $bytes.Length - 22; $i -ge $minOffset; $i--) {
    if ([BitConverter]::ToUInt32($bytes, $i) -eq 0x06054b50) {
      $eocd = $i
      break
    }
  }
  if ($eocd -lt 0) {
    throw "ZIP end-of-central-directory record not found: $resolved"
  }

  $entryCount = [BitConverter]::ToUInt16($bytes, $eocd + 10)
  $centralOffset = [int][BitConverter]::ToUInt32($bytes, $eocd + 16)
  $position = $centralOffset

  for ($entryIndex = 0; $entryIndex -lt $entryCount; $entryIndex++) {
    if ([BitConverter]::ToUInt32($bytes, $position) -ne 0x02014b50) {
      throw "Invalid ZIP central directory entry at offset $position"
    }

    $versionMadeBy = [BitConverter]::ToUInt16($bytes, $position + 4)
    $unixVersionMadeBy = [uint16]((3 -shl 8) -bor ($versionMadeBy -band 0xff))
    $versionBytes = [BitConverter]::GetBytes($unixVersionMadeBy)
    [Array]::Copy($versionBytes, 0, $bytes, $position + 4, 2)

    $nameLength = [BitConverter]::ToUInt16($bytes, $position + 28)
    $extraLength = [BitConverter]::ToUInt16($bytes, $position + 30)
    $commentLength = [BitConverter]::ToUInt16($bytes, $position + 32)
    $localOffset = [int][BitConverter]::ToUInt32($bytes, $position + 42)
    if ([BitConverter]::ToUInt32($bytes, $localOffset) -ne 0x04034b50) {
      throw "Invalid ZIP local file header at offset $localOffset"
    }
    $localNameLength = [BitConverter]::ToUInt16($bytes, $localOffset + 26)
    if ($localNameLength -ne $nameLength) {
      throw "ZIP filename length mismatch at offset $position"
    }

    for ($nameIndex = 0; $nameIndex -lt $nameLength; $nameIndex++) {
      $centralNameOffset = $position + 46 + $nameIndex
      if ($bytes[$centralNameOffset] -eq 0x5c) {
        $bytes[$centralNameOffset] = 0x2f
        $bytes[$localOffset + 30 + $nameIndex] = 0x2f
      }
    }

    $name = [Text.Encoding]::UTF8.GetString($bytes, $position + 46, $nameLength)
    $isDirectory =
      $nameLength -gt 0 -and $bytes[$position + 45 + $nameLength] -eq 0x2f
    Write-Verbose "ZIP entry: $name directory=$isDirectory"

    if ($isDirectory) {
      # 040755: Unix directory with 0755 permissions.
      $unixMode = 0x41ed
      $externalAttributes = [uint32](($unixMode * 65536) + 0x10)
    } elseif ($name.EndsWith('.sh')) {
      # 100755: regular executable file.
      $unixMode = 0x81ed
      $externalAttributes = [uint32]($unixMode * 65536)
    } else {
      # 100644: regular non-executable file.
      $unixMode = 0x81a4
      $externalAttributes = [uint32]($unixMode * 65536)
    }

    $attributeBytes = [BitConverter]::GetBytes($externalAttributes)
    [Array]::Copy($attributeBytes, 0, $bytes, $position + 38, 4)
    $position += 46 + $nameLength + $extraLength + $commentLength
  }

  [System.IO.File]::WriteAllBytes($resolved, $bytes)
}
