(() => {
  const channel = 'x-bellek';
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  const handlePattern = '[A-Za-z0-9_]{1,15}';
  const profilePath = new RegExp('^/(' + handlePattern + ')/?$');
  const profileRoute = new RegExp('^/(' + handlePattern + ')(?:/(?:with_replies|media|highlights|articles|likes))?/?$');
  const postPath = new RegExp('^/(' + handlePattern + ')/status/(\\d+)/?$');
  const postSelector = 'article[data-testid="tweet"]';
  const colors = {
    green: ['#34784b', '#edf5ed'], blue: ['#3e6999', '#edf3fb'],
    amber: ['#946c2d', '#fbf3e4'], rose: ['#a44f6a', '#fbedf1'],
    slate: ['#66717d', '#edf0f3']
  };
  const buttons = new Map();
  let overlay, frame, anchor, pendingOpen;
  let preferredHeight = 400;
  let scheduled = false, refreshing = false, refreshAgain = false;
  let port;

  function linkPath(link) {
    try {
      const url = new URL(link.href);
      return url.origin === 'https://x.com' ? url.pathname : '';
    } catch {
      return '';
    }
  }

  function handleSpan(header, handle) {
    return [...header.querySelectorAll('span')].find(span =>
      span.childElementCount === 0 && span.textContent.trim().toLowerCase() === '@' + handle
    );
  }

  function targets() {
    const found = new Map();
    for (const post of document.querySelectorAll(postSelector)) {
      if (post.parentElement?.closest(postSelector)) continue;
      const header = post.querySelector('[data-testid="User-Name"]');
      if (header?.closest(postSelector) !== post) continue;
      const links = [...header.querySelectorAll('a[href]')].map(link => ({ link, path: linkPath(link) }));
      const profiles = links.flatMap(({link, path}) => {
        const name = profilePath.exec(path)?.[1].toLowerCase();
        return name ? [{ link, name }] : [];
      });
      const account = profiles.find(({link,name}) => link.textContent.trim().toLowerCase() === '@' + name)
        || profiles.find(({name}) => handleSpan(header, name));
      if (!account) continue;
      const username = account.name;
      const slot = profiles.find(({name}) => name === username).link;
      const permalink = links.map(({path}) => postPath.exec(path))
        .find(match => match?.[1].toLowerCase() === username);
      found.set(slot, {
        username,
        source: permalink ? `https://x.com/${username}/status/${permalink[2]}` : '',
        title: permalink ? `@${username} · X post` : ''
      });
    }
    const profile = profileRoute.exec(location.pathname)?.[1].toLowerCase();
    const header = document.querySelector('main [data-testid="UserName"]');
    if (profile && header && !header.closest(postSelector)) {
      const slot = handleSpan(header, profile);
      if (slot) found.set(slot.closest('a[href]') || slot, { username: profile });
    }
    return found;
  }

  function place() {
    if (!overlay) return;
    if (!anchor?.isConnected) { requestClose(); return; }
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(1, Math.min(420, innerWidth - 24));
    const height = Math.max(1, Math.min(preferredHeight, 580, innerHeight - 32));
    const below = innerHeight - rect.bottom;
    const top = below >= height + 16
      ? rect.bottom + 8
      : Math.min(rect.top - height - 8, innerHeight - height - 16);
    Object.assign(overlay.style, {
      width: `${width}px`, height: `${height}px`,
      left: `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`,
      top: `${Math.max(16, top)}px`
    });
  }

  function close() {
    overlay?.remove();
    overlay = frame = null;
    const previous = anchor;
    anchor = null;
    previous?.shadowRoot.querySelector('button').focus();
    if (pendingOpen) {
      const next = pendingOpen;
      pendingOpen = null;
      if (next.host.isConnected) open(next);
    }
  }

  function requestClose() {
    frame?.contentWindow.postMessage({ type: channel + '-request-close' }, extensionOrigin);
  }

  function open(entry) {
    if (overlay) {
      pendingOpen = anchor === entry.host ? null : entry;
      requestClose();
      return;
    }
    const { ref, host } = entry;
    anchor = host;
    preferredHeight = 400;
    overlay = document.createElement('xbellek-panel');
    overlay.style.cssText = 'position:fixed;z-index:2147483647;display:block;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px #0f141920,0 24px 64px #0f14193c;border:1px solid #77859170;color-scheme:light dark';
    const shadow = overlay.attachShadow({ mode: 'open' });
    frame = document.createElement('iframe');
    frame.title = `Private notes for @${ref.username}`;
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:#fff';
    const url = new URL(chrome.runtime.getURL('pages/app.html'));
    url.searchParams.set('panel', ref.username);
    if (ref.source) url.searchParams.set('source', ref.source);
    if (ref.title) url.searchParams.set('title', ref.title);
    frame.src = url.href;
    frame.addEventListener('load', () => frame?.focus(), { once: true });
    shadow.append(frame);
    document.documentElement.append(overlay);
    place();
  }

  function makeButton(slot, ref) {
    const host = document.createElement('xbellek-button');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:3px;height:20px;min-width:20px;border:1px solid transparent;border-radius:6px;padding:2px 4px;background:transparent;color:#717c87;cursor:pointer;font:500 10px system-ui,sans-serif}
      svg{width:14px;height:14px;flex:none}
      button:hover{background:#eff3f4;color:#0f1419;border-color:#cfd9de}
      button:focus-visible{outline:2px solid #166da8;outline-offset:2px}
      button.saved{background:var(--bg);color:var(--fg);border-color:color-mix(in srgb,var(--fg) 20%,transparent)}
    `;
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h9l5 5v13H5V3Zm9 0v5h5m-10 3 6 6m0-6-6 6"/></svg>';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      reconcile();
      const current = buttons.get(slot);
      if (current) open(current);
    });
    label(button, ref.username);
    shadow.append(style, button);
    slot.before(host);
    return { host, button, ref };
  }

  function label(button, username, count = 0) {
    button.title = count ? `Show ${count} ${count === 1 ? 'note' : 'notes'} for @${username}` : `Add a note for @${username}`;
    button.setAttribute('aria-label', button.title);
  }

  function reconcile() {
    const found = targets();
    let changed = false;
    for (const [slot, entry] of buttons) {
      const ref = found.get(slot);
      if (!ref || !entry.host.isConnected || entry.host.nextSibling !== slot || ref.username !== entry.ref.username) {
        entry.host.remove();
        buttons.delete(slot);
        changed = true;
      } else {
        entry.ref = ref;
      }
    }
    for (const [slot, ref] of found) {
      if (buttons.has(slot)) continue;
      buttons.set(slot, makeButton(slot, ref));
      changed = true;
    }
    if (changed) void refresh();
    place();
  }

  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    if (!buttons.size) return;
    refreshing = true;
    try {
      const authors = [...new Set([...buttons.values()].map(({ref}) => ref.username))]
        .slice(0, 1000).map(username => ({username}));
      const response = await chrome.runtime.sendMessage({ channel, op: 'lookup', authors });
      if (!response?.ok) throw new Error(response?.error);
      const results = new Map(response.value.map(summary => [summary.username, summary]));
      for (const { button, ref } of buttons.values()) {
        const summary = results.get(ref.username);
        const count = summary?.count || 0;
        button.classList.toggle('saved', count > 0);
        const [fg, bg] = colors[summary?.color] || colors.green;
        button.style.setProperty('--fg', fg);
        button.style.setProperty('--bg', bg);
        let number = button.querySelector('span');
        if (count) {
          if (!number) { number = document.createElement('span'); button.append(number); }
          number.textContent = String(count);
        } else {
          number?.remove();
        }
        label(button, ref.username, count);
      }
    } catch {
      for (const { button } of buttons.values()) button.title = 'Could not reach HandleNotes. Refresh the page and try again.';
    } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; reconcile(); }, 100);
  }

  document.addEventListener('pointerdown', event => {
    if (overlay && !event.composedPath().includes(overlay) && !event.composedPath().includes(anchor)) requestClose();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') requestClose();
  });
  window.addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== extensionOrigin) return;
    if (event.data?.type === channel + '-close') close();
    if (event.data?.type === channel + '-size' && Number.isFinite(event.data.height)) {
      preferredHeight = Math.max(200, event.data.height);
      place();
    }
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, { passive: true });
  window.addEventListener('popstate', schedule);

  const ownTags = ['XBELLEK-BUTTON', 'XBELLEK-PANEL'];
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type !== 'childList' ||
        [...record.addedNodes, ...record.removedNodes].some(node => !ownTags.includes(node.tagName)))) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'data-testid'] });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== channel || message.op !== 'pageAuthors') return;
    const names = new Set([...targets().values()].map(ref => ref.username));
    respond([...names].slice(0, 1000).map(username => ({username})));
  });

  function connect() {
    try {
      port = chrome.runtime.connect({ name: channel + '-updates' });
      port.onMessage.addListener(refresh);
      port.onDisconnect.addListener(() => setTimeout(connect, 1800));
    } catch {}
  }

  reconcile();
  connect();
})();
