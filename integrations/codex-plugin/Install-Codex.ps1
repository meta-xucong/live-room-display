[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$serverName = 'soho_live_room'
$serverUrl = 'https://douyin.sohodigital.top/mcp'
$apiKeyEnvironmentVariable = 'SOHO_LIVE_ROOM_API_KEY'
$apiKey = [Environment]::GetEnvironmentVariable($apiKeyEnvironmentVariable, 'Process')
$secureKey = $null

try {
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        $secureKey = Read-Host -Prompt 'Codex MCP API Key' -AsSecureString
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

    $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
    if ($codexCommand) {
        $codexExecutable = $codexCommand.Source
    }
    elseif ($env:CODEX_CLI_PATH -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH)) {
        $codexExecutable = $env:CODEX_CLI_PATH
    }
    else {
        throw 'Codex CLI was not found. Open Codex once or add codex to PATH, then rerun this installer.'
    }

    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $configPath = Join-Path $codexHome 'config.toml'
    $skillSource = Join-Path $PSScriptRoot 'skills\live-room-schedule\SKILL.md'
    $skillTargetDirectory = Join-Path $codexHome 'skills\soho-live-room-schedule'

    if (-not (Test-Path -LiteralPath $skillSource)) {
        throw "The bundled skill file was not found: $skillSource"
    }

    New-Item -ItemType Directory -Force -Path $codexHome, $skillTargetDirectory | Out-Null
    [Environment]::SetEnvironmentVariable($apiKeyEnvironmentVariable, $apiKey, 'User')
    [Environment]::SetEnvironmentVariable($apiKeyEnvironmentVariable, $apiKey, 'Process')

    $serverListJson = (& $codexExecutable mcp list --json 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw 'Codex could not read its MCP configuration.'
    }
    $servers = @($serverListJson | ConvertFrom-Json)
    if ($servers | Where-Object { $_.name -eq $serverName }) {
        & $codexExecutable mcp remove $serverName | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not replace the existing MCP entry: $serverName"
        }
    }

    & $codexExecutable mcp add $serverName --url $serverUrl --bearer-token-env-var $apiKeyEnvironmentVariable | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Codex could not register the live room MCP server.'
    }

    function Set-TomlSection {
        param(
            [Parameter(Mandatory = $true)][string]$Path,
            [Parameter(Mandatory = $true)][string]$Header,
            [Parameter(Mandatory = $true)][string[]]$Body
        )

        $keptLines = [System.Collections.Generic.List[string]]::new()
        if (Test-Path -LiteralPath $Path) {
            $skipSection = $false
            foreach ($line in (Get-Content -LiteralPath $Path)) {
                if ($line -match '^\s*\[.+\]\s*$') {
                    if ($line.Trim() -eq $Header) {
                        $skipSection = $true
                        continue
                    }
                    $skipSection = $false
                }
                if (-not $skipSection) {
                    $keptLines.Add($line)
                }
            }
        }

        while ($keptLines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($keptLines[$keptLines.Count - 1])) {
            $keptLines.RemoveAt($keptLines.Count - 1)
        }
        if ($keptLines.Count -gt 0) {
            $keptLines.Add('')
        }
        $keptLines.Add($Header)
        foreach ($line in $Body) {
            $keptLines.Add($line)
        }

        [IO.File]::WriteAllText($Path, (($keptLines -join [Environment]::NewLine) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    }

    Set-TomlSection -Path $configPath -Header '[mcp_servers.soho_live_room.tools.commit_schedule_update]' -Body @('approval_mode = "prompt"')

    $pluginListJson = (& $codexExecutable plugin list --json 2>$null | Out-String)
    if ($LASTEXITCODE -eq 0) {
        try {
            $plugins = @((($pluginListJson | ConvertFrom-Json).installed))
            foreach ($plugin in ($plugins | Where-Object { $_.name -eq 'live-room-schedule' })) {
                $pluginSection = '[plugins."' + $plugin.pluginId + '".mcp_servers.live-room-display]'
                Set-TomlSection -Path $configPath -Header $pluginSection -Body @('enabled = false')
            }
        }
        catch {
            # Plugin discovery is optional; the standalone MCP connection remains usable.
        }
    }

    Copy-Item -LiteralPath $skillSource -Destination (Join-Path $skillTargetDirectory 'SKILL.md') -Force

    $verifiedListJson = (& $codexExecutable mcp list --json 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw 'Codex could not verify its MCP configuration.'
    }
    $verifiedServers = @($verifiedListJson | ConvertFrom-Json)
    $verifiedServer = $verifiedServers | Where-Object { $_.name -eq $serverName }
    if (-not $verifiedServer -or $verifiedServer.transport.url -ne $serverUrl -or $verifiedServer.transport.bearer_token_env_var -ne $apiKeyEnvironmentVariable) {
        throw 'The live room MCP configuration did not pass verification.'
    }

    Write-Host '直播间 MCP 已配置，排班技能已安装。重启 Codex 后，新建聊天并发送“查看直播间”完成连接验证。'
}
finally {
    [Environment]::SetEnvironmentVariable($apiKeyEnvironmentVariable, $null, 'Process')
    $apiKey = $null
    if ($secureKey) {
        $secureKey.Dispose()
    }
}
