/**
 * Exports Google Tasks to a JSON file in Drive, where the briefing agent can read it.
 *
 * Google Tasks has no Codex connector, Google publishes no Tasks MCP server, and the
 * Calendar API never returns tasks even though they render in the Calendar UI — so the
 * Tasks API is the only way in. Reaching it from the laptop needs an OAuth client in a
 * Cloud project, which needs project-creation rights many corporate Google orgs
 * simply do not grant.
 *
 * An Apps Script project gets a hidden default Cloud project of its own, and enabling
 * the Tasks advanced service from the editor enables the API inside it. So this runs as
 * the user, inside Google, and hands the result over through Drive: no OAuth client, no
 * credentials on the laptop, nothing for IT to approve.
 *
 * Deployed by hand — this copy is the source of truth. See ./README.md.
 */

/** Replaced in place every run, so the agent only ever has one filename to look for. */
const OUTPUT_FILE = 'daily-focus-tasks.json';

/**
 * Reads every task list and writes the open tasks to Drive as JSON.
 *
 * Completed, hidden and deleted tasks are left out. What counts as handled is decided
 * by the dashboard's action log, not by this file, and a task already ticked off in
 * Google Tasks is not news either way.
 */
function exportTasks() {
  const lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  const snapshot = { generatedAt: new Date().toISOString(), lists: [], tasks: [] };

  for (const list of lists) {
    snapshot.lists.push({ id: list.id, title: list.title });

    let pageToken;
    do {
      const page = Tasks.Tasks.list(list.id, {
        showCompleted: false,
        showHidden: false,
        showDeleted: false,
        // Off by default, which silently drops anything assigned to them from a Doc or
        // a Chat space — work they are on the hook for and didn't type themselves.
        showAssigned: true,
        maxResults: 100,
        pageToken,
      });

      for (const task of page.items || []) {
        snapshot.tasks.push({
          id: task.id,
          listId: list.id,
          listTitle: list.title,
          title: task.title,
          notes: task.notes || undefined,
          // Date-only, despite being formatted as a timestamp: this API discards the
          // time component on write. Nothing downstream may state an hour from it.
          due: task.due || undefined,
          updated: task.updated,
          parent: task.parent || undefined,
          status: task.status,
          webViewLink: task.webViewLink || undefined,
          // Assigned tasks come from a Doc comment or a Chat message, and that surface —
          // not the Tasks UI — is where the actual work and the person asking are.
          assignedFrom: task.assignmentInfo
            ? {
                surface: task.assignmentInfo.surfaceType,
                link: task.assignmentInfo.linkToTask,
              }
            : undefined,
        });
      }

      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  writeSnapshot(JSON.stringify(snapshot, null, 2));
  return snapshot.tasks.length;
}

/** One file, overwritten, so no second copy can accumulate for the agent to read by mistake. */
function writeSnapshot(json) {
  const existing = DriveApp.getFilesByName(OUTPUT_FILE);
  if (existing.hasNext()) {
    const file = existing.next();
    file.setContent(json);
    return file.getId();
  }
  return DriveApp.createFile(OUTPUT_FILE, json, MimeType.PLAIN_TEXT).getId();
}

/**
 * Run once, by hand, to schedule the export.
 *
 * Hourly rather than once before the brief: Apps Script randomises the hour a daily
 * trigger fires in, so a "06:00" job can land at 07:00 — after the brief has already
 * read the file. Hourly makes the worst case an hour of staleness instead of a day
 * with no tasks in it at all.
 */
function installTrigger() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'exportTasks') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('exportTasks').timeBased().everyHours(1).create();
}
