[CmdletBinding()]
param(
  [string]$GameRoot = 'C:\Users\rocma\CLI\Aetherglyph'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (!(Test-Path $GameRoot)) { throw "Game project not found: $GameRoot" }

foreach ($name in @('shared', 'server')) {
  $target = Join-Path $root $name
  if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $GameRoot $name) -Destination $target -Recurse -Force
}

foreach ($unused in @('shared\src\analytics', 'shared\src\bot')) {
  $path = Join-Path $root $unused
  if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force }
}

$netPath = Join-Path $root 'shared\src\protocol\net.js'
$net = Get-Content $netPath -Raw
if (!$net.Contains('SNAPSHOT_HZ: 15') -or !$net.Contains('SNAPSHOT_EVERY_TICKS: 4')) {
  throw 'Could not locate default snapshot cadence in shared protocol source.'
}
$net = $net.Replace('SNAPSHOT_HZ: 15', 'SNAPSHOT_HZ: 10')
$net = $net.Replace('SNAPSHOT_EVERY_TICKS: 4', 'SNAPSHOT_EVERY_TICKS: 6')
[IO.File]::WriteAllText($netPath, $net, [Text.UTF8Encoding]::new($false))

$matchPath = Join-Path $root 'server\matchRoom.js'
$match = Get-Content $matchPath -Raw
$old = 'seat.socket.emit(EVENTS.SNAPSHOT, {'
$new = '(force ? seat.socket : seat.socket.volatile).emit(EVENTS.SNAPSHOT, {'
if (!$match.Contains($old)) { throw 'Could not locate snapshot emit for volatile optimization.' }
$match = $match.Replace($old, $new)
[IO.File]::WriteAllText($matchPath, $match, [Text.UTF8Encoding]::new($false))

Write-Host 'Synced authoritative server/shared source and reapplied dedicated optimizations.' -ForegroundColor Green
