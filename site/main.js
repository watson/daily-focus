// The page's few behaviours. Everything here is an enhancement: without script
// the page shows the brief the sort ends on, the launch objective's brief, and
// the commands to copy by hand.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- Copy buttons ---------- */

for (const button of document.querySelectorAll('[data-copy]')) {
  let reset;
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy)?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      // No clipboard (an http page, or permission refused): select the text instead.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(button.dataset.copy));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      button.textContent = 'Selected';
    }
    clearTimeout(reset);
    reset = setTimeout(() => (button.textContent = 'Copy'), 2000);
  });
}

/* ---------- The sort: the morning's pile, down to three ---------- */

/** How long the stream takes to run past the reading line. */
const READ_MS = 4200;
/** How long a pick takes to lift out of the stream into the tray. */
const CATCH_MS = 520;
/** Then the stream fades, the picks line up and swell into cards. */
const SIFT_MS = 450;
const GATHER_MS = 650;
const SWELL_MS = 560;
/** How long the cards take to fill in, and the panel to come up around them. */
const CARDS_MS = 750;
const PANEL_MS = 800;
/** Between one pick and the next, as they line up and swell. */
const STAGGER_MS = 90;
/** The tray's slots, one under another. */
const SLOT_PX = 34;

function sort() {
  const figure = document.querySelector('[data-sort]');
  if (!figure || reduceMotion.matches) return;
  const stage = figure.querySelector('.sort__stage');
  const tray = figure.querySelector('.sort__tray');
  const view = figure.querySelector('.sort__window');
  const wall = figure.querySelector('.sort__wall');
  const tally = figure.querySelector('[data-tally]');
  const lines = [...wall.querySelectorAll('span')];
  const rows = [...figure.querySelectorAll('.sort__brief .row')];
  const replay = figure.querySelector('[data-replay]');

  // A fixed scatter of shades, so the pile looks the same on every visit.
  lines.forEach((line, i) => line.style.setProperty('--o', (0.45 + ((((i + 1) * 37) % 101) / 101) * 0.4).toFixed(2)));

  let timers = [];
  let frame = 0;
  let picks = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const stop = () => {
    timers.forEach(clearTimeout);
    timers = [];
    cancelAnimationFrame(frame);
    for (const pick of picks) pick?.chip.remove(), pick?.words.remove();
    picks = [];
  };
  const STATES = ['is-reading', 'is-sifting', 'is-gathering', 'is-swelling', 'is-cards', 'is-panel', 'is-done'];
  const enter = (...states) => {
    figure.classList.remove(...STATES);
    figure.classList.add(...states);
  };

  // Where things are, relative to the stage the stand-ins are placed in.
  const within = (rect) => {
    const box = stage.getBoundingClientRect();
    return { x: rect.left - box.left, y: rect.top - box.top, w: rect.width, h: rect.height };
  };
  const px = (n) => `${n}px`;
  const place = (r) => ({ left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) });
  const pad = (r, n) => ({ x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n });
  // The words keep their own height, so a title that wraps in its card can wrap.
  const spot = (r, extra = 0) => ({ left: px(r.x), top: px(r.y), width: px(r.w + extra) });
  const glide = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

  // The stream starts with its first line just under the reading line and
  // ends with its last just over it; every line is read on the way.
  const course = () => {
    const at = view.clientHeight * parseFloat(getComputedStyle(view).getPropertyValue('--read-at'));
    const middles = lines.map((line) => line.offsetTop + line.offsetHeight / 2);
    return { at, middles, from: at - Math.min(...middles) + 10, to: at - Math.max(...middles) - 6 };
  };
  const rest = () => (wall.style.transform = `translateY(${course().from}px)`);
  rest();
  document.fonts?.ready.then(() => figure.classList.contains('is-reading') || rest());

  // A pick becomes a tag: a chip and its words, which lift into the tray.
  const lift = (line) => {
    const i = Number(line.dataset.row) - 1;
    const from = within(line.getBoundingClientRect());
    const slot = { ...from, x: 0, y: within(tray.getBoundingClientRect()).y + 4 + i * SLOT_PX };
    const chip = Object.assign(document.createElement('div'), { className: 'sort__chip' });
    const words = Object.assign(document.createElement('p'), { className: 'sort__words', textContent: line.textContent });
    for (const el of [chip, words]) el.setAttribute('aria-hidden', 'true');
    const size = getComputedStyle(line).fontSize;
    Object.assign(chip.style, place(pad(from, 3)));
    Object.assign(words.style, { ...spot(from, 2), lineHeight: px(from.h), fontSize: size });
    stage.append(chip, words);
    line.classList.add('is-read');
    // A small pop where it was picked, then up into its slot.
    const timing = { duration: CATCH_MS, easing: glide, fill: 'both' };
    chip.animate(
      [
        { ...place(pad(from, 3)), transform: 'scale(1)' },
        { ...place(pad(from, 3)), transform: 'scale(1.08)', offset: 0.2 },
        { ...place(pad(slot, 3)), transform: 'scale(1)' },
      ],
      timing,
    );
    words.animate(
      [
        { ...spot(from, 2), transform: 'scale(1)' },
        { ...spot(from, 2), transform: 'scale(1.08)', offset: 0.2 },
        { ...spot(slot, 2), transform: 'scale(1)' },
      ],
      timing,
    );
    picks[i] = { chip, words, at: slot, size };
  };

  const read = () => {
    enter('is-reading');
    const { at, middles, from, to } = course();
    const order = lines.map((line, i) => ({ line, y: middles[i] })).sort((a, b) => a.y - b.y);
    const ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;
    const start = performance.now();
    let next = 0;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / READ_MS);
      const shift = from + (to - from) * ease(p);
      wall.style.transform = `translateY(${shift}px)`;
      while (next < order.length && order[next].y + shift <= at) {
        const { line } = order[next++];
        if (line.classList.contains('is-kept')) lift(line);
        else line.classList.add('is-read');
      }
      tally.textContent = String(Math.round((147 * next) / order.length));
      if (p < 1) frame = requestAnimationFrame(tick);
      else later(Math.max(300, CATCH_MS), sift);
    };
    frame = requestAnimationFrame(tick);
  };

  const sift = () => {
    enter('is-sifting');
    later(SIFT_MS, gather);
  };

  const gather = () => {
    // The rows the picks become are laid out already, only hidden.
    const plan = picks.map((pick, i) => {
      const row = rows[i];
      const title = row.querySelector('.row__title');
      const words = document.createRange();
      words.selectNodeContents(title);
      const look = getComputedStyle(title);
      const card = getComputedStyle(row);
      return {
        ...pick,
        title: within(title.getBoundingClientRect()),
        text: within(words.getBoundingClientRect()),
        row: within(row.getBoundingClientRect()),
        lineHeight: parseFloat(look.lineHeight),
        titleSize: look.fontSize,
        ink: look.color,
        surface: card.backgroundColor,
        border: card.borderTopColor,
        radius: card.borderTopLeftRadius,
        shadow: card.boxShadow,
      };
    });
    const tag = getComputedStyle(plan[0].chip);
    const tagInk = getComputedStyle(plan[0].words).color;

    enter('is-sifting', 'is-gathering');
    const last = plan.length - 1;
    plan.forEach((p, i) => {
      // The lowest pick leaves first, so none passes over another on the way down.
      const delay = (last - i) * STAGGER_MS;
      // First the picks line up where the titles will be, growing to their size.
      p.words.animate(
        [
          { ...spot(p.at, 2), lineHeight: px(p.at.h), fontSize: p.size, fontWeight: 400 },
          { ...spot(p.title), lineHeight: px(p.lineHeight), fontSize: p.titleSize, fontWeight: 600 },
        ],
        { duration: GATHER_MS, delay, easing: glide, fill: 'both' },
      );
      p.chip.animate([place(pad(p.at, 3)), place(pad(p.text, 3))], { duration: GATHER_MS, delay, easing: glide, fill: 'both' });
      // Then, in rank order, each pops out into its card, and its words take the card's ink.
      later(GATHER_MS + (last + i) * STAGGER_MS, () => {
        if (i === 0) enter('is-sifting', 'is-gathering', 'is-swelling');
        p.chip.animate(
          [
            { ...place(pad(p.text, 3)), backgroundColor: tag.backgroundColor, borderColor: 'transparent', borderRadius: '3px', boxShadow: 'none' },
            { ...place(p.row), backgroundColor: p.surface, borderColor: p.border, borderRadius: p.radius, boxShadow: p.shadow },
          ],
          // A touch past its size and back: the card pops out of the tag.
          { duration: SWELL_MS, easing: 'cubic-bezier(0.3, 1.3, 0.5, 1)', fill: 'forwards' },
        );
        p.words.animate([{ color: tagInk }, { color: p.ink }], { duration: SWELL_MS, fill: 'forwards' });
      });
    });

    // The last card is whole. From here the brief builds outwards: the real
    // rows take over and fill in, then the panel comes up around them.
    later(GATHER_MS + SWELL_MS + 2 * last * STAGGER_MS + 40, () => {
      enter('is-cards');
      stop();
      later(CARDS_MS, () => enter('is-panel'));
      later(CARDS_MS + PANEL_MS, () => {
        enter('is-done');
        replay.hidden = false;
      });
    });
  };

  const play = () => {
    stop();
    figure.classList.add('is-instant');
    enter();
    for (const line of lines) line.classList.remove('is-read');
    tally.textContent = '0';
    rest();
    replay.hidden = true;
    void figure.offsetWidth;
    figure.classList.remove('is-instant');
    later(300, read);
  };

  // Play once someone can see it: the page in front, and the pile in view.
  let inView = false;
  let started = false;
  const start = () => {
    if (started || !inView || document.hidden) return;
    started = true;
    later(400, play);
  };
  new IntersectionObserver(
    (entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      start();
    },
    { threshold: 0.6 },
  ).observe(stage);
  document.addEventListener('visibilitychange', start);
  replay.addEventListener('click', play);
  reduceMotion.addEventListener('change', () => {
    if (!reduceMotion.matches) return;
    stop();
    enter('is-done');
    replay.hidden = true;
  });
}

sort();

/* ---------- The objective: the same morning, ranked against each ---------- */

// The rows the four objectives draw on. Each objective picks three, in order,
// and may say why in its own words.
const ROWS = {
  review: {
    title: '<span class="row__repo">acme/webapp</span> Review requested: Fix rounding in gift card balances',
    src: ['GitHub', 'github'],
    who: '@alice',
    pills: '<span class="pill pill--warning">2 days on the list</span>',
    detail: 'Alice asked you directly 2 days ago; nobody else has looked.',
  },
  training: {
    title: 'Complete annual security &amp; compliance training',
    src: ['Workday', 'workday'],
    pills: '<span class="pill pill--critical">due today</span><span class="pill pill--warning">6 days on the list</span>',
    detail: 'Workday has sent three reminders. After tonight it goes to your manager.',
  },
  bob: {
    title: 'Re: Q4 headcount plan — Bob is waiting on your input',
    src: ['Email', 'email'],
    who: 'bob@acme.example',
    pills: '<span class="pill pill--warning">3 days on the list</span>',
    detail: 'He asked for the team split on Monday and followed up yesterday. Nothing sent back yet.',
  },
  written: {
    title: 'No path to faster checkout today. Protect 12:00–15:00 for profiling the slow requests',
    src: ['Other', 'other'],
    pills: '',
    detail: 'Nothing that came in moves the objective, and nobody is going to write and tell you so. 12:00–15:00 is your one free block long enough.',
  },
};

const GOALS = {
  launch: {
    objective: 'Launch gift cards before the holiday sale',
    blocked: 'the rounding fix in webapp#3421 is still waiting on review',
    note: 'Alice’s review on <code>webapp#3421</code> is the one thing here that moves the objective, and 12:00–15:00 is your only real focus block for it. The compliance training is due tonight.',
    says: 'Alice’s review comes first: merging it is what gets gift cards to staging. The louder threads wait their turn.',
    rows: [
      ['review', { objective: true, detail: 'Alice asked you directly 2 days ago; nobody else has looked. Merging it is what lets gift cards go live in staging.' }],
      ['training'],
      ['bob'],
    ],
  },
  hire: {
    objective: 'Hire two engineers for the Platform team',
    blocked: 'Platform’s share of the Q4 roles isn’t agreed',
    note: 'Bob’s headcount thread decides whether Platform gets its two roles, and the planning deck locks on Friday. Answer it before the 15:00 sync.',
    says: 'Same morning, same mail. Now Bob’s thread comes first, because his split decides whether Platform gets the roles.',
    rows: [
      ['bob', { objective: true, detail: 'His split decides whether Platform gets the two roles. He asked on Monday and followed up yesterday.' }],
      ['training'],
      ['review'],
    ],
  },
  speed: {
    objective: 'Halve the checkout page’s load time',
    blocked: 'nobody has profiled the slow checkout requests yet',
    note: 'Nothing that came in today moves the checkout work, so the time for it has to come from you. 12:00–15:00 is the only block long enough.',
    says: 'Nothing that came in moves this one. So the brief says that, and makes room for it at the top. No email would have told you.',
    rows: [['written', { objective: true }], ['training'], ['review']],
  },
  none: {
    objective: null,
    note: 'Two things are time-boxed today: the <b>compliance training</b>, due tonight, and the Lisbon fare that expires at 17:00.',
    says: 'With no objective, it ranks by deadlines and by who’s waiting. That helps, but it can’t know which work matters most to you.',
    rows: [['training'], ['bob'], ['review']],
  },
};

function objective() {
  const goals = document.querySelector('[data-goals]');
  const brief = document.querySelector('[data-brief]');
  if (!goals || !brief) return;
  const list = brief.querySelector('[data-rows]');
  const says = document.querySelector('[data-says]');
  const label = brief.querySelector('[data-label]');
  const text = brief.querySelector('[data-objective]');
  const blocked = brief.querySelector('[data-blocked]');
  const note = brief.querySelector('[data-note]');
  let swap;

  const row = (key, rank, { objective = false, detail } = {}) => {
    const r = ROWS[key];
    const pills = (objective ? '<span class="pill pill--accent">objective</span>' : '') + r.pills;
    return (
      `<span class="row__rank">${rank}</span><div>` +
      `<p class="row__title">${r.title}</p>` +
      `<p class="row__meta"><span class="src" style="--src: var(--src-${r.src[1]})">${r.src[0]}</span>` +
      `${r.who ? `<span class="muted">${r.who}</span>` : ''}${pills}</p>` +
      `<p class="row__detail">${detail ?? r.detail}</p></div>`
    );
  };

  const band = (goal) => {
    brief.classList.toggle('brief--empty', !goal.objective);
    label.textContent = goal.objective ? 'Current objective' : 'No current objective';
    text.textContent = goal.objective ?? 'Set one to have the day ranked against it.';
    blocked.hidden = !goal.blocked;
    blocked.querySelector('span').textContent = goal.blocked ?? '';
    note.innerHTML = goal.note;
  };

  const choose = (key) => {
    const goal = GOALS[key];
    if (!goal) return;
    const motion = !reduceMotion.matches;
    const was = new Map([...list.children].map((el) => [el.dataset.key, el]));
    const from = new Map([...was].map(([k, el]) => [k, el.getBoundingClientRect().top]));

    const rows = goal.rows.map(([k, opts], i) => {
      const el = was.get(k) ?? Object.assign(document.createElement('li'), { className: 'row' });
      el.dataset.key = k;
      el.classList.toggle('row--written', k === 'written');
      el.classList.toggle('is-entering', motion && !was.has(k));
      el.innerHTML = row(k, i + 1, opts);
      return el;
    });
    list.replaceChildren(...rows);
    says.textContent = goal.says;

    // Each row that stayed slides from where it was to where it ranks now.
    if (motion) {
      for (const el of rows) {
        const top = from.get(el.dataset.key);
        if (top === undefined) continue;
        const dy = top - el.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) continue;
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
          duration: 480,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        });
      }
    }

    clearTimeout(swap);
    if (!motion) return band(goal);
    brief.classList.add('is-changing');
    swap = setTimeout(() => {
      band(goal);
      brief.classList.remove('is-changing');
    }, 200);
  };

  list.addEventListener('animationend', (event) => event.target.classList.remove('is-entering'));
  goals.addEventListener('change', (event) => choose(event.target.value));
  goals.hidden = false;
}

objective();

/* ---------- The assistant, replayed ---------- */

// What the assistant did for Mara on each quick action: its steps, how long the
// panel says it worked, and its answer. The draft is the demo's own turn on this
// thread (src/demo.ts); the other two are written to the same thread.
const ASKS = {
  draft: {
    label: 'Draft a reply',
    seconds: 64,
    steps: [
      ['tool', 'Gmail: get thread'],
      ['tool', 'Gmail: search threads <code>Q4 planning doc headcount</code>'],
      ['said', 'Bob wants numbers per team with a reason each. The planning doc has both.'],
      ['tool', 'Gmail: create draft'],
    ],
    answer:
      '<p>He wants the Q4 team split: how many of the six open roles go to Platform and how many to Webapp, with a line of justification each, by the end of the week.</p>' +
      '<p>I have created a Gmail draft on the thread proposing four Platform and two Webapp, with the reasons from the planning doc. It is <b>not sent</b>; it is waiting on the thread when you open it.</p>',
    actions: ['Copy reply', 'Open draft'],
  },
  summary: {
    label: 'Summarise the thread',
    seconds: 21,
    steps: [
      ['tool', 'Gmail: get thread'],
      ['said', 'Four messages. Bob asked twice; Alice added when the deck locks.'],
    ],
    answer:
      '<p>Bob is planning Q4 hiring and needs your team split: how many of the six open roles go to Platform and how many to Webapp, with a line on why for each.</p>' +
      '<p>He asked on Monday and followed up yesterday. Alice added that the planning deck locks on Friday, so that is the real deadline. Nobody has answered yet.</p>',
    actions: ['Copy reply'],
  },
  need: {
    label: 'What do they need from me?',
    seconds: 29,
    steps: [
      ['tool', 'Gmail: get thread'],
      ['tool', 'Gmail: search threads <code>from:bob Q4</code>'],
    ],
    answer:
      '<p><b>The team split, by Friday.</b> Six open roles divided between Platform and Webapp, with one line on why for each, so it can go in the planning deck. The budget and the timing are settled already; that split is all Bob is waiting on.</p>',
    actions: ['Copy reply'],
  },
};

/** How long each step takes to tick by in the replay. */
const STEP_MS = 650;

function assistantReplay() {
  const turn = document.querySelector('[data-turn]');
  const chips = [...document.querySelectorAll('[data-ask]')];
  if (!turn || chips.length === 0) return;
  let timers = [];

  const head = (ask) => `<p class="turn__head"><b>${ask.label}</b> <span class="muted">· just now</span></p>`;
  const item = ([kind, text]) => `<li${kind === 'said' ? ' class="said"' : ''}>${text}</li>`;
  const steps = (n) => `${n} ${n === 1 ? 'step' : 'steps'}`;

  // The turn as the panel leaves it: the trail folded under its answer.
  const finished = (ask) => {
    turn.innerHTML =
      head(ask) +
      `<details class="turn__trail"><summary>Worked for ${ask.seconds} s · ${steps(ask.steps.length)}</summary><ul>${ask.steps.map(item).join('')}</ul></details>` +
      `<div class="answer">${ask.answer}</div>` +
      `<p class="panel__actions">${ask.actions.map((label) => `<span class="button button--ui">${label}</span>`).join('')}</p>`;
  };

  const play = (key) => {
    const ask = ASKS[key];
    if (!ask) return;
    timers.forEach(clearTimeout);
    timers = [];
    for (const chip of chips) {
      const on = chip.dataset.ask === key;
      chip.classList.toggle('chip--on', on);
      chip.setAttribute('aria-pressed', String(on));
    }
    turn.classList.remove('is-landed');
    if (reduceMotion.matches) {
      finished(ask);
      return;
    }

    // While it works: what it is doing, a clock, and each step as it goes.
    for (const chip of chips) chip.disabled = true;
    turn.innerHTML = `${head(ask)}<p class="turn__working"><span class="spinner"></span><span>Working</span></p><ul class="turn__steps"></ul>`;
    const list = turn.querySelector('.turn__steps');
    const status = turn.querySelector('.turn__working span:last-child');
    const later = (ms, fn) => timers.push(setTimeout(fn, ms));
    const total = ask.steps.length;
    ask.steps.forEach((step, index) => {
      later(200 + index * STEP_MS, () => {
        list.lastElementChild?.classList.remove('is-running');
        list.insertAdjacentHTML('beforeend', item(step));
        list.lastElementChild.classList.add('is-running');
        status.textContent = `Working · ${Math.round((ask.seconds * (index + 1)) / (total + 1))} s · ${steps(index + 1)}`;
      });
    });
    later(200 + total * STEP_MS, () => list.lastElementChild?.classList.remove('is-running'));
    later(200 + total * STEP_MS + 400, () => {
      finished(ask);
      turn.classList.add('is-landed');
      for (const chip of chips) chip.disabled = false;
    });
  };

  for (const chip of chips) chip.addEventListener('click', () => play(chip.dataset.ask));
}

assistantReplay();

/* ---------- Handle an item ---------- */

function handleCard() {
  const card = document.querySelector('[data-handle]');
  if (!card) return;
  const toast = card.querySelector('.toast');
  const text = toast.querySelector('.toast__text');
  const undo = toast.querySelector('.toast__undo');
  const note = card.querySelector('[data-note-form]');
  let hide;

  const show = (message, onUndo) => {
    text.textContent = message;
    undo.hidden = !onUndo;
    undo.onclick = onUndo;
    toast.hidden = false;
    clearTimeout(hide);
    hide = setTimeout(() => (toast.hidden = true), 6000);
  };

  for (const button of card.querySelectorAll('[data-act]')) {
    button.addEventListener('click', () => {
      card.classList.add('is-handled');
      show(button.dataset.act, () => {
        card.classList.remove('is-handled');
        toast.hidden = true;
        button.focus();
      });
    });
  }
  // Notes can't be undone in the dashboard either.
  note.addEventListener('submit', (event) => {
    event.preventDefault();
    show('Note saved', null);
  });
}

handleCard();
