/*
 * ============================================================================
 *  UNTESTED DRAFT. Not yet run against a live CRM. Review before use.
 * ============================================================================
 *
 *  Creates the "EWS Graph Middleware" security role in Dynamics 365 CE 9.1
 *  (on-premises), all privileges at Organization level, and optionally assigns
 *  it to the middleware service account with access mode Read-Write.
 *
 *  Why not Azure CLI: az manages Azure resources only. This role lives in the
 *  on-premises CRM, so the script calls the CRM's own Web API instead.
 *
 *  How to run
 *  1. Sign in to the CRM in the browser as a System Administrator.
 *  2. Press F12, open the Console tab, paste this whole script, press Enter.
 *  3. It runs in DRY RUN mode first: it only reads, and prints what it would do.
 *  4. Check the output. To apply, set DRY_RUN = false below and run it again.
 *     Running it again later is safe: an existing role is reused, not duplicated.
 *
 *  What it grants (Organization level). No Delete, no Share, no admin rights.
 *    Activity (covers email, appointment, task): Create, Read, Write, Append, Append To, Assign
 *    Contact: Read, Write, Append To            (never Create)
 *    Account, Lead: Read, Append To
 *    Queue: Read, Append To
 *    Queue Item: Create, Read, Append
 *    User, Team, Organization: Read
 *  It also lists any attachment-related privileges the org exposes, for review;
 *  it does not grant those automatically.
 */
(async () => {
  // ---- settings -------------------------------------------------------------
  const DRY_RUN = true;                    // set to false to apply
  const ROLE_NAME = 'EWS Graph Middleware';
  const SERVICE_ACCOUNT = '';              // e.g. 'DOMAIN\\svc-account' as shown in the user's Domain Name; '' skips assignment
  // ---------------------------------------------------------------------------

  const API = location.origin + '/api/data/v9.1/';
  const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
  };
  const PRIVILEGES = [
    'prvCreateActivity', 'prvReadActivity', 'prvWriteActivity',
    'prvAppendActivity', 'prvAppendToActivity', 'prvAssignActivity',
    'prvReadContact', 'prvWriteContact', 'prvAppendToContact',
    'prvReadAccount', 'prvAppendToAccount',
    'prvReadLead', 'prvAppendToLead',
    'prvReadQueue', 'prvAppendToQueue',
    'prvCreateQueueItem', 'prvReadQueueItem', 'prvAppendQueueItem',
    'prvReadUser', 'prvReadTeam', 'prvReadOrganization',
  ];

  const q = s => String(s).replace(/'/g, "''");
  async function call(method, path, body, extra) {
    const r = await fetch(API + path, {
      method, credentials: 'include',
      headers: { ...HEADERS, ...(extra || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 600)}`);
    return { json: text ? JSON.parse(text) : null, headers: r.headers };
  }
  const get = async path => (await call('GET', path)).json;

  try {
    console.log(`%c${DRY_RUN ? 'DRY RUN: nothing will be changed' : 'APPLY MODE'}`, 'font-weight:bold;font-size:14px');

    // 1. Who is running this, and the top-level business unit.
    const me = await get('WhoAmI');
    const rootBu = (await get(`businessunits?$select=businessunitid,name&$filter=_parentbusinessunitid_value eq null`)).value[0];
    console.log('Signed in as user', me.UserId, '| top-level business unit:', rootBu.name, rootBu.businessunitid);

    // 2. Resolve each privilege name to its id.
    const found = [];
    for (let i = 0; i < PRIVILEGES.length; i += 10) {
      const chunk = PRIVILEGES.slice(i, i + 10);
      const filter = chunk.map(n => `name eq '${q(n)}'`).join(' or ');
      const res = await get(`privileges?$select=privilegeid,name&$filter=${encodeURIComponent(filter)}`);
      found.push(...res.value);
    }
    const missing = PRIVILEGES.filter(n => !found.some(p => p.name.toLowerCase() === n.toLowerCase()));
    console.table(PRIVILEGES.map(n => ({ privilege: n, found: !missing.includes(n) })));
    if (missing.length) console.warn('Not found in this org (skipped, please review):', missing);

    // 3. Attachment-related privileges, for review only.
    try {
      const att = await get(`privileges?$select=name&$filter=${encodeURIComponent("contains(name,'Attachment')")}`);
      console.log('Attachment-related privileges in this org (not granted, review only):', att.value.map(p => p.name));
    } catch (e) { console.warn('Could not list attachment privileges:', e.message); }

    // 4. Existing role in the top-level business unit?
    const existing = (await get(`roles?$select=roleid,name&$filter=name eq '${q(ROLE_NAME)}' and _businessunitid_value eq ${rootBu.businessunitid}`)).value[0];
    console.log(existing ? `Role "${ROLE_NAME}" already exists: ${existing.roleid} (will be reused)` : `Role "${ROLE_NAME}" does not exist yet (will be created)`);

    // 5. Service account, if given.
    let user = null;
    if (SERVICE_ACCOUNT) {
      user = (await get(`systemusers?$select=systemuserid,fullname,domainname,accessmode,isdisabled,_businessunitid_value&$filter=domainname eq '${q(SERVICE_ACCOUNT)}'`)).value[0];
      if (!user) console.warn(`No CRM user with Domain Name "${SERVICE_ACCOUNT}". Add the user first, then run again.`);
      else console.log('Service account:', user.fullname, user.domainname, '| access mode now:', user.accessmode, '(0 = Read-Write) | disabled:', user.isdisabled);
    }

    if (DRY_RUN) {
      console.log(`%cDry run complete. Would grant ${found.length} privileges at Organization level${user ? ', set access mode Read-Write and assign the role' : ''}. Set DRY_RUN = false to apply.`, 'font-weight:bold');
      return;
    }

    // 6. Create the role (or reuse it).
    let roleId = existing && existing.roleid;
    if (!roleId) {
      const created = await call('POST', 'roles',
        { name: ROLE_NAME, 'businessunitid@odata.bind': `/businessunits(${rootBu.businessunitid})` },
        { 'Prefer': 'return=representation' });
      roleId = (created.json && created.json.roleid)
        || (created.headers.get('OData-EntityId') || '').match(/\(([0-9a-f-]{36})\)/i)[1];
      console.log('Created role', roleId);
    }

    // 7. Add the privileges, all at Organization level ("Global").
    await call('POST', `roles(${roleId})/Microsoft.Dynamics.CRM.AddPrivilegesRole`, {
      Privileges: found.map(p => ({ Depth: 'Global', PrivilegeId: p.privilegeid, BusinessUnitId: rootBu.businessunitid })),
    });
    console.log(`Granted ${found.length} privileges at Organization level`);

    // 8. Access mode and role assignment for the service account.
    if (user) {
      await call('PATCH', `systemusers(${user.systemuserid})`, { accessmode: 0 });
      console.log('Access mode set to Read-Write (0)');
      // A role is copied into every business unit; assign the copy in the user's own business unit.
      const userRole = (await get(`roles?$select=roleid&$filter=name eq '${q(ROLE_NAME)}' and _businessunitid_value eq ${user._businessunitid_value}`)).value[0];
      if (!userRole) throw new Error("Role copy not found in the user's business unit");
      try {
        await call('POST', `systemusers(${user.systemuserid})/systemuserroles_association/$ref`, { '@odata.id': `${API}roles(${userRole.roleid})` });
        console.log('Role assigned to', user.domainname);
      } catch (e) {
        if (/duplicate|already/i.test(e.message)) console.log('Role was already assigned');
        else throw e;
      }
    }

    // 9. Read back what the role now holds.
    const now = await get(`roles(${roleId})/roleprivileges_association?$select=name`);
    console.log(`%cDone. Role "${ROLE_NAME}" now holds ${now.value.length} privileges:`, 'font-weight:bold', now.value.map(p => p.name).sort());
  } catch (e) {
    console.error('Stopped:', e.message);
  }
})();
