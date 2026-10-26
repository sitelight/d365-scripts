# d365-scripts

Browser-console scripts for Dynamics 365 Customer Engagement (on-premises) 9.x.

| File | What it does |
|---|---|
| `check.js` | Read-only. Reports the signed-in user's access mode, entity metadata and privileges (account, lead, queue, queue item), and the privileges of roles whose name contains "EWS". GET requests only. |
| `create-role.UNTESTED.js` | **Untested.** Creates a least-privilege security role and optionally assigns it to a user. Dry run by default; changes nothing until `DRY_RUN = false`. |

Use: sign in to the CRM in the browser, press F12, open the Console tab, paste the file's contents and press Enter.
