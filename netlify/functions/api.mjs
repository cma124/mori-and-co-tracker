// Netlify Function: forwards the app's API calls to the Google Apps Script web app.
// The Apps Script URL is read from the APPS_SCRIPT_URL environment variable, so it is never
// committed to GitHub and never sent to the browser. Login and data checks still happen in
// Apps Script (this function adds no access of its own and stores nothing).

const MAX_BODY_BYTES = 100 * 1024;

const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export default async (req) => {
  if (req.method !== 'POST') return reply({ ok: false, error: 'Method not allowed.' }, 405);

  // Only accept calls made by pages served from this same site.
  const origin = req.headers.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === new URL(req.url).host; } catch (e) { /* ignore */ }
    if (!ok) return reply({ ok: false, error: 'Forbidden.' }, 403);
  }

  const target = process.env.APPS_SCRIPT_URL;
  if (!target) return reply({ ok: false, error: 'Server is not configured (APPS_SCRIPT_URL is missing).' }, 500);

  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return reply({ ok: false, error: 'Request too large.' }, 413);

  try {
    // Apps Script answers a POST with a redirect to the result; fetch follows it.
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    const text = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      return reply({ ok: false, error: 'The data service returned an unexpected response. Check the Apps Script deployment.' }, 502);
    }
    return reply(parsed);
  } catch (e) {
    return reply({ ok: false, error: 'Could not reach the data service. Please try again.' }, 502);
  }
};

export const config = { path: '/api' };
