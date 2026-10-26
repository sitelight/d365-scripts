# d365-scripts

Browser-console scripts for Dynamics 365 Customer Engagement (on-premises) 9.x.

| File | What it does |
|---|---|
| `check.js` | Read-only. Reports the signed-in user's access mode, entity metadata and privileges (account, lead, queue, queue item), and the privileges of roles whose name contains "EWS". GET requests only. |
| `check2.js` | Read-only. Reads the role in the top-level business unit and the copy assigned to a given user, with each privilege's depth. Asks for the user's domain name. |
| `check3.js` | Read-only. Lists the privileges and depth of the EWS Graph Middleware role in the top-level business unit. |
| `check4.js` | Read-only. Finds users whose name contains a term (default "test") with email, access mode and mailbox sync settings. |
| `create-role.UNTESTED.js` | **Untested.** Creates a least-privilege security role and optionally assigns it to a user. Dry run by default; changes nothing until `DRY_RUN = false`. |

Use: sign in to the CRM in the browser, press F12, open the Console tab, paste the file's contents and press Enter.
