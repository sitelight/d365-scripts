/* READ-ONLY (GET requests only, changes nothing). Lists the privileges of the
 * "EWS Graph Middleware" role in the top-level business unit, with their depth.
 * Sign in to the CRM in the browser, press F12, open Console, paste, press Enter. */
(async () => {
  const ROLE = 'EWS Graph Middleware';
  const API = location.origin + '/api/data/v9.1/';
  const H = { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };
  const enc = encodeURIComponent, q = s => String(s).replace(/'/g, "''");
  const get = async p => {
    const r = await fetch(API + p, { headers: H, credentials: 'include' });
    const t = await r.text();
    if (!r.ok) return { error: r.status, detail: t.slice(0, 300) };
    return t ? JSON.parse(t) : {};
  };
  const out = {};
  try {
    const root = (await get(`businessunits?$select=businessunitid&$filter=_parentbusinessunitid_value eq null`)).value[0];
    const role = (await get(`roles?$select=roleid&$filter=${enc(`name eq '${q(ROLE)}' and _businessunitid_value eq ${root.businessunitid}`)}`)).value[0];
    out.roleId = role.roleid;
    // privilege names on the role
    const names = await get(`roles(${role.roleid})/roleprivileges_association?$select=privilegeid,name`);
    const byId = {};
    if (!names.error) names.value.forEach(p => { byId[p.privilegeid] = p.name; });
    out.nameCount = names.error ? names : names.value.length;
    // depth per privilege (unbound function on 9.x on-premises)
    const d = await get(`RetrieveRolePrivilegesRole(RoleId=@p1)?@p1=${role.roleid}`);
    if (d.error || !d.RolePrivileges) {
      out.depthError = d;
      out.privileges = names.error ? [] : names.value.map(p => p.name).sort();
    } else {
      const missing = d.RolePrivileges.map(p => p.PrivilegeId).filter(id => !byId[id]);
      for (let i = 0; i < missing.length; i += 15) {
        const f = missing.slice(i, i + 15).map(id => `privilegeid eq ${id}`).join(' or ');
        const r = await get(`privileges?$select=privilegeid,name&$filter=${enc(f)}`);
        if (!r.error) r.value.forEach(p => { byId[p.privilegeid] = p.name; });
      }
      out.privileges = d.RolePrivileges.map(p => `${byId[p.PrivilegeId] || p.PrivilegeId}:${p.Depth}`).sort();
    }
  } catch (e) { out.stoppedAt = e.message; }
  const text = JSON.stringify(out, null, 1);
  console.log(text);
  try { copy(text); console.log('Copied to clipboard.'); } catch (e) { console.log('Select the text above and copy it.'); }
})();
