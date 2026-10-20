/**
 * The settings page: what can be changed from the dashboard, how each setting is
 * shown, and how a change is checked before it is saved.
 *
 * Every setting `config.ts` reads is kept in the store's `settings.json`, under
 * the name it is read by, and this page is how it gets there. This table adds
 * only what a page needs that a name can't say: a label, a line of help, what
 * kind of field it is, and its default in words. `test/docs-contract.test.ts`
 * checks that every name `config.ts` reads is either here or a launch setting,
 * so a new one can't be left off the page.
 *
 * A change is checked by building the whole config from it, the way the next
 * start will. A value the dashboard would refuse to start with is refused here
 * instead, while the page that can fix it is still open.
 */

import { DEFAULT_MERGE_GATE_REVIEWS, loadConfig, PROFILES, type Profile } from './config.ts';
import { layerSettings, LAUNCH_SETTINGS, PROFILE_SETTING, type SettingSources } from './env.ts';
import { asProfile } from './stores.ts';
import { writeJsonAtomic } from './fs.ts';

export type SettingGroup = 'instance' | 'agent' | 'assistant' | 'github' | 'jira' | 'calendar' | 'day';

export const SETTING_GROUPS: readonly { id: SettingGroup; title: string }[] = [
  { id: 'instance', title: 'This dashboard' },
  { id: 'agent', title: 'Morning agent' },
  { id: 'assistant', title: 'Assistant' },
  { id: 'github', title: 'Pull requests' },
  { id: 'jira', title: 'Jira tickets' },
  { id: 'calendar', title: 'Calendar' },
  { id: 'day', title: 'Working day' },
];

export interface SettingChoice {
  value: string;
  label: string;
}

/**
 * What kind of field a setting is. Lists are comma-separated text, since
 * several of them hold names with spaces in.
 */
export type SettingKind = 'choice' | 'flag' | 'text' | 'number' | 'list' | 'time';

export interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
  kind: SettingKind;
  choices?: readonly SettingChoice[];
  /** The default, in words, for an instance with this profile. */
  fallback: (profile: Profile) => string;
  /** Folded away on the page: paths, poll intervals and lists most people never touch. */
  advanced?: boolean;
}

const OFF_OR_CLI: readonly SettingChoice[] = [
  { value: 'off', label: 'Off' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
];

const EFFORTS: readonly SettingChoice[] = ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value }));

const always = (text: string) => () => text;

export const SETTINGS: readonly SettingDef[] = [
  {
    key: 'DAILY_FOCUS_PROFILE',
    group: 'instance',
    label: 'What this dashboard briefs',
    help:
      'Work or home, chosen at setup. It names the folder this store is in, and picks the morning prompt and the defaults below: ' +
      'the personal profile switches off Jira and free time. To brief the other as well, run a second dashboard beside this one.',
    kind: 'choice',
    choices: PROFILES.map((value) => ({ value, label: value === 'work' ? 'Work' : 'Personal life' })),
    fallback: always('Work'),
  },

  {
    key: 'DAILY_FOCUS_AGENT',
    group: 'agent',
    label: 'Write the brief with',
    help: 'The coding-agent CLI the dashboard runs each morning to write your brief. It has to be installed and logged in.',
    kind: 'choice',
    choices: OFF_OR_CLI,
    fallback: always('Off'),
  },
  {
    key: 'DAILY_FOCUS_AGENT_AT',
    group: 'agent',
    label: 'Run it at',
    help: 'Local time, such as 06:30, or off to run it only when you press refresh. If the dashboard was off at that time, it runs when it next starts that day.',
    kind: 'time',
    fallback: always('07:00'),
  },
  {
    key: 'DAILY_FOCUS_AGENT_DAYS',
    group: 'agent',
    label: 'On these days',
    help: 'Cron-style weekday numbers: 1-5 is Monday to Friday, 0-4 is Sunday to Thursday, 0,6 is the weekend.',
    kind: 'text',
    fallback: always('1-5, Monday to Friday'),
  },
  {
    key: 'DAILY_FOCUS_AGENT_MODEL',
    group: 'agent',
    label: 'Model',
    help: "Passed to the CLI as it is, such as opus for Claude Code. Empty uses the CLI's own default.",
    kind: 'text',
    fallback: always("The CLI's own"),
  },
  {
    key: 'DAILY_FOCUS_AGENT_EFFORT',
    group: 'agent',
    label: 'Effort',
    help: 'A brief is worth a high effort.',
    kind: 'choice',
    choices: EFFORTS,
    fallback: always("The CLI's own"),
  },
  {
    key: 'DAILY_FOCUS_AGENT_SEARCH_TRASH',
    group: 'agent',
    label: 'Search deleted mail',
    help: 'Lets the agent look in your mail’s Trash as well as the inbox and archive. Off, it leaves out what you deleted.',
    kind: 'flag',
    fallback: always('Off'),
  },
  {
    key: 'DAILY_FOCUS_AGENT_TOOLS',
    group: 'agent',
    label: 'Tools Claude Code may use',
    help: "In Claude Code's permission syntax, comma-separated. Add your calendar, chat and document connectors by name, or the brief reports them as unreachable. The default allows every Gmail tool, sending included; name the tools you want instead to narrow it. Ignored by Codex.",
    kind: 'list',
    fallback: always('Bash(gh *), Bash(acli *), WebFetch, mcp__claude_ai_Gmail'),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_AGENT_BIN',
    group: 'agent',
    label: 'Path to the CLI',
    help: "Only needed when the dashboard can't find the CLI on its own.",
    kind: 'text',
    fallback: always('Found on PATH'),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_STALE_AFTER_HOURS',
    group: 'agent',
    label: 'Expect a new brief every',
    help: 'Hours, counted only on the days above. After that, and 45 minutes more, the page says the agent may not have run.',
    kind: 'number',
    fallback: always('24 hours'),
    advanced: true,
  },

  {
    key: 'DAILY_FOCUS_ASSISTANT',
    group: 'assistant',
    label: 'Answer questions with',
    help: "Puts an assistant in every item's panel, told to read and draft and never to send, post or edit. Under Codex, every connector write but a Gmail draft is refused.",
    kind: 'choice',
    choices: OFF_OR_CLI,
    fallback: always('Off'),
  },
  {
    key: 'DAILY_FOCUS_ASSISTANT_MODEL',
    group: 'assistant',
    label: 'Model',
    help: "Passed to the CLI as it is. Empty uses the CLI's own default.",
    kind: 'text',
    fallback: always("The CLI's own"),
  },
  {
    key: 'DAILY_FOCUS_ASSISTANT_EFFORT',
    group: 'assistant',
    label: 'Effort',
    help: 'Passed to the CLI as it is.',
    kind: 'choice',
    choices: EFFORTS,
    fallback: always("The CLI's own"),
  },
  {
    key: 'DAILY_FOCUS_ASSISTANT_TOOLS',
    group: 'assistant',
    label: 'Tools Claude Code may use',
    help: "In Claude Code's permission syntax, comma-separated. Editing tools are denied whatever this says. The default allows every Gmail tool, sending included; name the tools you want instead to narrow it. Ignored by Codex.",
    kind: 'list',
    fallback: always('Bash(gh *), Bash(acli *), WebFetch, mcp__claude_ai_Gmail'),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_ASSISTANT_COMPUTER_USE',
    group: 'assistant',
    label: 'Computer use',
    help: "Codex only. On lets the assistant use Codex's computer-use and browser plugins, which act in your apps and browser with your sign-ins. Off switches them off for its runs. Claude Code uses only the tools in its list.",
    kind: 'flag',
    fallback: always('Off'),
  },
  {
    key: 'DAILY_FOCUS_ASSISTANT_AUTO',
    group: 'assistant',
    label: 'Answer ahead on pull requests',
    help: 'When a pull request starts waiting on you because of a review or a failing check, asks the assistant about it before you do, so the answer is on the row when you look. Only reads; it never drafts. It spends the CLI’s usage without you pressing anything.',
    kind: 'flag',
    fallback: always('Off'),
  },
  {
    key: 'DAILY_FOCUS_ASSISTANT_AUTO_LIMIT',
    group: 'assistant',
    label: 'Answer ahead at most',
    help: 'Times a day the assistant may start on its own, counted on the dashboard’s calendar.',
    kind: 'number',
    fallback: always('10 a day'),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_ASSISTANT_BIN',
    group: 'assistant',
    label: 'Path to the CLI',
    help: "Only needed when the dashboard can't find the CLI on its own.",
    kind: 'text',
    fallback: always('Found on PATH'),
    advanced: true,
  },

  {
    key: 'DAILY_FOCUS_GITHUB',
    group: 'github',
    label: 'Use GitHub',
    help: 'Your pull requests, in the brief and on their own tab, read through the GitHub CLI, gh. Off leaves GitHub out of Daily Focus. The Jira ticket board uses it too, to catch merges Jira hasn\'t heard about yet.',
    kind: 'flag',
    fallback: always('On'),
  },
  {
    key: 'DAILY_FOCUS_GITHUB_ACCOUNTS',
    group: 'github',
    label: 'Accounts',
    help: 'GitHub logins to read as, comma-separated, when gh holds more than one. Empty uses the active one.',
    kind: 'list',
    fallback: always("gh's active account"),
  },
  {
    key: 'DAILY_FOCUS_GITHUB_SCOPE',
    group: 'github',
    label: 'Only these organisations or repositories',
    help: 'Comma-separated: acme, or acme/webapp for one repository. Empty counts every pull request you have open.',
    kind: 'list',
    fallback: always('Everything'),
  },
  {
    key: 'DAILY_FOCUS_GITHUB_MERGE_GATE_CHECKS',
    group: 'github',
    label: 'Merge gate checks',
    help: "Exact names of checks that stand for a repository's whole merge policy, comma-separated. Pending ones get their own bucket, unless the gate's title says only approvals are missing.",
    kind: 'list',
    fallback: always('None'),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_GITHUB_MERGE_GATE_REVIEWS',
    group: 'github',
    label: 'Gate title for missing approvals',
    help: 'A regular expression for a merge gate title that means approvals are all it still wants, matched against the whole title, ignoring case. A pull request whose pending gates all match waits on reviewers instead. Off leaves every pending gate in its own bucket.',
    kind: 'text',
    fallback: always(DEFAULT_MERGE_GATE_REVIEWS),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_GITHUB_POLL_MINUTES',
    group: 'github',
    label: 'Read every',
    help: 'Minutes between reads while a tab is open.',
    kind: 'number',
    fallback: always('5 minutes'),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_GH',
    group: 'github',
    label: 'Path to gh',
    help: "Only needed when the dashboard can't find the GitHub CLI on its own.",
    kind: 'text',
    fallback: always('Found on PATH, else the one Daily Focus fetched'),
    advanced: true,
  },

  {
    key: 'DAILY_FOCUS_JIRA',
    group: 'jira',
    label: 'Use Jira',
    help: 'Your tickets, in the brief and on their own tab, which flags any whose status disagrees with their pull requests. Read through the Atlassian CLI, acli. Off leaves Jira out of Daily Focus.',
    kind: 'flag',
    fallback: (profile) => (profile === 'personal' ? 'Off' : 'On'),
  },
  {
    key: 'DAILY_FOCUS_JIRA_PROJECTS',
    group: 'jira',
    label: 'Only these projects',
    help: 'Project keys, comma-separated. Empty means every project you can see.',
    kind: 'list',
    fallback: always('Every project'),
  },
  {
    key: 'DAILY_FOCUS_JIRA_HOLD_STATUSES',
    group: 'jira',
    label: 'Statuses that mean on hold',
    help: 'Spelled as your Jira spells them, comma-separated, such as Blocked, On Hold. Tickets in them are not flagged for having no code linked.',
    kind: 'list',
    fallback: always('None'),
  },
  {
    key: 'DAILY_FOCUS_JIRA_IN_PROGRESS_STATUSES',
    group: 'jira',
    label: 'Statuses that mean working on it',
    help: 'What the Working on view shows, comma-separated. Use In Progress to leave out In Review.',
    kind: 'list',
    fallback: always('Everything Jira calls in progress'),
  },
  {
    key: 'DAILY_FOCUS_JIRA_SITE',
    group: 'jira',
    label: 'Atlassian site',
    help: 'The host links are built from, such as acme.atlassian.net. Empty uses the one acli signed in to.',
    kind: 'text',
    fallback: always("acli's own"),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_JIRA_POLL_MINUTES',
    group: 'jira',
    label: 'Read every',
    help: 'Minutes between reads while a tab is open.',
    kind: 'number',
    fallback: always('15 minutes'),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_ACLI',
    group: 'jira',
    label: 'Path to acli',
    help: "Only needed when the dashboard can't find the Atlassian CLI on its own.",
    kind: 'text',
    fallback: always('Found on PATH, else the one Daily Focus fetched'),
    advanced: true,
  },

  {
    key: 'DAILY_FOCUS_CALENDAR',
    group: 'calendar',
    label: 'Live agenda',
    help: "Reads today's events from Calendar.app on a Mac, so a meeting declined at eleven frees the slot. Off uses the events in the brief.",
    kind: 'flag',
    fallback: always('On'),
  },
  {
    key: 'DAILY_FOCUS_CALENDARS',
    group: 'calendar',
    label: 'Calendars',
    help: 'Names as Calendar.app shows them, comma-separated. Empty reads none, and the agenda uses the brief.',
    kind: 'list',
    fallback: always('None'),
  },
  {
    key: 'DAILY_FOCUS_CALENDAR_ADDRESSES',
    group: 'calendar',
    label: 'Your email addresses',
    help: 'Comma-separated. Used only to find your reply on an invitation, so a meeting you declined stops blocking your time.',
    kind: 'list',
    fallback: always('None'),
  },
  {
    key: 'DAILY_FOCUS_CALENDAR_POLL_MINUTES',
    group: 'calendar',
    label: 'Read every',
    help: 'Minutes between reads while a tab is open.',
    kind: 'number',
    fallback: always('5 minutes'),
    advanced: true,
  },
  {
    key: 'DAILY_FOCUS_CALENDAR_APP',
    group: 'calendar',
    label: 'Path to the calendar helper',
    help: 'Only needed to use a helper other than the Mac app’s, or the one built for this computer.',
    kind: 'text',
    fallback: always('The Mac app’s, or the built copy'),
    advanced: true,
  },

  {
    key: 'DAILY_FOCUS_FREE_WINDOWS',
    group: 'day',
    label: 'Show free time',
    help: 'Find focus windows between meetings in your working hours. Off shows events only.',
    kind: 'flag',
    fallback: (profile) => (profile === 'personal' ? 'Off' : 'On'),
  },
  {
    key: 'DAILY_FOCUS_WORK_START',
    group: 'day',
    label: 'Working day starts at',
    help: "Hour of the day, 0 to 23, when the brief doesn't say.",
    kind: 'number',
    fallback: always('9'),
  },
  {
    key: 'DAILY_FOCUS_WORK_END',
    group: 'day',
    label: 'Working day ends at',
    help: "Hour of the day, 0 to 23, when the brief doesn't say.",
    kind: 'number',
    fallback: always('17'),
  },
  {
    key: 'DAILY_FOCUS_MIN_FREE_WINDOW',
    group: 'day',
    label: 'Shortest focus window',
    help: 'Minutes a gap has to last to count as time for focused work.',
    kind: 'number',
    fallback: always('45 minutes'),
  },
];

const BY_KEY = new Map(SETTINGS.map((def) => [def.key, def]));

/** Where the value in effect came from: the page shows it, and locks a fixed one, which only the profile is. */
export type SettingSource = 'fixed' | 'settings' | 'default';

export interface SettingView {
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
  kind: SettingKind;
  choices: readonly SettingChoice[] | null;
  advanced: boolean;
  /** The value in effect, as written; null when it is the default. */
  value: string | null;
  source: SettingSource;
  fallback: string;
}

export interface SettingsView {
  groups: readonly { id: SettingGroup; title: string }[];
  settings: SettingView[];
  /** Why the store's settings file couldn't be used, when it couldn't. */
  error: string | null;
}

/** Set means present and not blank, which is what `config.ts` treats as set too. */
function present(record: Readonly<Record<string, string | undefined>>, key: string): string | null {
  const value = record[key];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/** The profile the layered values add up to, for the defaults that depend on it. */
function profileOf(sources: SettingSources, settings: Readonly<Record<string, string>> = sources.settings): Profile {
  const raw = (present(layerSettings(sources, settings), 'DAILY_FOCUS_PROFILE') ?? 'work').toLowerCase();
  return (PROFILES as readonly string[]).includes(raw) ? (raw as Profile) : 'work';
}

/** Every setting as the page shows it: what is in effect, where it came from, and what the default would be. */
export function describeSettings(sources: SettingSources): SettingsView {
  const profile = profileOf(sources);
  const settings = SETTINGS.map((def): SettingView => {
    // The store's folder says it, so it is shown but never changed here.
    const fixed = def.key === PROFILE_SETTING ? sources.store.profile : null;
    const saved = present(sources.settings, def.key);
    const [value, source]: [string | null, SettingSource] =
      fixed !== null ? [fixed, 'fixed'] : saved !== null ? [saved, 'settings'] : [null, 'default'];
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      help: def.help,
      kind: def.kind,
      choices: def.choices ?? null,
      advanced: def.advanced === true,
      value,
      source,
      fallback: def.fallback(profile),
    };
  });
  return { groups: SETTING_GROUPS, settings, error: sources.settingsError };
}

/** A save the page asked for: a value per setting, or null to go back to the default. */
export type SettingsChange = Readonly<Record<string, string | null>>;

/**
 * Apply `change` to the store's settings, or say why not. Nothing is written
 * here; the caller saves what comes back.
 *
 * A launch setting can't be changed from the page, since the value given at
 * launch would still win, and a save that changes nothing on screen would read
 * as broken. The candidate is checked by building the config from it exactly as
 * the next start will.
 *
 * The profile is saved only by the setup screen's finish (`setup`), and only
 * when none was given at launch: the next start renames the store's folder to
 * match. See `stores.ts`.
 */
export function applySettingsChange(
  sources: SettingSources,
  change: SettingsChange,
  opts: { setup?: boolean } = {},
): { settings: Record<string, string> } | { error: string } {
  const next: Record<string, string> = { ...sources.settings };
  for (const [key, raw] of Object.entries(change)) {
    if (LAUNCH_SETTINGS.includes(key)) {
      return { error: `${key} says where the store is or how the server listens, so it is given when the dashboard starts, not here` };
    }
    if (key === PROFILE_SETTING && raw !== null && !asProfile(raw)) {
      return { error: `${key} must be one of ${PROFILES.join(', ')}, got ${JSON.stringify(raw)}` };
    }
    if (key === PROFILE_SETTING && (!opts.setup || sources.store.given)) {
      if ((raw?.trim().toLowerCase() || null) === sources.store.profile) continue;
      return {
        error: sources.store.given
          ? `${key} was given when the dashboard started, so it can't be changed here`
          : `${key} is chosen at setup, so it can't be changed here; to brief the other as well, run a second dashboard`,
      };
    }
    if (!BY_KEY.has(key)) return { error: `${key} is not a setting` };
    if (raw !== null && typeof raw !== 'string') return { error: `${key} must be text, or null for the default` };
    const value = raw?.trim() ?? '';
    if (value === '') delete next[key];
    else next[key] = value;
  }
  try {
    loadConfig(layerSettings(sources, next));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { settings: next };
}

/** Write the store's settings, sorted so the file reads the way the page does and diffs cleanly. */
export async function saveSettings(path: string, settings: Readonly<Record<string, string>>): Promise<void> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(settings).sort()) sorted[key] = settings[key]!;
  await writeJsonAtomic(path, sorted);
}
