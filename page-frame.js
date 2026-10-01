'use strict';
window.TrackerPageFrame = Object.freeze((function () {
  const PARENT_ORIGINS = new Set([
    'https://galygious.github.io',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
    'http://127.0.0.1:8790',
    'http://localhost:8790'
  ]);
  const RPC_ID = /^[0-9a-f]{32}$/;
  const RPC_METHODS = new Set(['profile.read', 'profile.saveGoal', 'moderationQueue.list', 'moderationQueue.setStatus']);
  let active = null;

  function exactKeys(value, keys) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function randomRpcId() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') throw new Error('Secure page messaging is unavailable.');
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function safeScriptJson(value) {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => ({
      '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029'
    })[char]);
  }

  function bootstrap(parentOrigin, canEdit, capability) {
    return `<script>(()=>{
      'use strict';
      const parentOrigin=${safeScriptJson(parentOrigin)};
      const documentCapability=${safeScriptJson(capability)};
      const canEdit=${canEdit ? 'true' : 'false'};
      const RPC_ID=/^[0-9a-f]{32}$/;
      const pending=new Map();
      let replyPort=null;
      function id(){if(!window.crypto||!window.crypto.getRandomValues)throw new Error('Secure page messaging is unavailable.');const b=new Uint8Array(16);window.crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');}
      function exact(value,keys){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(value,k));}
      function receiveResult(message){if(!message||typeof message!=='object'||Array.isArray(message)||message.type!=='hearthside-page-result'||message.v!==1||typeof message.rpcId!=='string'||!RPC_ID.test(message.rpcId)||typeof message.ok!=='boolean')return;const keys=message.ok?['type','v','rpcId','ok','data']:['type','v','rpcId','ok','error'];if(!exact(message,keys))return;if(!message.ok&&(typeof message.error!=='string'||!/^[A-Z_]{1,40}$/.test(message.error)))return;const call=pending.get(message.rpcId);if(!call)return;clearTimeout(call.timer);pending.delete(message.rpcId);if(message.ok)call.resolve(message.data);else{const error=new Error(message.error);error.code=message.error;call.reject(error);}}
      window.addEventListener('message',event=>{if(event.origin!==parentOrigin||event.source!==window.parent)return;const message=event.data;if(!exact(message,['type','v'])||message.type!=='hearthside-page-connect'||message.v!==1||replyPort||!event.ports||event.ports.length!==1)return;replyPort=event.ports[0];replyPort.onmessage=portEvent=>receiveResult(portEvent.data);if(typeof replyPort.start==='function')replyPort.start();replyPort.postMessage({type:'hearthside-page-connected',v:1,capability:documentCapability});});
      function call(method,args){return new Promise((resolve,reject)=>{let rpcId;try{rpcId=id();}catch(error){reject(error);return;}const timer=setTimeout(()=>{pending.delete(rpcId);const error=new Error('The request timed out.');error.code=method.endsWith('.saveGoal')||method.endsWith('.setStatus')?'REQUEST_UNCERTAIN':'TIMEOUT';reject(error);},32000);pending.set(rpcId,{resolve,reject,timer,method});try{window.parent.postMessage({type:'hearthside-page-call',v:1,capability:documentCapability,rpcId,method,args},parentOrigin);}catch(error){clearTimeout(timer);pending.delete(rpcId);reject(error);}});}
      const profile=Object.freeze({canEdit,read:()=>call('profile.read',{}),saveGoal:(goal,expectedVersion)=>call('profile.saveGoal',{goal,expectedVersion})});
      const moderationQueue=Object.freeze({list:()=>call('moderationQueue.list',{}),setStatus:(id,status,expectedVersion)=>call('moderationQueue.setStatus',{id,status,expectedVersion})});
      const memberGuides=Object.freeze({mount:()=>undefined});
      Object.defineProperty(window,'HearthsidePage',{value:Object.freeze({profile,moderationQueue,memberGuides}),writable:false,configurable:false});
      window.addEventListener('beforeunload',()=>{try{window.parent.postMessage({type:'hearthside-page-navigating',v:1,capability:documentCapability},parentOrigin);}catch(_){}});
      window.addEventListener('load',()=>setTimeout(()=>{try{window.parent.postMessage({type:'hearthside-page-ready',v:1,capability:documentCapability},parentOrigin);}catch(_){}},0),{once:true});
    })();</script>`;
  }

  function documentFor(html, parentOrigin, canEdit, capability) {
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'; frame-src \'none\'; object-src \'none\'">';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">${csp}<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${bootstrap(parentOrigin, canEdit, capability)}${html}</body></html>`;
  }

  function send(entry, message) {
    if (active !== entry || !entry.frame.isConnected || !entry.ready || !entry.connected || !entry.port) return;
    try { entry.port.postMessage(message); } catch (_) { /* The port belongs to this srcdoc document and is closed on navigation. */ }
  }

  function reply(entry, rpcId, ok, value) {
    const message = ok
      ? { type: 'hearthside-page-result', v: 1, rpcId, ok: true, data: value }
      : { type: 'hearthside-page-result', v: 1, rpcId, ok: false, error: /^[A-Z_]{1,40}$/.test(value) ? value : 'UNAVAILABLE' };
    send(entry, message);
  }

  function handleMessage(event) {
    const entry = active;
    if (!entry || !entry.frame.isConnected || event.origin !== 'null' || event.source !== entry.frame.contentWindow) return false;
    const message = event.data;
    if (exactKeys(message, ['type', 'v', 'capability']) && message.type === 'hearthside-page-ready' && message.v === 1 &&
        message.capability === entry.capability && !entry.ready) {
      const channel = new window.MessageChannel();
      entry.port = channel.port1;
      entry.port.onmessage = (portEvent) => {
        const connected = portEvent.data;
        if (!entry.connected && exactKeys(connected, ['type', 'v', 'capability']) && connected.type === 'hearthside-page-connected' &&
            connected.v === 1 && connected.capability === entry.capability) {
          entry.connected = true;
          const queued = entry.queued.splice(0);
          queued.forEach((call) => invoke(entry, call));
        }
      };
      if (typeof entry.port.start === 'function') entry.port.start();
      entry.ready = true;
      entry.loaded = true;
      try { event.source.postMessage({ type: 'hearthside-page-connect', v: 1 }, '*', [channel.port2]); }
      catch (_) { clear(); return false; }
      return true;
    }
    if (exactKeys(message, ['type', 'v', 'capability']) && message.type === 'hearthside-page-navigating' && message.v === 1 &&
        message.capability === entry.capability) {
      if (typeof entry.onNavigate === 'function') entry.onNavigate();
      clear();
      return true;
    }
    if (!exactKeys(message, ['type', 'v', 'capability', 'rpcId', 'method', 'args']) || message.type !== 'hearthside-page-call' || message.v !== 1 ||
        message.capability !== entry.capability ||
        typeof message.rpcId !== 'string' || !RPC_ID.test(message.rpcId) || typeof message.method !== 'string' || !RPC_METHODS.has(message.method) ||
        !message.args || typeof message.args !== 'object' || Array.isArray(message.args)) return false;
    if (entry.seen.has(message.rpcId)) return false;
    if (entry.seen.size >= 256) { reply(entry, message.rpcId, false, 'BUSY'); return true; }
    entry.seen.add(message.rpcId);
    if (!entry.connected) {
      if (entry.queued.length >= 8) return true;
      entry.queued.push(message);
      return true;
    }
    invoke(entry, message);
    return true;
  }

  function invoke(entry, message) {
    if (active !== entry || entry.calls.size >= 8) { reply(entry, message.rpcId, false, 'BUSY'); return; }
    const controller = new AbortController();
    entry.calls.set(message.rpcId, controller);
    Promise.resolve().then(() => entry.onRequest(message.method, message.args, controller.signal)).then((data) => {
      if (active === entry && !controller.signal.aborted) reply(entry, message.rpcId, true, data);
    }).catch((error) => {
      if (active === entry && !controller.signal.aborted) reply(entry, message.rpcId, false, error && error.code || 'UNAVAILABLE');
    }).finally(() => { entry.calls.delete(message.rpcId); });
  }

  function clear() {
    const entry = active;
    active = null;
    if (!entry) return;
    for (const controller of entry.calls.values()) controller.abort();
    entry.calls.clear();
    entry.queued.length = 0;
    if (entry.port) entry.port.close();
    entry.frame.remove();
  }

  function mount(container, options) {
    clear();
    const origin = window.location.origin;
    if (!PARENT_ORIGINS.has(origin)) throw new Error('This page cannot safely host private content.');
    if (!options || typeof options.html !== 'string' || typeof options.title !== 'string' || typeof options.onRequest !== 'function') throw new Error('The shared page could not be opened.');
    const capability = randomRpcId();
    const frame = document.createElement('iframe');
    frame.className = 'private-page-frame';
    frame.title = options.title;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = documentFor(options.html, origin, options.canEdit === true, capability);
    const entry = { frame, capability, onRequest: options.onRequest, onNavigate: options.onNavigate, calls: new Map(), seen: new Set(), queued: [], ready: false, connected: false, port: null, loaded: false };
    frame.addEventListener('load', () => {
      if (!entry.ready || !entry.loaded) return;
      if (active === entry) {
        if (typeof entry.onNavigate === 'function') entry.onNavigate();
        clear();
      }
    });
    active = entry;
    container.append(frame);
    return frame;
  }

  return Object.freeze({ mount, clear, handleMessage });
})());
