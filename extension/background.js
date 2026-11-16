import { emptyState, mutate, resolveAuthor, importBackup, previewMove, noteStatus, MAX_IMPORT_BYTES } from './lib/model.js';

const KEY = 'x-bellek-v1';
const ports = new Set();
let queue = Promise.resolve();
const accessReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
accessReady.catch(() => {});
async function read() {
  await accessReady;
  const data = await chrome.storage.local.get(KEY);
  // Only a genuinely absent key means a new installation. An existing corrupt
  // value must never be interpreted as permission to replace the saved list.
  if (!Object.hasOwn(data, KEY)) return emptyState();
  const state = data[KEY];
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      state.schemaVersion !== 1 || !Array.isArray(state.authors) ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !state.settings || !['system', 'light', 'dark'].includes(state.settings.theme) ||
      typeof state.settings.reminders !== 'boolean' ||
      !Number.isSafeInteger(state.lastExportRevision) || state.lastExportRevision < -1 || state.lastExportRevision > state.revision ||
      !(state.lastExportAt === null || (typeof state.lastExportAt === 'string' && Number.isFinite(Date.parse(state.lastExportAt))))) {
    throw new Error('Saved data is invalid or unsupported. Your existing data was left intact.');
  }
  return state;
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'x-bellek-updates') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});
function notify() {
  for (const port of ports) { try { port.postMessage({ type: 'changed' }); } catch { ports.delete(port); } }
}
function trusted(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('pages/'));
}
async function handle(message, sender) {
  if (!message || message.channel !== 'x-bellek') throw new Error('Invalid request.');
  if (sender.id !== chrome.runtime.id) throw new Error('Request from an unauthorized source.');
  if (message.op === 'lookup') {
    const state = await read();
    if (!Array.isArray(message.authors) || message.authors.length > 1000) throw new Error('Invalid account list.');
    return message.authors.map(ref => {
      const a = resolveAuthor(state, ref.username);
      return { username: ref.username, count: a?.notes.filter(n => noteStatus(n) === 'active').length || 0, color: a?.color || 'green' };
    });
  }
  if (!trusted(sender)) throw new Error('You can only do this from the extension.');
  const state = await read();
  if (message.op === 'get') return state;
  if (message.op === 'previewMove') return previewMove(state, message.payload || {});
  let next;
  let result = null;
  if (message.op === 'import' || message.op === 'previewImport') {
    if (JSON.stringify(message.backup).length > MAX_IMPORT_BYTES) throw new Error('Backups must be 20 MB or smaller.');
    const merged = importBackup(state, message.backup, message.mode);
    if (message.op === 'previewImport') return { ...merged.report, revision: state.revision };
    if (message.expectedRevision !== state.revision) throw new Error('Your notes changed after the preview. Select the file again and review the updated preview.');
    next = merged.state; result = merged.report;
  } else next = mutate(state, message.op, message.payload || {});
  await chrome.storage.local.set({ [KEY]: next });
  notify();
  return result || next;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.channel !== 'x-bellek') return false;
  // Serial queue protects all read-modify-write operations across popup / iframe / tabs.
  const work = queue.then(() => handle(message, sender));
  queue = work.catch(() => {});
  work.then(value => respond({ ok: true, value }), error => respond({ ok: false, error: /quota|QUOTA|bytes/i.test(error.message) ? 'Storage is full. Your last change was not saved. Export a JSON backup before making room.' : error.message }));
  return true;
});
