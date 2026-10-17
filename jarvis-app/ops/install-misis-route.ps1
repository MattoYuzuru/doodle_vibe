# One-time setup (run PowerShell AS ADMINISTRATOR): creates the task "MISIS Route".
# It runs misis-route.ps1 at logon, when the network changes and after wake from sleep.
$script = Join-Path $PSScriptRoot "misis-route.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$xmlTrig = @'
<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[(EventID=10000 or EventID=10001)]]</Select></Query></QueryList>
'@
$xmlWake = @'
<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and (EventID=1)]]</Select></Query></QueryList>
'@
$cls = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger
$t1 = New-ScheduledTaskTrigger -AtLogOn
$t2 = New-CimInstance -CimClass $cls -ClientOnly -Property @{ Enabled = $true; Subscription = $xmlTrig }
$t3 = New-CimInstance -CimClass $cls -ClientOnly -Property @{ Enabled = $true; Subscription = $xmlWake }
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName "MISIS Route" -Action $action -Trigger @($t1, $t2, $t3) -Settings $set -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName "MISIS Route"
Write-Host "Done. Check: Get-NetRoute -DestinationPrefix 85.143.106.23/32  and ops\misis-route.log"
