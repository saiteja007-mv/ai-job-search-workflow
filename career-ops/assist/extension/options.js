const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = 'https://<YOUR_DOMAIN>';

chrome.storage.local.get(['endpoint', 'token'], (v) => {
  $('endpoint').value = v.endpoint || DEFAULT_ENDPOINT;
  $('token').value = v.token || '';
});

$('save').addEventListener('click', () => {
  const endpoint = ($('endpoint').value || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  chrome.storage.local.set({ endpoint, token: $('token').value.trim() }, () => {
    $('status').textContent = 'Saved.';
    $('status').style.color = '#2e7d32';
  });
});

$('test').addEventListener('click', async () => {
  const endpoint = ($('endpoint').value || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const token = $('token').value.trim();
  $('status').textContent = 'Testing…';
  $('status').style.color = '#666';
  try {
    // /health needs no auth — it proves the tunnel and service are up.
    const h = await fetch(endpoint + '/health');
    if (!h.ok) throw new Error('server returned HTTP ' + h.status);
    const info = await h.json();
    // A second, authenticated call is what actually proves the token.
    const a = await fetch(endpoint + '/api/assist/application/__probe__', {
      headers: { Authorization: 'Bearer\u0020' + token },
    });
    if (a.status === 401) throw new Error('server is up, but the token was rejected');
    $('status').textContent = `Connected to ${info.app} (v${info.version}). Token accepted.`;
    $('status').style.color = '#2e7d32';
  } catch (e) {
    $('status').textContent = 'Failed: ' + e.message;
    $('status').style.color = '#c62828';
  }
});
