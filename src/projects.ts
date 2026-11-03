/**
 * The order a project's tickets can land in, from Jira's blocks links: which
 * ticket waits for which, what goes round in a loop, and what each ticket still
 * waits for.
 *
 * Pure, for the reason `tickets.ts` is: the plan is a judgement about facts
 * that are read elsewhere, so it is derived on every read and never stored.
 *
 * A link is taken at Jira's word and nothing more. "Blocks" means the blocked
 * ticket's work can't land before the blocker's, which is the only claim the
 * order makes; stacked pull requests are a GitHub fact, and the page adds them.
 */

import type { OutsideTicket, ProjectPlan, ProjectTicket, TicketStatusCategory } from './types.ts';

/**
 * The plan for a project's tickets, given in Jira's order.
 *
 * `outside` supplies the status of the tickets beyond the project that a link
 * names, so a ticket waiting on a finished one elsewhere is not shown waiting.
 * A blocker known only by its key, neither inside nor outside, is assumed not
 * to be done: saying a ticket is free to go when it is not is the mistake that
 * costs something.
 */
export function planProject(tickets: readonly ProjectTicket[], outside: readonly OutsideTicket[] = []): ProjectPlan {
  const index = new Map(tickets.map((ticket, i) => [ticket.key, i]));
  const category = new Map<string, TicketStatusCategory>();
  for (const ticket of outside) category.set(ticket.key, ticket.statusCategory);
  for (const ticket of tickets) category.set(ticket.key, ticket.statusCategory);
  const done = (key: string): boolean => category.get(key) === 'done';

  // Edges run from blocker to blocked, inside the project only, and from both
  // ends' links: a ticket whose own links could not be read still shows up as
  // the blocker its neighbours name.
  const after = new Map<string, Set<string>>(tickets.map((ticket) => [ticket.key, new Set<string>()]));
  const link = (blocker: string, blocked: string): void => {
    if (index.has(blocker) && index.has(blocked)) after.get(blocker)!.add(blocked);
  };
  // Every blocker of each ticket, from its own links and from those naming it.
  const blockers = new Map<string, Set<string>>(tickets.map((ticket) => [ticket.key, new Set(ticket.blockedBy)]));
  for (const ticket of tickets) {
    for (const blocker of ticket.blockedBy) link(blocker, ticket.key);
    for (const blocked of ticket.blocks) {
      link(ticket.key, blocked);
      blockers.get(blocked)?.add(ticket.key);
    }
  }

  const waitsFor: Record<string, string[]> = {};
  for (const ticket of tickets) {
    waitsFor[ticket.key] = [...blockers.get(ticket.key)!]
      .filter((key) => key !== ticket.key && !done(key))
      .sort((a, b) => (index.get(a) ?? Infinity) - (index.get(b) ?? Infinity) || a.localeCompare(b));
  }

  const components = stronglyConnected(tickets.map((ticket) => ticket.key), after);
  const loops = components
    .filter((members) => members.length > 1 || after.get(members[0]!)!.has(members[0]!))
    .map((members) => [...members].sort((a, b) => index.get(a)! - index.get(b)!))
    .sort((a, b) => index.get(a[0]!)! - index.get(b[0]!)!);

  return { order: orderComponents(components, after, index, done), loops, waitsFor };
}

/**
 * Tarjan's strongly connected components, iteratively so a long chain of
 * tickets can't run out of stack. Each component is a loop when it has more
 * than one member; a single ticket is its own component.
 */
function stronglyConnected(keys: readonly string[], after: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let counter = 0;
  const number = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const start of keys) {
    if (number.has(start)) continue;
    const work: { key: string; next: Iterator<string> }[] = [];
    const visit = (key: string): void => {
      number.set(key, counter);
      low.set(key, counter);
      counter++;
      stack.push(key);
      onStack.add(key);
      work.push({ key, next: after.get(key)![Symbol.iterator]() });
    };
    visit(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const step = frame.next.next();
      if (!step.done) {
        const to = step.value;
        if (!number.has(to)) visit(to);
        else if (onStack.has(to)) low.set(frame.key, Math.min(low.get(frame.key)!, number.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      if (low.get(frame.key) === number.get(frame.key)) {
        const members: string[] = [];
        for (;;) {
          const key = stack.pop()!;
          onStack.delete(key);
          members.push(key);
          if (key === frame.key) break;
        }
        components.push(members);
      }
    }
  }
  return components;
}

/**
 * The tickets in an order that keeps every blocker ahead of what it blocks,
 * treating each loop as one unit. Of the units free to go next, a finished one
 * goes first and then the one Jira lists earliest, so two reads of the same
 * links give the same order.
 */
function orderComponents(
  components: readonly string[][],
  after: ReadonlyMap<string, ReadonlySet<string>>,
  index: ReadonlyMap<string, number>,
  done: (key: string) => boolean,
): string[] {
  const unitOf = new Map<string, number>();
  components.forEach((members, unit) => members.forEach((key) => unitOf.set(key, unit)));

  const waiting = components.map(() => 0);
  const next = components.map(() => new Set<number>());
  components.forEach((members, unit) => {
    for (const key of members) {
      for (const to of after.get(key)!) {
        const target = unitOf.get(to)!;
        if (target !== unit && !next[unit]!.has(target)) {
          next[unit]!.add(target);
          waiting[target]!++;
        }
      }
    }
  });

  const rank = (unit: number): [number, number] => {
    const members = components[unit]!;
    return [members.every(done) ? 0 : 1, Math.min(...members.map((key) => index.get(key)!))];
  };
  const before = (a: number, b: number): boolean => {
    const [doneA, firstA] = rank(a);
    const [doneB, firstB] = rank(b);
    return doneA !== doneB ? doneA < doneB : firstA < firstB;
  };

  const ready = components.map((_, unit) => unit).filter((unit) => waiting[unit] === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) if (before(ready[i]!, ready[best]!)) best = i;
    const unit = ready.splice(best, 1)[0]!;
    order.push(...[...components[unit]!].sort((a, b) => index.get(a)! - index.get(b)!));
    for (const target of next[unit]!) if (--waiting[target]! === 0) ready.push(target);
  }
  return order;
}
