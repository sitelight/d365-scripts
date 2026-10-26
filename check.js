/* READ-ONLY check (GET requests only, changes nothing).
 * Sign in to the CRM in the browser, press F12, open Console, paste, press Enter.
 * The result is printed and copied to the clipboard. */
(async () => {
  const API = location.origin + '/api/data/v9.1/';
  const H = { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };
  const get = async p => {
    const r = await fetch(API + p, { headers: H, credentials: 'include' });
    const t = await r.text();
    if (!r.ok) return { error: r.status, detail: t.slice(0, 200) };
    return JSON.parse(t);
  };
  const label = d => d && d.UserLocalizedLabel ? d.UserLocalizedLabel.Label : null;
  const MODES = { 0: 'Read-Write', 1: 'Administrative', 2: 'Read', 3: 'Support User', 4: 'Non-interactive', 5: 'Delegated Admin' };
  const out = {};
  try {
    // 1. Who is signed in
    const me = await get('WhoAmI');
    const meUser = await get(`systemusers(${me.UserId})?$select=fullname,domainname,accessmode`);
    out.signedInAs = { name: meUser.fullname, domain: meUser.domainname, accessMode: MODES[meUser.accessmode] || meUser.accessmode };

    // 2-4. Entity metadata: standard account, lead, queue, queue item (with their privileges)
    for (const e of ['account', 'lead', 'queue', 'queueitem']) {
      const m = await get(`EntityDefinitions(LogicalName='${e}')?$select=LogicalName,SchemaName,DisplayName,IsCustomizable,OwnershipType,Privileges`);
      out[e] = m.error ? m : {
        displayName: label(m.DisplayName), schema: m.SchemaName, ownership: m.OwnershipType,
        privileges: (m.Privileges || []).map(p => p.Name),
      };
    }

    // 3. Custom entities whose name looks like "account"
    const all = await get('EntityDefinitions?$select=LogicalName,DisplayName,IsCustomEntity');
    out.customAccountLike = all.error ? all : all.value
      .filter(x => x.IsCustomEntity && (/account/i.test(x.LogicalName) || /account/i.test(label(x.DisplayName) || '')))
      .map(x => ({ logical: x.LogicalName, displayName: label(x.DisplayName) }));

    // 5. The role Adam created, and its privileges with depth
    const roles = await get(`roles?$select=roleid,name,_businessunitid_value&$filter=${encodeURIComponent("contains(name,'EWS')")}`);
    out.roles = roles.error ? roles : roles.value.map(r => ({ id: r.roleid, name: r.name, bu: r._businessunitid_value }));
    if (!roles.error && roles.value.length) {
      const rid = roles.value[0].roleid;
      const names = await get(`roles(${rid})/roleprivileges_association?$select=privilegeid,name`);
      const depth = await get(`roles(${rid})/Microsoft.Dynamics.CRM.RetrieveRolePrivilegesRole()`);
      const byId = {};
      if (!names.error) names.value.forEach(p => { byId[p.privilegeid] = p.name; });
      out.rolePrivileges = depth.error || !depth.RolePrivileges
        ? (names.error ? names : names.value.map(p => p.name).sort())
        : depth.RolePrivileges.map(p => `${byId[p.PrivilegeId] || p.PrivilegeId}:${p.Depth}`).sort();
    }

    // 6. The CRM.EWS user, its access mode and roles
    const users = await get(`systemusers?$select=systemuserid,fullname,domainname,accessmode,isdisabled&$filter=${encodeURIComponent("contains(domainname,'EWS')")}`);
    out.serviceUsers = users.error ? users : [];
    if (!users.error) for (const u of users.value) {
      const ur = await get(`systemusers(${u.systemuserid})/systemuserroles_association?$select=name`);
      out.serviceUsers.push({ name: u.fullname, domain: u.domainname, accessMode: MODES[u.accessmode] || u.accessmode, disabled: u.isdisabled, roles: ur.error ? ur : ur.value.map(r => r.name) });
    }
  } catch (e) { out.stoppedAt = e.message; }
  const text = JSON.stringify(out, null, 1);
  console.log(text);
  try { copy(text); console.log('Copied to clipboard.'); } catch (e) { console.log('Select the text above and copy it.'); }
})();
