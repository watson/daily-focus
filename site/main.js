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
