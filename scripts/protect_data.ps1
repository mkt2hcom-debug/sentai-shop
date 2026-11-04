#Requires -Version 5.1
<#
.SYNOPSIS
Restrict private Sentai files to the current Windows user, SYSTEM and Administrators.
.DESCRIPTION
Only .env, data, artifacts and backups below this script's project are changed.
All existing descendants are checked before the first ACL change. Reparse points
(including symbolic links and junctions) are rejected. No files are created,
moved or deleted. Use -WhatIf to inspect the scope without changing permissions.
Only the access ACL (DACL) is written; ownership and audit rules are preserved.

Run with the same Windows account that runs the shop. If a service uses another
account, this policy must be adapted before applying it. This is an NTFS ACL
control, not disk encryption; administrators and SYSTEM retain access.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This script only supports Windows file permissions.'
}
# npm may inherit PowerShell 7's PSModulePath while launching Windows PowerShell
# 5.1. Import this host's built-in module explicitly instead of auto-loading a
# module from the other host's installation.
Import-Module -Name (Join-Path -Path $PSHOME -ChildPath 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

$projectRoot = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($PSScriptRoot)).TrimEnd('\', '/')
$driveRoot = [IO.Path]::GetPathRoot($projectRoot).TrimEnd('\', '/')
if ([string]::Equals($projectRoot, $driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A drive or workspace root cannot be a permission-change target.'
}
$projectPrefix = $projectRoot + [IO.Path]::DirectorySeparatorChar

function Assert-PrivateTargetPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $absolute = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not $absolute.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a target outside the project or equal to its root: $absolute"
    }
    $relative = $absolute.Substring($projectPrefix.Length)
    $firstPart = ($relative -split '[\\/]')[0]
    if ($firstPart -notin @('.env', 'data', 'artifacts', 'backups') -or ($firstPart -eq '.env' -and $relative -ne '.env')) {
        throw "Refusing a path outside the private-data scope: $absolute"
    }

    # Check every existing ancestor, including the project and volume path.
    # This prevents a junction in an ancestor from redirecting Set-Acl elsewhere.
    $ancestor = $absolute
    while ($ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse points are not allowed in protected paths: $ancestor"
        }
        $parent = [IO.Path]::GetDirectoryName($ancestor)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $ancestor) { break }
        $ancestor = $parent
    }
    return $absolute
}

$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowedSids = @($ownerSid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
$scopes = New-Object 'System.Collections.Generic.List[object]'
$total = 0
$alreadyProtected = 0

function Test-DesiredAccessAcl {
    param($Acl, [Security.AccessControl.InheritanceFlags]$Inheritance)
    if (-not $Acl.AreAccessRulesProtected -or $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value) { return $false }
    $rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne $allowedSids.Count) { return $false }
    $seen = @{}
    foreach ($rule in $rules) {
        $sidValue = $rule.IdentityReference.Value
        if ($sidValue -notin $allowedSids -or $seen.ContainsKey($sidValue) -or $rule.IsInherited -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne $Inheritance -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { return $false }
        $seen[$sidValue] = $true
    }
    return $true
}

# Enumerate manually instead of Get-ChildItem -Recurse, so a junction is never
# traversed before it is rejected. Build the entire plan before changing ACLs.
foreach ($name in @('.env', 'data', 'artifacts', 'backups')) {
    $targetPath = Join-Path -Path $projectRoot -ChildPath $name
    try { $target = Get-Item -LiteralPath $targetPath -Force -ErrorAction Stop }
    catch {
        if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { continue }
        throw
    }
    $null = Assert-PrivateTargetPath -Path $target.FullName
    if (($name -eq '.env' -and $target.PSIsContainer) -or ($name -ne '.env' -and -not $target.PSIsContainer)) {
        throw "Unexpected file or directory type: $targetPath"
    }
    $items = New-Object 'System.Collections.Generic.List[object]'
    $pending = New-Object 'System.Collections.Generic.Queue[object]'
    $pending.Enqueue($target)
    while ($pending.Count -gt 0) {
        $item = $pending.Dequeue()
        $absolute = Assert-PrivateTargetPath -Path $item.FullName
        $currentAcl = Get-Acl -LiteralPath $absolute -ErrorAction Stop
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
        if ($item.PSIsContainer) {
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        $needsChange = -not (Test-DesiredAccessAcl -Acl $currentAcl -Inheritance $inheritance)
        $acl = $null
        if ($needsChange) {
            # A fresh descriptor marks only Access as modified. Reusing Get-Acl
            # and setting owner can cause Windows PowerShell to persist other
            # security sections and unnecessarily request SeSecurityPrivilege.
            if ($item.PSIsContainer) { $acl = New-Object Security.AccessControl.DirectorySecurity }
            else { $acl = New-Object Security.AccessControl.FileSecurity }
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($sidValue in $allowedSids) {
                $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
                $rule = New-Object Security.AccessControl.FileSystemAccessRule(
                    $sid,
                    [Security.AccessControl.FileSystemRights]::FullControl,
                    $inheritance,
                    [Security.AccessControl.PropagationFlags]::None,
                    [Security.AccessControl.AccessControlType]::Allow
                )
                $acl.AddAccessRule($rule)
            }
        } else {
            $alreadyProtected++
        }
        $items.Add([pscustomobject]@{ Path = $absolute; Acl = $acl; NeedsChange = $needsChange })
        if ($item.PSIsContainer) {
            foreach ($child in @(Get-ChildItem -LiteralPath $absolute -Force -ErrorAction Stop)) {
                $null = Assert-PrivateTargetPath -Path $child.FullName
                $pending.Enqueue($child)
            }
        }
    }
    $total += $items.Count
    $scopes.Add([pscustomobject]@{ Path = $targetPath; Items = $items })
}

$changed = 0
foreach ($scope in $scopes) {
    $pendingChanges = @($scope.Items | Where-Object { $_.NeedsChange })
    if ($pendingChanges.Count -gt 0 -and $PSCmdlet.ShouldProcess($scope.Path, "Restrict $($pendingChanges.Count) files/directories to current user, SYSTEM and Administrators (DACL only)")) {
        foreach ($entry in $pendingChanges) {
            $null = Assert-PrivateTargetPath -Path $entry.Path
            Set-Acl -LiteralPath $entry.Path -AclObject $entry.Acl -ErrorAction Stop
            $changed++
        }
    }
}

[pscustomobject]@{
    Project = $projectRoot
    Checked = $total
    AlreadyProtected = $alreadyProtected
    Changed = $changed
    WindowsUser = $ownerSid.Value
}
