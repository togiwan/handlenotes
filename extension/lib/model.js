// Pure data operations. All persistent mutations are serialized by background.js.
export const FORMAT = 'x-bellek';
export const SCHEMA = 1;
export const BACKUP_SCHEMA = 1;
export const COLORS = ['green', 'blue', 'amber', 'rose', 'slate'];
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const str = (s, max, label, optional = false) => {
  if (typeof s !== 'string' || s.length > max || (!optional && !s.trim())) fail(`Invalid ${label}.`);
  return s.trim();
};
export function username(value) {
  const handle = str(value, 80, 'username').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) fail('Enter an X username using only letters, numbers, and underscores.');
  return handle.toLowerCase();
}
export function sourceURL(value = '') {
  if (!value) return '';
  const url = new URL(str(value, 2000, 'post URL'));
  const post = /^\/([a-z0-9_]{1,15}|i\/web)\/status\/(\d+)\/?$/i.exec(url.pathname);
  if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port || !post) {
    fail('Use the URL of an X post.');
  }
  return `https://x.com/${post[1].toLowerCase()}/status/${post[2]}`;
}
export function tags(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  if (items.length > 12) fail('You can add up to 12 tags.');
  return [...new Set(items.map(v => str(v, 32, 'tag', true).normalize('NFC')).filter(Boolean))];
}
export function emptyState() {
  return { schemaVersion: SCHEMA, revision: 0, authors: [], settings: { theme: 'system', reminders: true }, lastExportAt: null, lastExportRevision: -1 };
}
export function resolveAuthor(state, name) {
  const canonical = username(name);
  return state.authors.find(a => a.username === canonical);
}
export function noteStatus(note) {
  return note.trashedAt ? 'trash' : note.archivedAt ? 'archived' : 'active';
}
function checkSelection(notes, expected) {
  const signature = list => JSON.stringify(list.map(n => [n.id, n.version]).sort(([a], [b]) => a.localeCompare(b)));
  if (!Array.isArray(expected) || expected.some(n => !n || typeof n.id !== 'string' || !Number.isSafeInteger(n.version)) || signature(notes) !== signature(expected)) {
    fail('This account’s notes changed in another window. Open the latest list and try again.');
  }
}
function snapshot(note) {
  return { text: note.text, sourceUrl: note.sourceUrl, sourceTitle: note.sourceTitle, savedAt: note.updatedAt };
}
export function mutate(state, operation, payload, now = new Date().toISOString(), uuid = () => crypto.randomUUID()) {
  const next = structuredClone(state);
  if (operation === 'emptyTrash') {
    if (payload.expectedRevision !== state.revision) fail('Trash changed in another window. Open the latest list and try again.');
    if (!next.authors.some(a => a.notes.some(n => n.trashedAt))) fail('Trash is already empty.');
    next.authors = next.authors.filter(a => {
      const hadNotes = a.notes.length > 0;
      if (a.notes.some(n => n.trashedAt)) {
        a.notes = a.notes.filter(n => !n.trashedAt);
        a.updatedAt = now;
      }
      return !hadNotes || a.notes.length > 0;
    });
  } else if (operation === 'settings') {
    if (!['light', 'dark', 'system'].includes(payload.theme) || typeof payload.reminders !== 'boolean') fail('Invalid settings.');
    next.settings = { theme: payload.theme, reminders: payload.reminders };
  } else if (operation === 'exported') {
    if (!Number.isSafeInteger(payload.revision) || payload.revision > state.revision || payload.revision < 0) fail('Invalid backup revision.');
    next.lastExportAt = now;
    next.lastExportRevision = Math.max(next.lastExportRevision, payload.revision);
    return next;
  } else {
    const name = username(payload.username);
    let author = resolveAuthor(next, name);
    if (operation === 'add') {
      const text = str(payload.text, 20000, 'note');
      const url = sourceURL(payload.sourceUrl);
      const title = str(payload.sourceTitle || '', 300, 'source label', true);
      if (!author) {
        author = { key: uuid(), username: name, tags: [], color: 'green', createdAt: now, updatedAt: now, notes: [] };
        next.authors.push(author);
      }
      if (payload.tags !== undefined) author.tags = tags(payload.tags);
      if (COLORS.includes(payload.color)) author.color = payload.color;
      author.notes.unshift({ id: uuid(), text, sourceUrl: url, sourceTitle: title, createdAt: now, updatedAt: now, version: 1, archivedAt: null, trashedAt: null, history: [] });
    } else {
      if (!author) fail('Account not found.');
      if (operation === 'trashAuthor' || operation === 'untrashAuthor') {
        const notes = author.notes.filter(n => operation === 'trashAuthor' ? !n.trashedAt : Boolean(n.trashedAt));
        if (!notes.length) fail(operation === 'trashAuthor' ? 'There are no notes to move to Trash.' : 'There are no notes to restore.');
        checkSelection(notes, payload.expectedNotes);
        for (const note of notes) {
          note.trashedAt = operation === 'trashAuthor' ? now : null;
          note.version += 1;
          note.updatedAt = now;
        }
      } else if (operation === 'profile') {
        author.tags = tags(payload.tags);
        if (!COLORS.includes(payload.color)) fail('Invalid badge color.');
        author.color = payload.color;
      } else {
        const note = author.notes.find(n => n.id === payload.noteId);
        if (!note) fail('Note not found.');
        if (note.version !== payload.expectedVersion) fail('This note changed in another window. Open the latest version and try again.');
        if (note.trashedAt && !['untrash', 'purge'].includes(operation)) fail('Restore this note from Trash first.');
        if (['untrash', 'purge'].includes(operation) && !note.trashedAt) fail('This note is not in Trash.');
        if (operation === 'purge') {
          author.notes = author.notes.filter(n => n.id !== note.id);
          if (!author.notes.length) next.authors = next.authors.filter(a => a.key !== author.key);
        } else if (operation === 'edit') {
          const text = str(payload.text, 20000, 'note');
          const url = sourceURL(payload.sourceUrl);
          const title = str(payload.sourceTitle || '', 300, 'source label', true);
          if (text !== note.text || url !== note.sourceUrl || title !== note.sourceTitle) {
            note.history.unshift(snapshot(note));
            Object.assign(note, { text, sourceUrl: url, sourceTitle: title });
          }
        } else if (operation === 'trash') note.trashedAt = now;
        else if (operation === 'untrash') note.trashedAt = null;
        else if (operation === 'archive') note.archivedAt = now;
        else if (operation === 'restore') note.archivedAt = null;
        else fail('Unrecognized action.');
        note.version += 1;
        note.updatedAt = now;
      }
    }
    author.updatedAt = now;
  }
  next.revision += 1;
  return next;
}
const date = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('The backup contains an invalid date.');
  return new Date(value).toISOString();
};
function revision(raw) {
  return { text: str(raw.text, 20000, 'note revision'), sourceUrl: sourceURL(raw.sourceUrl), sourceTitle: str(raw.sourceTitle || '', 300, 'source label', true), savedAt: date(raw.savedAt) };
}
export function validateBackup(raw) {
  if (!raw || raw.format !== FORMAT || raw.schemaVersion !== BACKUP_SCHEMA || !Array.isArray(raw.authors) || raw.authors.length > 20000) fail('Choose a supported HandleNotes backup.');
  let total = 0;
  const keys = new Set();
  const identities = new Set();
  const authors = raw.authors.map(a => {
    const name = username(a.username);
    const key = str(a.key, 100, 'account key');
    if (keys.has(key) || identities.has(name)) fail('The backup contains a duplicate account.');
    keys.add(key); identities.add(name);
    if (!Array.isArray(a.notes)) fail('Invalid account record.');
    const noteIds = new Set();
    const notes = a.notes.map(n => {
      if (++total > 50000 || !Array.isArray(n.history)) fail('The backup has too many notes or contains invalid notes.');
      const noteId = str(n.id, 150, 'note ID');
      if (noteIds.has(noteId)) fail('The backup contains a duplicate note ID.');
      noteIds.add(noteId);
      if (!Number.isSafeInteger(n.version) || n.version < 1) fail('Invalid note version.');
      return { id: noteId, text: str(n.text, 20000, 'note'), sourceUrl: sourceURL(n.sourceUrl), sourceTitle: str(n.sourceTitle || '', 300, 'source label', true), createdAt: date(n.createdAt), updatedAt: date(n.updatedAt), version: n.version, archivedAt: n.archivedAt ? date(n.archivedAt) : null, trashedAt: n.trashedAt == null ? null : date(n.trashedAt), history: n.history.map(h => { if (++total > 50000) fail('The backup contains too many note revisions.'); return revision(h); }) };
    });
    return { key, username: name, tags: tags(a.tags), color: COLORS.includes(a.color) ? a.color : 'green', createdAt: date(a.createdAt), updatedAt: date(a.updatedAt), notes };
  });
  return { format: FORMAT, schemaVersion: BACKUP_SCHEMA, authors };
}
export function backup(state, now = new Date().toISOString()) {
  return { format: FORMAT, schemaVersion: BACKUP_SCHEMA, exportedAt: now, revision: state.revision, authors: structuredClone(state.authors).map(a => ({ ...a, notes: a.notes.map(n => ({ ...n, trashedAt: n.trashedAt || null })) })) };
}
// Chrome storage may reorder object keys; compare explicit field arrays instead.
const content = n => JSON.stringify([n.text, n.sourceUrl, n.sourceTitle, n.archivedAt, n.trashedAt || null, n.history.map(h => [h.text, h.sourceUrl, h.sourceTitle, h.savedAt])]);
export function importBackup(state, raw, mode = 'preserve', uuid = () => crypto.randomUUID()) {
  if (!['preserve', 'skip'].includes(mode)) fail('Invalid import option.');
  const incoming = validateBackup(raw);
  const next = structuredClone(state);
  const report = { newAuthors: 0, newNotes: 0, duplicates: 0, conflicts: [], metadataConflicts: 0 };
  for (const imported of incoming.authors) {
    const existing = resolveAuthor(next, imported.username);
    if (!existing) {
      const record = structuredClone(imported);
      // Keys are internal; don't allow a colliding imported key to select another author.
      record.key = uuid();
      next.authors.push(record);
      report.newAuthors++; report.newNotes += record.notes.length;
      continue;
    }
    if (JSON.stringify([existing.tags, existing.color]) !== JSON.stringify([imported.tags, imported.color])) report.metadataConflicts++;
    // Existing display metadata wins. Incoming labels are combined without losing labels.
    existing.tags = [...new Set([...existing.tags, ...imported.tags])];
    if (existing.tags.length > 12) fail('Combining tags would exceed the 12-tag limit. Edit the tags in the backup and try again.');
    for (const note of imported.notes) {
      const exact = existing.notes.find(n => n.id === note.id);
      const duplicate = existing.notes.find(n => content(n) === content(note));
      if (duplicate) { report.duplicates++; continue; }
      if (exact) {
        report.conflicts.push({ username: existing.username, current: exact.text, incoming: note.text, currentStatus: noteStatus(exact), incomingStatus: noteStatus(note) });
        if (mode === 'skip') continue;
      }
      const copied = structuredClone(note);
      if (exact) copied.id = uuid();
      existing.notes.push(copied);
      report.newNotes++;
    }
    existing.notes.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (Date.parse(imported.updatedAt) > Date.parse(existing.updatedAt)) existing.updatedAt = imported.updatedAt;
  }
  next.revision++;
  return { state: next, report };
}
