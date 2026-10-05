import { Engine } from './engine.js';
import { connectLively } from './lively-bridge.js';

// ?t=2026-09-22T21:00:00Z pins the start time (handy for screenshots).
// ?still: no panel and full-length trails at once, for preview screenshots.
const params = new URLSearchParams(location.search);
const t = params.get('t');
const still = params.has('still');
const engine = new Engine({ date: t ? new Date(t) : undefined });
connectLively(engine);
engine.start();

// A settings panel built from the same LivelyProperties.json Lively reads,
// feeding the same listener. Press H to hide it.
const props = await (await fetch('LivelyProperties.json')).json();
const panel = document.createElement('div');
panel.id = 'panel';
document.body.appendChild(panel);
const send = (k, v) => window.livelyPropertyListener(k, v);

for (const [key, p] of Object.entries(props)) {
  let input;
  if (p.type === 'checkbox') {
    const row = document.createElement('div');
    row.className = 'row';
    input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: p.value, id: key });
    input.oninput = () => send(key, input.checked);
    row.append(input, Object.assign(document.createElement('label'), { textContent: p.text, htmlFor: key }));
    panel.append(row);
  } else if (p.type === 'button') {
    input = Object.assign(document.createElement('button'), { textContent: p.value });
    input.onclick = () => send(key, true);
    panel.append(Object.assign(document.createElement('label'), { textContent: p.text }), input);
    continue;
  } else {
    const label = Object.assign(document.createElement('label'), { textContent: p.text });
    if (p.type === 'dropdown') {
      input = document.createElement('select');
      p.items.forEach((it, i) => input.add(new Option(it, i)));
      input.value = p.value;
      input.oninput = () => send(key, Number(input.value));
    } else if (p.type === 'textbox') {
      input = Object.assign(document.createElement('input'), { type: 'text', value: p.value });
      input.oninput = () => send(key, input.value);
    } else {
      input = Object.assign(document.createElement('input'), { type: 'range', min: p.min, max: p.max, step: p.step, value: p.value });
      input.oninput = () => { send(key, Number(input.value)); label.textContent = `${p.text}: ${input.value}`; };
      label.textContent = `${p.text}: ${p.value}`;
    }
    panel.append(label, input);
  }
  send(key, still && key === 'trailBuildup' ? false : p.value);
}
if (still) panel.classList.add('hidden');
panel.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: 'H — hide panel' }));
addEventListener('keydown', (e) => { if (e.key === 'h' || e.key === 'H') panel.classList.toggle('hidden'); });

// ?wx=rain (clear, cirrus, partly, overcast, fog, rain, storm, snow) previews
// a condition instead of the live weather.
const wx = params.get('wx');
if (wx) engine.previewWeather(wx);

window.engine = engine;
