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
  Write-Output "MSI file association checks passed: $msiPath"
}
finally {
  foreach ($item in @($view, $database, $installer)) {
    if ($null -ne $item) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item) }
  }
}
