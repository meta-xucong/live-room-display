Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $repoRoot '..\直播间排班模板'
$outputDir = [IO.Path]::GetFullPath($outputDir)
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$headers = @('日期','导演开始时间','导演结束时间','导演','','日期','主播开始时间','主播结束时间','主播','助播','主播照片','主推商品','目标销售额','备注')
$instruction = '左侧 A-D 填导演，右侧 F-N 填主播；两者数量和时间独立，助播跟随主播。某日期任一侧有排班时会替换当天两类排班。第3行标题勿改，照片锚定 K 列。'

function XmlEscape([string]$text) {
  return [System.Security.SecurityElement]::Escape($text)
}

function ColumnName([int]$number) {
  $name = ''
  while ($number -gt 0) {
    $number--
    $name = [char](65 + ($number % 26)) + $name
    $number = [math]::Floor($number / 26)
  }
  return $name
}

function New-CellXml([int]$row, [int]$column, [string]$value, [int]$style) {
  if ($null -eq $value -or $value -eq '') { return '' }
  $reference = "$(ColumnName $column)$row"
  $escaped = XmlEscape $value
  return "<c r=`"$reference`" s=`"$style`" t=`"inlineStr`"><is><t xml:space=`"preserve`">$escaped</t></is></c>"
}

function New-WorksheetXml([object[]]$rows, [bool]$isExample) {
  $sheetRows = for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
    $rowNumber = $rowIndex + 1
    $cellXml = for ($columnIndex = 0; $columnIndex -lt 14; $columnIndex++) {
      $value = [string]$rows[$rowIndex][$columnIndex]
      $style = 0
      if ($rowNumber -eq 3) { $style = 1 }
      elseif ($rowNumber -eq 2) { $style = 2 }
      elseif ($rowNumber -eq 1 -and $columnIndex -in @(0,1,3,4)) { $style = 3 }
      elseif ($isExample -and $rowNumber -ge 4) { $style = 4 }
      elseif ($columnIndex -eq 4) { $style = 5 }
      New-CellXml $rowNumber ($columnIndex + 1) $value $style
    }
    $height = if ($rowNumber -eq 2) { ' ht="44" customHeight="1"' } else { '' }
    "<row r=`"$rowNumber`"$height>$(($cellXml -join ''))</row>"
  }
  return @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:N$($rows.Count)"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>
    <col min="1" max="1" width="14" customWidth="1"/><col min="2" max="3" width="18" customWidth="1"/><col min="4" max="4" width="18" customWidth="1"/><col min="5" max="5" width="3" customWidth="1"/>
    <col min="6" max="6" width="14" customWidth="1"/><col min="7" max="8" width="18" customWidth="1"/><col min="9" max="10" width="18" customWidth="1"/><col min="11" max="11" width="14" customWidth="1"/><col min="12" max="12" width="28" customWidth="1"/><col min="13" max="13" width="15" customWidth="1"/><col min="14" max="14" width="30" customWidth="1"/>
  </cols>
  <sheetData>$($sheetRows -join '')</sheetData>
  <mergeCells count="1"><mergeCell ref="A2:N2"/></mergeCells>
</worksheet>
"@
}

function New-Workbook([string]$path, [string[]]$sheetNames, [bool]$blankOnly) {
  $workDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $workDir
  $null = New-Item -ItemType Directory -Path (Join-Path $workDir '_rels')
  $null = New-Item -ItemType Directory -Path (Join-Path $workDir 'xl\_rels')
  $null = New-Item -ItemType Directory -Path (Join-Path $workDir 'xl\worksheets')

  $sheetNodes = [System.Collections.Generic.List[string]]::new()
  $relationshipNodes = [System.Collections.Generic.List[string]]::new()
  $contentNodes = [System.Collections.Generic.List[string]]::new()
  $workbookRels = [System.Collections.Generic.List[string]]::new()
  $sheetId = 0
  foreach ($sheetName in $sheetNames) {
    $sheetId++
    $isFirstExample = !$blankOnly -and $sheetId -eq 1
    $roomCode = ''
    $roomName = ''
    if ($sheetNames.Count -eq 27) {
      $roomCode = if ($isFirstExample) { '示例01' } else { '{0:D2}' -f $sheetId }
      if ($isFirstExample) { $roomName = '示例直播间' }
      $sheetInstruction = 'B1填直播间名称，E1填直播间编号。' + $instruction + '总表必须保留27张工作表并填写全部直播间名称和编号。'
    } else {
      $sheetInstruction = '单间导入请先在网页选择直播间，B1和E1可留空。' + $instruction
      if ($isFirstExample) { $sheetInstruction += '示例数据上传前替换或删除。' }
    }
    $rows = [System.Collections.Generic.List[object]]::new()
    $rows.Add(@('直播间名称',$roomName,'','直播间编号',$roomCode,'','','','','','','','',''))
    $rows.Add(@($sheetInstruction,'','','','','','','','','','','','',''))
    $rows.Add($headers)
    if ($isFirstExample) {
      $rows.Add(@('2026-11-18','07:00','13:00','示例导演','','2026-11-18','07:00','11:00','示例主播甲','示例助播甲','','示例商品甲','80000','示例'))
      $rows.Add(@('2026-11-18','13:00','23:00','示例导演','','2026-11-18','11:00','15:00','示例主播乙','','','示例商品乙','60000','示例'))
      $rows.Add(@('','','','','','2026-11-18','15:00','19:00','示例主播甲','示例助播甲','','示例商品甲','60000','示例'))
      $rows.Add(@('','','','','','2026-11-18','19:00','23:00','示例主播乙','','','示例商品乙','60000','示例'))
    } else {
      $rows.Add(@('','','','','','','','','','','','','',''))
    }
    $sheetPath = Join-Path $workDir "xl\worksheets\sheet$sheetId.xml"
    [IO.File]::WriteAllText($sheetPath, (New-WorksheetXml $rows.ToArray() $isFirstExample), [Text.UTF8Encoding]::new($false))
    $safeName = XmlEscape $sheetName
    $sheetNodes.Add("<sheet name=`"$safeName`" sheetId=`"$sheetId`" r:id=`"rId$sheetId`"/>")
    $relationshipNodes.Add("<Relationship Id=`"rId$sheetId`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet`" Target=`"worksheets/sheet$sheetId.xml`"/>")
    $contentNodes.Add("<Override PartName=`"/xl/worksheets/sheet$sheetId.xml`" ContentType=`"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml`"/>")
  }

  $styles = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FF315C8A"/><sz val="10"/><name val="Aptos"/></font></fonts>
  <fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315C8A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF1FA"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF4D6"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD4DFED"/></left><right style="thin"><color rgb="FFD4DFED"/></right><top style="thin"><color rgb="FFD4DFED"/></top><bottom style="thin"><color rgb="FFD4DFED"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>
'@
  [IO.File]::WriteAllText((Join-Path $workDir 'xl\styles.xml'), $styles, [Text.UTF8Encoding]::new($false))
  $workbook = "<?xml version=`"1.0`" encoding=`"UTF-8`" standalone=`"yes`"?><workbook xmlns=`"http://schemas.openxmlformats.org/spreadsheetml/2006/main`" xmlns:r=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships`"><bookViews><workbookView/></bookViews><sheets>$($sheetNodes -join '')</sheets><calcPr calcId=`"191029`"/></workbook>"
  $rels = "<?xml version=`"1.0`" encoding=`"UTF-8`" standalone=`"yes`"?><Relationships xmlns=`"http://schemas.openxmlformats.org/package/2006/relationships`"><Relationship Id=`"rIdStyles`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles`" Target=`"styles.xml`"/>$($relationshipNodes -join '')</Relationships>"
  $rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  $types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + ($contentNodes -join '') + '</Types>'
  [IO.File]::WriteAllText((Join-Path $workDir 'xl\workbook.xml'), $workbook, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $workDir 'xl\_rels\workbook.xml.rels'), $rels, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $workDir '_rels\.rels'), $rootRels, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $workDir '[Content_Types].xml'), $types, [Text.UTF8Encoding]::new($false))

  $temporaryZip = "$path.tmp"
  if (Test-Path -LiteralPath $temporaryZip) { Remove-Item -LiteralPath $temporaryZip -Force }
  $archiveStream = [IO.File]::Open($temporaryZip, [IO.FileMode]::CreateNew)
  $archive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $workDir -File -Recurse | ForEach-Object {
      $entryName = $_.FullName.Substring($workDir.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
  $archiveStream.Dispose()
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  Move-Item -LiteralPath $temporaryZip -Destination $path
  $resolvedWork = [IO.Path]::GetFullPath($workDir)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (!$resolvedWork.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove an unexpected temporary path.' }
  Remove-Item -LiteralPath $resolvedWork -Recurse -Force
}

$exampleSingle = Join-Path $outputDir '单直播间排班模板_导演主播独立时间版.xlsx'
$exampleMaster = Join-Path $outputDir '27个直播间总表模板_导演主播独立时间版.xlsx'
$blankPublic = Join-Path $repoRoot 'public\live-room-schedule-template.xlsx'
New-Workbook $exampleSingle @('示例直播间') $false
New-Workbook $exampleMaster (@('示例直播间') + (2..27 | ForEach-Object { '直播间{0:D2}' -f $_ })) $false
New-Workbook $blankPublic @('直播间模板') $true
Get-Item $exampleSingle,$exampleMaster,$blankPublic | Select-Object FullName,Length
