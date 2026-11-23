import assert from 'node:assert/strict';
import test from 'node:test';

const event = () => ({ addListener(fn) { this.fire = fn; } });

test('named sessions group their own tabs and reject commands targeting another session', async () => {
  const port = { onMessage: event(), onDisconnect: event(), postMessage(message) { this.reply = message; } };
  const tabs = new Map();
  const groups = new Map();
  const pageActions = [];
  const mouseEvents = [];
  const clickMotion = [];
  let visible = true;
  globalThis.chrome = {
    runtime: { onMessage: event(), getURL: () => 'popup', connectNative: () => port },
    action: { async setBadgeText() {} },
    permissions: { onRemoved: event(), async contains() { return true; } },
    debugger: { onDetach: event(), onEvent: event(), async attach() {}, async detach() {}, async sendCommand(_target, method, params) {
      if (method === 'Input.dispatchMouseEvent') mouseEvents.push(params.type);
    } },
    scripting: { async executeScript({ args, target }) {
      pageActions.push([target.tabId, args[3]]);
      if (args[3] === 'click') clickMotion.push(args[6]);
      const documentId = `document-${target.tabId}`;
      if (args[3] === 'confirmClick') assert.deepEqual(target.documentIds, [documentId]);
      const value = args[3] === 'click' ? { x: 10, y: 10 } : args[3] !== 'waitCursor' || visible;
      return [{ documentId, result: { ok: true, value } }];
    } },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async get(id) { return tabs.get(id); },
      async update(id, { active }) { tabs.get(id).active = active; },
      async create({ url }) {
        const tab = { id: tabs.size + 1, groupId: -1, windowId: 1, url };
        tabs.set(tab.id, tab);
        return tab;
      },
      async query({ groupId }) { return [...tabs.values()].filter(tab => groupId === undefined || tab.groupId === groupId); },
      async group({ groupId = groups.size + 1, tabIds }) {
        groups.set(groupId, groups.get(groupId) ?? { windowId: 1 });
        for (const id of tabIds) tabs.get(id).groupId = groupId;
        return groupId;
      },
    },
    tabGroups: {
      async get(id) { return groups.get(id); },
      async update(id, info) { Object.assign(groups.get(id), info); },
    },
  };
  try {
    await import('../extension/worker.js');
    const started = new Promise(resolve => chrome.runtime.onMessage.fire({ action: 'start' }, { url: 'popup' }, resolve));
    await port.onMessage.fire({ ready: true });
    assert.deepEqual(await started, { ok: true });
    async function run(...args) {
      await port.onMessage.fire({ id: 'fixture', args });
      return port.reply.error ?? port.reply.value;
    }
    const a = await run('session-start', 'Checkout');
    const b = await run('session-start', 'Catalog');
    assert.notEqual(a.sessionId, b.sessionId);
    const first = await run('--session', a.sessionId, 'open', 'https://example.test/');
    const sibling = await run('--session', a.sessionId, 'open', 'https://example.test/other');
    const second = await run('--session', b.sessionId, 'open', 'https://example.test/');
    assert.equal(first.group, sibling.group);
    assert.notEqual(first.group, second.group);
    await run('--session', a.sessionId, 'use', String(first.tab));
    assert.match(await run('--session', b.sessionId, 'use', String(first.tab)), /does not belong/);
    assert.match(await run('--session', b.sessionId, 'snapshot'), /Select a tab/);
    assert.match(await run('use', String(first.tab)), /does not belong/);
    await run('--session', b.sessionId, 'use', String(second.tab));
    assert.deepEqual(pageActions, [[first.tab, 'show'], [first.tab, 'clear'], [second.tab, 'show']]);
    assert.equal(groups.get(first.group).title, 'Checkout');
    assert.equal(groups.get(second.group).title, 'Catalog');
    assert.deepEqual(await run('--session', a.sessionId, 'session-end'), { ended: true });
    assert.deepEqual(await run('session-list'), [b]);
    assert.equal(tabs.size, 3);
    assert.equal(tabs.get(second.tab).active, undefined);
    assert.deepEqual(await run('--session', b.sessionId, 'click', '@r1'), { x: 10, y: 10, dispatched: true, trusted: false });
    assert.equal(tabs.get(second.tab).active, undefined);
    assert.deepEqual(mouseEvents, []);
    tabs.get(second.tab).active = true;
    assert.deepEqual(await run('--session', b.sessionId, 'click', '@r1'), { x: 10, y: 10, dispatched: true });
    assert.deepEqual(mouseEvents, ['mouseMoved', 'mousePressed', 'mouseReleased']);
    visible = false;
    assert.match(await run('--session', b.sessionId, 'click', '@r1'), /not visible/);
    assert.deepEqual(mouseEvents, ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseMoved']);
    assert.deepEqual(clickMotion, [false, true, true]);
  } finally {
    delete globalThis.chrome;
  }
});
