param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

# Inspect the installer database without installing or changing registry values.
$ErrorActionPreference = 'Stop'
$installer = $null
$database = $null
$view = $null
try {
  $msiPath = (Resolve-Path -LiteralPath $Path).Path
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $database = $installer.OpenDatabase($msiPath, 0)
  $view = $database.OpenView('SELECT `Root`, `Key`, `Name`, `Value`, `Component_` FROM `Registry`')
  $view.Execute()
  $registry = @()
  while ($record = $view.Fetch()) {
    $registry += [PSCustomObject]@{
      Root = $record.IntegerData(1)
      Key = $record.StringData(2)
      Name = $record.StringData(3)
      Value = $record.StringData(4)
      Component = $record.StringData(5)
    }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
  }
  $view.Close()

  function Assert-Registration([string]$Key, [string]$Name, [string]$Value) {
    $match = @($registry | Where-Object {
      $_.Root -eq 2 -and $_.Key -eq $Key -and $_.Name -eq $Name -and $_.Value -ceq $Value
    })
    if ($match.Count -ne 1) { throw "Missing or ambiguous MSI registration: $Key [$Name]" }
  }

  $progId = 'JSONAtlas.Document'
  $capabilities = 'Software\The_cute_cat\JSON Atlas\Capabilities'
  Assert-Registration "Software\Classes\$progId\shell\open\command" '' '"[INSTALLDIR]json-atlas.exe" "%1"'
  Assert-Registration "Software\Classes\$progId\DefaultIcon" '' '"[INSTALLDIR]document.ico",0'
  Assert-Registration 'Software\Classes\Applications\json-atlas.exe\shell\open\command' '' '"[INSTALLDIR]json-atlas.exe" "%1"'
  Assert-Registration 'Software\RegisteredApplications' 'JSON Atlas' $capabilities
  Assert-Registration $capabilities 'ApplicationName' 'JSON Atlas'
  foreach ($extension in @('.json', '.jsonl', '.ndjson', '.jsonlines')) {
    Assert-Registration "Software\Classes\$extension\OpenWithProgids" $progId ''
    Assert-Registration "$capabilities\FileAssociations" $extension $progId
    Assert-Registration 'Software\Classes\Applications\json-atlas.exe\SupportedTypes' $extension ''
  }
  if ($registry | Where-Object { $_.Key -match 'Explorer\\FileExts\\.*\\UserChoice' }) {
    throw 'MSI must not overwrite Windows UserChoice.'
  }

  # Verify the new registration component is actually selected by a feature.
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
  $view = $database.OpenView('SELECT `Feature_` FROM `FeatureComponents` WHERE `Component_` = ''DocumentAssociations''')
  $view.Execute()
  $record = $view.Fetch()
  if (!$record) { throw 'DocumentAssociations is not included in an installer feature.' }
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
  $view.Close()

  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
  $view = $database.OpenView('SELECT `FileName` FROM `File`')
  $view.Execute()
  $files = @()
  while ($record = $view.Fetch()) {
    $files += ($record.StringData(1) -split '\|')[-1]
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
  }
  $view.Close()
  foreach ($requiredFile in @('json-atlas.exe', 'document.ico')) {
    if ($requiredFile -notin $files) { throw "Missing association target file: $requiredFile" }
  }
  function Read-InstallerRows([string]$Query, [int]$Columns) {
    $checkView = $database.OpenView($Query)
    try {
      [void]$checkView.Execute()
      while ($checkRecord = $checkView.Fetch()) {
        try {
          $values = for ($column = 1; $column -le $Columns; $column++) { $checkRecord.StringData($column) }
          [pscustomobject]@{ Values = @($values) }
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($checkRecord) }
      }
    } finally {
      [void]$checkView.Close()
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($checkView)
    }
  }
  $launch = @(Read-InstallerRows 'SELECT `Type`, `Y`, `Width`, `Text` FROM `Control` WHERE `Dialog_` = ''AtlasExitDialog'' AND `Control` = ''Launch''' 4)
  if ($launch.Count -ne 1 -or $launch[0].Values[0] -ne 'PushButton' -or [int]$launch[0].Values[1] -ne 243 -or [int]$launch[0].Values[2] -lt 90 -or $launch[0].Values[3] -ne '启动 JSON Atlas') {
    throw 'MSI exit dialog must use a localized launch button in the footer.'
  }
  $events = @(Read-InstallerRows 'SELECT `Event`, `Argument`, `Ordering` FROM `ControlEvent` WHERE `Dialog_` = ''AtlasExitDialog'' AND `Control_` = ''Launch''' 3)
  if (!($events | Where-Object { $_.Values[0] -eq 'DoAction' -and $_.Values[1] -eq 'LaunchApplication' -and $_.Values[2] -eq '1' }) -or
      !($events | Where-Object { $_.Values[0] -eq 'EndDialog' -and $_.Values[1] -eq 'Return' -and $_.Values[2] -eq '2' })) { throw 'Launch button must start the app and close the installer.' }
  $exitDialog = @(Read-InstallerRows 'SELECT `Action` FROM `InstallUISequence` WHERE `Sequence` = -1' 1)
  if ($exitDialog.Count -ne 1 -or $exitDialog[0].Values[0] -ne 'AtlasExitDialog') { throw 'Custom exit dialog is not selected.' }
  $prompt = @(Read-InstallerRows 'SELECT `Action` FROM `CustomAction` WHERE `Action` = ''AtlasPromptDataRemoval''' 1)
  if ($prompt.Count) { throw 'Uninstall must not ask whether to clear data.' }
  $cleanup = @(Read-InstallerRows 'SELECT `Condition` FROM `InstallExecuteSequence` WHERE `Action` = ''AtlasClearUserData''' 1)
  if ($cleanup.Count -ne 1 -or $cleanup[0].Values[0] -ne 'Installed AND REMOVE = "ALL" AND NOT UPGRADINGPRODUCTCODE') {
    throw 'Uninstall must clear data automatically while upgrades retain it.'
  }
  Write-Output "MSI association, completion UI and uninstall cleanup checks passed: $msiPath"
}
finally {
  foreach ($item in @($view, $database, $installer)) {
    if ($null -ne $item) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item) }
  }
}
