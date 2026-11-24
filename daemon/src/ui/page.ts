/**
 * The status page, as a string.
 *
 * Plain HTML and `fetch`, deliberately. A React build would add a bundler, a
 * dependency tree and a compile step to what is a two-field page — and this ships
 * to employee laptops, where every extra build artifact is another thing that can
 * fail to install. It is also inspectable: an employee who wants to know what the
 * DND toggle does can read this page's source.
 *
 * Everything shown comes from /api/state on this same loopback origin. The page
 * makes no external requests, so it works offline and cannot leak.
 */
export const STATUS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Lily agent</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #16161a; --muted: #6b7280; --line: #e5e7eb;
    --card: #f9fafb; --ok: #047857; --warn: #b45309; --bad: #b91c1c; --accent: #4338ca;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --fg: #e8e8ea; --muted: #9aa0aa; --line: #262a33;
      --card: #171a21; --ok: #34d399; --warn: #fbbf24; --bad: #f87171; --accent: #a5b4fc;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: .85rem; margin: 0 0 1.75rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.15rem; margin-bottom: 1rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .dot { width: .6rem; height: .6rem; border-radius: 50%; display: inline-block; margin-right: .5rem; }
  .state { font-weight: 600; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1.25rem; margin: .9rem 0 0; font-size: .9rem; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .pills { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .3rem; }
  .pill { border: 1px solid var(--line); border-radius: 999px; padding: .1rem .55rem; font-size: .78rem; color: var(--muted); }
  button {
    font: inherit; font-weight: 600; cursor: pointer; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
    padding: .5rem .9rem;
  }
  button[data-on="true"] { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  button:disabled { opacity: .5; cursor: progress; }
  table { width: 100%; border-collapse: collapse; font-size: .87rem; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: .3rem .5rem .45rem 0; }
  td { padding: .35rem .5rem .35rem 0; border-top: 1px solid var(--line); vertical-align: top; }
  td.task { overflow-wrap: anywhere; }
  .empty { color: var(--muted); font-size: .88rem; }
  .banner { border-left: 3px solid var(--warn); padding-left: .8rem; color: var(--warn); font-size: .87rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 .75rem; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Lily agent</h1>
  <p class="sub">Runs on your machine. Nothing here is uploaded.</p>

  <div class="card">
    <div class="row">
      <div><span class="dot" id="dot"></span><span class="state" id="state">loading…</span></div>
      <button id="dnd" disabled>…</button>
    </div>
    <dl id="facts"></dl>
    <div id="warning"></div>
  </div>

  <div class="card">
    <h2>Recent tasks</h2>
    <div id="tasks" class="empty">No tasks yet.</div>
  </div>
</main>

<script>
const COLOURS = {
  connected: "var(--ok)", connecting: "var(--warn)", reconnecting: "var(--warn)",
  idle: "var(--muted)", stopped: "var(--muted)", revoked: "var(--bad)"
};
const WORDS = {
  connected: "Connected to Lily", connecting: "Connecting…", reconnecting: "Reconnecting…",
  idle: "Not started", stopped: "Stopped", revoked: "Access revoked — re-enroll this device"
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
}
function ago(ms) {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
}

let busy = false;

async function refresh() {
  let state;
  try {
    state = await (await fetch("/api/state", { headers: { "x-lily-ui": "1" } })).json();
  } catch {
    document.getElementById("state").textContent = "Daemon not responding";
    document.getElementById("dot").style.background = "var(--bad)";
    return;
  }

  document.getElementById("dot").style.background = COLOURS[state.connection] || "var(--muted)";
  document.getElementById("state").textContent = WORDS[state.connection] || state.connection;

  const button = document.getElementById("dnd");
  button.disabled = busy;
  button.dataset.on = String(state.dnd);
  button.textContent = state.dnd ? "Do Not Disturb: on" : "Do Not Disturb: off";

  const caps = state.capabilities.length
    ? '<div class="pills">' + state.capabilities.map(c => '<span class="pill">' + esc(c) + "</span>").join("") + "</div>"
    : '<span class="empty">none reported</span>';

  document.getElementById("facts").innerHTML =
    "<dt>Agent</dt><dd>" + esc(state.agent.label) + "</dd>" +
    "<dt>Employee</dt><dd>" + esc(state.employeeId) + "</dd>" +
    "<dt>Reachable tools</dt><dd>" + caps + "</dd>" +
    "<dt>Device token</dt><dd>" + esc(state.tokenBackend) + "</dd>" +
    "<dt>Version</dt><dd>" + esc(state.daemonVersion) + "</dd>";

  document.getElementById("warning").innerHTML = state.tokenInsecure
    ? '<p class="banner">Your device token is stored unprotected because no OS credential store was available.</p>'
    : "";

  const tasks = state.tasks || [];
  document.getElementById("tasks").className = tasks.length ? "" : "empty";
  document.getElementById("tasks").innerHTML = tasks.length
    ? "<table><thead><tr><th>Task</th><th>Mode</th><th>State</th><th>When</th></tr></thead><tbody>" +
      tasks.map(t =>
        '<tr><td class="task">' + esc(t.label) + "</td><td>" + esc(t.mode) +
        "</td><td>" + esc(t.state) + "</td><td>" + ago(t.startedAt) + "</td></tr>"
      ).join("") + "</tbody></table>"
    : "No tasks yet.";
}

document.getElementById("dnd").addEventListener("click", async () => {
  const enabled = document.getElementById("dnd").dataset.on !== "true";
  busy = true;
  document.getElementById("dnd").disabled = true;
  try {
    await fetch("/api/dnd", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lily-ui": "1" },
      body: JSON.stringify({ enabled })
    });
  } finally {
    busy = false;
    refresh();
  }
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;
