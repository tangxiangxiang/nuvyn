# Diary

Diary is a first-level Workspace in Nuvyn Personal OS, specialized for time and
personal experience. Use the Calendar to find a day, then open that date in the
same reading and editing experience used by ordinary Nuvyn documents.

## Calendar Home

Calendar Home is the Diary starting point and navigation center.

- Use the previous and next month buttons to change the visible month.
- The current local civil date is marked as Today when its month is visible.
- A date with an existing Diary shows its Mood marker when one is set.
- Click a date to open its Diary. Existing dates open directly.
- A missing today or past date asks for a Mood first. Choosing a Mood creates
  the date and then opens the new Diary; cancelling leaves the date untouched.
- A missing future date is not created until that date arrives.

Diary dates use the `YYYY-MM-DD` identity shown by the Calendar. Changing the
month does not change the identity of an existing entry.

## Opening and closing a Diary

Opening a date takes you to a native Nuvyn document tab. The Diary document
uses Nuvyn's normal Read and Edit surfaces, save behavior, and workspace tab
controls.

Return from the active document with its tab close button, or use the Diary
shortcut:

```text
G, then B — return to Diary Calendar Home
```

Press the two keys in order within a short interval; do not hold them at the
same time. The shortcut works only while a Diary document is active. It does
nothing on Calendar Home, in another workspace, or while focus is in a text
editor/input context. It follows the same workspace-tab close and unsaved-change
policy as the tab close button: returning to Calendar Home clears the old date
selection and keeps the visible month and Mood markers.

Unsaved changes continue to use Nuvyn's existing close confirmation/save policy.
The shortcut does not bypass that protection.

## Mood

Mood is a small piece of metadata attached to a Diary date; it is separate from
the Diary body.

To view or change it, use the Mood control in the date cell and choose an
available icon. Use **Clear mood** to remove it. The Calendar updates the
marker after the metadata change succeeds. Mood remains associated with the
date when you close, reopen, change months, or refresh the page.

For a missing today or past date, selecting a Mood is the first step that
creates the Diary. If you cancel the picker, no Diary is created.

## Editing and saving

Diary content is a normal Nuvyn Markdown document. Use Read mode to read it and
Edit mode to change it. Nuvyn's existing save, dirty-state, conflict, and
workspace lifecycle apply.

Some generic surfaces that would expose a protected encrypted Diary body are
intentionally unavailable unless they have an adapter-aware privacy path.
This does not change the normal Diary read/edit experience.

## Protected Diary access

Diary has a separate access password in addition to the Nuvyn owner login.
The first visit asks you to set it up; later visits ask you to unlock Diary.
Locking Diary is available from the Nuvyn navigation controls. Locking or an
expired session removes access to protected Diary bodies until you unlock
again.

If Nuvyn finds legacy Diary data, the Settings migration section shows an
explicit scan and the required next action. Depending on the platform, Nuvyn
may prepare an encrypted candidate for you to replace manually and then ask
you to resume verification. Do not delete the original until Nuvyn reports
that the migration state is safe.
