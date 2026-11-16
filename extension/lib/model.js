// Pure data operations. All persistent mutations are serialized by background.js.
export const FORMAT = 'x-bellek';
export const SCHEMA = 1;
export const BACKUP_SCHEMA = 2;
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
function moveAccounts(state, { accountKey, targetUsername }) {
  const source = state.authors.find(account => account.key === accountKey);
  if (!source?.notes.length) fail('This account has no notes to move.');
  const handle = username(targetUsername);
  if (handle === source.username) fail('Enter a different X username.');
  const target = resolveAuthor(state, handle);
  const combinedTags = target ? [...new Set([...target.tags, ...source.tags])] : source.tags;
  return { source, target, handle, combinedTags };
}
function noteCounts(notes) {
  const counts = { active: 0, archived: 0, trash: 0 };
  for (const note of notes) counts[noteStatus(note)]++;
  return counts;
}
export function previewMove(state, payload) {
  const { source, target, handle, combinedTags } = moveAccounts(state, payload);
  return {
    sourceUsername: source.username,
    targetUsername: handle,
    sourceCounts: noteCounts(source.notes),
    targetCounts: target ? noteCounts(target.notes) : null,
    canMerge: combinedTags.length <= 12,
    revision: state.revision
  };
}
function moveNotes(next, payload, now, uuid) {
  if (payload.expectedRevision !== next.revision) fail('Your notes changed after the preview. Review the move again.');
  const { source, target, handle, combinedTags } = moveAccounts(next, payload);
  if (payload.merge !== Boolean(target)) fail('Review and confirm the move for this destination.');
  if (combinedTags.length > 12) fail('Combining tags would exceed the 12-tag limit. Remove some account tags first.');

  for (const note of source.notes) note.savedHandle ??= source.username;
  if (!target) {
    source.username = handle;
    source.updatedAt = now;
    return;
  }

  const targetIds = new Set(target.notes.map(note => note.id));
  const occupied = new Set([...targetIds, ...source.notes.map(note => note.id)]);
  for (const note of source.notes) {
    if (targetIds.has(note.id)) {
      do { note.id = uuid(); } while (occupied.has(note.id));
      occupied.add(note.id);
    }
    target.notes.push(note);
  }
  target.notes.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  target.tags = combinedTags;
  target.updatedAt = now;
  next.authors = next.authors.filter(account => account.key !== source.key);
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
  if (operation === 'moveNotes') {
    moveNotes(next, payload, now, uuid);
  } else if (operation === 'emptyTrash') {
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
  if (!raw || raw.format !== FORMAT || ![1, BACKUP_SCHEMA].includes(raw.schemaVersion) || !Array.isArray(raw.authors) || raw.authors.length > 20000) fail('Choose a supported HandleNotes backup.');
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
      const savedHandle = n.savedHandle == null ? {} : { savedHandle: username(n.savedHandle) };
      return { ...savedHandle, id: noteId, text: str(n.text, 20000, 'note'), sourceUrl: sourceURL(n.sourceUrl), sourceTitle: str(n.sourceTitle || '', 300, 'source label', true), createdAt: date(n.createdAt), updatedAt: date(n.updatedAt), version: n.version, archivedAt: n.archivedAt ? date(n.archivedAt) : null, trashedAt: n.trashedAt == null ? null : date(n.trashedAt), history: n.history.map(h => { if (++total > 50000) fail('The backup contains too many note revisions.'); return revision(h); }) };
    });
    return { key, username: name, tags: tags(a.tags), color: COLORS.includes(a.color) ? a.color : 'green', createdAt: date(a.createdAt), updatedAt: date(a.updatedAt), notes };
  });
  return { format: FORMAT, schemaVersion: BACKUP_SCHEMA, authors };
}
export function backup(state, now = new Date().toISOString()) {
  // Older builds would silently drop a moved note's original handle.
  const hasSavedHandles = state.authors.some(account => account.notes.some(note => note.savedHandle));
  const schemaVersion = hasSavedHandles ? BACKUP_SCHEMA : 1;
  const authors = structuredClone(state.authors).map(a => ({ ...a, notes: a.notes.map(n => ({ ...n, trashedAt: n.trashedAt || null })) }));
  return { format: FORMAT, schemaVersion, exportedAt: now, revision: state.revision, authors };
}
// Chrome storage may reorder object keys; compare explicit field arrays instead.
const content = (n, handle) => JSON.stringify([n.savedHandle ?? handle, n.text, n.sourceUrl, n.sourceTitle, n.archivedAt, n.trashedAt || null, n.history.map(h => [h.text, h.sourceUrl, h.sourceTitle, h.savedAt])]);
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
      const incomingContent = content(note, existing.username);
      const duplicate = existing.notes.find(n => content(n, existing.username) === incomingContent);
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
