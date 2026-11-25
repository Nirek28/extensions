import {patterns} from './tracker.js';

const $ = id => document.getElementById(id);
let busy = false;
let lastKey = '';

async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({type, ...extra});
  if (!result?.ok) throw new Error(result?.error || 'Extension unavailable. Reload it in chrome://extensions.');
  return result.data;
}

const minutes = value => value < 1 ? `${Math.round(value * 60)} sec` : `${value.toFixed(value < 10 ? 1 : 0)} min`;

function liveLine(s) {
  const dot = $('dot');
  dot.className = s.error ? 'warn' : (s.enabled && s.tracking) ? 'on' : '';
  const seconds = s.nextSync ? Math.max(0, Math.round((s.nextSync - Date.now()) / 1000)) : 0;
  if (s.error) {
    $('sync-line').textContent = 'Upload paused. Retrying automatically.';
    return;
  }
  const last = s.lastSync ? new Date(s.lastSync).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : 'no upload yet';
  $('sync-line').textContent = `Auto-sync on · last upload ${last}${seconds ? ` · next in ${seconds}s` : ''}`;
}

function paint(s) {
  $('status').textContent = s.enabled
    ? (s.tracking ? 'Tracking a selected website' : 'Tracking on · waiting for a selected tab or audio')
    : 'Tracking paused';
  $('toggle').textContent = s.enabled ? 'Pause tracking' : 'Start tracking';
  $('stats').textContent = `Waiting to upload: ${s.pendingMinutes.toFixed(2)} min (${s.pending} records).`;
  $('expiry').textContent = s.expiresAt ? 'Connection valid until ' + new Date(s.expiresAt).toLocaleDateString() : '';
  $('rejected').textContent = s.rejected.length
    ? s.rejected.map(r => r.reason).join('\n')
    : 'None. Expired or disabled-service records are discarded with a reason here.';

  $('sites').replaceChildren();
  for (const site of s.sites) {
    const row = document.createElement('div');
    row.className = 'site';
    const info = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = site.name;
    const sub = document.createElement('small');
    sub.textContent = `Today: ${minutes(site.minutesToday || 0)}`;
    info.append(name, sub);
    row.append(info);

    if (site.granted) {
      const done = document.createElement('span');
      done.className = 'done';
      done.textContent = 'Allowed ✓';
      row.append(done);
    } else {
      const button = document.createElement('button');
      button.textContent = 'Allow';
      button.onclick = () => {
        // Call directly inside the user gesture.
        chrome.permissions.request({origins: patterns(site)})
          .then(granted => run(async () => {
            if (!granted) throw new Error('Permission was not granted. This website will not be tracked.');
            return send('permissionsChanged');
          }))
          .catch(e => { $('notice').textContent = e.message; });
      };
      row.append(button);
    }
    $('sites').append(row);
  }
  if (!s.sites.length) {
    $('sites').textContent = 'No websites selected yet. Choose them in the website Settings; they appear here automatically.';
  }
}

function render(s) {
  $('pair').hidden = s.connected;
  $('connected').hidden = !s.connected;
  $('notice').textContent = s.error || '';
  if (!s.connected) return;
  const key = JSON.stringify(s);
  if (key !== lastKey) {
    lastKey = key;
    paint(s);
  }
  liveLine(s);
}

async function run(fn) {
  if (busy) return;
  busy = true;
  ['connect', 'toggle', 'disconnect'].forEach(id => $(id).disabled = true);
  try {
    render(await fn());
  } catch (e) {
    $('notice').textContent = e.message;
  } finally {
    busy = false;
    ['connect', 'toggle', 'disconnect'].forEach(id => $(id).disabled = false);
  }
}

// Refresh automatically while the popup is open; no button needed.
async function poll() {
  if (busy) return;
  try {
    render(await send('status'));
  } catch (e) {
    $('notice').textContent = e.message;
  }
}

$('connect').onclick = () => run(() => send('connect', {code: $('code').value, name: $('name').value}));
$('toggle').onclick = () => run(() => send('toggle'));
$('disconnect').onclick = () => {
  if (confirm('Clear this browser connection and all unsent records? You can also revoke the device from website Settings.')) {
    run(() => send('disconnect'));
  }
};

run(() => send('status'));
setInterval(poll, 3000);
