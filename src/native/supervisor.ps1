#Requires -Version 7.0
param([Parameter(Mandatory)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'Supervisor.cs')
    $launch = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
    [Syndic.Supervisor]::Run($launch.commandLine, $launch.cwd, $launch.receipt)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
