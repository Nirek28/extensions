export const matches = (host, domain) => host === domain || host.endsWith('.' + domain);
export const patterns = mapping => mapping.domains.map(d => `https://${d === 'open.spotify.com' ? '' : '*.'}${d}/*`);
export function trackedSubscription(tab, focused, idle, mappings) {
  if (!focused || idle !== 'active' || !tab || tab.incognito || !tab.url) return null;
  let url; try { url = new URL(tab.url); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  return mappings.find(m => m.domains.some(d => matches(url.hostname, d)))?.subscriptionId || null;
}
export function interval(anchor, now, session, eventId) {
  const elapsed = now - (anchor?.at || now);
  // Long or backwards gaps are unobserved (sleep, restart, delayed alarm).
  if (!anchor?.subscriptionId || anchor.session !== session || elapsed <= 0 || elapsed > 60000) return null;
  return { eventId, subscriptionId:anchor.subscriptionId, startedAt:new Date(anchor.at).toISOString(), endedAt:new Date(now).toISOString(), activeSeconds:elapsed / 1000 };
}
// A tab that is playing sound counts even when another window is focused or you are away.
// Muted tabs, incognito tabs and non-HTTPS pages never count.
export function audibleSubscription(tabs, mappings) {
  for (const tab of tabs || []) {
    if (!tab || !tab.audible || tab.mutedInfo?.muted || tab.incognito || !tab.url) continue;
    let url; try { url = new URL(tab.url); } catch { continue; }
    if (url.protocol !== 'https:') continue;
    const id = mappings.find(m => m.domains.some(d => matches(url.hostname, d)))?.subscriptionId;
    if (id) return id;
  }
  return null;
}
