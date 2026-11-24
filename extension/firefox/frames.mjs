// Invoked only by the selected top document's private content-script port.
export function frameInspection(origin, key, signal, inspect) {
  let nextId = 0;
  const byFrame = new WeakMap();
  let listed = new Map();
  const unavailable = () => new Error('Frame is stale or not an authorized visible iframe; run frames again');
  const visible = (el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const enabled = (el) => !el.matches(':disabled') && !el.closest('[inert], [aria-disabled="true"]');
  const safe = (el) => !el.closest('script,style,noscript,template,iframe,frame,fencedframe,object,embed,input[type=password i],input[type=file i]');

  function child(parentDoc, frame) {
    try {
      if (frame.namespaceURI !== 'http://www.w3.org/1999/xhtml' || frame.localName !== 'iframe' ||
          frame.getRootNode() !== parentDoc || frame.hasAttribute('sandbox') || frame.hasAttribute('srcdoc') || !visible(frame)) return;
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      if (!doc || !win || win.document !== doc || win.frameElement !== frame || win.parent !== parentDoc.defaultView) return;
      const url = new URL(doc.URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || win.origin !== origin ||
          url.username || url.password) return;
      const { left, right, top, bottom } = frame.getBoundingClientRect();
      if (right <= 0 || bottom <= 0 || left >= win.parent.innerWidth || top >= win.parent.innerHeight) return;
      return { doc, win, href: url.href };
    } catch { return undefined; }
  }

  function frames() {
    const found = new Map();
    function visit(parent, depth) {
      if (depth === 20) return;
      for (const frame of (parent?.doc ?? document).querySelectorAll('iframe')) {
        const context = child(parent?.doc ?? document, frame);
        if (!context) continue;
        let entry = byFrame.get(frame);
        if (!entry?.valid || entry.doc !== context.doc || entry.href !== context.href || entry.parent !== parent) {
          entry = { ...context, frame, parent, valid: true, frameId: entry?.frameId ?? ++nextId,
            documentId: crypto.randomUUID(), realm: { origin } };
          byFrame.set(frame, entry);
          const pinned = entry;
          const lifetime = new AbortController();
          const invalidate = () => { pinned.valid = false; lifetime.abort(); };
          const options = { signal: AbortSignal.any([signal, lifetime.signal]), capture: true };
          for (const event of ['pagehide', 'popstate', 'hashchange']) {
            entry.win.addEventListener(event, (e) => { if (e.isTrusted) invalidate(); }, options);
          }
        }
        found.set(entry.frameId, entry);
        visit(entry, depth + 1);
      }
    }
    visit(undefined, 0);
    listed = found;
    return Array.from(found.values(), ({ frameId, documentId }) => ({ frameId, documentId }));
  }

  function assert(entry) {
    if (signal.aborted) throw unavailable();
    if (entry.parent) assert(entry.parent);
    if (!entry.valid) throw unavailable();
    const current = child(entry.parent?.doc ?? document, entry.frame);
    if (!current || current.doc !== entry.doc || current.win !== entry.win || current.href !== entry.href) throw unavailable();
  }

  function click(entry, ref) {
    const { doc, win, realm } = entry;
    const [generation, index] = ref.slice(2).split(':');
    const state = realm.vacuInspectionState;
    const el = state?.refs[Number(index) - 1];
    if (!state || state.key !== key || state.href !== entry.href || generation !== state.generation ||
        !el?.isConnected || el.ownerDocument !== doc || !safe(el)) throw new Error('Stale inspection reference; query again');
    if (!visible(el) || !enabled(el)) throw new Error('Frame control is hidden or disabled');
    const rect = el.getBoundingClientRect();
    const x = (Math.max(0, rect.left) + Math.min(win.innerWidth, rect.right)) / 2;
    const y = (Math.max(0, rect.top) + Math.min(win.innerHeight, rect.bottom)) / 2;
    const hit = doc.elementFromPoint(x, y);
    if (!hit || !el.contains(hit) || !safe(hit) || !enabled(hit)) throw new Error('Frame control is covered or unavailable');
    let px = x;
    let py = y;
    for (let node = entry; node; node = node.parent) {
      const { frame } = node;
      const parent = frame.ownerDocument;
      // shortcut: reject transformed/zoomed frames for input until precise coordinate mapping is supported.
      for (let ancestor = frame; ancestor; ancestor = ancestor.parentElement) {
        const style = parent.defaultView.getComputedStyle(ancestor);
        if (['transform', 'scale', 'rotate', 'translate', 'perspective'].some((name) => style[name] !== 'none') ||
            !['normal', '1'].includes(style.zoom)) throw new Error('Frame coordinate mapping is not supported');
      }
      const style = parent.defaultView.getComputedStyle(frame);
      const box = frame.getBoundingClientRect();
      px += box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      py += box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
      if (parent.elementFromPoint(px, py) !== frame) throw new Error('Frame control is covered or unavailable');
    }
    const labelControl = hit.closest('label')?.control;
    if (labelControl && (!safe(labelControl) || !enabled(labelControl))) throw new Error('Unsupported label control');
    const control = labelControl ?? hit.closest('button,input');
    if (control?.form && ['image', 'submit', 'reset'].includes(control.type)) throw new Error('Frame form actions are not supported');
    const anchor = hit.closest('a,area');
    if (anchor?.hasAttribute('href')) {
      const target = anchor.getAttribute('target') || doc.querySelector('base[target]')?.getAttribute('target') || '';
      const url = new URL(anchor.getAttribute('href'), doc.baseURI);
      if (anchor.namespaceURI !== 'http://www.w3.org/1999/xhtml' || anchor.hasAttribute('download') ||
          !['', '_self'].includes(target.toLowerCase()) || !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== origin || url.username || url.password) throw new Error('Frame link destination is not supported');
    } else if (anchor && anchor.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
      throw new Error('Frame link destination is not supported');
    }
    assert(entry);
    hit.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, detail: 1 }));
    return { ok: true, value: { dispatched: true, trusted: false } };
  }

  return { frames, run(frameId, documentId, operation, payload) {
    const entry = listed.get(frameId);
    if (!entry || entry.documentId !== documentId) throw unavailable();
    assert(entry);
    const result = operation === 'assert' ? { ok: true, value: true }
      : operation === 'click' ? click(entry, payload) : inspect(entry, origin, key, operation, payload);
    assert(entry);
    return result;
  } };
}
