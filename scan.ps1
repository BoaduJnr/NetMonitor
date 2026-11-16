# Scans the local network and prints the result as JSON (called by server.js).
$ErrorActionPreference = 'Stop'

$cfg = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    Select-Object -First 1
if (-not $cfg) { throw 'No active network connection found.' }

$myIp    = $cfg.IPv4Address[0].IPAddress
$gw      = $cfg.IPv4DefaultGateway[0].NextHop
$ifIndex = $cfg.InterfaceIndex
$myMac   = (Get-NetAdapter -InterfaceIndex $ifIndex).MacAddress
$base    = ($myIp -split '\.')[0..2] -join '.'

# Ping every address at once. This also makes Windows look up each device's
# hardware address, so devices that ignore ping still show up.
$pings = @{}
foreach ($i in 1..254) {
    $ip = "$base.$i"
    if ($ip -eq $myIp) { continue }
    $pings[$ip] = (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($ip, 800)
}
try { [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($pings.Values)) } catch {}

$latency = @{}
foreach ($kv in $pings.GetEnumerator()) {
    $t = $kv.Value
    if ($t.Status -eq 'RanToCompletion' -and $t.Result.Status -eq 'Success') {
        $latency[$kv.Key] = [int]$t.Result.RoundtripTime
    }
}

# "Stale" neighbour entries may be devices that already left, so only count
# fresh entries or devices that answered the ping.
$macs = @{}
Get-NetNeighbor -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -like "$base.*" -and
        $_.LinkLayerAddress -and
        $_.LinkLayerAddress -notin @('FF-FF-FF-FF-FF-FF', '00-00-00-00-00-00') -and
        ($_.State -in @('Reachable', 'Delay', 'Probe') -or $latency.ContainsKey($_.IPAddress))
    } |
    ForEach-Object { $macs[$_.IPAddress] = $_.LinkLayerAddress }

$ips = @(@($macs.Keys) + @($latency.Keys) | Sort-Object -Unique)

# Reverse-lookup hostnames in parallel, giving up after 2.5 seconds.
$dns = @{}
foreach ($ip in $ips) { $dns[$ip] = [System.Net.Dns]::GetHostEntryAsync($ip) }
if ($dns.Count) {
    try { [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($dns.Values), 2500) } catch {}
}

$devices = @([pscustomobject]@{
    ip = $myIp; mac = $myMac; hostname = $env:COMPUTERNAME; pingMs = 0
    isGateway = $false; isThisPc = $true
})
foreach ($ip in $ips) {
    $hostName = $null
    $t = $dns[$ip]
    if ($t.Status -eq 'RanToCompletion' -and $t.Result.HostName -ne $ip) { $hostName = $t.Result.HostName }
    $devices += [pscustomobject]@{
        ip        = $ip
        mac       = $macs[$ip]
        hostname  = $hostName
        pingMs    = $latency[$ip]
        isGateway = ($ip -eq $gw)
        isThisPc  = $false
    }
}

# Internet quality: 5 pings to Cloudflare.
$times = @()
$pinger = New-Object System.Net.NetworkInformation.Ping
foreach ($n in 1..5) {
    try {
        $r = $pinger.Send('1.1.1.1', 1500)
        if ($r.Status -eq 'Success') { $times += [int]$r.RoundtripTime }
    } catch {}
}
$avg = if ($times.Count) { [math]::Round(($times | Measure-Object -Average).Average) } else { $null }

[pscustomobject]@{
    scannedAt = (Get-Date).ToString('o')
    myIp      = $myIp
    gateway   = $gw
    devices   = $devices
    internet  = [pscustomobject]@{ sent = 5; received = $times.Count; avgMs = $avg }
} | ConvertTo-Json -Depth 4 -Compress
