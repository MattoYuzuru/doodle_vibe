# Keeps MISIS hosts (LK, journal, MISIS ID) reachable without the VPN.
# Finds the real (non-VPN) default gateway and routes the MISIS addresses through it. Safe to run many times.
# Needs administrator rights. Log: ops\misis-route.log
$ErrorActionPreference = "Stop"
$log = Join-Path $PSScriptRoot "misis-route.log"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $log -Encoding utf8 }
try {
  # VPN clients usually add 0.0.0.0/1 and 128.0.0.0/1, so the plain 0.0.0.0/0 route is the real network.
  $def = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" | Where-Object { $_.NextHop -ne "0.0.0.0" } | Sort-Object RouteMetric | Select-Object -First 1
  if (-not $def) { Log "no default gateway yet"; exit 0 }
  $gw = $def.NextHop; $if = $def.InterfaceIndex
  $ips = @("85.143.106.23", "85.143.104.227")
  foreach ($h in "lk.misis.ru", "ej.misis.ru", "id.misis.ru", "login.misis.ru") {
    try { $ips += (Resolve-DnsName $h -Type A -ErrorAction Stop | Where-Object { $_.IPAddress -like "85.143.*" }).IPAddress } catch { }
  }
  foreach ($ip in ($ips | Sort-Object -Unique)) {
    $cur = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$ip/32" -ErrorAction SilentlyContinue
    if ($cur -and ($cur | Where-Object { $_.NextHop -eq $gw -and $_.InterfaceIndex -eq $if })) { continue }
    if ($cur) { $cur | Remove-NetRoute -Confirm:$false }
    New-NetRoute -AddressFamily IPv4 -DestinationPrefix "$ip/32" -NextHop $gw -InterfaceIndex $if -RouteMetric 1 -PolicyStore ActiveStore | Out-Null
    Log "route $ip via $gw (if $if)"
  }
} catch { Log "error: $($_.Exception.Message)" }
