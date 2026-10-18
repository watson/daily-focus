/**
 * The questions the setup screen asks, in order, and what each answer writes.
 *
 * The dashboard owns the questions; a CLI only fills some of them in. Each
 * question draws its card from what the dashboard knows for itself (what is
 * installed, what Calendar.app has, what gh says), and the ones with an `agent`
 * part also from a proposal: a CLI session asked to look into that one question
 * and say which answer the user most likely wants (see `onboarding.ts`). What
 * the user confirms is turned into settings, the source list and the objective
 * here, so the screen, the summary sentence and the files can't disagree.
 *
 * Everything here is pure: `QuestionContext` is everything a question may read,
 * gathered by the caller.
 */

import { CLI_LABEL, CLI_PREFERENCE, LOGIN, type CliReport } from './clis.ts';
import type { CliName, Profile } from './config.ts';
import type { Identity } from './setup.ts';
import type { OnboardingCard, OnboardingChoice, OnboardingField, OnboardingOption } from './types.ts';

/** A calendar Calendar.app has, with how many events it has today, which is evidence for free. */
export interface CalendarListing {
  title: string;
  source: string;
  eventsToday: number;
}

/** How a board is doing, as the setup screen words it. */
export interface BoardHealth {
  enabled: boolean;
  fetchedAt: string | null;
  reason: string | null;
}

export interface QuestionContext {
  /** What to call the machine the dashboard runs on, for the screen's sentences: "Mac", "PC" or "computer". */
  machine: string;
  /** The profile answered, or the one in effect when it hasn't been. */
  profile: Profile;
  /**
   * Whether the profile is settled, so setup doesn't ask: given when the
   * dashboard started, or the other profile's store is already beside this one.
   */
  profileSet: boolean;
  /** The CLI answered, set, or found ready; null when there is none to run. */
  cli: CliName | null;
  /** What looking for the CLIs found, with a path the user gave folded in; null until it has looked. */
  clis: CliReport | null;
  identity: Identity;
  /**
   * What Calendar.app has. A string is why it couldn't say; null when this
   * machine has no Calendar.app, or the list hasn't been read yet.
   */
  calendars: CalendarListing[] | string | null;
  calendar: { supported: boolean; built: boolean; buildCommand: string };
  boards: { github: BoardHealth; jira: BoardHealth };
  /** Every setting's value in effect now, from wherever it came. */
  current: Readonly<Record<string, string>>;
  /** The proposal each step's CLI session settled on, parsed but not trusted. */
  proposals: Readonly<Record<string, unknown>>;
}

/** An answer that was given rather than put off. */
export interface Chosen {
  choices: Record<string, string[]>;
  fields: Record<string, string>;
}

/** A section of the source list, which the finish puts together in order. */
export interface SourcesSection {
  heading: string;
  body: string;
}

/** A card as a question draws it; the version and whether it can be revised are the caller's. */
export type DrawnCard = Omit<OnboardingCard, 'version' | 'revisable' | 'later'>;

export interface Question {
  id: string;
  title(ctx: QuestionContext): string;
  /** What it is about, in a few words, for a list of what is still to come: "your calendars". */
  topic: string;
  /** Whether the question is asked at all, given the answers so far. */
  applies?(ctx: QuestionContext): boolean;
  /**
   * How the question can be left, when it can: the button, named for what it
   * does, and the sentence the thread says afterwards. Null where Continue
   * already says "nothing", with a list left unticked or a field left empty.
   */
  later: { label: string; summary: string } | null;
  card(ctx: QuestionContext): DrawnCard;
  summary(answer: Chosen, ctx: QuestionContext): string;
  settings?(answer: Chosen, ctx: QuestionContext): Record<string, string | null>;
  sources?(answer: Chosen, ctx: QuestionContext): SourcesSection[];
  /** For the objective: what goes in `focus.md`. */
  objective?(answer: Chosen): { objective: string; blocker: string | null } | null;
  /**
   * A CLI looks into this question as soon as the CLI and the profile are
   * known. `brief` is the question as the CLI is asked it, `facts` what the
   * dashboard already knows that would help, and `schema` the shape of its
   * answer. Every property is required, which both CLIs' structured output
   * insists on, with an empty string for unknown.
   */
  agent?: {
    brief(ctx: QuestionContext): string;
    facts?(ctx: QuestionContext): string | null;
    schema: Record<string, unknown>;
  };
}

export { CLI_LABEL };

/**
 * Where to get each CLI, and the plan it runs on: ChatGPT Free and Go have
 * Codex only in the desktop app, and the free Claude plan has no Claude Code.
 */
const INSTALL: Record<CliName, { label: string; url: string; needs: string }> = {
  codex: { label: 'Install Codex', url: 'https://developers.openai.com/codex/cli', needs: 'Codex needs ChatGPT Plus or higher' },
  claude: { label: 'Install Claude Code', url: 'https://code.claude.com/docs', needs: 'Claude Code needs a paid Claude plan' },
};

function option(value: string, label: string, detail: string | null = null, group: string | null = null): OnboardingOption {
  return { value, label, detail, group };
}

function choice(id: string, options: OnboardingOption[], selected: string[], extra: Partial<OnboardingChoice> = {}): OnboardingChoice {
  return { id, label: null, multiple: false, options, selected, custom: null, ...extra };
}

function field(id: string, label: string, value: string, extra: Partial<OnboardingField> = {}): OnboardingField {
  return { id, label, value, placeholder: null, help: null, ...extra };
}

function card(parts: Partial<DrawnCard>): DrawnCard {
  return { why: null, choices: [], fields: [], problem: null, ...parts };
}

/** The one value chosen in a single choice. */
function one(answer: Chosen, id: string): string | null {
  return answer.choices[id]?.[0] ?? null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The proposal a step's CLI settled on, as an object, or null. */
function proposalOf(ctx: QuestionContext, id: string): Record<string, unknown> | null {
  const proposal = ctx.proposals[id];
  return typeof proposal === 'object' && proposal !== null && !Array.isArray(proposal) ? (proposal as Record<string, unknown>) : null;
}

/** "a, b and c" */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A name for a source list, in backticks, which is how the template has always written them. */
function ticked(name: string): string {
  return `\`${name.replaceAll('`', "'")}\``;
}

/* ---------- the questions ---------- */

/** The path to save for a CLI, when it can't be found by its name alone. */
function binFor(ctx: QuestionContext, cli: CliName | null): string | null {
  const found = cli ? ctx.clis?.[cli] : null;
  return found?.path && !found.onPath ? found.path : null;
}

/**
 * Asked only when it has to be. With a CLI ready, setup picks it and shows the
 * answer as a sentence: Codex if it is ready, then Claude Code. The card is for
 * changing that, or for when neither is ready, which is when it says what is
 * wrong with each and takes a path to one it couldn't find.
 */
const cli: Question = {
  id: 'cli',
  title: () => 'Which agent should write your brief?',
  topic: 'your coding agent',
  later: { label: 'Decide later', summary: 'No agent yet: the boards work, and there is no brief until you choose one.' },
  card(ctx) {
    if (!ctx.clis) return card({});
    const report = ctx.clis;
    const ready = CLI_PREFERENCE.filter((name) => report[name].ready);
    if (ready.length === 0) {
      // What is wrong with both is said once, not once for each.
      const labels = CLI_PREFERENCE.map((name) => CLI_LABEL[name]);
      const wrong = CLI_PREFERENCE.every((name) => !report[name].path)
        ? `Neither ${labels.join(' nor ')} is installed.`
        : CLI_PREFERENCE.every((name) => report[name].fix === LOGIN[name].fix)
          ? `${labels.join(' and ')} are installed, but neither is logged in.`
          : CLI_PREFERENCE.map((name) => `${report[name].problem ?? `${CLI_LABEL[name]} can't be used`}.`).join(' ');
      const fix = CLI_PREFERENCE.map((name) => report[name].fix).find((command) => command) ?? null;
      const missing = CLI_PREFERENCE.filter((name) => !report[name].path);
      const needs = missing.length ? `${missing.map((name) => INSTALL[name].needs).join('; ')}. ` : '';
      return card({
        problem: {
          message: `${wrong} ${needs}${fix ? 'Run this in a terminal, then check again.' : 'Install one, log in once in a terminal, then check again.'}`,
          command: fix,
          blocking: true,
          links: missing.map((name) => ({ label: INSTALL[name].label, url: INSTALL[name].url })),
        },
        fields: [
          field('path', 'Installed somewhere setup didn’t look? Its path', '', {
            placeholder: process.platform === 'win32' ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd' : '/opt/homebrew/bin/codex',
            help: 'The program itself, codex or claude. Setup checks it before using it.',
          }),
        ],
      });
    }
    const set = ctx.current.DAILY_FOCUS_AGENT as CliName | undefined;
    const others = CLI_PREFERENCE.filter((name) => !report[name].ready && report[name].path).map((name) => `${report[name].problem}.`);
    return card({
      why: [
        ready.length > 1
          ? `Both are ready on this ${ctx.machine}, so it uses Codex unless you say otherwise.`
          : `${CLI_LABEL[ready[0]!]} is the one ready on this ${ctx.machine}.`,
        ...others,
      ].join(' '),
      choices: [
        choice(
          'cli',
          ready.map((name) => option(name, CLI_LABEL[name], [report[name].version, report[name].path].filter(Boolean).join(', at '))),
          [set && ready.includes(set) ? set : ready[0]!],
        ),
      ],
    });
  },
  summary: (answer) => {
    const chosen = CLI_LABEL[one(answer, 'cli') as CliName];
    return chosen ? `${chosen} writes your brief.` : 'No agent writes your brief yet.';
  },
  // The assistant comes with it, on the same CLI, unless it has been set: it
  // only reads and drafts, and it is what the Ask button on every row needs.
  settings: (answer, ctx) => {
    const chosen = one(answer, 'cli') as CliName | null;
    const bin = binFor(ctx, chosen);
    const assistant = chosen && !ctx.current.DAILY_FOCUS_ASSISTANT;
    return {
      DAILY_FOCUS_AGENT: chosen,
      ...(bin ? { DAILY_FOCUS_AGENT_BIN: bin } : {}),
      ...(assistant ? { DAILY_FOCUS_ASSISTANT: chosen, ...(bin ? { DAILY_FOCUS_ASSISTANT_BIN: bin } : {}) } : {}),
    };
  },
};

const profile: Question = {
  id: 'profile',
  topic: 'what it covers',
  title: () => 'What should your brief cover?',
  later: null,
  applies: (ctx) => !ctx.profileSet,
  card: (ctx) =>
    card({
      choices: [
        choice(
          'profile',
          [
            option('work', 'Your work', 'Work mail and calendars, pull requests, tickets and meeting notes.'),
            option('personal', 'Your personal life', 'Personal mail, family calendars, reminders and messages.'),
          ],
          [ctx.current.DAILY_FOCUS_PROFILE === 'personal' ? 'personal' : 'work'],
        ),
      ],
      why: 'One dashboard briefs one of them. For both, run a second dashboard beside this one.',
    }),
  summary: (answer) => (one(answer, 'profile') === 'personal' ? 'It briefs your personal life.' : 'It briefs your work.'),
  settings: (answer) => ({ DAILY_FOCUS_PROFILE: one(answer, 'profile') }),
};

const TIMES = ['06:00', '06:30', '07:00', '07:30', '08:00'];
const DAYS: Record<string, string> = { '1-5': 'Weekdays', '0-6': 'Every day' };

const schedule: Question = {
  id: 'schedule',
  topic: 'when it runs',
  title: () => 'When should your brief be ready?',
  applies: (ctx) => ctx.cli !== null,
  later: null,
  card(ctx) {
    const at = ctx.current.DAILY_FOCUS_AGENT_AT || '07:00';
    const days = ctx.current.DAILY_FOCUS_AGENT_DAYS || '1-5';
    const times = [...new Set([...TIMES, ...(at === 'off' ? [] : [at])])].sort();
    return card({
      why: `It starts then and takes a few minutes. If the ${ctx.machine} is asleep or the dashboard isn't running then, it runs as soon as it is, that day.`,
      choices: [
        choice('at', [...times.map((time) => option(time, time)), option('off', 'Only when I ask')], [at], {
          label: 'Time',
          custom: 'Another time, such as 05:45',
        }),
        choice('days', Object.entries({ ...DAYS, ...(DAYS[days] ? {} : { [days]: days }) }).map(([value, label]) => option(value, label)), [days], {
          label: 'Days',
        }),
      ],
    });
  },
  summary(answer) {
    const at = one(answer, 'at');
    if (!at || at === 'off') return 'It runs only when you ask.';
    const days = one(answer, 'days') ?? '1-5';
    return `It runs at ${at} ${days === '1-5' ? 'on weekdays' : days === '0-6' ? 'every day' : `on days ${days}`}.`;
  },
  settings: (answer) => ({ DAILY_FOCUS_AGENT_AT: one(answer, 'at'), DAILY_FOCUS_AGENT_DAYS: one(answer, 'days') }),
};

/** The GitHub accounts a proposal named, with what each is for, as it said. */
function proposedAccounts(proposal: Record<string, unknown> | null): { login: string; note: string }[] {
  const raw = Array.isArray(proposal?.githubAccounts) ? (proposal.githubAccounts as unknown[]) : [];
  return raw.flatMap((entry) => {
    const account = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const login = str(account.login);
    return login ? [{ login, note: str(account.note) }] : [];
  });
}

/** Every GitHub account the card offers: gh's own, then any the proposal added, each with the proposal's note. */
function githubAccounts(ctx: QuestionContext): { login: string; note: string }[] {
  const accounts = new Map<string, { login: string; note: string }>();
  for (const login of ctx.identity.logins) accounts.set(login.toLowerCase(), { login, note: '' });
  for (const { login, note } of proposedAccounts(proposalOf(ctx, 'identity'))) {
    accounts.set(login.toLowerCase(), { login: accounts.get(login.toLowerCase())?.login ?? login, note });
  }
  return [...accounts.values()];
}

const identity: Question = {
  id: 'identity',
  topic: 'who you are',
  title: () => 'Is this you?',
  // Clearing three fields and unticking the accounts is a chore; one button, named for what it does, isn't.
  later: { label: 'Leave this out', summary: 'Who you are is left out, so the brief can’t tell your to-dos from other people’s.' },
  card(ctx) {
    const proposal = proposalOf(ctx, 'identity');
    const names = Array.isArray(proposal?.names) ? proposal.names.map(str).filter(Boolean) : [];
    const name = names.length ? names.join(', ') : (ctx.identity.name ?? '');
    const email = str(proposal?.email) || (ctx.identity.email ?? '');
    const accounts = githubAccounts(ctx);
    return card({
      why: str(proposal?.why) || 'The brief tells your to-dos from everyone else’s by these.',
      fields: [
        field('name', 'Your name, as meeting notes write it', name, {
          placeholder: 'Robin Lark',
          help: 'Add short forms after a comma, such as Robin L.',
        }),
        field('email', ctx.profile === 'personal' ? 'Your email' : 'Your work email', email, { placeholder: 'robin@example.com' }),
      ],
      choices: [
        choice(
          'github',
          accounts.map((account) => option(account.login, account.login, account.note || null)),
          accounts.map((account) => account.login),
          { label: 'Your GitHub accounts', multiple: true, custom: 'Add a GitHub login' },
        ),
      ],
    });
  },
  summary(answer) {
    const name = answer.fields.name?.split(',')[0]?.trim();
    const logins = answer.choices.github ?? [];
    const rest = [answer.fields.email?.trim() ?? '', logins.length ? `${listed(logins)} on GitHub` : ''].filter(Boolean);
    if (!name) return rest.length ? `You're ${listed(rest)}.` : 'No details about you.';
    return `You're ${name}${rest.length ? `, ${rest.join(', ')}` : ''}.`;
  },
  settings(answer, ctx): Record<string, string | null> {
    const values: Record<string, string | null> = {};
    // The address also tells the live agenda which reply on an invitation is yours.
    if (answer.fields.email?.trim()) values.DAILY_FOCUS_CALENDAR_ADDRESSES = answer.fields.email.trim();
    // The board reads as gh's active account unless told otherwise: told when
    // there is more than one, or the one isn't the active one.
    const logins = answer.choices.github ?? [];
    if (logins.length > 1 || (logins.length === 1 && logins[0] !== ctx.identity.logins[0])) {
      values.DAILY_FOCUS_GITHUB_ACCOUNTS = logins.join(', ');
    }
    return values;
  },
  sources(answer, ctx) {
    const names = (answer.fields.name ?? '').split(',').map((n) => n.trim()).filter(Boolean);
    const email = answer.fields.email?.trim();
    const notes = new Map(githubAccounts(ctx).map((account) => [account.login, account.note]));
    const logins = answer.choices.github ?? [];
    const lines = [
      names.length
        ? `- Name, as meeting notes and Doc assignments write it: ${ticked(names[0]!)}${names.length > 1 ? `, also ${listed(names.slice(1).map(ticked))}` : ''}`
        : null,
      email ? `- ${ctx.profile === 'personal' ? 'Personal' : 'Work'} email: ${ticked(email)}` : null,
      logins.length
        ? [
            `- GitHub ${logins.length > 1 ? 'logins' : 'login'}, which review requests and authorship are judged against:`,
            ...logins.map((login) => `  - ${ticked(login)}${notes.get(login) ? ` — ${notes.get(login)}` : ''}`),
          ].join('\n')
        : null,
    ].filter((line): line is string => line !== null);
    return lines.length ? [{ heading: 'Identity', body: lines.join('\n') }] : [];
  },
  agent: {
    brief: (ctx) =>
      'Who the user is, as their morning brief needs to know them: their name as meeting notes and document ' +
      'assignments write it, with any short forms colleagues use, their ' +
      (ctx.profile === 'personal' ? 'personal' : 'work') +
      ' email address, and every GitHub account they work as: gh may hold several, such as one for an ' +
      'employer’s organisation. Give each account a few words on what it is for when you can tell. Start from ' +
      'what the dashboard found, below. Check the address they send mail from, how others address them, and ' +
      '`gh auth status`.',
    facts: (ctx) =>
      [
        ctx.identity.name ? `- gh says their name is ${ctx.identity.name}` : null,
        ctx.identity.logins.length ? `- gh is logged in to GitHub as ${listed(ctx.identity.logins)}; the first is active` : null,
        ctx.identity.email ? `- git's global email is ${ctx.identity.email}` : null,
      ]
        .filter(Boolean)
        .join('\n') || null,
    schema: {
      type: 'object',
      properties: {
        why: { type: 'string', description: 'One or two sentences on where these came from.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Full name first, then short forms.' },
        email: { type: 'string' },
        githubAccounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              login: { type: 'string' },
              note: { type: 'string', description: 'What the account is for, in a few words, or empty.' },
            },
            required: ['login', 'note'],
            additionalProperties: false,
          },
        },
      },
      required: ['why', 'names', 'email', 'githubAccounts'],
      additionalProperties: false,
    },
  },
};

/** A board's state in a few words, for the option that turns it on. */
function healthText(board: BoardHealth, via: string): string | null {
  if (board.reason) return board.reason;
  if (board.fetchedAt) return `Connected through ${via}.`;
  if (board.enabled) return `Checking ${via}…`;
  return null;
}

const boards: Question = {
  id: 'boards',
  topic: 'the boards',
  title: () => 'What else should the dashboard show?',
  later: null,
  card(ctx) {
    const { github, jira } = ctx.boards;
    const selected = [
      github.enabled && !github.reason ? 'github' : null,
      jira.enabled && !jira.reason && ctx.profile === 'work' ? 'jira' : null,
    ].filter((value): value is string => value !== null);
    return card({
      why: 'Both are read live, beside the brief, so a merge or a status change shows up within minutes.',
      choices: [
        choice(
          'boards',
          [
            option('github', 'Your pull requests', healthText(github, 'gh') ?? 'Through the GitHub CLI, gh.'),
            option('jira', 'Your Jira tickets', healthText(jira, 'acli') ?? 'Through the Atlassian CLI, acli.'),
          ],
          selected,
          { multiple: true },
        ),
      ],
    });
  },
  summary(answer) {
    const on = answer.choices.boards ?? [];
    const names = [on.includes('github') ? 'your pull requests' : null, on.includes('jira') ? 'your Jira tickets' : null].filter(
      (name): name is string => name !== null,
    );
    return names.length ? `It shows ${listed(names)}.` : 'No boards beside the brief.';
  },
  settings(answer) {
    const on = answer.choices.boards ?? [];
    return { DAILY_FOCUS_GITHUB: on.includes('github') ? 'on' : 'off', DAILY_FOCUS_JIRA: on.includes('jira') ? 'on' : 'off' };
  },
};

/** One calendar on the card: Calendar.app's, the brief's own connector's, or one typed in. */
interface CalendarEntry {
  value: string;
  title: string;
  group: string;
  /** Calendar.app has it, so the live agenda can read it. */
  live: boolean;
  holiday: boolean;
  /** How the brief's calendar connector names it, when it differs. */
  briefName: string;
  note: string;
  include: boolean;
}

const HOLIDAYS = 'Holidays';

/** Every calendar the card offers: Calendar.app's, with the proposal's verdict on each, then the proposal's others. */
export function calendarEntries(ctx: QuestionContext): CalendarEntry[] {
  const proposal = proposalOf(ctx, 'calendars');
  const verdicts = Array.isArray(proposal?.calendars)
    ? (proposal.calendars as unknown[]).flatMap((raw) => {
        const entry = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
        const title = str(entry.title);
        return title
          ? [{ title, account: str(entry.account), include: entry.include === true, holiday: entry.holiday === true, briefName: str(entry.briefName), note: str(entry.note) }]
          : [];
      })
    : [];
  const configured = new Set((ctx.current.DAILY_FOCUS_CALENDARS ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
  const used = new Set<(typeof verdicts)[number]>();
  const entries: CalendarEntry[] = [];
  for (const calendar of Array.isArray(ctx.calendars) ? ctx.calendars : []) {
    const key = calendar.title.toLowerCase();
    const verdict =
      verdicts.find((v) => !used.has(v) && v.title.toLowerCase() === key && v.account.toLowerCase() === calendar.source.toLowerCase()) ??
      verdicts.find((v) => !used.has(v) && v.title.toLowerCase() === key);
    if (verdict) used.add(verdict);
    entries.push({
      value: `live:${calendar.source}:${calendar.title}`,
      title: calendar.title,
      group: verdict?.holiday ? HOLIDAYS : calendar.source || 'Calendar.app',
      live: true,
      holiday: verdict?.holiday ?? false,
      briefName: verdict?.briefName ?? '',
      note: verdict?.note ?? '',
      include: verdict ? verdict.include : configured.has(key),
    });
  }
  for (const verdict of verdicts) {
    if (used.has(verdict)) continue;
    entries.push({
      value: `brief:${verdict.account}:${verdict.title}`,
      title: verdict.title,
      group: verdict.holiday ? HOLIDAYS : verdict.account || 'Your calendar account',
      live: false,
      holiday: verdict.holiday,
      briefName: verdict.briefName,
      note: verdict.note,
      include: verdict.include,
    });
  }
  // Holidays last, the user's own accounts first, in the order Calendar.app listed them.
  return entries.sort((a, b) => Number(a.group === HOLIDAYS) - Number(b.group === HOLIDAYS));
}

/** The calendars chosen, whichever kind: values that aren't an entry are names the user typed. */
function chosenCalendars(answer: Chosen, ctx: QuestionContext): { entries: CalendarEntry[]; typed: string[] } {
  const all = new Map(calendarEntries(ctx).map((entry) => [entry.value, entry]));
  const values = answer.choices.calendars ?? [];
  return {
    entries: values.flatMap((value) => all.get(value) ?? []),
    typed: values.filter((value) => !all.has(value)).map((value) => value.trim()).filter(Boolean),
  };
}

const calendars: Question = {
  id: 'calendars',
  topic: 'your calendars',
  title: (ctx) => (ctx.profile === 'personal' ? 'Which calendars belong in your brief?' : 'Which calendars belong in your work brief?'),
  later: null,
  card(ctx) {
    const entries = calendarEntries(ctx);
    const proposal = proposalOf(ctx, 'calendars');
    const problem =
      ctx.calendar.supported && !ctx.calendar.built
        ? {
            message:
              'The live agenda reads Calendar.app through a small helper, built once with this command. Until then it uses the brief’s events, so this list is from your calendar account.',
            command: ctx.calendar.buildCommand,
            blocking: false,
          }
        : typeof ctx.calendars === 'string'
          ? { message: `Calendar.app couldn't be read: ${ctx.calendars}`, command: null, blocking: false }
          : null;
    return card({
      why: str(proposal?.why) || null,
      problem,
      choices: [
        choice(
          'calendars',
          entries.map((entry) => option(entry.value, entry.title, entry.note || null, entry.group)),
          entries.filter((entry) => entry.include).map((entry) => entry.value),
          { multiple: true, custom: 'Add a calendar by name' },
        ),
      ],
    });
  },
  summary(answer, ctx) {
    const { entries, typed } = chosenCalendars(answer, ctx);
    const names = [...entries.map((entry) => entry.title), ...typed];
    if (names.length === 0) return 'No calendars.';
    if (names.length <= 3) return `It reads ${listed(names)}.`;
    return `It reads ${names.slice(0, 2).join(', ')} and ${names.length - 2} more calendars.`;
  },
  settings(answer, ctx) {
    const { entries, typed } = chosenCalendars(answer, ctx);
    const live = [...new Set([...entries.filter((entry) => entry.live).map((entry) => entry.title), ...typed])];
    // Commas separate the setting's names, so a name with one in can't be kept there.
    return { DAILY_FOCUS_CALENDARS: live.filter((name) => !name.includes(',')).join(', ') || null };
  },
  sources(answer, ctx) {
    const { entries, typed } = chosenCalendars(answer, ctx);
    const line = (entry: CalendarEntry) => `- ${ticked(entry.briefName || entry.title)}${entry.group !== HOLIDAYS && entry.group ? ` (${entry.group})` : ''}`;
    const own = [...entries.filter((entry) => !entry.holiday).map(line), ...typed.map((name) => `- ${ticked(name)}`)];
    const holidays = entries.filter((entry) => entry.holiday).map(line);
    return [
      ...(own.length ? [{ heading: 'Calendars', body: `Query these, and treat their events as blocking time:\n\n${own.join('\n')}` }] : []),
      ...(holidays.length
        ? [{ heading: 'Holiday calendars', body: `Call out a holiday today or within the next 14 days:\n\n${holidays.join('\n')}` }]
        : []),
    ];
  },
  agent: {
    brief: (ctx) =>
      `Which calendars the user's ${ctx.profile} brief should read. ` +
      (Array.isArray(ctx.calendars)
        ? 'Below is every calendar Calendar.app on this Mac has, with the account it is on and how many events it has today. '
        : 'List the calendars their calendar connector reaches. ') +
      'Include ' +
      (ctx.profile === 'personal'
        ? 'their own personal and family calendars, '
        : 'their own work calendar, team calendars whose events block their time, ') +
      'and the holiday calendars for where they and the people they work with are. Leave out ' +
      (ctx.profile === 'personal' ? 'work calendars, ' : 'personal and family calendars, ') +
      "birthdays, and shared calendars that are mostly other people's events. If you can reach their calendar " +
      'through a connector, look at the coming week for evidence, and give `briefName`, the name the connector ' +
      'uses where it differs from Calendar.app’s. ' +
      (Array.isArray(ctx.calendars) ? 'List every calendar from the list below, and any your connector has that Calendar.app does not. ' : '') +
      '`note` is a few words shown under the name, such as ' +
      '"Your primary calendar" or "12 of your meetings this week", or empty.',
    facts(ctx) {
      if (typeof ctx.calendars === 'string') return `Calendar.app could not be read (${ctx.calendars}), so work from your calendar connector alone.`;
      if (!Array.isArray(ctx.calendars)) return 'There is no list from Calendar.app here, so work from your calendar connector alone.';
      if (ctx.calendars.length === 0) return 'Calendar.app has no calendars.';
      return [
        'Calendar.app has these, as title (account): events today.',
        '',
        ...ctx.calendars.map((calendar) => `- ${calendar.title} (${calendar.source || 'no account'}): ${calendar.eventsToday}`),
      ].join('\n');
    },
    schema: {
      type: 'object',
      properties: {
        why: { type: 'string', description: 'One or two sentences on which you ticked and why.' },
        calendars: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: "Exactly as Calendar.app spells it, or the connector's name for one Calendar.app lacks." },
              account: { type: 'string' },
              include: { type: 'boolean' },
              holiday: { type: 'boolean' },
              briefName: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['title', 'account', 'include', 'holiday', 'briefName', 'note'],
            additionalProperties: false,
          },
        },
      },
      required: ['why', 'calendars'],
      additionalProperties: false,
    },
  },
};

/** What a proposal suggested as objectives, each with what it was drawn from. */
function suggestedObjectives(proposal: Record<string, unknown> | null): { text: string; detail: string | null }[] {
  const raw = Array.isArray(proposal?.suggestions) ? (proposal.suggestions as unknown[]) : [];
  return raw.flatMap((entry) => {
    const suggestion = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const text = str(suggestion.objective);
    return text ? [{ text, detail: str(suggestion.evidence) || null }] : [];
  });
}

/**
 * The one thing the user is trying to get done, in their words. A session
 * looks at what they have been doing and suggests a few, only from a strong
 * signal, and none ticked: an objective made up for someone is worse than
 * none. Its real job is the conversation: the user says what they are working
 * on, as roughly as they like, and it writes that up as an objective and a
 * blocker.
 */
const objective: Question = {
  id: 'objective',
  topic: 'your objective',
  title: () => 'What are you trying to get done right now?',
  // Left empty, Continue says so; see `empty` on its card.
  later: null,
  card(ctx) {
    const proposal = proposalOf(ctx, 'objective');
    return card({
      reply: 'Tell it what you’re working on, however roughly',
      empty: 'Continue without one',
      why:
        str(proposal?.why) ||
        'The brief ranks the day against it. A next move works better than a project name. Tell it what you’re working on, however roughly, and it will write it up.',
      fields: [
        field('objective', 'Your objective', str(proposal?.objective), {
          placeholder: 'Get the staging deploy working again',
          suggestions: suggestedObjectives(proposal),
        }),
        field('blocker', 'What’s in the way, if anything', str(proposal?.blocker), { placeholder: 'Nobody can reproduce the failure' }),
      ],
    });
  },
  summary: (answer) => {
    const text = answer.fields.objective?.trim();
    const blocker = answer.fields.blocker?.trim();
    if (!text) return 'No objective for now.';
    return `Your objective: ${text}${blocker ? `. In the way: ${blocker}` : ''}`;
  },
  objective: (answer) =>
    answer.fields.objective?.trim() ? { objective: answer.fields.objective.trim(), blocker: answer.fields.blocker?.trim() || null } : null,
  agent: {
    brief: (ctx) =>
      `The user's current objective: the one thing they are trying to get done right now, which their ${ctx.profile} ` +
      'brief ranks the day against. Look at what they have been doing lately: their own recent and open pull ' +
      'requests, tickets assigned to them and in progress, and anything on the calendar that keeps coming back. ' +
      'Suggest up to three objectives, each only where there is a strong signal, with the evidence in a few ' +
      'words, such as "your 4 open pull requests on checkout". If nothing stands out, suggest none and say so. ' +
      'Leave `objective` and `blocker` empty until the user tells you what they are working on. When they do, ' +
      'write it up as one objective: a next move rather than a project name, in their own terms, under 12 words. ' +
      'Put what is in the way, if they mention anything, in `blocker`, as briefly.',
    schema: {
      type: 'object',
      properties: {
        why: { type: 'string', description: 'One or two sentences: what you looked at, or how you wrote up what they said.' },
        objective: { type: 'string' },
        blocker: { type: 'string' },
        suggestions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              objective: { type: 'string' },
              evidence: { type: 'string', description: 'What it was drawn from, in a few words.' },
            },
            required: ['objective', 'evidence'],
            additionalProperties: false,
          },
        },
      },
      required: ['why', 'objective', 'blocker', 'suggestions'],
      additionalProperties: false,
    },
  },
};

export const QUESTIONS: readonly Question[] = [cli, profile, schedule, identity, boards, calendars, objective];

export function questionById(id: string): Question | undefined {
  return QUESTIONS.find((question) => question.id === id);
}

/**
 * The source list the answers add up to. Only sections something was chosen
 * for, and never a placeholder: a source list that sends the agent looking for
 * `Your Name` is worse than none. The agent reports what is missing.
 */
export function composeSources(profile: Profile, sections: readonly SourcesSection[], today: string): string {
  // One line per paragraph: an editor or a narrow preview wraps it where it fits.
  const intro = [
    '# Sources',
    '',
    `Who you are and where to look, for your ${profile === 'personal' ? 'personal' : 'work'} morning brief. Written by ` +
      `setup on ${today}; change it freely. The prompt next to this file (\`prompt.md\`) says *what* to gather and ` +
      'how to judge it; this file says *who* and *where*. A section that is missing is fine: the agent falls back to ' +
      'your primary calendar and connected accounts, and says what it missed.',
  ];
  return [...intro, ...sections.flatMap((section) => ['', `## ${section.heading}`, '', section.body])].join('\n') + '\n';
}

/** What the screen calls the machine the dashboard runs on. */
export function machineName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'PC' : 'computer';
}
