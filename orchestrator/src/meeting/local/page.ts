/**
 * The room page, as a string.
 *
 * Deliberately a template literal in a `.ts` file rather than a static asset:
 * `tsc` compiles the source tree into `dist` and copies nothing else, so an
 * `.html` file here would exist in the source tree and be absent at runtime.
 * Inlining it keeps `npm run build` a single `tsc -b` with no asset step and no
 * bundler, which is what "preferred over adding a build step" buys.
 *
 * All rendering of user-supplied values happens client-side through
 * `textContent`, never `innerHTML`, so a participant cannot type markup into
 * someone else's page.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RoomPageOptions {
  readonly meetingId: string;
  readonly botDisplayName: string;
  readonly brainKind: string;
  readonly platformNote: string;
}

const STYLES = `
:root {
  color-scheme: dark;
  --bg: #0b0d12;
  --panel: #12151d;
  --panel-2: #171b25;
  --line: #232838;
  --text: #e7eaf2;
  --dim: #8b93a7;
  --accent: #7c6cff;
  --accent-soft: #7c6cff22;
  --lily: #38d3a8;
  --warn: #ffb454;
  --danger: #ff6b6b;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column;
}
button { font: inherit; cursor: pointer; }
header.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 18px; border-bottom: 1px solid var(--line); background: var(--panel);
  flex: 0 0 auto;
}
.brand { font-weight: 650; letter-spacing: .2px; }
.brand .dot { color: var(--lily); }
.pill {
  font-size: 11.5px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--dim); background: var(--panel-2);
  white-space: nowrap;
}
.spacer { flex: 1; }
.danger-btn {
  background: transparent; color: var(--danger); border: 1px solid #47232b;
  padding: 6px 12px; border-radius: 8px;
}
.danger-btn:hover { background: #2a1418; }

main.layout {
  flex: 1 1 auto; display: grid; grid-template-columns: 250px minmax(0,1fr) 300px;
  min-height: 0;
}
aside { background: var(--panel); border-right: 1px solid var(--line); overflow-y: auto; padding: 14px; }
aside.right { border-right: none; border-left: 1px solid var(--line); }
.section-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: .09em;
  color: var(--dim); margin: 0 0 10px; font-weight: 650;
}

.person { display: flex; gap: 10px; align-items: flex-start; padding: 8px; border-radius: 10px; }
.person + .person { margin-top: 2px; }
.person.bot { background: linear-gradient(180deg, #12251f, #101821); border: 1px solid #1d3a30; }
.avatar {
  width: 32px; height: 32px; border-radius: 9px; flex: 0 0 auto;
  display: grid; place-items: center; font-weight: 650; font-size: 13px;
  background: var(--accent-soft); color: #b9b0ff; border: 1px solid #2c2a4d;
}
.person.bot .avatar { background: #10352b; color: var(--lily); border-color: #1e5646; }
.person .who { min-width: 0; }
.person .nm { font-size: 13.5px; font-weight: 560; display: flex; align-items: center; gap: 6px; }
.person .sub { font-size: 11.5px; color: var(--dim); overflow-wrap: anywhere; }
.tag {
  font-size: 10px; padding: 1px 6px; border-radius: 5px;
  background: #1c2130; color: var(--dim); border: 1px solid var(--line);
}

.wip-holder { display: none; margin-top: 6px; }
.wip-holder.on { display: block; }
.wip {
  display: flex; align-items: center; gap: 7px;
  font-size: 11.5px; color: var(--lily);
  background: #0f2620; border: 1px solid #1e5646; border-radius: 8px; padding: 5px 8px;
}
.wip .spin {
  width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
  background: var(--lily); animation: pulse 1.1s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity: .25; transform: scale(.72);} 50% { opacity: 1; transform: scale(1);} }
.speaking-bars { display: none; gap: 2px; align-items: flex-end; height: 11px; }
.speaking-bars.on { display: inline-flex; }
.speaking-bars i { width: 2.5px; background: var(--lily); border-radius: 2px; animation: bar .8s ease-in-out infinite; }
.speaking-bars i:nth-child(2) { animation-delay: .16s; }
.speaking-bars i:nth-child(3) { animation-delay: .32s; }
@keyframes bar { 0%,100% { height: 3px; } 50% { height: 11px; } }

section.stage { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
#sharePanel { display: none; border-bottom: 1px solid var(--line); background: #0e1017; }
#sharePanel.on { display: block; }
#sharePanel .bar {
  display: flex; align-items: center; gap: 8px; padding: 7px 14px;
  font-size: 12px; color: var(--dim); border-bottom: 1px solid var(--line);
}
#sharePanel iframe { width: 100%; height: 300px; border: 0; background: #fff; display: block; }

#stream { flex: 1 1 auto; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.msg { display: flex; gap: 10px; max-width: 780px; }
.msg .body { min-width: 0; }
.msg .hdr { font-size: 12px; color: var(--dim); margin-bottom: 2px; }
.msg .hdr b { color: var(--text); font-weight: 600; }
.msg .txt {
  background: var(--panel-2); border: 1px solid var(--line);
  padding: 9px 12px; border-radius: 4px 12px 12px 12px; overflow-wrap: anywhere; white-space: pre-wrap;
}
.msg.bot .txt { background: #10241e; border-color: #1e5646; }
.msg.bot .hdr b { color: var(--lily); }
.sysline { text-align: center; color: var(--dim); font-size: 12px; padding: 2px 0; }
.sysline span { background: var(--panel-2); border: 1px solid var(--line); border-radius: 999px; padding: 3px 12px; }

form.composer { flex: 0 0 auto; border-top: 1px solid var(--line); background: var(--panel); padding: 12px 14px; display: flex; gap: 10px; }
form.composer input {
  flex: 1; background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
  border-radius: 10px; padding: 11px 13px; font: inherit; outline: none;
}
form.composer input:focus { border-color: var(--accent); }
form.composer button {
  background: var(--accent); border: 0; color: #fff; border-radius: 10px; padding: 0 18px; font-weight: 600;
}
form.composer button:disabled { opacity: .45; cursor: not-allowed; }
.hint { padding: 0 15px 10px; color: var(--dim); font-size: 11.5px; }
.hint code { background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; }

.task { border: 1px solid var(--line); background: var(--panel-2); border-radius: 10px; padding: 9px 10px; margin-bottom: 8px; }
.task .t { font-size: 13px; overflow-wrap: anywhere; }
.task .m { font-size: 11px; color: var(--dim); margin-top: 5px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line); }
.badge.unconfirmed { color: var(--warn); border-color: #4a3a1c; background: #241d10; }
.badge.confirmed, .badge.done { color: var(--lily); border-color: #1e5646; background: #10241e; }
.badge.in_progress { color: #7cb8ff; border-color: #21395c; background: #101c2c; }
.badge.lily_action { color: #b9b0ff; border-color: #2c2a4d; background: #17162b; }
.empty { color: var(--dim); font-size: 12.5px; font-style: italic; }

#gate {
  position: fixed; inset: 0; background: rgba(6,8,12,.94); display: grid; place-items: center; z-index: 30; padding: 20px;
}
#gate.off { display: none; }
.card {
  width: min(560px, 100%); background: var(--panel); border: 1px solid var(--line);
  border-radius: 16px; padding: 22px; max-height: 90vh; overflow-y: auto;
}
.card h1 { margin: 0 0 4px; font-size: 19px; }
.card p.lede { margin: 0 0 16px; color: var(--dim); font-size: 13px; }
.pick { display: flex; flex-direction: column; gap: 7px; }
.pick button {
  display: flex; gap: 11px; align-items: flex-start; text-align: left; width: 100%;
  background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
  border-radius: 11px; padding: 11px 12px;
}
.pick button:hover:not(:disabled) { border-color: var(--accent); background: #1a1a2e; }
.pick button:disabled { opacity: .4; cursor: not-allowed; }
.pick .nm { font-weight: 600; font-size: 14px; }
.pick .jd { font-size: 12px; color: var(--dim); }
.guest { margin-top: 14px; display: flex; gap: 8px; }
.guest input {
  flex: 1; background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
  border-radius: 9px; padding: 9px 11px; font: inherit; outline: none;
}
.guest button { background: transparent; border: 1px solid var(--line); color: var(--text); border-radius: 9px; padding: 0 14px; }
#gateError { color: var(--danger); font-size: 12.5px; margin-top: 10px; min-height: 16px; }

@media (max-width: 1000px) {
  main.layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; }
  aside { max-height: 190px; border-right: none; border-bottom: 1px solid var(--line); }
  aside.right { border-left: none; border-top: 1px solid var(--line); }
}
`;

const CLIENT = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  let ws = null, me = null, directory = [], people = [];
  let statusState = null, speaking = false;

  // Letters only, so "Lily (AI assistant)" reads as "LA" and not "L(".
  const initials = (name) => (name.match(/\p{L}+/gu) || []).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  function append(node) {
    const stream = $('stream');
    const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
    stream.appendChild(node);
    if (atBottom) stream.scrollTop = stream.scrollHeight;
  }

  function sysline(text) {
    const row = document.createElement('div');
    row.className = 'sysline';
    const span = document.createElement('span');
    span.textContent = text;
    row.appendChild(span);
    append(row);
  }

  function message(m) {
    const row = document.createElement('div');
    row.className = 'msg' + (m.isBot ? ' bot' : '');
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = initials(m.from);
    const body = document.createElement('div');
    body.className = 'body';
    const hdr = document.createElement('div');
    hdr.className = 'hdr';
    const who = document.createElement('b');
    who.textContent = m.from;
    hdr.appendChild(who);
    hdr.appendChild(document.createTextNode(' · ' + new Date(m.at).toLocaleTimeString()));
    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = m.text;
    body.appendChild(hdr); body.appendChild(txt);
    row.appendChild(av); row.appendChild(body);
    append(row);
  }

  function renderPeople() {
    const box = $('people');
    box.textContent = '';
    for (const p of people) {
      const row = document.createElement('div');
      row.className = 'person' + (p.isBot ? ' bot' : '');
      const av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = initials(p.displayName);
      const who = document.createElement('div');
      who.className = 'who';
      const nm = document.createElement('div');
      nm.className = 'nm';
      const label = document.createElement('span');
      label.textContent = p.displayName;
      nm.appendChild(label);
      if (p.isBot) {
        const bars = document.createElement('span');
        bars.className = 'speaking-bars' + (speaking ? ' on' : '');
        for (let i = 0; i < 3; i += 1) bars.appendChild(document.createElement('i'));
        nm.appendChild(bars);
        const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'AI';
        nm.appendChild(tag);
      } else if (me && p.participantId === me.participantId) {
        const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'you';
        nm.appendChild(tag);
      }
      const sub = document.createElement('div');
      sub.className = 'sub';
      if (p.isBot) {
        sub.textContent = 'AI participant';
      } else {
        const entry = directory.find(d => d.employeeId === p.employeeId);
        sub.textContent = entry ? entry.jobDescription : 'guest';
      }
      who.appendChild(nm); who.appendChild(sub);
      if (p.isBot) {
        const holder = document.createElement('div');
        holder.className = 'wip-holder' + (statusState ? ' on' : '');
        if (statusState) {
          const wip = document.createElement('div');
          wip.className = 'wip';
          const dot = document.createElement('span'); dot.className = 'spin';
          const label2 = document.createElement('span');
          label2.textContent = statusState.note || statusState.state;
          wip.appendChild(dot); wip.appendChild(label2);
          holder.appendChild(wip);
        }
        who.appendChild(holder);
      }
      row.appendChild(av); row.appendChild(who);
      box.appendChild(row);
    }
  }

  function renderTasks(tasks) {
    const box = $('tasks');
    box.textContent = '';
    if (!tasks.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'Nothing captured yet.';
      box.appendChild(e);
      return;
    }
    for (const t of tasks) {
      const card = document.createElement('div'); card.className = 'task';
      const text = document.createElement('div'); text.className = 't'; text.textContent = t.text;
      const meta = document.createElement('div'); meta.className = 'm';
      const owner = document.createElement('span'); owner.textContent = t.ownerName;
      const status = document.createElement('span');
      status.className = 'badge ' + t.status;
      status.textContent = t.status.replace('_', ' ');
      const type = document.createElement('span');
      type.className = 'badge ' + t.type;
      type.textContent = t.type.replace('_', ' ');
      meta.appendChild(owner); meta.appendChild(status); meta.appendChild(type);
      if (t.due) { const d = document.createElement('span'); d.textContent = 'due ' + t.due; meta.appendChild(d); }
      card.appendChild(text); card.appendChild(meta);
      box.appendChild(card);
    }
  }

  async function refreshPeople() {
    try {
      const res = await fetch('/api/participants');
      people = await res.json();
      renderPeople();
    } catch (err) { /* the next socket event re-drives this */ }
  }

  function connect(displayName, employeeId) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/room');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', displayName: displayName, employeeId: employeeId }));
    ws.onclose = () => { sysline('Disconnected from the room.'); $('send').disabled = true; };
    ws.onerror = () => { $('gateError').textContent = 'Could not reach the room server.'; };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (err) { return; }
      switch (m.t) {
        case 'welcome':
          me = m.you;
          people = m.participants;
          $('gate').classList.add('off');
          $('send').disabled = false;
          $('composerInput').focus();
          renderPeople();
          renderTasks(m.tasks);
          sysline('You joined as ' + m.you.displayName + '.');
          break;
        case 'participant':
          sysline(m.participant.displayName + (m.action === 'join' ? ' joined' : ' left'));
          refreshPeople();
          break;
        case 'message': message(m); break;
        case 'status':
          statusState = m.state === 'idle' ? null : { state: m.state, note: m.note };
          renderPeople();
          break;
        case 'speaking': speaking = m.on; renderPeople(); break;
        case 'tasks': renderTasks(m.tasks); break;
        case 'system': sysline(m.text); break;
        case 'error': $('gateError').textContent = m.text; sysline(m.text); break;
        case 'hand': sysline(m.raised ? 'Lily raised her hand' : 'Lily lowered her hand'); break;
        case 'muted': sysline(m.muted ? 'Lily muted herself' : 'Lily unmuted'); break;
        case 'screenshare':
          $('sharePanel').classList.toggle('on', !!m.url);
          $('shareFrame').src = m.url || 'about:blank';
          $('shareUrl').textContent = m.url || '';
          break;
        case 'ended':
          sysline('Meeting ended (' + m.reason + ').');
          $('send').disabled = true;
          break;
        default: break;
      }
    };
  }

  async function boot() {
    const res = await fetch('/api/roster');
    const data = await res.json();
    directory = data.directory;
    const pick = $('pick');
    pick.textContent = '';
    for (const person of directory) {
      const b = document.createElement('button');
      b.type = 'button';
      b.disabled = person.taken;
      const av = document.createElement('div'); av.className = 'avatar'; av.textContent = initials(person.name);
      const who = document.createElement('div');
      const nm = document.createElement('div'); nm.className = 'nm';
      nm.textContent = person.name + (person.taken ? ' — already in the room' : '');
      const jd = document.createElement('div'); jd.className = 'jd';
      jd.textContent = person.jobDescription + (person.daemonEnrolled ? ' · agent connected' : ' · no agent');
      who.appendChild(nm); who.appendChild(jd);
      b.appendChild(av); b.appendChild(who);
      b.onclick = () => connect(person.name, person.employeeId);
      pick.appendChild(b);
    }
  }

  $('guestJoin').onclick = () => {
    const name = $('guestName').value.trim();
    if (name) connect(name, null);
  };
  $('composer').onsubmit = (e) => {
    e.preventDefault();
    const input = $('composerInput');
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ t: 'say', text: text }));
    input.value = '';
  };
  $('endBtn').onclick = () => {
    if (ws && ws.readyState === 1 && confirm('End the meeting for everyone?')) ws.send(JSON.stringify({ t: 'end' }));
  };
  window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'leave' }));
  });

  boot();
})();
`;

export function renderRoomPage(options: RoomPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lily - simulated meeting room</title>
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <div class="brand"><span class="dot">&#9679;</span> Lily meeting room</div>
  <span class="pill">${escapeHtml(options.meetingId)}</span>
  <span class="pill">brain: ${escapeHtml(options.brainKind)}</span>
  <span class="pill">${escapeHtml(options.platformNote)}</span>
  <div class="spacer"></div>
  <button class="danger-btn" id="endBtn" type="button">End meeting</button>
</header>

<main class="layout">
  <aside>
    <h2 class="section-title">In the room</h2>
    <div id="people"></div>
  </aside>

  <section class="stage">
    <div id="sharePanel">
      <div class="bar">Screen shared by ${escapeHtml(options.botDisplayName)} &middot; <span id="shareUrl"></span></div>
      <iframe id="shareFrame" title="Shared screen" sandbox="allow-same-origin"></iframe>
    </div>
    <div id="stream"></div>
    <form class="composer" id="composer" autocomplete="off">
      <input id="composerInput" placeholder="Say something to the room..." maxlength="2000">
      <button id="send" type="submit" disabled>Send</button>
    </form>
    <div class="hint">
      Typing stands in for speech. Try <code>Lily, what have you got for me?</code>,
      <code>Sarah, how does the login flow work?</code>, or
      <code>John, make sure you finish the auth refactor by Sunday</code>.
    </div>
  </section>

  <aside class="right">
    <h2 class="section-title">What Lily has picked up</h2>
    <div id="tasks"><div class="empty">Nothing captured yet.</div></div>
  </aside>
</main>

<div id="gate">
  <div class="card">
    <h1>Join the meeting</h1>
    <p class="lede">
      Pick who you are. ${escapeHtml(options.botDisplayName)} is already in the room and will
      announce herself &mdash; she only acts on things addressed to her.
    </p>
    <div class="pick" id="pick"></div>
    <div class="guest">
      <input id="guestName" placeholder="...or join as an unlisted guest" maxlength="64">
      <button id="guestJoin" type="button">Join</button>
    </div>
    <div id="gateError"></div>
  </div>
</div>

<script>${CLIENT}</script>
</body>
</html>`;
}

export interface BoardTaskRow {
  readonly text: string;
  readonly ownerName: string;
  readonly status: string;
  readonly type: string;
  readonly due: string | null;
}

/**
 * The page Lily "shares her screen" with.
 *
 * A served HTML page rendered into an iframe stands in for a video track. It is
 * the same substitution the room makes for audio, and it keeps the screenshare
 * path exercised end to end without a media pipeline.
 */
export function renderBoardPage(meetingId: string, rows: readonly BoardTaskRow[]): string {
  const body = rows
    .map(
      (row) => `<tr>
  <td>${escapeHtml(row.text)}</td>
  <td>${escapeHtml(row.ownerName)}</td>
  <td><span class="s ${escapeHtml(row.status)}">${escapeHtml(row.status.replace('_', ' '))}</span></td>
  <td>${escapeHtml(row.type.replace('_', ' '))}</td>
  <td>${row.due === null ? '&mdash;' : escapeHtml(row.due)}</td>
</tr>`,
    )
    .join('\n');

  const table =
    rows.length === 0
      ? '<p class="empty">Nothing captured yet.</p>'
      : `<table><thead><tr><th>Item</th><th>Owner</th><th>Status</th><th>Type</th><th>Due</th></tr></thead><tbody>${body}</tbody></table>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Action items</title>
<style>
  body { font: 14px ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 18px; color: #1b1f2a; background: #fff; }
  h1 { font-size: 16px; margin: 0 0 3px; }
  .sub { color: #6b7280; font-size: 12px; margin: 0 0 14px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 6px 8px; }
  td { padding: 8px; border-bottom: 1px solid #f0f1f4; vertical-align: top; }
  .s { font-size: 11px; padding: 2px 7px; border-radius: 5px; background: #f3f4f6; }
  .s.unconfirmed { background: #fef3c7; }
  .s.confirmed, .s.done { background: #d1fae5; }
  .s.in_progress { background: #dbeafe; }
  .empty { color: #6b7280; font-style: italic; }
</style></head>
<body>
<h1>Action items</h1>
<p class="sub">Meeting ${escapeHtml(meetingId)} &middot; live</p>
${table}
</body></html>`;
}
