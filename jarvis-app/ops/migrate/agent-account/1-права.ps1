# Права для учётной записи агента лаб doodle-agent (ops\migrate\УЧЁТКА-АГЕНТА.md, шаг 3).
#
# Запускает владелец ПК в окне «Windows PowerShell (администратор)»:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\<вы>\moodle-work\jarvis-app\ops\migrate\agent-account\1-права.ps1"
# Сначала печатает, что сделает, и спрашивает подтверждение. Ничего не удаляет: добавляет разрешения и запреты для
# doodle-agent, создаёт папки и задачи Планировщика, пишет файлы настройки. Учётную запись и пароль не создаёт.
#
# Запускать два раза:
#   1) после того как учётная запись doodle-agent создана (шаг 1) и Docker Desktop поставлен (шаг 2);
#   2) после первого входа под doodle-agent и 2-агент.cmd — тогда появятся его профиль и папка журналов, и скрипт даст
#      вашей учётной записи чтение журналов агента (для учёта расхода) и его настроек Claude Code (проверка сторожа).
# Повторный запуск безопасен: то, что уже сделано, просто подтверждается.
#
#   -PlanOnly  — только показать план: ничего не меняет, прав администратора не требует.
#   -Agent     — имя учётной записи агента (по умолчанию doodle-agent).
#   -Owner     — ваша учётная запись (по умолчанию — владелец папки moodle-work).
param([string]$Agent = 'doodle-agent', [string]$Owner = '', [switch]$PlanOnly)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$App = (Resolve-Path (Join-Path $Here '..\..\..')).Path          # moodle-work\jarvis-app
$Work = Split-Path $App -Parent                                   # moodle-work
$GatewayTask = 'OpenClaw Gateway'
$RestartTask = 'Doodle Gateway Restart'
$Export = Join-Path $Here 'export'

function Say([string]$s) { Write-Host $s }
function Warn([string]$s) { Write-Host $s -ForegroundColor Yellow }
# Запуск внешней программы: вывод строками, код — в $LASTEXITCODE. В Windows PowerShell 5.1 строки stderr при
# ErrorActionPreference=Stop обрывали бы скрипт, поэтому внутри — Continue; -NoErr отбрасывает stderr.
function Native([string]$exe, [string[]]$argv, [switch]$NoErr) {
  $ErrorActionPreference = 'Continue'
  if ($NoErr) { $out = & $exe @argv 2>$null } else { $out = & $exe @argv 2>&1 }
  return @($out | ForEach-Object { "$_" })
}
function SidOf([string]$name) {
  try { return (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $null }
}
function ProfileOf([string]$sid) {
  if (-not $sid) { return $null }
  $p = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue
  if ($p) { return $p.LocalPath } else { return $null }
}
# Есть ли у широких групп (Все, Прошедшие проверку, Пользователи) или у самого агента право записи в папку.
$Broad = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
function WritableBy([string]$path, [string[]]$sids) {
  try { $acl = Get-Acl -LiteralPath $path } catch { return $false }
  # Только биты записи: создать файл (WriteData), создать папку (AppendData), GENERIC_WRITE, GENERIC_ALL.
  $w = [int64](0x2 -bor 0x4 -bor 0x40000000 -bor 0x10000000)
  foreach ($a in $acl.Access) {
    if ($a.AccessControlType -ne 'Allow' -or ($a.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    try { $sid = $a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { continue }
    if ($sids -contains $sid -and (([int64]([int]$a.FileSystemRights) -band 0xFFFFFFFFL) -band $w)) { return $true }
  }
  return $false
}

Say ''
Say '=== Учётная запись агента лаб: права на папки и задачи ==='
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $PlanOnly) {
  Warn 'Нужны права администратора: откройте «Windows PowerShell (администратор)» и запустите скрипт оттуда.'
  Warn 'Только посмотреть план без изменений: добавьте -PlanOnly.'
  exit 1
}

# --- кто есть кто ---
$AgentSid = SidOf "$env:COMPUTERNAME\$Agent"
if (-not $AgentSid) {
  if (-not $PlanOnly) { Warn "Учётной записи $Agent нет. Сначала создайте её (УЧЁТКА-АГЕНТА.md, шаг 1), потом запустите скрипт снова."; exit 1 }
  Warn "Учётной записи $Agent пока нет — план показан так, как он выглядел бы после её создания."
  $AgentSid = 'S-1-5-21-0-0-0-0'
} else {
  $admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue | ForEach-Object { $_.SID.Value })
  if ($admins -contains $AgentSid) { Warn "$Agent состоит в группе «Администраторы» — так защита не работает. Сделайте её обычным пользователем и запустите скрипт снова."; exit 1 }
}
if (-not $Owner) {
  $folderOwner = (Get-Acl -LiteralPath $Work).Owner
  if ($folderOwner -and $folderOwner -notmatch '^(BUILTIN|NT AUTHORITY|NT SERVICE)\\' -and $folderOwner -notmatch 'Администраторы|Administrators|SYSTEM') { $Owner = $folderOwner } else { $Owner = "$env:COMPUTERNAME\$env:USERNAME" }
}
if ($Owner -notmatch '\\') { $Owner = "$env:COMPUTERNAME\$Owner" }
$OwnerSid = SidOf $Owner
if (-not $OwnerSid) { Warn "Не нашёл учётную запись владельца $Owner — укажите её: -Owner <имя>"; exit 1 }
if ($OwnerSid -eq $AgentSid) { Warn 'Владелец и агент — одна и та же учётная запись. Укажите свою: -Owner <имя>'; exit 1 }
$OwnerHome = ProfileOf $OwnerSid
$AgentHome = ProfileOf $AgentSid
$AgentHomeKnown = [bool]$AgentHome
if (-not $AgentHome) {
  $dirs = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList').ProfilesDirectory)
  $AgentHome = Join-Path $dirs $Agent
}
$AgentAce = "*$AgentSid"; $OwnerAce = "*$OwnerSid"
Say "Владелец (сервер приложения): $Owner"
Say "Агент лаб:                     $env:COMPUTERNAME\$Agent$(if ($AgentHomeKnown) { "  (профиль $AgentHome)" } else { "  (профиля ещё нет: под $Agent ещё не входили)" })"
Say "Папка moodle-work:             $Work"
Say ''

# --- план: список шагов (Kind — что делать, остальное — параметры) ---
$plan = New-Object System.Collections.Generic.List[object]
function Step([string]$what, [hashtable]$p) { $p.What = $what; $plan.Add([pscustomobject]$p) }

# 1. Docker
$dockerGroup = Get-LocalGroup -Name 'docker-users' -ErrorAction SilentlyContinue
if ($dockerGroup) {
  $inGroup = @(Get-LocalGroupMember -Name 'docker-users' -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $AgentSid }).Count -gt 0
  if (-not $inGroup) { Step "Добавить $Agent в группу docker-users (Docker Desktop)" @{ Kind = 'group'; Group = 'docker-users' } }
} else { Warn 'Группы docker-users нет — Docker Desktop ещё не установлен. Поставьте его «для всех пользователей» и запустите скрипт ещё раз.' }

# 2. moodle-work: в корне — только чтение, внутри — чтение и запись
Step "moodle-work: $Agent может читать сам корень папки, но не создавать в нём файлы" @{ Kind = 'icacls'; Path = $Work; Args = @('/grant', "${AgentAce}:(RX)") }
Step 'moodle-work: внутри (папки лаб, tools, agent-shared) — чтение и запись' @{ Kind = 'icacls'; Path = $Work; Args = @('/grant', "${AgentAce}:(OI)(CI)(IO)(M)") }
$shared = Join-Path $Work 'agent-shared'
if (-not (Test-Path -LiteralPath $shared)) { Step 'Создать moodle-work\agent-shared — общие файлы агента (замки замеров, установок и снимков, список WSL-пользователей)' @{ Kind = 'mkdir'; Path = $shared } }
if ((Test-Path -LiteralPath (Join-Path $Work 'wsl-users.json')) -and -not (Test-Path -LiteralPath (Join-Path $shared 'wsl-users.json'))) {
  Step 'Скопировать moodle-work\wsl-users.json в agent-shared (старый файл остаётся)' @{ Kind = 'copy'; From = (Join-Path $Work 'wsl-users.json'); To = (Join-Path $shared 'wsl-users.json') }
}

# 3. Папка приложения: закрыта целиком, кроме чтения assets, папки сторожа и этой папки
Step 'jarvis-app: закрыть целиком (ключи, токены, данные пользователей, код сервера)' @{ Kind = 'icacls'; Path = $App; Args = @('/deny', "${AgentAce}:(OI)(CI)(F)") }
foreach ($sub in @('assets', 'ops\agent-guard', 'ops\migrate\agent-account')) {
  $p = Join-Path $App $sub
  if (Test-Path -LiteralPath $p) { Step "jarvis-app\$sub — только чтение" @{ Kind = 'icacls'; Path = $p; Args = @('/grant', "${AgentAce}:(OI)(CI)(RX)") } }
}
foreach ($f in @('guard.log', 'guard.seen')) {
  $p = Join-Path $App "ops\agent-guard\$f"
  Step "jarvis-app\ops\agent-guard\$f — запись (сторож отмечает вызовы и отказы)" @{ Kind = 'icacls'; Path = $p; Touch = $true; Args = @('/grant', "${AgentAce}:(RX,W)") }
}

# 4. Всё остальное в корне moodle-work — закрыть: ops, история git, личное владельца
$labLike = '^(\d+|check-\d+|users|tools|agent-shared|jarvis-app)$'
$closed = @()
foreach ($it in Get-ChildItem -LiteralPath $Work -Force) {
  if ($it.Name -match $labLike) { continue }
  $closed += $it.Name
  $flags = if ($it.PSIsContainer) { '(OI)(CI)(F)' } else { '(F)' }
  Step "moodle-work\$($it.Name) — закрыть" @{ Kind = 'icacls'; Path = $it.FullName; Args = @('/deny', "${AgentAce}:$flags") }
}

# 5. Место резервных копий из backup.json (jarvis-app\backups и так закрыта шагом 3)
$bj = Join-Path $App 'backup.json'
if (Test-Path -LiteralPath $bj) {
  try { $bdir = (Get-Content -LiteralPath $bj -Raw -Encoding UTF8 | ConvertFrom-Json).dir } catch { $bdir = $null }
  if ($bdir -and (Test-Path -LiteralPath $bdir) -and -not ((Resolve-Path -LiteralPath $bdir).Path.StartsWith($App, [StringComparison]::OrdinalIgnoreCase))) {
    Step "Папка резервных копий $bdir — закрыть (в копиях ключ и токены)" @{ Kind = 'icacls'; Path = $bdir; Args = @('/deny', "${AgentAce}:(OI)(CI)(F)") }
  }
}

# 6. Пустая закрытая папка node_modules в корне дисков C: и moodle-work: Node.js ищет модули и в корне диска, а создавать
#    папки там может любой пользователь.
foreach ($drv in @($env:SystemDrive, (Split-Path -Qualifier $Work)) | Select-Object -Unique) {
  $nm = "$drv\node_modules"
  if (-not (Test-Path -LiteralPath $nm)) { Step "Создать пустую папку $nm, закрытую на запись для всех, кроме администраторов" @{ Kind = 'lockdir'; Path = $nm } }
  else { Step "$nm уже есть — закрыть её для $Agent" @{ Kind = 'icacls'; Path = $nm; Args = @('/deny', "${AgentAce}:(OI)(CI)(F)") } }
}

# 7. Другие диски, открытые всем пользователям на запись (так бывает с D:): спросить отдельно
$drives = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.DeviceID -ne $env:SystemDrive }
foreach ($d in $drives) {
  $root = "$($d.DeviceID)\"
  if (-not (WritableBy $root ($Broad + $AgentSid))) { continue }
  Warn "Диск $root открыт на запись всем пользователям Windows — значит, и агенту."
  Say  "  Закрыть его для ${Agent}? Если на нём лежат программы для лаб (Java, Docker, WSL агента) — ответьте «нет»."
  if ((Split-Path -Qualifier $Work) -eq $d.DeviceID) { Say '  moodle-work на этом диске останется открытой агенту (её разрешения важнее).' }
  $ans = if ($PlanOnly) { 'нет' } else { Read-Host "  Закрыть $root для $Agent? (да/нет)" }
  if ($ans -match '^\s*(да|д|yes|y)\s*$') { Step "Диск $root — закрыть для $Agent" @{ Kind = 'icacls'; Path = $root; Args = @('/deny', "${AgentAce}:(OI)(CI)(F)") } }
}

# 8. Задачи Планировщика
$gwOld = Get-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue
if ($gwOld -and $gwOld.Principal.UserId -and (SidOf $gwOld.Principal.UserId) -ne $AgentSid) {
  Step "Задача «$GatewayTask» сейчас от имени $($gwOld.Principal.UserId): сохранить её описание в export\, затем заменить задачей от имени $Agent" @{ Kind = 'backup-task'; Name = $GatewayTask }
}
Step "Задача «$GatewayTask» от имени $Agent «при входе» (Gateway OpenClaw и агент лаб запускаются под ним)" @{ Kind = 'task'; Name = $GatewayTask; Restart = $false }
Step "Задача «$RestartTask» от имени ${Agent}: сервер может только запустить её, когда Gateway завис" @{ Kind = 'task'; Name = $RestartTask; Restart = $true }

# 9. Журналы и настройки агента — вашей учётной записи на чтение (только когда профиль агента уже есть)
$projects = Join-Path $AgentHome '.claude\projects'
$settings = Join-Path $AgentHome '.claude\settings.json'
if ($AgentHomeKnown) {
  Step "Журналы агента ($projects) — вашей учётной записи на чтение (учёт расхода, «что сейчас делает»)" @{ Kind = 'icacls'; Path = $projects; MkDir = $true; Args = @('/grant', "${OwnerAce}:(OI)(CI)(RX)") }
  if (Test-Path -LiteralPath $settings) { Step "Настройки Claude Code агента ($settings) — вашей учётной записи на чтение (проверка сторожа)" @{ Kind = 'icacls'; Path = $settings; Args = @('/grant', "${OwnerAce}:(R)") } }
  else { Warn "Настроек Claude Code агента ещё нет ($settings) — запустите 2-агент.cmd под $Agent, потом этот скрипт ещё раз." }
} else { Warn "Журналы агента: профиля $Agent ещё нет. После первого входа под $Agent и 2-агент.cmd запустите этот скрипт ещё раз." }

# 10. Настройки агента files для 2-агент.cmd (без токенов) и файл для сервера
Step 'Выгрузить настройки агента files (модель, запреты инструментов, файлы его рабочей папки — без токенов) в export\ для 2-агент.cmd' @{ Kind = 'export' }
Step "Записать jarvis-app\agent-account.json: сервер будет искать журналы и настройки агента в профиле $Agent" @{ Kind = 'config' }

# --- показать план ---
Say ''
Say 'Что будет сделано:'
$i = 0
foreach ($s in $plan) { $i++; Say ("{0,3}. {1}" -f $i, $s.What) }
Say ''
if ($closed.Count) { Say ("Закрыто в корне moodle-work: {0}" -f ($closed -join ', ')) }
Say 'Новые папки, которые вы сами положите в moodle-work, агенту будут открыты — личное держите вне moodle-work.'

# Папки из PATH, куда может писать агент (только предупреждение: программы оттуда запускаете и вы).
$paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';')
try { $paths += @((Get-ItemProperty "Registry::HKEY_USERS\$OwnerSid\Environment" -ErrorAction Stop).Path -split ';') } catch { }
$risky = @($paths | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) } | Select-Object -Unique |
  Where-Object { (Test-Path -LiteralPath $_) -and -not $_.StartsWith($Work, [StringComparison]::OrdinalIgnoreCase) -and (WritableBy $_ ($Broad + $AgentSid)) })
if ($risky.Count) {
  Warn 'Внимание: в эти папки из PATH может писать любой пользователь, в том числе агент. Программы оттуда лучше поставить в Program Files:'
  $risky | ForEach-Object { Warn "  $_" }
}

if ($PlanOnly) { Say ''; Say 'Это только план (-PlanOnly): ничего не изменено.'; exit 0 }
Say ''
$ans = Read-Host 'Выполнить всё это? (да/нет)'
if ($ans -notmatch '^\s*(да|д|yes|y)\s*$') { Say 'Ничего не сделано.'; exit 0 }

# --- выполнение ---
function TaskXml([bool]$restart) {
  $u = [Security.SecurityElement]::Escape("$env:COMPUTERNAME\$Agent")
  if ($restart) {
    $trig = ''
    $exec = "<Command>$env:SystemRoot\System32\wscript.exe</Command><Arguments>$([Security.SecurityElement]::Escape('"' + (Join-Path $Here 'restart-gateway.vbs') + '"'))</Arguments>"
    $limit = 'PT10M'; $desc = 'Doodle: restart the OpenClaw Gateway of the lab agent (started by the app server)'
  } else {
    $trig = "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$u</UserId></LogonTrigger></Triggers>"
    $exec = "<Command>$([Security.SecurityElement]::Escape((Join-Path $AgentHome '.openclaw\gateway.vbs')))</Command>"
    $limit = 'PT0S'; $desc = 'OpenClaw Gateway'
  }
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$desc</Description></RegistrationInfo>
  $trig
  <Principals><Principal id="Author"><UserId>$u</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>$limit</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec>$exec</Exec></Actions>
</Task>
"@
}

function Invoke-Step($s) {
  switch ($s.Kind) {
    'group' { Add-LocalGroupMember -Group $s.Group -Member "$env:COMPUTERNAME\$Agent" }
    'mkdir' { New-Item -ItemType Directory -Path $s.Path -Force | Out-Null }
    'copy' { if (-not (Test-Path -LiteralPath $s.To)) { Copy-Item -LiteralPath $s.From -Destination $s.To } }
    'icacls' {
      if ($s.MkDir -and -not (Test-Path -LiteralPath $s.Path)) { New-Item -ItemType Directory -Path $s.Path -Force | Out-Null }
      if ($s.Touch -and -not (Test-Path -LiteralPath $s.Path)) { New-Item -ItemType File -Path $s.Path | Out-Null }
      $out = Native 'icacls' (@($s.Path) + $s.Args)
      if ($LASTEXITCODE -ne 0) { throw "icacls: $($out -join ' ')" }
    }
    'lockdir' {
      New-Item -ItemType Directory -Path $s.Path -Force | Out-Null
      $out = Native 'icacls' @($s.Path, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)(F)', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-545:(OI)(CI)(RX)')
      if ($LASTEXITCODE -ne 0) { throw "icacls: $($out -join ' ')" }
    }
    'backup-task' {
      New-Item -ItemType Directory -Path $Export -Force | Out-Null
      $f = Join-Path $Export ("old-{0}-{1}.xml" -f ($s.Name -replace '\s', '-'), (Get-Date -Format 'yyyy-MM-dd-HHmm'))
      Export-ScheduledTask -TaskName $s.Name | Out-File -LiteralPath $f -Encoding Unicode
      Say "     описание прежней задачи: $f"
    }
    'task' {
      # Права на задачу: администраторам и системе — всё; агенту — всё на свою задачу Gateway (OpenClaw сам её
      # обновляет и перезапускает) и только запуск задачи перезапуска; вашей учётной записи — только запуск перезапуска.
      $sddl = if ($s.Restart) { "D:(A;;GA;;;BA)(A;;GA;;;SY)(A;;GRGX;;;$AgentSid)(A;;GRGX;;;$OwnerSid)" } else { "D:(A;;GA;;;BA)(A;;GA;;;SY)(A;;GA;;;$AgentSid)" }
      $svc = New-Object -ComObject Schedule.Service
      $svc.Connect()
      $svc.GetFolder('\').RegisterTask($s.Name, (TaskXml $s.Restart), 6, "$env:COMPUTERNAME\$Agent", $null, 3, $sddl) | Out-Null
    }
    'export' {
      New-Item -ItemType Directory -Path $Export -Force | Out-Null
      $setup = [ordered]@{ agent = $Agent; owner = $Owner; ownerSid = $OwnerSid; work = $Work; app = $App; created = (Get-Date -Format 's'); openclawVersion = $null; files = $null }
      $oc = if ($OwnerHome) { Join-Path $OwnerHome 'AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs' } else { $null }
      if ($oc -and (Test-Path -LiteralPath $oc)) {
        # Ваш OpenClaw читает ВАШИ настройки: домашняя папка подменяется на ваш профиль (скрипт может идти от другого
        # администратора). Секреты в выводе config get OpenClaw сам скрывает; пути рабочих папок убираются.
        $keep = @{}; foreach ($k in 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA') { $keep[$k] = [Environment]::GetEnvironmentVariable($k) }
        try {
          $env:USERPROFILE = $OwnerHome; $env:HOME = $OwnerHome; $env:APPDATA = Join-Path $OwnerHome 'AppData\Roaming'; $env:LOCALAPPDATA = Join-Path $OwnerHome 'AppData\Local'
          $ver = (Native 'node' @($oc, '--version') -NoErr) -join "`n"
          if ($ver -match '(\d{4}\.\d+\.\d+)') { $setup.openclawVersion = $Matches[1] }
          $raw = (Native 'node' @($oc, 'config', 'get', 'agents.entries.files', '--json') -NoErr) -join "`n"
          if ($raw.IndexOf('{') -lt 0) { throw 'OpenClaw не выдал настройки агента files' }
          $j = $raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json
          foreach ($k in 'workspace', 'agentDir') { $j.PSObject.Properties.Remove($k) }
          $setup.files = $j
        } catch { Warn "     настройки агента files не выгрузились: $($_.Exception.Message)" }
        finally { foreach ($k in $keep.Keys) { [Environment]::SetEnvironmentVariable($k, $keep[$k]) } }
        $ws = Join-Path $OwnerHome '.openclaw\workspace-files'
        if (Test-Path -LiteralPath $ws) {
          Native 'robocopy' @($ws, (Join-Path $Export 'workspace-files'), '/E', '/XD', '.git', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') | Out-Null
          if ($LASTEXITCODE -ge 8) { Warn "     файлы рабочей папки агента files скопировались не все (robocopy, код $LASTEXITCODE)" }
        }
      } else { Warn '     OpenClaw под вашей учётной записью не найден — 2-агент.cmd заведёт агента files без ваших настроек и предупредит.' }
      $freeze = Join-Path $App 'ops\migrate\pip-user-freeze.txt'
      if (Test-Path -LiteralPath $freeze) { Copy-Item -LiteralPath $freeze -Destination (Join-Path $Export 'pip-user-freeze.txt') -Force }
      [IO.File]::WriteAllText((Join-Path $Export 'setup.json'), ($setup | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
    }
    'config' {
      $cfg = [ordered]@{ user = $Agent; home = $AgentHome; restartTask = $RestartTask; by = '1-права.ps1'; at = (Get-Date -Format 's') }
      [IO.File]::WriteAllText((Join-Path $App 'agent-account.json'), ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    }
  }
}

$bad = 0; $i = 0
foreach ($s in $plan) {
  $i++
  try { Invoke-Step $s; Say ("{0,3}. готово: {1}" -f $i, $s.What) }
  catch { $bad++; Warn ("{0,3}. НЕ ВЫШЛО: {1} — {2}" -f $i, $s.What, $_.Exception.Message) }
}

# --- итог: права, как их видит Windows ---
Say ''
Say '=== Итог (icacls): строки с doodle-agent и вашей учётной записью ==='
$show = @($Work, $App, (Join-Path $App 'assets'), (Join-Path $App 'ops\agent-guard'), $Here, $shared, (Join-Path $Work 'ops'), "$env:SystemDrive\node_modules")
if ($AgentHomeKnown) { $show += $projects }
$names = @("$env:COMPUTERNAME\$Agent", $Owner, $AgentSid, $OwnerSid)
foreach ($p in $show) {
  if (-not (Test-Path -LiteralPath $p)) { continue }
  Say $p
  # Первая строка icacls — путь и первое разрешение; путь убираем, остальное фильтруем по именам.
  foreach ($l in (Native 'icacls' @($p))) {
    $l = $l.Replace($p, '').Trim()
    if (@($names | Where-Object { $l -match [regex]::Escape($_) }).Count) { Say "    $l" }
  }
}
Say ("Личное в корне moodle-work (закрыто): {0}" -f ($closed -join ', '))
foreach ($t in $GatewayTask, $RestartTask) {
  $x = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  if ($x) { Say ("Задача «{0}»: от имени {1}, {2}" -f $t, $x.Principal.UserId, $x.State) }
}
Say ''
if ($bad) { Warn "Не вышло шагов: $bad (см. выше). Остальное сделано; скрипт можно запустить снова." }
else { Say 'Всё сделано.' }
Say 'Дальше (УЧЁТКА-АГЕНТА.md): первый вход под doodle-agent и 2-агент.cmd; потом этот скрипт ещё раз; затем 3-ключ.cmd под вашей учётной записью.'
Say 'Задачи «Jarvis App Server», «Jarvis Tunnel», «Jarvis App Watchdog» переведите на «Выполнять для всех пользователей» (шаг 5).'
