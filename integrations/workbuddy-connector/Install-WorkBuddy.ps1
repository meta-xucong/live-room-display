[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$serverName = 'soho-live-room'
$serverUrl = 'https://douyin.sohodigital.top/mcp'
$apiKeyEnvironmentVariable = 'SOHO_LIVE_ROOM_API_KEY'
$apiKey = [Environment]::GetEnvironmentVariable($apiKeyEnvironmentVariable, 'Process')
$secureKey = $null

try {
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        $secureKey = Read-Host -Prompt 'WorkBuddy MCP API Key' -AsSecureString
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try {
            $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
        }
    }

    if ($apiKey -notmatch '^lrd_live_[A-Za-z0-9_-]{20,}$') {
        throw 'The API key format is invalid.'
    }

    $workbuddyHome = if ($env:WORKBUDDY_HOME) { $env:WORKBUDDY_HOME } else { Join-Path $env:USERPROFILE '.workbuddy' }
    if (-not (Test-Path -LiteralPath $workbuddyHome -PathType Container)) {
        throw 'WorkBuddy was not found for this Windows user. Open WorkBuddy once, then rerun the installer.'
    }

    $configPath = Join-Path $workbuddyHome 'mcp.json'
    $skillSource = Join-Path $PSScriptRoot 'skills\live-room-schedule\SKILL.md'
    $skillTargetDirectory = Join-Path $workbuddyHome 'skills\live-room-schedule'
    if (-not (Test-Path -LiteralPath $skillSource -PathType Leaf)) {
        throw "The bundled skill file was not found: $skillSource"
    }

    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $configText = [IO.File]::ReadAllText($configPath)
        try {
            $config = $configText | ConvertFrom-Json
        }
        catch {
            throw 'WorkBuddy mcp.json is not valid JSON. The existing file was left unchanged.'
        }
    }
    else {
        $config = [pscustomobject]@{}
    }

    if ($null -eq $config.mcpServers) {
        $config | Add-Member -MemberType NoteProperty -Name 'mcpServers' -Value ([pscustomobject]@{}) -Force
    }
    elseif ($config.mcpServers -isnot [pscustomobject]) {
        throw 'WorkBuddy mcp.json has an unsupported mcpServers structure. The existing file was left unchanged.'
    }

    $server = [pscustomobject][ordered]@{
        type    = 'streamableHttp'
        url     = $serverUrl
        headers = [pscustomobject]@{
            Authorization = "Bearer $apiKey"
        }
        timeout = 30000
    }
    $config.mcpServers | Add-Member -MemberType NoteProperty -Name $serverName -Value $server -Force

    $configDirectory = Split-Path -Parent $configPath
    $temporaryConfigPath = Join-Path $configDirectory ([IO.Path]::GetRandomFileName() + '.tmp')
    $json = $config | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($temporaryConfigPath, ($json + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

    New-Item -ItemType Directory -Force -Path $skillTargetDirectory | Out-Null
    Copy-Item -LiteralPath $skillSource -Destination (Join-Path $skillTargetDirectory 'SKILL.md') -Force
    Move-Item -LiteralPath $temporaryConfigPath -Destination $configPath -Force

    $verifiedConfig = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    $verifiedServer = $verifiedConfig.mcpServers.PSObject.Properties[$serverName].Value
    if (-not $verifiedServer -or $verifiedServer.url -ne $serverUrl -or $verifiedServer.headers.Authorization -ne "Bearer $apiKey") {
        throw 'The WorkBuddy MCP configuration did not pass verification.'
    }

    Write-Host 'WorkBuddy 直播间 MCP 已配置，排班技能已安装。新建聊天发送“查看直播间”；如果工具未出现，请完全退出并重启 WorkBuddy。'
    Write-Host '密钥已写入当前 Windows 用户的 WorkBuddy 本地 MCP 配置，不会写入仓库或安装包。'
}
finally {
    if ($temporaryConfigPath -and (Test-Path -LiteralPath $temporaryConfigPath)) {
        Remove-Item -LiteralPath $temporaryConfigPath -Force -ErrorAction SilentlyContinue
    }
    $apiKey = $null
    if ($secureKey) {
        $secureKey.Dispose()
    }
}
