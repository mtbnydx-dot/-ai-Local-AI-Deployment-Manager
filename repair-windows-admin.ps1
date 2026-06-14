# Run this file in an elevated PowerShell window.
# It performs common Windows repair and maintenance steps without deleting personal files.

$ErrorActionPreference = "Continue"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $env:USERPROFILE "Desktop\system-repair-$timestamp.log"
$energyReport = Join-Path $env:USERPROFILE "Desktop\energy-report-$timestamp.html"

Start-Transcript -Path $logPath

Write-Host "Step 1/6: DISM component store repair"
DISM.exe /Online /Cleanup-Image /RestoreHealth

Write-Host "Step 2/6: System File Checker"
sfc.exe /scannow

Write-Host "Step 3/6: C: online file-system scan"
chkdsk.exe C: /scan

Write-Host "Step 4/6: SSD TRIM optimization"
Optimize-Volume -DriveLetter C,D,E -ReTrim -Verbose

Write-Host "Step 5/6: Disable MSI Afterburner scheduled startup task"
Disable-ScheduledTask -TaskName "MSIAfterburner" -ErrorAction Continue

Write-Host "Step 6/6: Generate Windows energy report"
powercfg.exe /energy /duration 60 /output $energyReport

Write-Host "Done. Repair log: $logPath"
Write-Host "Energy report: $energyReport"

Stop-Transcript
