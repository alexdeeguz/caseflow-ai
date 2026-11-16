# Users and cases

[Back to README](../README.md)

CaseFlow uses one shared fictional workspace. Application roles and case assignments control access after Microsoft sign-in.

## Roles and administration

| Capability                              | Staff                 | Admin                 | Super Admin           |
| --------------------------------------- | --------------------- | --------------------- | --------------------- |
| Edit own display name                   | Yes                   | Yes                   | Yes                   |
| View cases                              | Assigned only         | All                   | All                   |
| Create cases                            | No                    | Yes                   | Yes                   |
| Edit details/status or archive/restore  | No                    | Yes                   | Yes                   |
| View archived cases                     | Assigned only         | All                   | All                   |
| Assign/remove Staff                     | No                    | Yes                   | Yes                   |
| Enable/disable Staff                    | No                    | Yes                   | Yes                   |
| Promote/demote or enable/disable Admins | No                    | No                    | Yes                   |
| View audit history                      | No                    | Yes                   | Yes                   |
| Grant/remove Super Admin                | Operator command only | Operator command only | Operator command only |

New users start as active Staff with no assignments. Super Admin changes use an
audited operator-only function, identified by application user ID rather than email
or display name. It rejects disabled targets and removal of the last active Super Admin.
The web app cannot change a Super Admin's role or access status; they can still edit
their own display name. Local operator tooling is covered by
[development](development.md#local-role-administration).

Admins manage Staff access; Super Admins also manage Admin access. Demotion retains
explicit assignments. Disabling blocks protected endpoints while retaining those
assignments. New assignments require active Staff. Existing assignments to promoted
Admins are retained and can be managed again after demotion.

Permission mutations use a transaction-scoped advisory lock shared with operator
commands, then reload authorization and commit the mutation and audit together.
This serializes the demo's small administration workload; ordinary reads remain
concurrent. New authorization checks observe committed permission changes. Data
already delivered to a browser cannot be recalled.

## Creating and viewing cases

Admin and Super Admin users can choose **Create case** in the Cases workspace.
The form requires a case title (up to 200 characters) and fictional client name
(up to 100). Incident date and summary (up to 2,000 characters) are optional.
Status defaults to Intake; Active and Closed are also available at creation.
Admin and Super Admin users can edit all five fields and move freely between the three statuses.

The server generates the UUID, case number, creation time, and creator identity.
Case numbers use a database sequence, such as `CF-000001`; gaps are expected after
rollbacks or repeated seed runs. New cases have no Staff assignments. After saving,
the case details screen provides the existing assignment controls.

The case list supports case-insensitive literal substring search across case number,
title, and client name, plus status and Current / Archived / All filters (Current by default). Results and totals obey case permissions
and are ordered newest first, with UUID as a stable tie-breaker. Incident dates are
calendar dates, so they do not shift with the viewer's time zone.

Case-list filters apply immediately; search updates after a 300 ms typing pause.
Changing filters resets pagination, and automatic updates replace the current URL entry.

Workspace URLs retain the selected tab, case, search, status, archive filter, and page, allowing
bookmarks, refresh, and browser Back/Forward. Add `mode=edit` to a case URL to open its edit form. Form drafts are not stored in URLs.
The desktop list uses a table; narrow screens use case cards.

The additive case schema preserves profiles, case IDs, assignments, and audit history.
Legacy cases have no recorded creator; newly created cases always do.

## Editing, archiving, and restoring cases

Choose **Edit case** on current case details. IDs, case numbers, creators, and creation
times are immutable. Unsaved edits remain in memory while navigating within the same
user/role workspace. Background refreshes retain dirty fields. Saving or explicitly
discarding clears the draft; sign-out or loss of access also clears protected drafts.
Refreshing or closing a page with unsaved edits triggers the browser's leave-page warning;
drafts do not survive a reload and are never written to browser storage.

Concurrent mutations use an `expectedVersion` check after locking the case row and
rechecking the actor under the permission lock. A conflict retains the edit draft and
requires an explicit, confirmed reload of the latest saved case. It never merges or
retries an outdated edit automatically. No-op requests leave the version, timestamp,
and audit history unchanged.

**Archive case** opens an in-app confirmation modal naming the case. Archiving preserves
its Intake/Active/Closed status, data, assignments, and history. Archived case details
are read-only until **Restore case** is used. Assigned Staff can still read archived
cases, and administrators can manage assignments while archived. Saved detail links
continue to work regardless of the list filter. There is no permanent deletion.

Successful case, profile, role, access, and assignment changes use shared toast
notifications. Toasts dismiss automatically, pause while hovered or focused, and have
a keyboard-accessible dismiss button. Errors remain beside the relevant controls.
Confirmation dialogs contain keyboard focus, support Escape, and return focus to the
trigger when closed. Existing case metadata starts at version 1 with `updatedAt`
equal to the original creation time.

## Related guides

- [Authentication](authentication.md)
- [API reference](api.md)
- [Document management](document-management.md)
