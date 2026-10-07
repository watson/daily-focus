/**
 * A realistic sample brief for each profile, dated relative to `now` so the agenda
 * and the "now" marker always look sensible whenever it is written. Used by
 * `npm run seed` and by the demo (see `demo.ts`, which adds everything around
 * it), and the best worked example of the payload shape: see
 * `schema/items.schema.json` and the morning prompts for the rules.
 *
 * Every name, account, ticket and letter in it is invented. The two briefs are
 * one person's two halves — Mara Lindqvist at Acme by day, at home after — so
 * the demo of either profile tells one coherent story.
 */

import type { Profile } from './config.ts';
import type { Brief, Item } from './types.ts';
import { localDateKey } from './time.ts';

/** Today at a given local time, as an ISO string. */
function timeOn(now: Date, hour: number, minute = 0): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString();
}

/** A local date key some days from today. */
export function dateFromNow(now: Date, days: number): string {
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/**
 * When the sample brief was written: 06:36 this morning, or a few minutes ago
 * when it is earlier than that, so a dashboard looked at before dawn never shows
 * a brief from the future.
 */
export function sampleGeneratedAt(now: Date): string {
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 36).getTime();
  const earlier = now.getTime() - 4 * 60_000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 10).getTime();
  return new Date(Math.max(start, Math.min(morning, earlier))).toISOString();
}

export function sampleBrief(now: Date = new Date(), profile: Profile = 'work'): Brief {
  return profile === 'personal' ? personalBrief(now) : workBrief(now);
}

/* ---------- work ---------- */

function workBrief(now: Date): Brief {
  const at = (hour: number, minute = 0) => timeOn(now, hour, minute);
  const daysFromNow = (days: number) => dateFromNow(now, days);

  const items: Item[] = [
    {
      id: 'workday:task:compliance-training-2026',
      source: 'workday',
      kind: 'task',
      title: 'Complete annual security & compliance training',
      detail: 'Workday has sent three reminders. Due end of day — after that it escalates to your manager.',
      url: 'https://wd5.myworkday.com/acme/d/task/compliance-2026',
      priority: 1,
      due: daysFromNow(0),
      firstSeen: daysFromNow(-6),
      tags: ['deadline'],
    },
    {
      id: 'github:pr:acme/webapp#3421',
      source: 'github',
      kind: 'task',
      title: 'Review requested: Fix session replay memory leak on long-lived tabs',
      detail:
        'Alice asked you directly 2 days ago; nobody else has looked. 4 files, +180/−62. ' +
        'Merging this is what unblocks the staging checkout path.',
      url: 'https://github.com/acme/webapp/pull/3421',
      priority: 2,
      firstSeen: daysFromNow(-2),
      people: ['@alice'],
      tags: ['review-requested'],
      advancesObjective: true,
    },
    {
      id: 'email:thread:18f2a9c4b7',
      source: 'email',
      kind: 'task',
      title: 'Re: Q4 headcount plan — Bob is waiting on your input',
      detail: 'They asked for the team split on Monday and followed up yesterday. Nothing sent back yet.',
      url: 'https://mail.google.com/mail/u/0/#inbox/18f2a9c4b7',
      priority: 3,
      firstSeen: daysFromNow(-3),
      people: ['bob@acme.example'],
    },
    {
      id: 'gtasks:task:MTU3NDkyODkwMjE2NDcx',
      source: 'tasks',
      kind: 'task',
      title: 'Write up the staging repro steps for the checkout breakage',
      detail: 'Your own note, and the only item here nobody else will ever chase. 42 minutes on it this morning.',
      due: daysFromNow(1),
      firstSeen: daysFromNow(-4),
      advancesObjective: true,
    },
    {
      id: 'workday:expense:berlin-offsite',
      source: 'workday',
      kind: 'task',
      title: 'Submit the expense report for the Berlin offsite',
      detail: 'Receipts are attached in Workday; the report has sat in draft since the trip.',
      url: 'https://wd5.myworkday.com/acme/d/expense/berlin-offsite',
      due: daysFromNow(5),
      firstSeen: daysFromNow(-8),
    },
    {
      id: 'github:pr:acme/webapp#3402',
      source: 'github',
      kind: 'task',
      title: 'CI failing on your PR: Add trace context to fetch instrumentation',
      detail:
        '`unit-tests (node-20)` is red. The failure is in `tracing/fetch.spec.ts`, which your diff touches — likely yours, not flaky infra.',
      url: 'https://github.com/acme/webapp/pull/3402',
      firstSeen: daysFromNow(-1),
      tags: ['ci-failing'],
    },
    {
      id: 'github:pr:acme/webapp#3395',
      source: 'github',
      kind: 'task',
      title: 'Open 3 days with no review: Bump chrome-launcher to 1.2.0',
      url: 'https://github.com/acme/webapp/pull/3395',
      firstSeen: daysFromNow(-3),
      tags: ['awaiting-review'],
    },
    {
      id: 'github:pr:acme/webapp#3430',
      source: 'github',
      kind: 'task',
      title: 'Draft PR is green — ready to mark for review?',
      detail: 'You opened this last night as a draft. All checks passed 40 minutes ago.',
      url: 'https://github.com/acme/webapp/pull/3430',
      firstSeen: daysFromNow(0),
      tags: ['draft', 'ci-green'],
    },
    {
      id: 'jira:PROJ-8842',
      source: 'jira',
      kind: 'task',
      title: 'PROJ-8842 still open — all 2 linked PRs are merged',
      detail: 'Assigned to you. Both PRs merged last week; the ticket never moved to Done.',
      url: 'https://acme.atlassian.net/browse/PROJ-8842',
      firstSeen: daysFromNow(-5),
    },
    {
      id: 'atlassian:page:sdk-sampling-design',
      source: 'atlassian',
      kind: 'task',
      title: 'Comment on the SDK sampling design doc — Dana asked for your review by Wednesday',
      detail: 'Two open questions are addressed to you in the margin, on the per-tab budget and the default rate.',
      url: 'https://acme.atlassian.net/wiki/spaces/PLAT/pages/8812001/SDK+sampling+design',
      due: daysFromNow(2),
      firstSeen: daysFromNow(-1),
      people: ['@dana'],
    },
    {
      id: 'slack:msg:C04ABCDE/1757480412.118',
      source: 'slack',
      kind: 'task',
      title: '#webapp-dev: Chris asked whether v6 can drop IE11 shims',
      detail: 'Direct question to you, 19 hours ago, still unanswered in-thread.',
      url: 'https://acme.slack.com/archives/C04ABCDE/p1757480412118',
      firstSeen: daysFromNow(-1),
      people: ['@chris'],
    },
    {
      id: 'email:thread:18f30bb211',
      source: 'email',
      kind: 'task',
      title: 'Travel: approve your Dublin flight option before 17:00',
      detail: 'The held fare expires this evening. Two options attached.',
      url: 'https://mail.google.com/mail/u/0/#inbox/18f30bb211',
      due: daysFromNow(0),
      firstSeen: daysFromNow(0),
      tags: ['travel'],
    },
    {
      id: 'email:thread:18f31c0d9e',
      source: 'email',
      kind: 'task',
      title: 'Renew the Chrome Web Store developer registration',
      detail: 'Google’s reminder; the registration runs out at the end of the month.',
      url: 'https://mail.google.com/mail/u/0/#inbox/18f31c0d9e',
      due: daysFromNow(20),
      firstSeen: daysFromNow(-3),
    },
    {
      id: 'calendar:event:standup',
      source: 'calendar',
      kind: 'event',
      title: 'Webapp standup',
      start: at(9, 30),
      end: at(9, 45),
      url: 'https://meet.google.com/abc-defg-hij',
    },
    {
      id: 'calendar:event:1on1',
      source: 'calendar',
      kind: 'event',
      title: '1:1 with Alice',
      start: at(11, 0),
      end: at(11, 30),
    },
    {
      id: 'calendar:event:design-review',
      source: 'calendar',
      kind: 'event',
      title: 'Design review: search indexing v3',
      start: at(11, 15),
      end: at(12, 0),
    },
    {
      id: 'calendar:event:lunch-and-learn',
      source: 'calendar',
      kind: 'event',
      title: 'Lunch & learn: tracing in production (optional)',
      start: at(12, 30),
      end: at(13, 0),
      blocking: false,
    },
    {
      id: 'calendar:event:sync',
      source: 'calendar',
      kind: 'event',
      title: 'Platform ↔ Infra sync',
      start: at(15, 0),
      end: at(16, 0),
    },
    {
      id: 'calendar:holiday:us-labor-day',
      source: 'calendar',
      kind: 'info',
      title: 'US public holiday today — most American colleagues are off',
      detail: 'Expect slow replies from colleagues there.',
      firstSeen: daysFromNow(0),
    },
    {
      id: 'calendar:holiday:local-national-day',
      source: 'calendar',
      kind: 'info',
      title: `Local public holiday in 9 days (${daysFromNow(9)}) — office closed`,
      firstSeen: daysFromNow(0),
    },
  ];

  return {
    version: 1,
    generatedAt: sampleGeneratedAt(now),
    generatedBy: 'codex (sample data)',
    date: localDateKey(now),
    headline:
      'Two things are genuinely time-boxed today: the **compliance training**, due tonight, and the Dublin fare that ' +
      'expires at 17:00. Alice’s review request on `webapp#3421` is the one thing here that moves the objective, and ' +
      '12:00–15:00 is your only real focus block for it.',
    items,
  };
}

/* ---------- personal ---------- */

function personalBrief(now: Date): Brief {
  const at = (hour: number, minute = 0) => timeOn(now, hour, minute);
  const daysFromNow = (days: number) => dateFromNow(now, days);

  const items: Item[] = [
    {
      id: 'eboks:message:4417820931',
      source: 'eboks',
      kind: 'task',
      title: 'Pay the daycare invoice before Friday',
      detail: 'Letter from the kommune in e-Boks: 3,250 kr. A late fee is added after the due date.',
      priority: 1,
      due: daysFromNow(3),
      firstSeen: daysFromNow(-2),
      tags: ['payment', 'deadline'],
    },
    {
      id: 'email:thread:19a0c4e2f1',
      source: 'email',
      kind: 'task',
      title: 'Chase Nordvarme for the loft insulation quote',
      detail: 'They promised it “within the week” nine days ago. Nothing since, and the other two quotes are in.',
      url: 'https://mail.google.com/mail/u/0/#inbox/19a0c4e2f1',
      priority: 2,
      firstSeen: daysFromNow(-5),
      people: ['tilbud@nordvarme.example'],
      advancesObjective: true,
    },
    {
      id: 'messages:thread:chat8812/5C1F0A2E-77B4',
      source: 'messages',
      kind: 'task',
      title: 'Reply to Jonas about Saturday’s dinner — he asked for a time',
      detail: 'Asked on Tuesday; the group has gone quiet since.',
      priority: 3,
      firstSeen: daysFromNow(-1),
      people: ['Jonas'],
      tags: ['reply-owed'],
    },
    {
      id: 'eboks:message:4417911204',
      source: 'eboks',
      kind: 'task',
      title: 'Check the deductions on your annual tax assessment',
      detail: 'Skattestyrelsen’s assessment is ready. Corrections are accepted until the deadline; after that the figure stands.',
      due: daysFromNow(20),
      firstSeen: daysFromNow(-5),
      tags: ['deadline'],
    },
    {
      id: 'email:thread:19a0d1b7c3',
      source: 'email',
      kind: 'task',
      title: 'Sign Noa’s field-trip permission slip by Thursday',
      detail: 'The school sent the form on Monday; it needs a signature and a packed lunch note.',
      url: 'https://mail.google.com/mail/u/0/#inbox/19a0d1b7c3',
      due: daysFromNow(2),
      firstSeen: daysFromNow(-1),
      people: ['Noa’s school'],
    },
    {
      id: 'email:thread:19a0b9f0a2',
      source: 'email',
      kind: 'task',
      title: 'Confirm Ida’s dentist appointment on the 14th',
      detail: 'Tandlægehuset asks for a reply; otherwise the slot is released on Friday.',
      url: 'https://mail.google.com/mail/u/0/#inbox/19a0b9f0a2',
      firstSeen: daysFromNow(-3),
      people: ['Tandlægehuset'],
    },
    {
      id: 'messages:thread:chat7731/9A3D4B6C-1E22',
      source: 'messages',
      kind: 'task',
      title: 'Send Priya the photos from the cabin weekend — you said you would',
      firstSeen: daysFromNow(-4),
      people: ['Priya'],
      tags: ['promised'],
    },
    {
      id: 'reminders:item:9E1B7C3D-2A44',
      source: 'reminders',
      kind: 'task',
      title: 'Book the car’s service before the inspection in November',
      detail: 'From your Home list. The garage takes about two weeks to find a slot.',
      due: daysFromNow(25),
      firstSeen: daysFromNow(-9),
    },
    {
      id: 'reminders:list:3F0C9A11-6D2E',
      source: 'reminders',
      kind: 'info',
      title: 'Home list: 7 reminders, nothing touched since May — worth five minutes to prune',
      firstSeen: daysFromNow(-2),
    },
    {
      id: 'github:pr:mara-l/pedalboard#47',
      source: 'github',
      kind: 'task',
      title: 'A contributor’s pull request on pedalboard has waited 6 days: Add MIDI clock sync',
      detail: 'Tomas’s first contribution. A review, even a short one, is what keeps a contributor around.',
      url: 'https://github.com/mara-l/pedalboard/pull/47',
      firstSeen: daysFromNow(-3),
      people: ['@tomas-k'],
      tags: ['review-requested'],
    },
    {
      id: 'calendar:event:sam-away',
      source: 'calendar',
      kind: 'event',
      title: 'Sam away — back Thursday',
      start: daysFromNow(0),
    },
    {
      id: 'calendar:event:daycare-pickup',
      source: 'calendar',
      kind: 'event',
      title: 'Pick up Ida from daycare',
      start: at(16, 15),
      end: at(16, 45),
    },
    {
      id: 'calendar:event:insurance-call',
      source: 'calendar',
      kind: 'event',
      title: 'Call with the insurance adjuster about the water damage',
      start: at(16, 30),
      end: at(17, 0),
    },
    {
      id: 'calendar:event:football',
      source: 'calendar',
      kind: 'event',
      title: 'Noa’s football practice — Jonas drives this week',
      start: at(17, 0),
      end: at(18, 0),
      blocking: false,
    },
    {
      id: 'calendar:event:parcel',
      source: 'calendar',
      kind: 'event',
      title: 'Parcel: new router, delivery window',
      start: at(18, 0),
      end: at(21, 0),
      blocking: false,
    },
    {
      id: 'calendar:event:book-club',
      source: 'calendar',
      kind: 'event',
      title: 'Book club at Priya’s',
      start: at(20, 0),
      end: at(21, 30),
    },
    {
      id: 'calendar:holiday:autumn-break',
      source: 'calendar',
      kind: 'info',
      title: `School autumn holiday starts in 9 days (${daysFromNow(9)}) — Noa is off all week`,
      firstSeen: daysFromNow(0),
    },
  ];

  return {
    version: 1,
    generatedAt: sampleGeneratedAt(now),
    generatedBy: 'codex (sample data)',
    date: localDateKey(now),
    headline:
      'Two things have real deadlines: the **daycare invoice** on Friday and Noa’s permission slip on Thursday. ' +
      'Sam is away until Thursday, so the evening is yours after the 16:15 pickup — and the insulation quote has ' +
      'now been quiet for nine days.',
    items,
  };
}
