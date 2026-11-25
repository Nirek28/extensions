import { patterns, trackedSubscription, audibleSubscription, interval } from './tracker.js';

// Website that receives pairing codes and usage uploads.
// Local default: the launcher runs the site on http://localhost:4000.
// For a hosted site, change SITE and add the same origin to host_permissions in manifest.json.
const SITE = 'https://subscription-hub-rep.vercel.app';
const API = SITE + '/api/extension';
const API_PERMISSION = SITE + '/*';
const SYNC_EVERY = 60000;   // automatic upload cadence
const CONFIG_EVERY = 60000; // how quickly website changes reach the extension

const DEFAULT = {
  connection: null,
  enabled: false,
  mappings: [],
  queue: [],
  anchor: null,
  lastSync: null,
  lastConfig: 0,
  error: '',
  rejected: [],
  nextSync: 0,
  failures: 0,
  today: { day: '', seconds: {} }
};

let chain = Promise.resolve();

const serial = fn => {
  const next = chain.then(fn);
  chain = next.catch(() => {});
  return next;
};

// India calendar day for the "today" totals shown in the popup.
const istDay = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);

function addToday(s, event, now) {
  const day = istDay(now);
  const base = s.today?.day === day ? s.today.seconds : {};
  s.today = {
    day,
    seconds: { ...base, [event.subscriptionId]: (base[event.subscriptionId] || 0) + event.activeSeconds }
  };
}

async function read() {
  const stored = await chrome.storage.local.get('state');
  return { ...DEFAULT, ...stored.state };
}

async function save(state) {
  await chrome.storage.local.set({ state });
}

async function session() {
  let { runId } = await chrome.storage.session.get('runId');

  if (!runId) {
    runId = crypto.randomUUID();
    await chrome.storage.session.set({ runId });
  }

  return runId;
}

async function setup() {
  await chrome.storage.local.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS'
  });

  chrome.idle.setDetectionInterval(120);

  if (!await chrome.alarms.get('checkpoint')) {
    await chrome.alarms.create('checkpoint', {
      periodInMinutes: 0.5
    });
  }

  if (!await chrome.alarms.get('sync')) {
    await chrome.alarms.create('sync', {
      periodInMinutes: 1
    });
  }
}

async function checkpoint() {
  const s = await read();
  const now = Date.now();
  const runId = await session();

  if (s.enabled && s.connection) {
    const event = interval(
      s.anchor,
      now,
      runId,
      crypto.randomUUID()
    );

    if (event && s.queue.length < 20000) {
      s.queue.push(event);
      addToday(s, event, now);
    }

    if (s.queue.length >= 20000) {
      s.enabled = false;
      s.error =
        'Pending queue is full. Sync or disconnect to clear it, then resume.';
    }
  }

  s.anchor = null;

  if (
    s.enabled &&
    s.connection &&
    s.connection.expiresAt > now
  ) {
    let subscriptionId = null;

    // 1. The focused tab you are working in (must not be idle).
    try {
      const window = await chrome.windows.getLastFocused();

      const [tab] = await chrome.tabs.query({
        active: true,
        windowId: window.id
      });

      const idle = await chrome.idle.queryState(120);

      subscriptionId = trackedSubscription(
        tab,
        window.focused,
        idle,
        s.mappings
      );
    } catch {
      // No accessible browser window; the audible check below still runs.
    }

    // 2. Otherwise any tab that is playing sound, even in the background or while you are away.
    if (!subscriptionId) {
      try {
        const audible = await chrome.tabs.query({ audible: true });
        subscriptionId = audibleSubscription(audible, s.mappings);
      } catch {
        // Tabs unavailable; stop timing and preserve the queue.
      }
    }

    if (subscriptionId) {
      s.anchor = {
        subscriptionId,
        at: now,
        session: runId
      };
    }
  }

  await save(s);
}

async function api(path, token, body) {
  let response;

  try {
    response = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    throw new Error(
      'Cannot reach Subscription Hub. Make sure the app is running. Usage is saved and will upload automatically.'
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      'Subscription Hub responded unexpectedly. Usage is saved and will upload automatically.'
    );
  }

  if (!response.ok) {
    const error = new Error(data.error || 'Upload failed.');
    error.status = response.status;
    throw error;
  }

  return data;
}

async function sync(force = false) {
  let s = await read();

  if (!s.connection || (!force && Date.now() < s.nextSync)) {
    return;
  }

  try {
    if (force || Date.now() - s.lastConfig > CONFIG_EVERY) {
      const config = await api('/config', s.connection.token);

      await checkpoint();
      s = await read();
      s.mappings = config.mappings;
      s.lastConfig = Date.now();

      await save(s);
    }

    // Send at most five batches per attempt.
    // Later alarms continue uploading larger offline queues.
    for (let i = 0; i < 5; i++) {
      s = await read();

      if (!s.queue.length) {
        break;
      }

      const result = await api(
        '/usage/batch',
        s.connection.token,
        { events: s.queue.slice(0, 100) }
      );

      const ids = new Set([
        ...result.accepted,
        ...result.rejected.map(event => event.eventId)
      ]);

      s.queue = s.queue.filter(event => !ids.has(event.eventId));

      if (result.rejected.length) {
        s.rejected = [...s.rejected, ...result.rejected].slice(-20);
      }

      s.lastSync = Date.now();
      await save(s);
    }

    s = await read();
    s.error = '';
    s.failures = 0;
    s.nextSync = Date.now() + SYNC_EVERY;

    await save(s);
  } catch (error) {
    s = await read();
    s.error = error.message;
    s.failures++;

    s.nextSync = Date.now() + Math.min(
      30 * 60000,
      60000 * 2 ** Math.min(s.failures, 5)
    );

    if (error.status === 401) {
      s.enabled = false;
      s.anchor = null;
    }

    await save(s);
  }
}

async function status() {
  const s = await read();
  const today = s.today?.day === istDay(Date.now()) ? s.today.seconds : {};
  const sites = [];

  for (const mapping of s.mappings) {
    sites.push({
      ...mapping,
      granted: await chrome.permissions.contains({
        origins: patterns(mapping)
      }),
      minutesToday: (today[mapping.subscriptionId] || 0) / 60
    });
  }

  return {
    connected: !!s.connection,
    expiresAt: s.connection?.expiresAt,
    enabled: s.enabled,
    sites,
    pending: s.queue.length,
    pendingMinutes:
      s.queue.reduce((total, event) => total + event.activeSeconds, 0) / 60,
    lastSync: s.lastSync,
    nextSync: s.nextSync,
    error: s.error,
    rejected: s.rejected,
    tracking: !!s.anchor
  };
}

async function message(msg) {
  if (msg.type === 'status') {
    return status();
  }

  if (msg.type === 'connect') {
    const old = await read();

    if (old.connection) {
      throw new Error(
        'Disconnect the previous account before pairing again.'
      );
    }

    const connection = await api('/pair', null, {
      code: String(msg.code || '').trim(),
      name: String(msg.name || 'Chrome browser').slice(0, 60)
    });

    await save({ ...DEFAULT, connection });
    await sync(true);
  } else if (msg.type === 'toggle') {
    await checkpoint();

    const s = await read();

    if (!s.connection) {
      throw new Error('Connect your account first.');
    }

    if (s.connection.expiresAt <= Date.now()) {
      throw new Error('Access expired. Disconnect and pair again.');
    }

    s.enabled = !s.enabled;
    s.anchor = null;

    await save(s);
    await checkpoint();
  } else if (msg.type === 'sync') {
    // Kept for compatibility; uploads now happen automatically.
    await checkpoint();
    await sync(true);
    await checkpoint();
  } else if (msg.type === 'disconnect') {
    // Local disconnect clears pending data to prevent cross-account uploads.
    await save({ ...DEFAULT });

    const granted = await chrome.permissions.getAll();
    const origins = (granted.origins || []).filter(
      origin => origin !== API_PERMISSION
    );

    if (origins.length) {
      await chrome.permissions.remove({ origins });
    }
  } else if (msg.type === 'permissionsChanged') {
    await checkpoint();
  }

  return status();
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  serial(() => message(msg)).then(
    data => reply({ ok: true, data }),
    error => reply({ ok: false, error: error.message })
  );

  return true;
});

const changed = () => {
  serial(checkpoint).catch(() => {});
};

chrome.tabs.onActivated.addListener(changed);

chrome.tabs.onUpdated.addListener((_id, info) => {
  // 'audible' fires when a tab starts or stops playing sound, so timing starts and stops right away.
  if (info.url || info.status === 'complete' || 'audible' in info) {
    changed();
  }
});

chrome.tabs.onRemoved.addListener(changed);
chrome.windows.onFocusChanged.addListener(changed);
chrome.idle.onStateChanged.addListener(changed);
chrome.permissions.onRemoved.addListener(changed);

chrome.alarms.onAlarm.addListener(alarm => {
  serial(async () => {
    await checkpoint();

    if (alarm.name === 'sync') {
      await sync();
    }
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  serial(async () => {
    const s = await read();
    s.anchor = null;
    await save(s);
    await setup();
    await checkpoint();
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  serial(async () => {
    const s = await read();
    s.anchor = null;
    await save(s);
    await setup();
    await checkpoint();
  }).catch(() => {});
});

serial(setup).catch(() => {});
