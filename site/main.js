// The page's few behaviours. Everything here is an enhancement: without script
// the page shows the finished run, no now line, and the commands to copy by hand.

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

/* ---------- 07:00: the morning agent's run plays out once ---------- */

// Each subagent and when, in milliseconds from the start, it reports back. The
// results are the trail's own, so the run ends exactly as the folded trail reads.
const RUN = [
  { at: 0, done: 1500 },
  { at: 140, done: 2300 },
  { at: 280, done: 2800 },
  { at: 420, done: 1900 },
  { at: 560, done: 1200 },
];
const LANDED = 3100;
const FINISHED = 4100;

function playRun() {
  const run = document.querySelector('.run');
  if (!run || reduceMotion.matches) return;
  const live = run.querySelector('.run__live .run__steps');
  const phase = run.querySelector('.run__phase-text');
  const state = run.querySelector('.run__state');
  const trail = [...run.querySelectorAll('.run__trail li')];

  run.classList.add('is-playing');
  state.textContent = '· running';
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  trail.forEach((source, i) => {
    const step = source.cloneNode(true);
    const result = step.querySelector('.step__result');
    const final = result.textContent;
    result.textContent = 'reading…';
    step.classList.add('is-running');
    later(RUN[i].at, () => live.append(step));
    later(RUN[i].done, () => {
      step.classList.remove('is-running');
      result.textContent = final;
    });
  });
  later(LANDED, () => (phase.textContent = 'The brief is in; checking it and writing its report'));
  later(FINISHED, () => {
    run.classList.remove('is-playing');
    run.classList.add('is-landed');
    state.textContent = '· finished';
  });

  // Someone who turns reduced motion on mid-play gets the end straight away.
  reduceMotion.addEventListener('change', () => {
    timers.forEach(clearTimeout);
    run.classList.remove('is-playing');
    state.textContent = '· finished';
  });
}

playRun();

/* ---------- The now line ---------- */

// Each hour's dot is a known time at a known height. The line sits at a fixed
// height in the viewport; the time it shows is wherever that height falls
// between the two dots around it, so scrolling from 10:20 to 11:30 runs the
// clock through the minutes between.
function nowLine() {
  const now = document.querySelector('.now');
  const label = now?.querySelector('.now__label');
  const hours = [...document.querySelectorAll('.hour[data-at]')];
  if (!now || !label || hours.length < 2) return;
  now.hidden = false;

  const minutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const format = (total) => {
    const h = Math.floor(total / 60);
    const m = Math.floor(total % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  let marks = [];
  const measure = () => {
    marks = hours.map((hour) => {
      const dot = hour.querySelector('.hour__time');
      const box = dot.getBoundingClientRect();
      const y = box.top + scrollY + parseFloat(getComputedStyle(hour.querySelector('.hour__inner')).getPropertyValue('--dot-y'));
      return { y, t: minutes(hour.dataset.at), dot };
    });
  };

  let queued = false;
  const update = () => {
    queued = false;
    const y = now.getBoundingClientRect().top + scrollY;
    const first = marks[0];
    const last = marks[marks.length - 1];
    let t = first.t;
    if (y >= last.y) t = last.t;
    else if (y > first.y) {
      const i = marks.findIndex((mark) => mark.y > y);
      const a = marks[i - 1];
      const b = marks[i];
      t = a.t + ((b.t - a.t) * (y - a.y)) / (b.y - a.y);
    }
    label.textContent = format(t);
    for (const mark of marks) mark.dot.classList.toggle('is-passing', Math.abs(mark.y - y) < 18);
    // The day ends at the last hour; the line goes with it, and isn't there
    // before the first.
    now.classList.toggle('is-gone', y > last.y + 4 || y < first.y - 4);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };

  // The line rides at the height of the first hour's dot, so the page opens
  // with it on 07:00, and an hour reaches it as its heading nears the top.
  const pin = () => {
    now.style.top = `${Math.min(marks[0].y, innerHeight * 0.4)}px`;
  };

  measure();
  pin();
  update();
  addEventListener('scroll', queue, { passive: true });
  const remeasure = () => {
    measure();
    pin();
    queue();
  };
  addEventListener('resize', remeasure);
  // Fonts arriving move everything below them.
  document.fonts?.ready.then(remeasure);
}

nowLine();

/* ---------- 11:30: the assistant, replayed ---------- */

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

/* ---------- 17:00: handle an item ---------- */

function handleCard() {
  const card = document.querySelector('[data-handle]');
  if (!card) return;
  const toast = card.querySelector('.toast');
  const text = toast.querySelector('.toast__text');
  const undo = toast.querySelector('.toast__undo');
  const note = card.querySelector('[data-note]');
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
