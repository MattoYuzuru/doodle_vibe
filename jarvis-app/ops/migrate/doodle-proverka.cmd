@echo off
rem Doodle: check of this PC before moving the server here. Changes nothing, installs nothing.
rem The report appears on the Desktop as doodle-check-result.txt and opens in Notepad.
setlocal
set "DOODLE_SELF=%~f0"
echo Checking this PC, please wait about a minute...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:DOODLE_SELF,[Text.Encoding]::UTF8); $i=$t.LastIndexOf('#==PS'+'==#'); Invoke-Expression $t.Substring($i)"
echo.
echo The report is on the Desktop: doodle-check-result.txt
pause
exit /b
#==PS==#
# Проверка ПК перед переносом сервера Doodle. Ничего не меняет и не устанавливает — только читает сведения о системе
# и пробует открыть нужные сайты. Итог пишет в doodle-check-result.txt на рабочем столе и открывает его в Блокноте.
# Владельцу отдаётся одним файлом doodle-proverka.cmd (собирается из этого скрипта: см. ПЕРЕНОС.md).
$ErrorActionPreference = 'SilentlyContinue'
# Отчёт кладём на рабочий стол: скрипт могут запустить прямо из архива, и тогда его папка временная.
$desk = [Environment]::GetFolderPath('Desktop')
if ($env:DOODLE_CHECK_OUT) { $desk = $env:DOODLE_CHECK_OUT }
if (-not $desk -or -not (Test-Path $desk)) { $desk = $env:TEMP }
$file = Join-Path $desk 'doodle-check-result.txt'
$out = New-Object System.Collections.Generic.List[string]
$script:bad = 0
$script:warn = 0
function Line($s) { $out.Add($s) }
function Ok($s) { $out.Add("[ OK ]      $s") }
function Warn($s) { $script:warn++; $out.Add("[ВНИМАНИЕ]  $s") }
function Bad($s) { $script:bad++; $out.Add("[ НЕТ ]     $s") }

# Внешняя команда с пределом по времени: код возврата и первая строка вывода (или $null, если команды нет / зависла).
function Run($exe, $arguments) {
  # Программы, поставленные через npm (openclaw, claude), — это .cmd-ярлыки: их запускаем через cmd.exe.
  $cmd = Get-Command "$exe.exe", "$exe.cmd", $exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { return $null }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  if ($cmd.Source -match '\.(cmd|bat)$') { $psi.FileName = "$env:ComSpec"; $psi.Arguments = '/c ""' + $cmd.Source + '" ' + $arguments + '"' }
  elseif ($cmd.Source -match '\.ps1$') { $psi.FileName = 'powershell.exe'; $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $cmd.Source + '" ' + $arguments }
  else { $psi.FileName = $cmd.Source; $psi.Arguments = $arguments }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $so = $p.StandardOutput.ReadToEndAsync()
    $se = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(15000)) { try { $p.Kill() } catch {}; return @{ code = -1; text = 'не ответила за 15 с'; path = $cmd.Source } }
    $text = (($so.Result + "`n" + $se.Result) -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    return @{ code = $p.ExitCode; text = "$text".Trim(); path = $cmd.Source }
  } catch { return @{ code = -2; text = $_.Exception.Message; path = $cmd.Source } }
}

Line "Проверка ПК для сервера Doodle — $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Line ('=' * 70)

# ---------- система ----------
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Line ''
Line 'СИСТЕМА'
$build = [int]$os.BuildNumber
$osText = "$($os.Caption) $($os.OSArchitecture), сборка $build"
if ($os.OSArchitecture -notmatch '64') { Bad "$osText — нужна 64-разрядная Windows" }
elseif ($build -lt 19041) { Bad "$osText — нужна Windows 10 версии 2004 (сборка 19041) или новее: без неё не встанут WSL 2 и Docker" }
else { Ok $osText }
if ($os.Caption -match 'Pro|Проф|Enterprise|Корпор|Education|образоват') { Line '            Редакция Pro или выше: встроенный удалённый рабочий стол (RDP) доступен.' }
else { Line '            Редакция Home: встроенного удалённого рабочего стола нет — понадобится AnyDesk, RustDesk или Chrome Remote Desktop.' }

$ram = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
if ($ram -ge 15.5) { Ok "Память: $ram ГБ" }
elseif ($ram -ge 7.5) { Warn "Память: $ram ГБ — заработает, но три лабы с Docker одновременно не потянет (на ноутбуке сейчас 16 ГБ)" }
else { Bad "Память: $ram ГБ — мало: нужно от 8 ГБ, лучше 16" }

$cores = ($cpu.NumberOfCores | Measure-Object -Sum).Sum
$threads = ($cpu.NumberOfLogicalProcessors | Measure-Object -Sum).Sum
$cpuText = "Процессор: $($cpu.Name.Trim()), ядер $cores, потоков $threads"
if ($threads -ge 8) { Ok $cpuText } elseif ($threads -ge 4) { Warn "$cpuText — заработает, но медленнее ноутбука (12 ядер, 16 потоков)" } else { Bad "$cpuText — слишком слабый" }

# Виртуализация: когда гипервизор уже работает, Windows сообщает «в прошивке выключена» — поэтому смотрим оба признака.
if ($cpu.VirtualizationFirmwareEnabled -or $cs.HypervisorPresent) { Ok 'Виртуализация включена (нужна для Docker и WSL)' }
else { Bad 'Виртуализация выключена: её нужно включить в BIOS/UEFI (Intel VT-x / AMD-V, SVM) — без неё не работают Docker и WSL' }

Line ''
Line 'ДИСКИ'
$sys = $env:SystemDrive
$media = @{}
try { Get-PhysicalDisk | ForEach-Object { $media["$($_.DeviceId)"] = "$($_.MediaType)" } } catch {}
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')
$roomy = $disks | Where-Object { $_.DeviceID -ne $sys -and $_.FreeSpace / 1GB -ge 100 } | Select-Object -First 1
foreach ($d in $disks) {
  $free = [math]::Round($d.FreeSpace / 1GB)
  $size = [math]::Round($d.Size / 1GB)
  # Какой это диск физически (SSD или HDD): буква → раздел → физический диск.
  $kind = ''
  try {
    $part = Get-Partition -DriveLetter $d.DeviceID.Substring(0, 1) -ErrorAction Stop
    $pd = Get-PhysicalDisk | Where-Object { "$($_.DeviceId)" -eq "$($part.DiskNumber)" } | Select-Object -First 1
    if ($pd) { $kind = " — $($pd.MediaType), $($pd.FriendlyName), $([math]::Round($pd.Size / 1GB)) ГБ" }
  } catch {}
  $t = "$($d.DeviceID) свободно $free ГБ из $size ГБ$kind"
  if ($d.DeviceID -eq $sys) {
    if ($free -ge 100) { Ok "$t (системный)" }
    elseif ($roomy) { Warn "$t (системный) — мало, но на $($roomy.DeviceID) места хватает: Docker и папки лаб можно держать там" }
    elseif ($free -ge 50) { Warn "$t (системный) — хватит на первое время; лучше от 100 ГБ" }
    else { Bad "$t (системный) — мало: нужно от 50 ГБ, лучше 100" }
  } else { Line "            $t" }
}
foreach ($pd in Get-PhysicalDisk) { Line "            Физический диск: $($pd.FriendlyName) — $($pd.MediaType), $([math]::Round($pd.Size / 1GB)) ГБ, $($pd.BusType)" }
$kinds = ($media.Values | Sort-Object -Unique) -join ', '
if ($kinds) { if ($kinds -match 'HDD') { Warn "Тип дисков: $kinds — на HDD лабы с Docker идут заметно медленнее, чем на SSD" } else { Line "            Тип дисков: $kinds" } }

Line ''
Line 'УЧЁТНАЯ ЗАПИСЬ И ПИТАНИЕ'
if ($env:USERNAME -eq 'User') { Ok 'Имя пользователя Windows: User — как на ноутбуке, пути менять не придётся' }
else { Line "            Имя пользователя Windows: $($env:USERNAME) (на ноутбуке — User; пути в правилах бота поправим при переносе)" }
if ($env:USERPROFILE -match '[^\x00-\x7F]') { Warn "Папка пользователя с русскими буквами ($($env:USERPROFILE)) — часть программ (Docker, npm) с такими путями работает плохо; лучше отдельная учётная запись латиницей" }
$isAdmin = $false
try { $isAdmin = [bool](Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.Name -match "\\$([regex]::Escape($env:USERNAME))$" }) } catch {}
if ($isAdmin) { Ok 'Учётная запись — администратор (нужно для установки Docker и WSL)' } else { Warn 'Учётная запись не администратор (или не удалось определить): для установки Docker и WSL понадобится пароль администратора' }
if (Get-CimInstance Win32_Battery) { Warn 'Это ноутбук (есть батарея): у него те же риски сна и закрытой крышки, что и сейчас' } else { Ok 'Батареи нет — стационарный ПК' }
$pq = (powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null) -join "`n"
$hex = [regex]::Matches($pq, '0x[0-9a-fA-F]{8}') | ForEach-Object { [Convert]::ToInt32($_.Value, 16) }
if ($hex.Count -ge 2) {
  $ac = $hex[$hex.Count - 2]
  if ($ac -eq 0) { Ok 'Сон от сети: никогда' } else { Line "            Сон от сети: через $([math]::Round($ac / 60)) мин — при переносе нужно поставить «никогда»" }
}
Line "            Часовой пояс: $((Get-TimeZone).DisplayName)"
$nics = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' }
foreach ($n in $nics) {
  $kind = if ("$($n.PhysicalMediaType)" -match '802\.11|Wireless') { 'Wi-Fi' } else { 'провод' }
  Line "            Сеть: $($n.Name) — $kind, $($n.LinkSpeed)"
}
if ($nics -and -not ($nics | Where-Object { "$($_.PhysicalMediaType)" -notmatch '802\.11|Wireless' })) { Warn 'Интернет только по Wi-Fi — для сервера надёжнее провод' }

# ---------- программы ----------
Line ''
Line 'ЧТО УЖЕ УСТАНОВЛЕНО (ставить заново ничего не нужно — это сделаем при переносе)'
$progs = @(
  @('winget', '--version', 'winget (установщик программ Windows)'),
  @('node', '--version', 'Node.js'),
  @('python', '--version', 'Python'),
  @('git', '--version', 'Git'),
  @('java', '-version', 'Java'),
  @('dotnet', '--version', '.NET SDK'),
  @('docker', '--version', 'Docker'),
  @('wsl', '--status', 'WSL (Linux в Windows)'),
  @('claude', '--version', 'Claude Code'),
  @('openclaw', '--version', 'OpenClaw')
)
foreach ($p in $progs) {
  $r = Run $p[0] $p[1]
  if (-not $r) { Line "            нет   $($p[2])" }
  elseif ($r.path -match 'WindowsApps' -and $p[0] -eq 'python') { Line "            нет   $($p[2]) (только ярлык Магазина Microsoft)" }
  elseif ($p[0] -eq 'wsl') { if ($r.code -eq 0) { Line "            есть  $($p[2])" } else { Line "            нет   $($p[2]) (компонент Windows не включён)" } }
  elseif ($r.code -eq 0 -or $r.text) { Line "            есть  $($p[2]): $($r.text)" }
  else { Line "            ?     $($p[2]): код $($r.code)" }
}
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Warn 'Нет winget — программы придётся ставить установщиками с сайтов (дольше, но возможно)' }
foreach ($o in @('C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE', 'C:\Program Files (x86)\Microsoft Office\root\Office16\WINWORD.EXE')) { if (Test-Path $o) { Line '            есть  Microsoft Word' } }
if (Test-Path 'C:\Program Files\LibreOffice\program\soffice.exe') { Line '            есть  LibreOffice' }
# Шрифты для снимков терминала в отчётах (render_ps.py, render_wsl.py): на Windows 10 Cascadia Mono может не быть.
$fonts = @(@('CascadiaMono.ttf', 'Cascadia Mono'), @('seguisym.ttf', 'Segoe UI Symbol'))
foreach ($f in $fonts) {
  $sysFont = Join-Path $env:WINDIR ('Fonts\' + $f[0])
  $userFont = Join-Path $env:LOCALAPPDATA ('Microsoft\Windows\Fonts\' + $f[0])
  if ((Test-Path $sysFont) -or (Test-Path $userFont)) { Line "            есть  шрифт $($f[1])" }
  else { Warn "Нет шрифта $($f[1]) (нужен для снимков терминала в отчётах) — поставим при переносе, он бесплатный" }
}
Line "            PowerShell $($PSVersionTable.PSVersion) (серверу нужен Windows PowerShell 5.1 — он есть в любой Windows 10/11)"

# ---------- сеть: подробности ----------
# Нужны, чтобы отличить слабый Wi-Fi от неверного DNS и от VPN/прокси, который пропускает только часть адресов.
Line ''
Line 'СЕТЬ: ПОДРОБНОСТИ (помогают понять причину, если адреса ниже не открываются)'
$defaults = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object { $_.RouteMetric + $_.InterfaceMetric })
foreach ($r in $defaults) { Line "            Маршрут в интернет: «$($r.InterfaceAlias)», шлюз $($r.NextHop), метрика $($r.RouteMetric + $r.InterfaceMetric)" }
if (-not $defaults.Count) { Bad 'Маршрута в интернет нет (шлюз по умолчанию не найден)' }
$gw = $defaults | Where-Object { $_.NextHop -ne '0.0.0.0' } | Select-Object -First 1
if ($gw) {
  $pings = @(Test-Connection -ComputerName $gw.NextHop -Count 10)
  $lost = 10 - $pings.Count
  if ($pings.Count -eq 0) { Line '            Связь с роутером: на проверку (ping) не отвечает — так бывает и при исправной сети' }
  else {
    $avg = [math]::Round(($pings | Measure-Object ResponseTime -Average).Average)
    $max = ($pings | Measure-Object ResponseTime -Maximum).Maximum
    if ($lost -ge 2 -or $avg -gt 50) { Warn "Связь с роутером плохая: потеряно $lost из 10, в среднем $avg мс, до $max мс — слабый сигнал Wi-Fi или помехи" }
    else { Ok "Связь с роутером: потеряно $lost из 10, в среднем $avg мс, до $max мс" }
  }
}
foreach ($v in Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and -not $_.HardwareInterface }) { Line "            Виртуальный адаптер (VPN, туннель или Hyper-V): $($v.Name) — $($v.InterfaceDescription)" }
$inet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
if ($inet.ProxyEnable -eq 1 -and $inet.ProxyServer) { Line "            Системный прокси включён: $(("$($inet.ProxyServer)" -replace '[^=;]*@', ''))" }
if ($inet.AutoConfigURL) { $u = [uri]"$($inet.AutoConfigURL)"; Line "            Сценарий автонастройки прокси (PAC): $($u.Scheme)://$($u.Host):$($u.Port)" }
if ($inet.ProxyEnable -ne 1 -and -not $inet.AutoConfigURL) { Line '            Системный прокси: не задан' }
$dnsList = @(Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses })
foreach ($d in $dnsList) { Line "            DNS для «$($d.InterfaceAlias)»: $($d.ServerAddresses -join ', ')" }
# Имена нужных серверов: спрашиваем DNS этого ПК и два общедоступных (Google и Яндекс) — видно, чей DNS не отвечает.
function Dns($name, $server) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    if ($server) { $a = Resolve-DnsName -Name $name -Type A -DnsOnly -QuickTimeout -Server $server -ErrorAction Stop }
    else { $a = Resolve-DnsName -Name $name -Type A -DnsOnly -QuickTimeout -ErrorAction Stop }
    if ($a | Where-Object { $_.IPAddress }) { return "да ($($sw.ElapsedMilliseconds) мс)" }
    return 'нет (пустой ответ)'
  } catch { return "нет ($($sw.ElapsedMilliseconds) мс)" }
}
$sysFail = 0; $pubOk = 0
foreach ($n in @('newlms.misis.ru', 'api.telegram.org', 'api.anthropic.com', 'registry.npmjs.org', 'pypi.org')) {
  $s0 = Dns $n $null
  if ($s0 -notmatch '^да') { Start-Sleep -Milliseconds 500; $s0 = Dns $n $null }   # вторая попытка: первая могла потеряться
  $g = Dns $n '8.8.8.8'
  $y = Dns $n '77.88.8.8'
  if ($s0 -notmatch '^да') { $sysFail++; if ($g -match '^да' -or $y -match '^да') { $pubOk++ } }
  Line "            Имя $($n): DNS этого ПК — $s0; Google 8.8.8.8 — $g; Яндекс 77.88.8.8 — $y"
}
if ($sysFail -gt 0 -and $pubOk -gt 0) { Warn "DNS этого ПК не находит $sysFail из 5 нужных адресов, а общедоступный DNS находит — поможет смена DNS-сервера в настройках сети или роутера" }
elseif ($sysFail -gt 0) { Warn "Не находятся $sysFail из 5 нужных адресов ни через DNS этого ПК, ни через общедоступные — похоже на плохую связь или блокировку в сети" }
else { Ok 'DNS этого ПК находит все нужные адреса' }

# ---------- интернет ----------
Line ''
Line 'ДОСТУП В ИНТЕРНЕТ (без этих адресов сервер работать не сможет)'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$sites = @(
  @('https://newlms.misis.ru/', 'Moodle МИСИС', $true),
  @('https://api.telegram.org/', 'Telegram (бот)', $true),
  @('https://api.anthropic.com/', 'Claude (работа агента)', $true),
  @('https://claude.ai/', 'Claude (вход в подписку)', $true),
  @('https://misis.ru/students/schedule/', 'Расписание МИСИС', $false),
  @('https://registry.npmjs.org/', 'npm (пакеты Node.js)', $false),
  @('https://pypi.org/', 'PyPI (пакеты Python)', $false),
  @('https://github.com/', 'GitHub', $false),
  @('https://registry-1.docker.io/v2/', 'Docker Hub (образы для стендов)', $false)
)
foreach ($s in $sites) {
  $code = $null; $err = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { $resp = Invoke-WebRequest -UseBasicParsing -Uri $s[0] -TimeoutSec 15 -ErrorAction Stop; $code = [int]$resp.StatusCode }
  catch {
    $r = $_.Exception.Response
    if ($r) { $code = [int]$r.StatusCode } else { $err = $_.Exception.Message }
  }
  $ms = $sw.ElapsedMilliseconds
  # Любой ответ сервера (даже 401/403/404) значит, что адрес доступен; ошибка без ответа — что соединения нет.
  if ($code) { Ok "$($s[1]): отвечает (код $code, $ms мс)" }
  elseif ($s[2]) { Bad "$($s[1]): НЕ открывается — $err" }
  else { Warn "$($s[1]): не открывается — $err" }
}

Line ''
Line ('=' * 70)
if ($script:bad -gt 0) { Line "ИТОГ: есть препятствия ($($script:bad)) — см. строки [ НЕТ ]. Замечаний: $($script:warn)." }
elseif ($script:warn -gt 0) { Line "ИТОГ: подходит, но есть замечания ($($script:warn)) — см. строки [ВНИМАНИЕ]." }
else { Line 'ИТОГ: ПК подходит для сервера.' }
Line 'Пришлите этот файл (или его текст) в чат с Claude. Паролей и ключей в нём нет.'

[IO.File]::WriteAllLines($file, $out, (New-Object Text.UTF8Encoding($true)))
Write-Host "Done: $file"
if (-not $env:DOODLE_CHECK_QUIET) { Start-Process notepad.exe $file }
