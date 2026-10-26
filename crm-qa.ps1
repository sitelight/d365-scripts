<#
  UNTESTED DRAFT. Review before use.

  QA for a Dynamics 365 CE (on-premises) service account through AD FS:
    1. Gets an OAuth token from AD FS (client credentials or password grant).
    2. Calls WhoAmI and shows which CRM user the token resolves to.
    3. Read checks: can the account read each entity the middleware reads?
    4. With -Apply only: creates clearly labelled test records ("EWS middleware test"),
       times each write, and lists what it created so it can be removed afterwards.

  Nothing is written unless -Apply is given. Secrets are typed at the prompt, kept in
  memory only, and never printed or saved.

  Run (PowerShell 5.1 is fine):
    powershell -ExecutionPolicy Bypass -File .\crm-qa.ps1 -CrmUrl https://crm.example.com
    powershell -ExecutionPolicy Bypass -File .\crm-qa.ps1 -CrmUrl https://crm.example.com -Grant password
    powershell -ExecutionPolicy Bypass -File .\crm-qa.ps1 -CrmUrl https://crm.example.com -Apply -AssignTo 'DOMAIN\test.user'
    powershell -ExecutionPolicy Bypass -File .\crm-qa.ps1 -CrmUrl https://crm.example.com -ListTestRecords

  -AssignTo    creates the test appointment owned by that user (tests the Assign privilege).
  -QueueEmail  also routes the test email into that queue. Only use a test queue: a real
               functional queue would show the test email to its users.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CrmUrl,
  [ValidateSet('client_credentials', 'password')][string]$Grant = 'client_credentials',
  [string]$TokenEndpoint,
  [string]$Resource,
  [switch]$Apply,
  [string]$AssignTo,
  [string]$QueueEmail,
  [switch]$ListTestRecords
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$CrmUrl = $CrmUrl.TrimEnd('/')
$Api = $CrmUrl + '/api/data/v9.1/'
$Label = 'EWS middleware test'

function Get-Plain([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Get-ErrorText($err) {
  try {
    $r = $err.Exception.Response
    if ($r) {
      $sr = New-Object IO.StreamReader($r.GetResponseStream())
      $txt = $sr.ReadToEnd()
      if ($txt.Length -gt 300) { $txt = $txt.Substring(0, 300) }
      return ([int]$r.StatusCode).ToString() + ' ' + $txt
    }
  } catch { }
  return $err.Exception.Message
}

function Get-JwtClaims([string]$jwt) {
  $p = $jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
  switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
}

# --- 1. Token endpoint and resource, discovered from the CRM's 401 challenge ---------------
if (-not $TokenEndpoint -or -not $Resource) {
  $challenge = $null
  try { Invoke-WebRequest -Uri $Api -UseBasicParsing | Out-Null }
  catch { if ($_.Exception.Response) { $challenge = $_.Exception.Response.Headers['WWW-Authenticate'] } }
  if (-not $TokenEndpoint -and $challenge -match 'authorization_uri=([^,\s]+)') {
    $TokenEndpoint = ($Matches[1].Trim('"')) -replace '/authorize/?$', '/token/'
  }
  if (-not $Resource -and $challenge -match 'resource_id=([^,\s]+)') {
    $Resource = $Matches[1].Trim('"')
  }
}
if (-not $TokenEndpoint) { $TokenEndpoint = Read-Host 'Token endpoint (https://<adfs host>/adfs/oauth2/token/)' }
if (-not $Resource) { $Resource = Read-Host 'Resource (the CRM relying party identifier, with trailing slash)' }
Write-Host "Token endpoint : $TokenEndpoint"
Write-Host "Resource       : $Resource"
Write-Host "Grant          : $Grant"

# --- 2. Token -----------------------------------------------------------------------------
$form = @{ client_id = (Read-Host 'Client ID'); resource = $Resource; grant_type = $Grant }
$secret = Get-Plain (Read-Host 'Client secret (leave empty if none)' -AsSecureString)
if ($secret) { $form.client_secret = $secret }
if ($Grant -eq 'password') {
  $form.username = Read-Host 'Service account (UPN, for example name@domain)'
  $form.password = Get-Plain (Read-Host 'Service account password' -AsSecureString)
}
try {
  $tok = Invoke-RestMethod -Method Post -Uri $TokenEndpoint -Body $form -ContentType 'application/x-www-form-urlencoded'
} catch {
  Write-Host ('TOKEN FAILED: ' + (Get-ErrorText $_)) -ForegroundColor Red
  return
} finally {
  $form.Clear(); $secret = $null
}
$c = Get-JwtClaims $tok.access_token
Write-Host ('Token OK. aud={0} upn={1} unique_name={2} appid={3} expires_in={4}s' -f $c.aud, $c.upn, $c.unique_name, $c.appid, $tok.expires_in) -ForegroundColor Green

$Headers = @{ Authorization = 'Bearer ' + $tok.access_token; Accept = 'application/json'; 'OData-MaxVersion' = '4.0'; 'OData-Version' = '4.0' }

function Invoke-Crm([string]$Method, [string]$Path, $Body, [switch]$Represent) {
  $h = $Headers.Clone()
  if ($Represent) { $h['Prefer'] = 'return=representation' }
  $p = @{ Method = $Method; Uri = ($Api + $Path); Headers = $h; UseBasicParsing = $true }
  if ($Body) {
    $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 5))
    $p.ContentType = 'application/json; charset=utf-8'
  }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-WebRequest @p
    $sw.Stop()
    $data = $null
    if ($r.Content) { $data = $r.Content | ConvertFrom-Json }
    return [pscustomobject]@{ ok = $true; status = [int]$r.StatusCode; ms = $sw.ElapsedMilliseconds; data = $data; error = $null }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ ok = $false; status = $null; ms = $sw.ElapsedMilliseconds; data = $null; error = (Get-ErrorText $_) }
  }
}

function Write-Check([string]$Name, $Res, [string]$Detail = '') {
  if ($Res.ok) { $state = 'OK'; $col = 'Green' } else { $state = 'FAILED'; $col = 'Red'; $Detail = $Res.error }
  Write-Host ('{0,-34} {1,-7} {2,6} ms  {3}' -f $Name, $state, $Res.ms, $Detail) -ForegroundColor $col
}

function Get-Filter([string]$expr) { [uri]::EscapeDataString($expr) }

# --- 3. WhoAmI ----------------------------------------------------------------------------
$who = Invoke-Crm GET 'WhoAmI'
if (-not $who.ok) { Write-Host ('WhoAmI FAILED: ' + $who.error) -ForegroundColor Red; return }
$me = Invoke-Crm GET ('systemusers(' + $who.data.UserId + ')?$select=fullname,domainname,accessmode')
Write-Host ('WhoAmI OK: {0} ({1}), access mode {2} (0 = Read-Write)' -f $me.data.fullname, $me.data.domainname, $me.data.accessmode) -ForegroundColor Green

# --- Optional: list labelled test records for clean-up (read-only) -------------------------
if ($ListTestRecords) {
  foreach ($set in 'emails', 'appointments', 'tasks') {
    $r = Invoke-Crm GET ($set + '?$select=activityid,subject,createdon&$top=200&$filter=' + (Get-Filter "startswith(subject,'$Label')"))
    if ($r.ok) {
      Write-Host ("{0}: {1} labelled record(s)" -f $set, $r.data.value.Count)
      $r.data.value | ForEach-Object { Write-Host ('  {0}({1})  {2}  {3}' -f $set, $_.activityid, $_.createdon, $_.subject) }
    } else { Write-Check "List $set" $r }
  }
  return
}

# --- 4. Read checks (always) --------------------------------------------------------------
Write-Host ''
Write-Host 'Read checks'
$reads = [ordered]@{
  'Account (may be renamed, e.g. Company)' = 'accounts?$select=accountid&$top=1'
  'Lead'          = 'leads?$select=leadid&$top=1'
  'Contact'       = 'contacts?$select=contactid&$top=1'
  'Queue'         = 'queues?$select=queueid&$top=1'
  'User'          = 'systemusers?$select=systemuserid&$top=1'
  'Team'          = 'teams?$select=teamid&$top=1'
  'Organization'  = 'organizations?$select=maxuploadfilesize'
  'Email'         = 'emails?$select=activityid&$top=1'
  'Appointment'   = 'appointments?$select=activityid&$top=1'
}
foreach ($k in $reads.Keys) { Write-Check $k (Invoke-Crm GET $reads[$k]) }

if (-not $Apply) {
  Write-Host ''
  Write-Host 'Read-only run complete. Add -Apply to create labelled test records.'
  return
}

# --- 5. Write checks (only with -Apply) ---------------------------------------------------
Write-Host ''
Write-Host 'Write checks (labelled test records)'
$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm')
$note = 'Created by the EWS middleware QA script. Safe to delete.'
$created = New-Object System.Collections.ArrayList
$writeMs = New-Object System.Collections.ArrayList

# Email, with a unique Internet message id
$msgId = '<ews-qa-' + [guid]::NewGuid().ToString('N') + '@ews-test.invalid>'
$e = Invoke-Crm POST 'emails?$select=activityid' @{ subject = "$Label $stamp"; description = $note; directioncode = $false; messageid = $msgId } -Represent
Write-Check 'Create email' $e
if ($e.ok) {
  [void]$writeMs.Add($e.ms)
  $emailId = $e.data.activityid
  [void]$created.Add("emails($emailId)")

  $d = Invoke-Crm GET ('emails?$select=activityid&$filter=' + (Get-Filter "messageid eq '$msgId'"))
  if ($d.ok) { Write-Check 'Find email by message id' $d ("{0} match(es), expect 1" -f $d.data.value.Count) } else { Write-Check 'Find email by message id' $d }

  $att = @{
    filename = 'ews-qa.txt'; mimetype = 'text/plain'; objecttypecode = 'email'
    body = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('EWS middleware QA'))
    'objectid_email@odata.bind' = "/emails($emailId)"
  }
  $a = Invoke-Crm POST 'activitymimeattachments?$select=activitymimeattachmentid' $att -Represent
  Write-Check 'Attach file to email' $a
  if ($a.ok) { [void]$writeMs.Add($a.ms) }

  if ($QueueEmail) {
    $q = Invoke-Crm GET ('queues?$select=queueid&$filter=' + (Get-Filter "emailaddress eq '$QueueEmail'"))
    if ($q.ok -and $q.data.value.Count -gt 0) {
      $qi = Invoke-Crm POST 'queueitems?$select=queueitemid' @{ 'queueid@odata.bind' = '/queues(' + $q.data.value[0].queueid + ')'; 'objectid_email@odata.bind' = "/emails($emailId)" } -Represent
      Write-Check 'Route email to queue' $qi
      if ($qi.ok) { [void]$writeMs.Add($qi.ms); [void]$created.Add('queueitems(' + $qi.data.queueitemid + ')') }
    } else { Write-Host "Queue '$QueueEmail' not found; queue routing skipped." -ForegroundColor Yellow }
  }
}

# Appointment, optionally owned by another user, then cancelled
$start = (Get-Date).ToUniversalTime().AddDays(1)
$appt = @{
  subject = "$Label $stamp"; description = $note
  scheduledstart = $start.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"); scheduledend = $start.AddMinutes(30).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
}
if ($AssignTo) {
  $ou = Invoke-Crm GET ('systemusers?$select=systemuserid&$filter=' + (Get-Filter "domainname eq '$AssignTo'"))
  if ($ou.ok -and $ou.data.value.Count -gt 0) { $appt['ownerid@odata.bind'] = '/systemusers(' + $ou.data.value[0].systemuserid + ')' }
  else { Write-Host "User '$AssignTo' not found; appointment stays owned by the service account." -ForegroundColor Yellow }
}
$ap = Invoke-Crm POST 'appointments?$select=activityid' $appt -Represent
$apName = 'Create appointment'
if ($appt.ContainsKey('ownerid@odata.bind')) { $apName = 'Create appointment (assigned)' }
Write-Check $apName $ap
if ($ap.ok) {
  [void]$writeMs.Add($ap.ms)
  [void]$created.Add('appointments(' + $ap.data.activityid + ')')
  $cx = Invoke-Crm PATCH ('appointments(' + $ap.data.activityid + ')') @{ statecode = 2; statuscode = 4 }
  Write-Check 'Cancel appointment' $cx
  if ($cx.ok) { [void]$writeMs.Add($cx.ms) }
}

# Task
$t = Invoke-Crm POST 'tasks?$select=activityid' @{ subject = "$Label $stamp"; description = $note } -Represent
Write-Check 'Create task' $t
if ($t.ok) { [void]$writeMs.Add($t.ms); [void]$created.Add('tasks(' + $t.data.activityid + ')') }

# --- 6. Summary ---------------------------------------------------------------------------
Write-Host ''
if ($writeMs.Count -gt 0) {
  $sorted = @($writeMs | Sort-Object)
  $median = $sorted[[int][Math]::Floor(($sorted.Count - 1) / 2)]
  Write-Host ('Write timings (each includes the synchronous plug-ins): min {0} ms, median {1} ms, max {2} ms' -f $sorted[0], $median, $sorted[-1])
}
Write-Host 'Created (for clean-up; the service role has no Delete):'
$created | ForEach-Object { Write-Host ('  ' + $_) }
