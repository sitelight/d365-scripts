/* READ-ONLY follow-up check (GET requests only, changes nothing).
 * Sign in to the CRM in the browser, press F12, open Console, paste, press Enter.
 * It asks for the service account's domain name (or part of it).
 * The result is printed and copied to the clipboard. */
(async () => {
  const ROLE = 'EWS Graph Middleware';
  const who = (prompt('Service account domain name, or part of it:', '') || '').trim();
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

  async function privs(roleId) {
    const d = await get(`roles(${roleId})/Microsoft.Dynamics.CRM.RetrieveRolePrivilegesRole()`);
    if (d.error) return { error: d };
    const list = d.RolePrivileges || [];
    const ids = [...new Set(list.map(p => p.PrivilegeId))];
    const names = {};
    for (let i = 0; i < ids.length; i += 15) {
      const f = ids.slice(i, i + 15).map(id => `privilegeid eq ${id}`).join(' or ');
      const r = await get(`privileges?$select=privilegeid,name&$filter=${enc(f)}`);
      if (!r.error) r.value.forEach(p => { names[p.privilegeid] = p.name; });
    }
    return { count: list.length, privileges: list.map(p => `${names[p.PrivilegeId] || p.PrivilegeId}:${p.Depth}`).sort() };
  }

  const out = {};
  try {
    const root = await get(`businessunits?$select=businessunitid,name&$filter=_parentbusinessunitid_value eq null`);
    const rootBu = root.value && root.value[0];
    out.rootBusinessUnit = rootBu ? rootBu.name : root;

    if (rootBu) {
      const rr = await get(`roles?$select=roleid,name&$filter=${enc(`name eq '${q(ROLE)}' and _businessunitid_value eq ${rootBu.businessunitid}`)}`);
      const rootRole = rr.value && rr.value[0];
      out.mainRole = rootRole ? { id: rootRole.roleid, ...(await privs(rootRole.roleid)) } : (rr.error ? rr : 'not found in the top-level business unit');
    }

    if (who) {
      const users = await get(`systemusers?$select=systemuserid,fullname,domainname,accessmode,_businessunitid_value&$filter=${enc(`contains(domainname,'${q(who)}')`)}`);
      out.users = users.error ? users : [];
      if (!users.error) for (const u of users.value) {
        const ur = await get(`systemusers(${u.systemuserid})/systemuserroles_association?$select=roleid,name,_businessunitid_value`);
        const roles = ur.error ? ur : await Promise.all(ur.value.map(async r => ({
          name: r.name, id: r.roleid,
          ...(r.name === ROLE ? await privs(r.roleid) : {}),
        })));
        out.users.push({ name: u.fullname, domain: u.domainname, accessMode: MODES[u.accessmode] || u.accessmode, roles });
      }
    }
  } catch (e) { out.stoppedAt = e.message; }
  const text = JSON.stringify(out, null, 1);
  console.log(text);
  try { copy(text); console.log('Copied to clipboard.'); } catch (e) { console.log('Select the text above and copy it.'); }
})();
