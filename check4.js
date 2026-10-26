/* READ-ONLY (GET requests only, changes nothing). Finds CRM users whose name or
 * domain name contains a search term (default "test"), with their email address,
 * access mode and server-side sync mailbox settings.
 * Sign in to the CRM in the browser, press F12, open Console, paste, press Enter. */
(async () => {
  const term = (prompt('Search users whose name contains:', 'test') || 'test').trim();
  const API = location.origin + '/api/data/v9.1/';
  const H = { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };
  const enc = encodeURIComponent, q = s => String(s).replace(/'/g, "''");
  const get = async p => {
    const r = await fetch(API + p, { headers: H, credentials: 'include' });
    const t = await r.text();
    if (!r.ok) return { error: r.status, detail: t.slice(0, 300) };
    return t ? JSON.parse(t) : {};
  };
  const MODES = { 0: 'Read-Write', 1: 'Administrative', 2: 'Read', 3: 'Support User', 4: 'Non-interactive', 5: 'Delegated Admin' };
  const DELIVERY = { 0: 'None', 1: 'Microsoft Dynamics 365 for Outlook', 2: 'Server-Side Synchronization or Email Router', 3: 'Forward Mailbox' };
  const out = { search: term, users: [] };
  try {
    const f = `contains(fullname,'${q(term)}') or contains(domainname,'${q(term)}')`;
    const users = await get(`systemusers?$select=systemuserid,fullname,domainname,internalemailaddress,accessmode,isdisabled,createdon&$filter=${enc(f)}&$orderby=createdon desc&$top=50`);
    if (users.error) { out.users = users; }
    else for (const u of users.value) {
      const mb = await get(`mailboxes?$select=emailaddress,incomingemaildeliverymethod,outgoingemaildeliverymethod,actdeliverymethod&$filter=_regardingobjectid_value eq ${u.systemuserid}`);
      const box = mb.error ? mb : (mb.value[0] ? {
        email: mb.value[0].emailaddress,
        incoming: DELIVERY[mb.value[0].incomingemaildeliverymethod] ?? mb.value[0].incomingemaildeliverymethod,
        outgoing: DELIVERY[mb.value[0].outgoingemaildeliverymethod] ?? mb.value[0].outgoingemaildeliverymethod,
        appointmentsContactsTasks: DELIVERY[mb.value[0].actdeliverymethod] ?? mb.value[0].actdeliverymethod,
      } : 'no mailbox record');
      out.users.push({
        name: u.fullname, domain: u.domainname, email: u.internalemailaddress,
        accessMode: MODES[u.accessmode] ?? u.accessmode, disabled: u.isdisabled,
        created: (u.createdon || '').slice(0, 10), mailbox: box,
      });
    }
  } catch (e) { out.stoppedAt = e.message; }
  const text = JSON.stringify(out, null, 1);
  console.log(text);
  try { copy(text); console.log('Copied to clipboard.'); } catch (e) { console.log('Select the text above and copy it.'); }
})();
