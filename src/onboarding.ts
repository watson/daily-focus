/**
 * The setup screen: a new store's way to a first brief, as a conversation the
 * dashboard steers.
 *
 * The questions and their order are the dashboard's (`questions.ts`). What is
 * already ticked on each is what the user most likely wants, and for some of
 * them a CLI has looked into it first: one short session per question, started
 * as soon as the CLI and the profile are known, so the slow ones are ready by
 * the time the user reaches them. A session only reads, and answers in JSON the
 * schema fixes; the user confirms, edits, or tells it what to change, which
 * resumes the session with their words.
 *
 * Nothing is saved until the end. Saving settings restarts the dashboard, which
 * would cut every session short, so the answers wait in `onboarding.json` and
 * the finish saves them at once: the settings, the source list when there isn't
 * one, and the objective. The first brief starts after that restart, from the
 * finish's click (see `takeBriefRequest`).
 *
 * The file is this module's alone, rewritten whole on each change. A session's
 * steps live in memory only: a restart starts any unfinished session again.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ADAPTERS, type ParsedEvent } from './assistant.ts';
import { preferredCli, type CliFound, type CliReport } from './clis.ts';
import { CodexGate, codexLatestModel, computerUseOff } from './codex.ts';
import { CLI_NAMES, PROFILES, type CliName, type Config, type Profile } from './config.ts';
import { ABSENT, readEditable, saveEditable, setFocusFields } from './editable.ts';
import { expandHome, layerEnv, type EnvSources } from './env.ts';
import { writeJsonAtomic } from './fs.ts';
import {
  composeSources,
  QUESTIONS,
  questionById,
  type BoardHealth,
  type CalendarListing,
  type Chosen,
  type Question,
  type QuestionContext,
  type SourcesSection,
} from './questions.ts';
import { SETTINGS } from './settings.ts';
import type { Identity } from './setup.ts';
import type { ExecFile } from './shellpath.ts';
import { FOCUS_TEMPLATE } from './templates.ts';
import type { AssistantStep, OnboardingAnswer, OnboardingState, OnboardingStep, SetupState } from './types.ts';

/** A session that takes longer than this is stopped: someone is waiting on the screen. */
const TURN_TIMEOUT_MS = 4 * 60_000;

/** How many steps a session keeps, the newest. */
const STEPS_KEPT = 40;

/**
 * The model and effort each CLI's sessions run at: the newest flagship, at low
 * effort. A proposal is a few lookups and one judgement, and someone is
 * waiting. Measured on 2026-10-16 with the identity and calendar questions:
 * Opus at low effort answered in 16–20 s and called both right; medium was no
 * better and a little slower. Sonnet, and Codex's lighter GPT-6-Luna, answered
 * in 14–16 s and called someone else's calendar the user's own. Codex's
 * flagship at low answered in 19–28 s and called both right.
 *
 * `opus` is Claude Code's alias for its newest Opus. Codex has no such alias,
 * so its flagship is read from its own catalog (`codexLatestModel`), and the
 * user's default stands when that can't be read.
 */
export const SESSION_MODEL: Record<CliName, { model: string | null; effort: string }> = {
  claude: { model: 'opus', effort: 'low' },
  codex: { model: null, effort: 'low' },
};

/**
 * What a Claude Code session may call: reads by name, and nothing that writes
 * but what `gh` and `acli` can, which the prompt holds to reading as the
 * assistant's does. Connectors the user hasn't connected are simply absent.
 */
export const ONBOARDING_TOOLS: readonly string[] = [
  'Bash(gh *)',
  'Bash(acli *)',
  'Bash(git config *)',
  'mcp__claude_ai_Gmail__search_threads',
  'mcp__claude_ai_Gmail__get_thread',
  'mcp__claude_ai_Gmail__get_message',
  'mcp__claude_ai_Gmail__list_labels',
  'mcp__claude_ai_Google_Calendar__list_calendars',
  'mcp__claude_ai_Google_Calendar__list_events',
  'mcp__claude_ai_Google_Calendar__search_events',
  'mcp__claude_ai_Google_Calendar__get_event',
  'mcp__claude_ai_Google_Drive__search_files',
  'mcp__claude_ai_Google_Drive__list_recent_files',
  'mcp__claude_ai_Google_Drive__get_file_metadata',
  'mcp__claude_ai_Google_Drive__read_file_content',
];

/** Why a session stopped when the dashboard did. Started again on the next start. */
const RESTARTED = 'the dashboard restarted while this was running';

interface ProposalRecord {
  /** Who it was asked of, and for which profile: a change to either asks again. */
  cli: CliName;
  profile: Profile;
  sessionId: string | null;
  status: 'working' | 'ready' | 'failed';
  /** The JSON it answered with, parsed. */
  result: unknown;
  error: string | null;
  /** Bumped each time `result` changes, so the screen can tell a draft made against an older one. */
  version: number;
  /** Its reason for each proposal and each change the user asked for, in order. */
  conversation: { from: 'you' | 'it'; text: string }[];
}

interface OnboardingFile {
  startedAt: string;
  /** When the finish saved everything. Setup is over from then on, whatever happens to the first brief. */
  finishedAt: string | null;
  /**
   * The finish asked for the first brief. Saving its settings restarts the
   * dashboard, so the start after that begins the run, and clears this.
   */
  briefRequested: boolean;
  answers: Record<string, OnboardingAnswer>;
  proposals: Record<string, ProposalRecord>;
}

export interface OnboardingDeps {
  /** Something changed that the screen should show. */
  onChange(): void;
  /** Look for both CLIs: where each is, and whether it is ready to run. See `clis.ts`. */
  detectClis(): Promise<CliReport>;
  /** What the program at a path the user gave is, and whether it is ready. */
  probeCli(path: string): Promise<{ cli: CliName | null; found: CliFound }>;
  /** Every place a setting can come from, read afresh. */
  readSources(): EnvSources;
  /** What the dashboard can check for itself: the calendar helper, mostly. */
  setup(): Promise<SetupState>;
  identity(): Promise<Identity>;
  boards(): Promise<{ github: BoardHealth; jira: BoardHealth }>;
  /** Calendar.app's calendars; throws with why it couldn't list them. */
  listCalendars(): Promise<CalendarListing[]>;
  /** Whether these settings would be accepted, without saving them: the reason when not. */
  checkSettings(values: Record<string, string | null>): string | null;
  /** Save settings as the settings page does, which restarts the dashboard when anything changed. The reason when refused. */
  saveSettings(values: Record<string, string | null>): Promise<string | null>;
  spawnFn?: typeof spawn;
  execFn?: ExecFile;
}

interface Running {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  abortReason: string | null;
}

function blankFile(): OnboardingFile {
  return { startedAt: new Date().toISOString(), finishedAt: null, briefRequested: false, answers: {}, proposals: {} };
}

/** The file as written, salvaged: anything malformed in it is dropped rather than trusted. */
function parseFile(text: string): OnboardingFile {
  const file = blankFile();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return file;
  }
  if (typeof raw !== 'object' || raw === null) return file;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.startedAt === 'string') file.startedAt = obj.startedAt;
  if (typeof obj.finishedAt === 'string') file.finishedAt = obj.finishedAt;
  file.briefRequested = obj.briefRequested === true;
  if (typeof obj.answers === 'object' && obj.answers !== null) {
    for (const [id, answer] of Object.entries(obj.answers as Record<string, unknown>)) {
      const clean = cleanAnswer(answer);
      if (clean) file.answers[id] = clean;
    }
  }
  if (typeof obj.proposals === 'object' && obj.proposals !== null) {
    for (const [id, value] of Object.entries(obj.proposals as Record<string, unknown>)) {
      const record = value as Partial<ProposalRecord> | null;
      if (!record || !CLI_NAMES.includes(record.cli as CliName) || !PROFILES.includes(record.profile as Profile)) continue;
      file.proposals[id] = {
        cli: record.cli as CliName,
        profile: record.profile as Profile,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
        status: record.status === 'ready' || record.status === 'failed' ? record.status : 'working',
        result: record.result ?? null,
        error: typeof record.error === 'string' ? record.error : null,
        version: typeof record.version === 'number' ? record.version : 0,
        conversation: Array.isArray(record.conversation)
          ? record.conversation.filter(
              (line): line is { from: 'you' | 'it'; text: string } =>
                typeof line === 'object' && line !== null && (line.from === 'you' || line.from === 'it') && typeof line.text === 'string',
            )
          : [],
      };
    }
  }
  return file;
}

/** An answer as the screen sent it or the file kept it, or null when it isn't one. */
export function cleanAnswer(value: unknown): OnboardingAnswer | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.later === true) return { later: true };
  const choices: Record<string, string[]> = {};
  const fields: Record<string, string> = {};
  if (typeof obj.choices === 'object' && obj.choices !== null) {
    for (const [id, values] of Object.entries(obj.choices as Record<string, unknown>)) {
      if (Array.isArray(values)) choices[id] = [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim() !== ''))];
    }
  }
  if (typeof obj.fields === 'object' && obj.fields !== null) {
    for (const [id, text] of Object.entries(obj.fields as Record<string, unknown>)) {
      if (typeof text === 'string') fields[id] = text;
    }
  }
  return { choices, fields };
}

function given(answer: OnboardingAnswer | null | undefined): Chosen | null {
  return answer && answer.later !== true ? answer : null;
}

/** The answer a card's own ticks and fields add up to: what a locked step stands at. */
function answerFromCard(card: { choices: { id: string; selected: string[] }[]; fields: { id: string; value: string }[] }): Chosen {
  return {
    choices: Object.fromEntries(card.choices.map((choice) => [choice.id, choice.selected])),
    fields: Object.fromEntries(card.fields.map((field) => [field.id, field.value])),
  };
}

export class Onboarding {
  private file: OnboardingFile | null = null;
  private loaded = false;
  private readonly running = new Map<string, Running>();
  private readonly steps = new Map<string, AssistantStep[]>();
  private calendars: Promise<CalendarListing[] | string> | null = null;
  private finishError: string | null = null;
  private readonly config: Config;
  private readonly deps: OnboardingDeps;
  private readonly spawnFn: typeof spawn;
  private readonly gates = new Map<string, CodexGate>();
  private codexOff: Promise<string[]> | null = null;
  private codexModel: Promise<string | null> | null = null;
  /** What looking for the CLIs found, once the screen has asked. Not kept: what is installed changes. */
  private detected: CliReport | null = null;
  private detecting: Promise<CliReport> | null = null;
  /** The write in progress, which the next one waits for. */
  private writes: Promise<void> = Promise.resolve();

  constructor(config: Config, deps: OnboardingDeps) {
    this.config = config;
    this.deps = deps;
    this.spawnFn = deps.spawnFn ?? spawn;
  }

  /** Whether a session has a process going. A restart waits for none. */
  get busy(): boolean {
    return this.running.size > 0;
  }

  /**
   * Read the file, and start again any session the last process left going.
   * Only while setup is still to do: `needed` is the caller's `firstBriefPending`.
   */
  async start(needed: boolean): Promise<void> {
    await this.load();
    if (!needed || this.file?.finishedAt) return;
    for (const record of Object.values(this.file?.proposals ?? {})) {
      if (record.status === 'working') {
        record.status = 'failed';
        record.error = RESTARTED;
      }
    }
    await this.ensureProposals();
  }

  /** The screen, while setup is to do: the store has never had a brief, and setup hasn't finished. */
  async view(setup: SetupState): Promise<OnboardingState | null> {
    await this.load();
    if (!setup.needed || this.file?.finishedAt) return null;
    const file = this.file ?? blankFile();
    const ctx = await this.context({ setup });
    const sources = this.deps.readSources();
    const answers = this.effective(ctx, file.answers);
    const steps: OnboardingStep[] = [];
    for (const question of this.questions(ctx)) {
      const locked = this.locked(question, sources);
      const drawn = question.card(ctx);
      const record = file.proposals[question.id];
      // A step the environment answers stands at what is in effect. For the CLI
      // that is the setting itself: its card has nothing to show until it has looked.
      const answer: OnboardingAnswer | null = locked
        ? question.id === 'cli'
          ? { choices: { cli: ctx.cli ? [ctx.cli] : [] }, fields: {} }
          : answerFromCard(drawn)
        : (answers[question.id] ?? null);
      const chosen = given(answer);
      // Until it has looked, the first question is the looking.
      const looking = question.id === 'cli' && !answer && !this.detected;
      steps.push({
        id: question.id,
        title: question.title(ctx),
        topic: question.topic,
        status: answer ? (chosen ? 'answered' : 'later') : 'open',
        summary: chosen ? question.summary(chosen, ctx) : null,
        locked,
        card: { ...drawn, version: record?.version ?? 0, revisable: Boolean(question.agent && record), deferrable: question.deferrable },
        proposal: looking
          ? {
              status: 'working',
              conversation: [],
              steps: [{ kind: 'tool', text: 'Look for Codex and Claude Code', detail: null, state: 'running' }],
              error: null,
            }
          : record
            ? {
                status: record.status,
                conversation: record.conversation,
                steps: this.steps.get(question.id) ?? [],
                error: record.status === 'failed' ? record.error : null,
              }
            : null,
        answer,
      });
    }
    return {
      detected: this.detected !== null,
      steps,
      current: steps.find((step) => step.status === 'open')?.id ?? null,
      error: this.finishError,
    };
  }

  /**
   * Look for the CLIs, which the screen asks for when it opens: with one ready,
   * the first question answers itself. Asked again by Check again.
   */
  async detect(): Promise<void> {
    await this.load();
    await this.lookForClis(true);
    await this.ensureProposals();
    this.deps.onChange();
  }

  /**
   * Record an answer, or that the user would rather decide later. One whose
   * settings the dashboard would refuse is refused here, while the card that
   * can fix it is still open.
   */
  async answer(id: string, raw: unknown): Promise<string | null> {
    await this.load();
    const file = (this.file ??= blankFile());
    if (file.finishedAt) return 'setup has finished';
    const question = questionById(id);
    let answer = cleanAnswer(raw);
    if (!question || !answer) return `there is no question ${JSON.stringify(id)}, or that is not an answer to it`;
    if (!given(answer) && !question.deferrable) return `"${question.topic}" needs an answer`;
    if (id === 'cli' && given(answer)) {
      const chosen = await this.chooseCli(given(answer)!);
      if (typeof chosen === 'string') return chosen;
      answer = chosen;
    }
    const ctx = await this.context();
    const before = { cli: ctx.cli, profile: ctx.profile };
    // Checked with every answer so far, as the finish will save them: some
    // settings only make sense beside another, such as a time for the agent.
    if (given(answer) && question.settings) {
      const refused = this.deps.checkSettings(this.settingsOf({ ...file.answers, [id]: answer }, await this.context({ answers: { ...file.answers, [id]: answer } })));
      if (refused) return refused;
    }
    file.answers[id] = answer;
    this.finishError = null;
    const after = await this.context();
    if (after.profile !== before.profile) {
      // Every proposal was made for the other profile, and so were the answers to them.
      for (const other of QUESTIONS) {
        if (!other.agent) continue;
        delete file.answers[other.id];
        await this.drop(other.id);
      }
    } else if (after.cli !== before.cli) {
      // Answers stand; proposals not yet answered are asked of the new CLI.
      for (const other of QUESTIONS) if (other.agent && !file.answers[other.id]) await this.drop(other.id);
    }
    await this.save();
    await this.ensureProposals();
    this.deps.onChange();
    return null;
  }

  /** Tell a question's session what to change. `draft` is what the card holds now, which it should start from. */
  async revise(id: string, text: string, draft: unknown): Promise<string | null> {
    await this.load();
    const question = questionById(id);
    const record = this.file?.proposals[id];
    if (!question?.agent || !record) return 'nothing is looking into that question';
    if (this.running.has(id)) return 'it is still working on that question';
    const ctx = await this.context();
    const current = cleanAnswer(draft);
    const request = [
      `The user says: ${text.trim()}`,
      ...(given(current) ? ['', 'What the card holds now, which they may have changed:', '', '```json', JSON.stringify(current), '```'] : []),
      '',
      'Revise your proposal, and answer with the whole of it again.',
    ].join('\n');
    const resume = record.sessionId && record.cli === ctx.cli ? record.sessionId : null;
    const said = [...record.conversation, { from: 'you' as const, text: text.trim() }];
    await this.ask(question, ctx, resume ? request : `${await this.firstMessage(question, ctx)}\n\n${request}`, resume, said);
    return null;
  }

  /**
   * Look again: ask a question's session again from the start, after it failed,
   * and list Calendar.app's calendars again for the question that shows them,
   * since what failed may have been the access the user has since granted.
   */
  async retry(id: string): Promise<string | null> {
    await this.load();
    const question = questionById(id);
    if (!question) return `there is no question ${JSON.stringify(id)}`;
    if (this.running.has(id)) return 'it is still working on that question';
    if (id === 'calendars') this.calendars = null;
    if (id === 'cli') await this.lookForClis(true);
    if (question.agent) await this.drop(id);
    await this.ensureProposals();
    this.deps.onChange();
    return null;
  }

  /**
   * Save everything, and ask for the first brief. Files first, then the
   * settings, whose save restarts the dashboard: the start after it begins the
   * run. Resolves with why not, or null.
   */
  async finish(): Promise<{ error: string } | { restart: boolean }> {
    await this.load();
    const file = (this.file ??= blankFile());
    if (file.finishedAt) return { error: 'setup has already finished' };
    // The CLI it picked without asking is an answer too, and needs it to have looked.
    if (!file.answers.cli) await this.lookForClis(false);
    const ctx = await this.context();
    const sources = this.deps.readSources();
    const answers = this.effective(ctx, file.answers);
    const sections: SourcesSection[] = [];
    let objective: string | null = null;
    for (const question of this.questions(ctx)) {
      const answer = answers[question.id];
      if (!answer && !this.locked(question, sources)) return this.refuse(`answer "${question.title(ctx)}", or decide it later`);
      const chosen = this.locked(question, sources) ? null : given(answer);
      if (!chosen) continue;
      sections.push(...(question.sources?.(chosen, ctx) ?? []));
      objective = question.objective?.(chosen) ?? objective;
    }
    const values = this.settingsOf(file.answers, ctx);
    const refused = this.deps.checkSettings(values);
    if (refused) return this.refuse(refused);

    for (const id of [...this.running.keys()]) await this.stop(id, 'setup finished');

    // The user's two files, written only when the user has said what goes in
    // them, and never over a version they wrote themselves.
    const existing = await readEditable(this.config.sourcesFile);
    if (existing.text === null && sections.length > 0) {
      await mkdir(this.config.dataDir, { recursive: true });
      await saveEditable(this.config.sourcesFile, composeSources(ctx.profile, sections, new Date().toISOString().slice(0, 10)), ABSENT);
    }
    if (objective) {
      const focus = await readEditable(this.config.focusFile);
      const saved = await saveEditable(this.config.focusFile, setFocusFields(focus.text, { objective, blocker: null }, FOCUS_TEMPLATE), focus.version);
      if (!saved.saved) return this.refuse('focus.md changed on disk while saving; finish again');
    }

    file.finishedAt = new Date().toISOString();
    file.briefRequested = ctx.cli !== null;
    await this.save();
    const before = JSON.stringify(Object.entries(sources.settings).sort());
    const saveRefused = await this.deps.saveSettings(values);
    if (saveRefused) {
      file.finishedAt = null;
      file.briefRequested = false;
      await this.save();
      return this.refuse(saveRefused);
    }
    this.finishError = null;
    this.deps.onChange();
    return { restart: JSON.stringify(Object.entries(this.deps.readSources().settings).sort()) !== before };
  }

  /**
   * Whether the finish asked for a first brief that hasn't been started, and
   * forget it: asked once, so a run that fails is retried by the user, not by
   * every start.
   */
  async takeBriefRequest(): Promise<boolean> {
    await this.load();
    if (!this.file?.briefRequested) return false;
    this.file.briefRequested = false;
    await this.save();
    return true;
  }

  /** What the finish would write as the source list, or null when the store already has one it would keep. */
  async previewSources(): Promise<{ text: string | null; kept: boolean }> {
    await this.load();
    const existing = await readEditable(this.config.sourcesFile);
    if (existing.text !== null) return { text: null, kept: true };
    const ctx = await this.context();
    const sections: SourcesSection[] = [];
    for (const question of this.questions(ctx)) {
      const chosen = given(this.file?.answers[question.id]);
      if (chosen) sections.push(...(question.sources?.(chosen, ctx) ?? []));
    }
    return { text: sections.length ? composeSources(ctx.profile, sections, new Date().toISOString().slice(0, 10)) : null, kept: false };
  }

  /** Stop every session, for shutdown. */
  async close(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stop(id, RESTARTED);
  }

  /* ---------- the sessions ---------- */

  /** Start a session for each question that has one and needs it: the CLI and the profile are known, and nobody has asked yet. */
  private async ensureProposals(): Promise<void> {
    const file = this.file;
    if (!file || file.finishedAt) return;
    // Not before the user has answered something: see `context`.
    if (Object.keys(file.answers).length === 0) return;
    await this.lookForClis(false);
    const ctx = await this.context({ listCalendars: true });
    const sources = this.deps.readSources();
    const profileKnown = given(file.answers.profile) !== null || (sources.process.DAILY_FOCUS_PROFILE ?? '').trim() !== '';
    if (!ctx.cli || !profileKnown) return;
    for (const question of this.questions(ctx)) {
      if (!question.agent || file.answers[question.id] || this.running.has(question.id)) continue;
      const record = file.proposals[question.id];
      if (record && record.cli === ctx.cli && record.profile === ctx.profile && record.status !== 'failed') continue;
      if (record?.status === 'failed' && record.error !== RESTARTED && record.cli === ctx.cli && record.profile === ctx.profile) continue;
      await this.ask(question, ctx, await this.firstMessage(question, ctx), null);
    }
  }

  /** The first message of a question's session: the instructions, what is known, and the question. */
  private async firstMessage(question: Question, ctx: QuestionContext): Promise<string> {
    const instructions = await readFile(this.config.onboardingPromptSource, 'utf8').catch(
      () => 'You are helping someone set up Daily Focus. Only read; never send, post or edit anything. Answer with the JSON the schema asks for.',
    );
    const agent = question.agent!;
    const facts = agent.facts?.(ctx) ?? null;
    return [
      instructions.trim(),
      '',
      '## This setup',
      '',
      `- Profile: ${ctx.profile}`,
      `- Today: ${new Date().toISOString().slice(0, 10)}`,
      '',
      `## The question: ${question.title(ctx)}`,
      '',
      agent.brief(ctx),
      ...(facts ? ['', '### What the dashboard already knows', '', facts] : []),
    ].join('\n');
  }

  private async ask(
    question: Question,
    ctx: QuestionContext,
    prompt: string,
    resume: string | null,
    conversation: ProposalRecord['conversation'] = [],
  ): Promise<void> {
    const file = (this.file ??= blankFile());
    const cli = ctx.cli!;
    const previous = file.proposals[question.id];
    const record: ProposalRecord = {
      cli,
      profile: ctx.profile,
      sessionId: resume,
      status: 'working',
      result: previous?.cli === cli && previous.profile === ctx.profile ? previous.result : null,
      error: null,
      version: previous?.version ?? 0,
      conversation,
    };
    file.proposals[question.id] = record;
    this.steps.set(question.id, []);
    await this.save();
    this.deps.onChange();

    const bin = ctx.clis?.[cli]?.path ?? null;
    if (!bin) return this.settle(question.id, record, { ok: false, error: `could not find ${cli} on this machine` });
    if (cli === 'codex') {
      const gate = this.gates.get(bin) ?? new CodexGate(bin, this.deps.execFn);
      this.gates.set(bin, gate);
      const refusal = await gate.refusal();
      if (refusal) return this.settle(question.id, record, { ok: false, error: refusal });
    }
    let codexConfig: string[] = [];
    if (cli === 'codex') {
      try {
        this.codexOff ??= computerUseOff(bin, this.deps.execFn);
        codexConfig = await this.codexOff;
      } catch (err) {
        this.codexOff = null;
        return this.settle(question.id, record, { ok: false, error: `Codex could not say which plugins to switch off: ${(err as Error).message}` });
      }
    }

    const schemaDir = await mkdtemp(join(tmpdir(), 'daily-focus-setup-'));
    const schemaFile = join(schemaDir, 'schema.json');
    const json = JSON.stringify(question.agent!.schema);
    await writeFile(schemaFile, json, 'utf8');
    await mkdir(this.config.onboardingDir, { recursive: true });
    const adapter = ADAPTERS[cli];
    const session = SESSION_MODEL[cli];
    const model = cli === 'codex' ? await (this.codexModel ??= codexLatestModel(bin, this.deps.execFn)) : session.model;
    const args = adapter.args({
      prompt,
      sessionId: resume,
      model,
      effort: session.effort,
      tools: ONBOARDING_TOOLS,
      denyEdits: true,
      drafts: false,
      codexConfig,
      schema: { json, file: schemaFile },
    });

    let child: ChildProcess;
    try {
      child = this.spawnFn(bin, args, { cwd: this.config.onboardingDir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      await rm(schemaDir, { recursive: true, force: true });
      return this.settle(question.id, record, { ok: false, error: `could not run ${bin}: ${(err as Error).message}` });
    }
    const timer = setTimeout(() => void this.stop(question.id, 'gave up after four minutes'), TURN_TIMEOUT_MS);
    timer.unref();
    const run: Running = { child, timer, abortReason: null };
    this.running.set(question.id, run);

    let done: ParsedEvent['done'] | undefined;
    let said = '';
    const stderr: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf8'));
      if (stderr.length > 50) stderr.shift();
    });
    const calls = new Map<string, AssistantStep>();
    const steps = this.steps.get(question.id)!;
    const add = (step: AssistantStep) => {
      steps.push(step);
      if (steps.length > STEPS_KEPT) steps.shift();
    };
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        const event = adapter.parse(line);
        if (!event) return;
        if (event.sessionId) record.sessionId = event.sessionId;
        // The last thing said is the answer; anything before it is on the way.
        if (event.text) said = event.text;
        for (const parsed of event.steps ?? []) {
          const known = calls.get(parsed.id);
          if (known) {
            if (parsed.text) known.text = parsed.text;
            if (parsed.detail) known.detail = parsed.detail;
            known.state = parsed.state;
          } else if (parsed.text) {
            const step: AssistantStep = { kind: 'tool', text: parsed.text, detail: parsed.detail ?? null, state: parsed.state };
            calls.set(parsed.id, step);
            add(step);
          }
        }
        if (event.steps) this.deps.onChange();
        if (event.done) done = event.done;
      });
    }
    child.on('error', (err) => {
      done = { ok: false, error: `could not run ${bin}: ${err.message}` };
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      this.running.delete(question.id);
      void rm(schemaDir, { recursive: true, force: true });
      const outcome: NonNullable<ParsedEvent['done']> = run.abortReason
        ? { ok: false, error: run.abortReason }
        : (done ?? {
            ok: false,
            error: `${cli} exited with code ${code}${stderr.length ? `: ${stderr.join('').trim().split('\n').slice(-3).join(' ')}` : ''}`,
          });
      void this.settle(question.id, record, outcome.ok ? { ok: true, reply: outcome.reply ?? said } : outcome);
    });
  }

  /** A session is over: keep its answer when it is JSON, or why it isn't. */
  private async settle(id: string, record: ProposalRecord, outcome: NonNullable<ParsedEvent['done']>): Promise<void> {
    // Dropped meanwhile, by a change of profile or CLI: what it found is for a question nobody is asking.
    if (this.file?.proposals[id] !== record) return;
    for (const step of this.steps.get(id) ?? []) if (step.state === 'running') step.state = outcome.ok ? 'done' : 'failed';
    if (outcome.ok) {
      try {
        record.result = JSON.parse(stripFence(outcome.reply ?? ''));
        record.status = 'ready';
        record.error = null;
        record.version += 1;
        const why = (record.result as { why?: unknown } | null)?.why;
        if (typeof why === 'string' && why.trim()) record.conversation.push({ from: 'it', text: why.trim() });
      } catch {
        record.status = 'failed';
        record.error = 'it answered, but not in the shape asked for';
      }
    } else {
      record.status = 'failed';
      record.error = outcome.error ?? 'failed';
    }
    await this.save();
    this.deps.onChange();
  }

  private async stop(id: string, reason: string): Promise<void> {
    const run = this.running.get(id);
    if (!run) return;
    run.abortReason = reason;
    run.child.kill('SIGTERM');
  }

  /** Forget a question's proposal, stopping its session first. */
  private async drop(id: string): Promise<void> {
    await this.stop(id, 'no longer needed');
    if (this.file) delete this.file.proposals[id];
    this.steps.delete(id);
  }

  /* ---------- what a question may read ---------- */

  /**
   * Look for the CLIs, once per process unless `again`. Only from a click or
   * from setup already under way: `--version` and a login check are programs
   * run on the user's behalf, and a new store's state is read before anyone is
   * at the screen.
   */
  private async lookForClis(again: boolean): Promise<void> {
    if (this.detected && !again) return;
    this.detecting ??= this.deps.detectClis().finally(() => {
      this.detecting = null;
    });
    this.detected = await this.detecting;
  }

  /**
   * The CLI answer to keep: one of the ready ones, or a path the user typed,
   * which is used only once it has said what it is and that it is ready.
   * Otherwise why not, in a sentence the card shows.
   */
  private async chooseCli(answer: Chosen): Promise<OnboardingAnswer | string> {
    const typed = answer.fields.path?.trim();
    if (!typed) {
      const picked = answer.choices.cli?.[0] as CliName | undefined;
      await this.lookForClis(false);
      if (picked && this.detected?.[picked]?.ready) return { choices: { cli: [picked] }, fields: {} };
      return 'Enter the path to codex or claude, or decide this later';
    }
    const { cli, found } = await this.deps.probeCli(expandHome(typed));
    if (!cli || !found.ready) {
      return `${found.problem ?? "That can't be used"}${found.fix ? `: run ${found.fix} in a terminal, then try again.` : '.'}`;
    }
    await this.lookForClis(false);
    this.detected = { ...this.detected!, [cli]: found };
    return { choices: { cli: [cli] }, fields: { path: found.path! } };
  }

  /**
   * The answers as they stand, with the CLI setup picked without asking when
   * the user hasn't picked one: the first ready, or the one already set.
   */
  private effective(ctx: QuestionContext, answers: Readonly<Record<string, OnboardingAnswer>>): Record<string, OnboardingAnswer> {
    if (answers.cli || !ctx.cli) return { ...answers };
    return { ...answers, cli: { choices: { cli: [ctx.cli] }, fields: {} } };
  }

  /** Set in the environment, which wins over setup: shown as it stands, never asked. */
  private locked(question: Question, sources: EnvSources): boolean {
    return question.keys.length > 0 && question.keys.every((key) => (sources.process[key] ?? '').trim() !== '');
  }

  /**
   * The settings these answers add up to, in question order, less what the
   * environment sets: that can't be saved over, and wins anyway.
   */
  private settingsOf(answers: Readonly<Record<string, OnboardingAnswer>>, ctx: QuestionContext): Record<string, string | null> {
    const sources = this.deps.readSources();
    const values: Record<string, string | null> = {};
    const effective = this.effective(ctx, answers);
    for (const question of this.questions(ctx)) {
      const chosen = this.locked(question, sources) ? null : given(effective[question.id]);
      if (chosen) Object.assign(values, question.settings?.(chosen, ctx) ?? {});
    }
    for (const key of Object.keys(values)) if ((sources.process[key] ?? '').trim() !== '') delete values[key];
    return values;
  }

  private questions(ctx: QuestionContext): Question[] {
    return QUESTIONS.filter((question) => !question.applies || question.applies(ctx));
  }

  /**
   * Everything a question may read. The CLI and the profile are the answers
   * when given, else what is in effect, else the card's own pick, so the
   * questions that follow from them are counted from the start.
   *
   * Calendar.app's calendars only as already listed, unless `listCalendars`:
   * the helper may ask for calendar access, so it is launched only from a
   * click, never from a state read, which any GET makes.
   */
  private async context(
    opts: { listCalendars?: boolean; answers?: Readonly<Record<string, OnboardingAnswer>>; setup?: SetupState } = {},
  ): Promise<QuestionContext> {
    const sources = this.deps.readSources();
    const env = layerEnv(sources);
    const current: Record<string, string> = {};
    for (const def of SETTINGS) {
      const value = (env[def.key] ?? '').trim();
      if (value) current[def.key] = value;
    }
    const setup = opts.setup ?? (await this.deps.setup());
    const answers = opts.answers ?? this.file?.answers ?? {};
    const profileAnswer = given(answers.profile)?.choices.profile?.[0];
    const profile: Profile = PROFILES.includes(profileAnswer as Profile)
      ? (profileAnswer as Profile)
      : current.DAILY_FOCUS_PROFILE === 'personal'
        ? 'personal'
        : 'work';
    // What looking found, with a path the user typed folded in: after a restart
    // the look is fresh, and knows nothing of it.
    const cliAnswer = given(answers.cli);
    const typed = cliAnswer?.fields.path?.trim();
    const answered = cliAnswer?.choices.cli?.[0] as CliName | undefined;
    let clis = this.detected;
    if (clis && typed && answered && CLI_NAMES.includes(answered) && clis[answered].path !== typed) {
      clis = { ...clis, [answered]: { ...clis[answered], path: typed, onPath: false, ready: true, problem: null, fix: null } };
    }
    const set = current.DAILY_FOCUS_AGENT as CliName | undefined;
    const cliLocked = (sources.process.DAILY_FOCUS_AGENT ?? '').trim() !== '';
    const cli: CliName | null = answers.cli
      ? (answered ?? null)
      : cliLocked
        ? (set && CLI_NAMES.includes(set) ? set : null)
        : set && clis?.[set]?.ready
          ? set
          : clis
            ? preferredCli(clis)
            : null;
    // Nothing reaches outside the dashboard until the user has answered
    // something, which is how it knows they are at the screen: a new store's
    // state is read before anyone is, and the calendar helper may ask for
    // access, a prompt that should come while they're there to answer it.
    const started = Object.keys(answers).length > 0;
    const profileKnown = started && (given(answers.profile) !== null || (sources.process.DAILY_FOCUS_PROFILE ?? '').trim() !== '');
    let calendars: CalendarListing[] | string | null = null;
    const liveAgenda = !['off', 'false', '0', 'no'].includes((current.DAILY_FOCUS_CALENDAR ?? '').toLowerCase());
    if (setup.calendar.supported && setup.calendar.built && liveAgenda) {
      if (opts.listCalendars === true && profileKnown) {
        this.calendars ??= this.deps.listCalendars().catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      }
      calendars = this.calendars ? await this.calendars : null;
    }
    const proposals: Record<string, unknown> = {};
    for (const [id, record] of Object.entries(this.file?.proposals ?? {})) {
      if (record.cli === cli && record.profile === profile && record.result !== null) proposals[id] = record.result;
    }
    return {
      profile,
      cli: cli && CLI_NAMES.includes(cli) ? cli : null,
      clis,
      identity: started ? await this.deps.identity() : { name: null, login: null, logins: [], email: null },
      calendars,
      calendar: setup.calendar,
      boards: await this.deps.boards(),
      current,
      proposals,
    };
  }

  /* ---------- the file ---------- */

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.file = parseFile(await readFile(this.config.onboardingFile, 'utf8'));
    } catch {
      this.file = null;
    }
  }

  /**
   * Write the file as it is now. One write at a time: sessions settle side by
   * side, and two renames of the same temporary file would trip over each other.
   */
  private save(): Promise<void> {
    const write = this.writes.then(async () => {
      if (!this.file) return;
      await mkdir(this.config.dataDir, { recursive: true });
      await writeJsonAtomic(this.config.onboardingFile, this.file);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private refuse(error: string): { error: string } {
    this.finishError = error;
    this.deps.onChange();
    return { error };
  }
}

/** The JSON in a reply that wrapped it in a code fence anyway. */
function stripFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return fenced ? fenced[1]! : text.trim();
}
