// The browser only ever talks to this same-site path. The real Apps Script URL lives in the
// Netlify environment variable APPS_SCRIPT_URL and is used by netlify/functions/api.mjs.
window.APP_CONFIG = {
  API_URL: '/api',
};
