'use strict';
const cfg = window.TRACKER_CONFIG || {};
const el = (id) => document.getElementById(id);
const status = el('status');
const allowedApiOrigins = new Set(['https://script.google.com']);
const allowedPublicResponseOrigins = new Set(['https://script.google.com', 'https://script.googleusercontent.com']);
const allowedChallengeOps = new Set(['exchange', 'profile', 'logout']);
const publicResponseLimit = 512 * 1024;
let session = null;
let gisPromise = null;
let gisInitialized = false;
let signInGeneration = 0;
let signInDeadline = 0;
let signInExpiryTimer = null;
let busy = false;
const pending = new Map();

function say(message, tone) {
  status.textContent = message;
  status.dataset.tone = tone || 'neutral';
}

function validateConfig() {
  try {
    const url = new URL(cfg.apiUrl);
    return url.protocol === 'https:' && allowedApiOrigins.has(url.origin) &&
      /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) && !url.search && !url.hash &&
      typeof cfg.clientId === 'string' && /^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/.test(cfg.clientId);
  } catch (_) {
    return false;
  }
}

function randomRequestId() {
  if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') throw new Error('Secure sign-in needs a modern browser on HTTPS.');
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function publicGetUrl(kind, gameOp, requestId) {
  if (typeof cfg.apiUrl !== 'string') throw new Error('The community service is unavailable.');
  const url = new URL(cfg.apiUrl);
  if (url.href !== cfg.apiUrl || url.origin !== 'https://script.google.com' || url.username || url.password || url.search || url.hash ||
      !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw new Error('The community service is unavailable.');
  if (kind === 'challenge') {
    if (!allowedChallengeOps.has(gameOp) || typeof requestId !== 'string' || !/^[0-9a-f]{48}$/.test(requestId)) {
      throw new Error('A secure request could not be prepared. Please try again.');
    }
    url.searchParams.set('op', 'app.challenge');
    url.searchParams.set('gameOp', gameOp);
    url.searchParams.set('requestId', requestId);
    url.searchParams.set('callback', 'trackerCallback');
    return url;
  }
  if (kind === 'public' && gameOp === undefined && requestId === undefined) {
    url.searchParams.set('op', 'public');
    return url;
  }
  throw new Error('The community service is unavailable.');
}

function publicGetError(message, code) {
  return Object.assign(new Error(message), { code });
}

function publicGetAbortError() {
  return publicGetError('This request was cancelled.', 'ABORTED');
}

async function readBoundedPublicText(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const normalized = String(contentLength).trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) > publicResponseLimit) throw new Error('Oversized public response.');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let byteLength = 0;
    let text = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        byteLength += part.value.byteLength;
        if (byteLength > publicResponseLimit) {
          try { await reader.cancel(); } catch (_) { /* Stop an oversized response best-effort. */ }
          throw new Error('Oversized public response.');
        }
        text += decoder.decode(part.value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      try { await reader.cancel(); } catch (_) { /* The response may already be aborted or closed. */ }
      throw error;
    }
  }
  const text = await response.text();
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > publicResponseLimit) throw new Error('Oversized public response.');
  return text;
}

function parsePublicGetText(kind, text) {
  if (kind === 'challenge') {
    const match = /^\s*trackerCallback\((\{[\s\S]*\})\);\s*$/.exec(text);
    if (!match) throw new Error('Unexpected challenge response.');
    const result = JSON.parse(match[1]);
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 ||
        typeof result.challenge !== 'string' || !result.challenge || result.challenge.length > 2048) {
      throw new Error('Unexpected challenge response.');
    }
    return result.challenge;
  }
  if (kind === 'public') {
    const result = JSON.parse(text);
    if (!Array.isArray(result)) throw new Error('Unexpected community board response.');
    return result;
  }
  throw new Error('The community service is unavailable.');
}

function fetchPublicGet(kind, gameOp, requestId) {
  let url;
  try { url = publicGetUrl(kind, gameOp, requestId); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    if (typeof AbortController !== 'function') return reject(new Error('This browser cannot securely contact the community service.'));
    const controller = new AbortController();
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      finish(publicGetError('The community service did not respond.', 'PUBLIC_GET_TIMEOUT'));
    }, 15000);
    Promise.resolve().then(() => window.fetch(url.href, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    })).then(async (response) => {
      if (!response || !response.ok) throw new Error('The community service is unavailable.');
      const finalOrigin = new URL(response.url).origin;
      if (!allowedPublicResponseOrigins.has(finalOrigin)) throw new Error('Unexpected community service response origin.');
      const mediaType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      const expectedType = kind === 'challenge' ? 'text/javascript' : 'application/json';
      if (mediaType !== expectedType) throw new Error('Unexpected community service response type.');
      return parsePublicGetText(kind, await readBoundedPublicText(response));
    }).then((result) => finish(null, result)).catch(() => {
      if (timedOut) return;
      finish(new Error('The community service is unavailable.'));
    });
  });
}

async function getChallenge(gameOp, requestId) {
  return fetchPublicGet('challenge', gameOp, requestId);
}

async function getPublicRows() {
  return fetchPublicGet('public');
}

function acceptedOrigin(event) {
  return window.TrackerBridge && window.TrackerBridge.accepts(event, pending.get(event.data && event.data.requestId));
}

function clearPending(requestId, entry) {
  if (entry.timer) window.clearTimeout(entry.timer);
  pending.delete(requestId);
  if (entry.form) entry.form.remove();
  if (entry.frame) entry.frame.remove();
}

function postBridge(gameOp, requestId, challenge, values) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.name = `tracker-response-${requestId}`;
    frame.title = 'Secure community response';
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = cfg.apiUrl;
    form.target = frame.name;
    form.hidden = true;
    const fields = { app: 'game', gameOp, requestId, challenge, ...values };
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value !== 'string') return reject(new Error('The secure request contains invalid data.'));
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    const entry = { requestId, frame, form, resolve, reject, timer: null };
    entry.timer = window.setTimeout(() => {
      clearPending(requestId, entry);
      reject(new Error('The response timed out. Check your connection and try again.'));
    }, 25000);
    pending.set(requestId, entry);
    document.body.append(frame, form);
    try {
      form.submit();
      for (const input of Array.from(form.elements)) {
        input.value = '';
        input.remove();
      }
    } catch (_) {
      clearPending(requestId, entry);
      reject(new Error('The secure request could not be sent.'));
    }
  });
}

window.addEventListener('message', (event) => {
  if (!acceptedOrigin(event)) return;
  const message = event.data;
  const entry = pending.get(message.requestId);
  if (!entry) return;
  clearPending(message.requestId, entry);
  if (message.ok) entry.resolve(message.data);
  else entry.reject(Object.assign(new Error(friendlyError(message.error)), { code: message.error }));
});

async function sendGame(gameOp, values, fixedChallenge, fixedRequestId) {
  const requestId = fixedRequestId || randomRequestId();
  const challenge = fixedChallenge || await getChallenge(gameOp, requestId);
  return postBridge(gameOp, requestId, challenge, values);
}

function friendlyError(code) {
  const messages = {
    DENIED: 'This Google account does not have access to that player space.',
    INVALID_IDENTITY: 'Google sign-in could not be verified. Please sign in again.',
    INVALID_CHALLENGE: 'The secure request expired. Please start again.',
    INVALID_SESSION: 'Your sign-in has expired. Please sign in again.',
    SESSION_REVOKED: 'You have signed out. Sign in again to continue.',
    DEMO_DISABLED: 'The community app is temporarily unavailable.',
    STORAGE_UNAVAILABLE: 'The community app is temporarily unavailable.',
    BUSY: 'The community service is busy. Please try again shortly.'
  };
  return messages[code] || 'Something went wrong. Please try again.';
}

function decodeChallengeIdentity(challenge) {
  const body = challenge.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  const decoded = window.atob(body + '='.repeat((4 - body.length % 4) % 4));
  const payload = JSON.parse(decoded);
  if (typeof payload.nonce !== 'string' || !payload.nonce || !Number.isInteger(payload.exp)) {
    throw new Error('The sign-in request could not be prepared.');
  }
  return { nonce: payload.nonce, exp: payload.exp };
}

function loadGIS() {
  if (window.google && window.google.accounts) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => {
      gisPromise = null;
      script.remove();
      reject(new Error('Google sign-in could not be loaded. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

function setBusy(value) {
  busy = value;
  el('sign-in').disabled = value;
  el('sign-out').disabled = value;
  el('refresh-profile').disabled = value;
  el('sign-in').setAttribute('aria-busy', String(value));
}

function retireSignIn(message, tone) {
  signInGeneration += 1;
  signInDeadline = 0;
  if (signInExpiryTimer !== null) window.clearTimeout(signInExpiryTimer);
  signInExpiryTimer = null;
  el('google-button').replaceChildren();
  el('google-button').hidden = true;
  el('sign-in').textContent = gisInitialized ? 'Refresh sign-in' : 'Try Google sign-in again';
  el('sign-in').hidden = Boolean(session);
  el('sign-in-slot').hidden = Boolean(session);
  if (message) say(message, tone || 'notice');
}

async function prepareSignIn() {
  if (busy || session) return;
  if (gisInitialized) { window.location.reload(); return; }
  const generation = ++signInGeneration;
  setBusy(true);
  el('google-button').replaceChildren();
  el('google-button').hidden = true;
  el('sign-in').textContent = 'Preparing Google sign-in…';
  el('sign-in').hidden = false;
  el('sign-in-slot').hidden = false;
  try {
    const requestId = randomRequestId();
    const challenge = await getChallenge('exchange', requestId);
    await loadGIS();
    if (generation !== signInGeneration || session) return;
    const { nonce, exp } = decodeChallengeIdentity(challenge);
    const freshForMs = Math.min(240000, exp * 1000 - Date.now() - 45000);
    if (freshForMs <= 0) throw new Error('Sign-in preparation expired. Refresh this page and try again.');
    signInDeadline = Date.now() + freshForMs;
    gisInitialized = true;
    window.google.accounts.id.initialize({
      client_id: cfg.clientId,
      nonce,
      auto_select: false,
      callback: async (response) => {
        if (generation !== signInGeneration || session || busy || Date.now() >= signInDeadline) {
          if (response && typeof response.credential === 'string') response.credential = '';
          if (generation === signInGeneration && !session && !busy) retireSignIn('Sign-in preparation expired. Refresh sign-in to continue.', 'notice');
          return;
        }
        if (signInExpiryTimer !== null) window.clearTimeout(signInExpiryTimer);
        signInExpiryTimer = null;
        setBusy(true);
        el('google-button').replaceChildren();
        el('google-button').hidden = true;
        try {
          if (!response || typeof response.credential !== 'string') throw new Error('Google sign-in did not return an identity token.');
          const data = await sendGame('exchange', { credential: response.credential }, challenge, requestId);
          if (data.enrollmentNeeded === true) {
            const verifiedSub = document.createElement('code');
            verifiedSub.textContent = data.sub;
            el('account-name').textContent = 'Your Google account is verified';
            el('account-detail').replaceChildren(document.createTextNode('Ask the community owner to add this account: '), verifiedSub);
            el('account-badge').textContent = 'Access requested';
            say('Your account is verified. The owner can add it to the player group before your profile becomes available.', 'notice');
            return;
          }
          if (typeof data.session !== 'string') throw new Error('Your player session could not be started.');
          session = data.session;
          el('account-badge').textContent = 'Loading profile';
          say('Opening your player space…', 'neutral');
          await loadProfile();
        } catch (error) {
          clearProfile(error.message || 'Sign-in failed. Please try again.');
          status.dataset.tone = 'error';
        } finally {
          if (response && typeof response.credential === 'string') response.credential = '';
          retireSignIn();
          setBusy(false);
        }
      }
    });
    window.google.accounts.id.renderButton(el('google-button'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 220 });
    el('google-button').hidden = false;
    el('sign-in').hidden = true;
    signInExpiryTimer = window.setTimeout(() => {
      if (generation === signInGeneration && !session && !busy) retireSignIn('Sign-in preparation expired. Refresh sign-in to continue.', 'notice');
    }, freshForMs);
    say('Choose your Google account to continue.', 'neutral');
    setBusy(false);
  } catch (error) {
    retireSignIn(error.message || 'Sign-in could not be started.', 'error');
    setBusy(false);
  }
}

function retireExpiredSignIn() {
  if (signInDeadline && Date.now() >= signInDeadline && !session && !busy) {
    retireSignIn('Sign-in preparation expired. Refresh sign-in to continue.', 'notice');
  }
}

function clearProfile(message) {
  session = null;
  el('account-badge').textContent = 'Signed out';
  el('account-name').textContent = 'Your profile is waiting';
  el('account-detail').textContent = 'Sign in with Google to open your player profile and the pages shared with your role.';
  el('role-chip').hidden = true;
  el('page-list').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-state', textContent: 'Your available pages will appear here after you sign in.' }));
  el('page-preview').hidden = true;
  el('page-preview').replaceChildren();
  el('sign-out').hidden = true;
  el('refresh-profile').hidden = true;
  el('sign-in').hidden = false;
  retireSignIn();
  if (message) say(message, 'neutral');
}

async function loadProfile() {
  if (!session) return;
  const data = await sendGame('profile', { session });
  if (!data.profile || typeof data.profile.displayName !== 'string' || !Array.isArray(data.pages)) throw new Error('Your profile response was incomplete.');
  const { profile, pages } = data;
  el('account-name').textContent = profile.displayName;
  el('account-detail').textContent = 'Your community profile and currently available pages.';
  el('account-badge').textContent = 'Signed in';
  el('role-chip').textContent = profile.role;
  el('role-chip').hidden = false;
  el('sign-out').hidden = false;
  el('refresh-profile').hidden = false;
  el('sign-in').hidden = true;
  el('page-list').replaceChildren();
  if (!pages.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'There are no shared pages for your role yet.';
    el('page-list').append(empty);
  }
  for (const page of pages) {
    if (!page || typeof page.id !== 'string' || typeof page.title !== 'string') continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-card';
    const title = document.createElement('span');
    title.className = 'page-card-title';
    title.textContent = page.title;
    const action = document.createElement('span');
    action.className = 'page-card-action';
    action.textContent = 'View page';
    button.append(title, action);
    button.addEventListener('click', () => showPage(page));
    el('page-list').append(button);
  }
  say('Your profile is up to date.', 'success');
}

function showPage(page) {
  const preview = el('page-preview');
  const heading = document.createElement('h3');
  heading.textContent = page.title;
  const message = document.createElement('p');
  message.textContent = 'This page is ready for your player space. Its shared content will be available soon.';
  preview.replaceChildren(heading, message);
  preview.hidden = false;
  preview.focus({ preventScroll: true });
  preview.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}

async function refreshProfile() {
  if (busy || !session) return;
  setBusy(true);
  try {
    await loadProfile();
  } catch (error) {
    if (error.code === 'INVALID_SESSION' || error.code === 'SESSION_REVOKED' || error.code === 'DENIED') {
      clearProfile('Your player session has ended. Sign in again to continue.');
    } else {
      say(error.message || 'Your profile could not be refreshed. Please try again.', 'error');
    }
  } finally {
    setBusy(false);
  }
}

async function signOut() {
  if (busy || !session) return;
  setBusy(true);
  const currentSession = session;
  try {
    await sendGame('logout', { session: currentSession });
    clearProfile('You have signed out.');
  } catch (error) {
    clearProfile('Your local sign-in has been cleared. Sign in again to continue.');
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
  } finally {
    setBusy(false);
  }
}

async function loadPublicBoard() {
  try {
    const items = await getPublicRows();
    if (!Array.isArray(items)) throw new Error('The community board is unavailable.');
    const board = el('public-board');
    board.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'There are no new community notes right now.';
      board.append(empty);
      return;
    }
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'event-card';
      const label = document.createElement('p');
      label.className = 'event-label';
      label.textContent = 'COMMUNITY NOTE';
      const title = document.createElement('h3');
      title.textContent = String(item.title || 'Community note');
      const copy = document.createElement('p');
      copy.textContent = String(item.text || '');
      card.append(label, title, copy);
      board.append(card);
    }
  } catch (error) {
    const board = el('public-board');
    const unavailable = document.createElement('p');
    unavailable.className = 'empty-state';
    unavailable.textContent = 'The community board is taking a short break. Please check again soon.';
    board.replaceChildren(unavailable);
  }
}

el('sign-in').addEventListener('click', prepareSignIn);
el('sign-out').addEventListener('click', signOut);
el('refresh-profile').addEventListener('click', refreshProfile);
window.addEventListener('focus', retireExpiredSignIn);
window.addEventListener('pageshow', retireExpiredSignIn);
if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', retireExpiredSignIn);

if (!validateConfig()) {
  el('sign-in').disabled = true;
  el('sign-in').title = 'Google sign-in has not been configured for this site.';
  say('This community space is being prepared. Please check back soon.', 'notice');
} else {
  say('Preparing Google sign-in…', 'neutral');
  void prepareSignIn();
}
loadPublicBoard();
