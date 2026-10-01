'use strict';
window.TrackerBridge = Object.freeze((function () {
  const allowedOrigins = new Set([
    'https://script.google.com',
    'https://script.googleusercontent.com'
  ]);

  function sourceDescendsFrom(source, target) {
    if (!source || !target) return false;
    let current = source;
    for (let depth = 0; depth <= 8; depth += 1) {
      if (current === target) return true;
      let parent;
      try {
        parent = current.parent;
      } catch (_) {
        return false;
      }
      if (!parent || parent === current) return false;
      current = parent;
    }
    return false;
  }

  function accepts(event, pending) {
    if (!event || !pending || !pending.frame || !allowedOrigins.has(event.origin)) return false;
    const message = event.data;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    if (message.type !== 'tracker-response' || message.v !== 1 || message.requestId !== pending.requestId || typeof message.ok !== 'boolean') return false;
    const expected = message.ok
      ? ['type', 'v', 'requestId', 'ok', 'data']
      : ['type', 'v', 'requestId', 'ok', 'error'];
    if (Object.keys(message).length !== expected.length || expected.some((key) => !Object.prototype.hasOwnProperty.call(message, key))) return false;
    if (message.ok && (!message.data || typeof message.data !== 'object' || Array.isArray(message.data))) return false;
    if (!message.ok && (typeof message.error !== 'string' || !/^[A-Z_]{1,40}$/.test(message.error))) return false;
    return sourceDescendsFrom(event.source, pending.frame.contentWindow);
  }

  return { accepts, sourceDescendsFrom };
})());
