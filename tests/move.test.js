import test from 'node:test';
import assert from 'node:assert/strict';
import { backup, emptyState, importBackup, mutate, noteStatus, previewMove, resolveAuthor } from '../extension/lib/model.js';

const originalDate = '2026-11-05T10:00:00.000Z';
const moveDate = '2026-11-16T10:00:00.000Z';
const post = 'https://x.com/old_handle/status/1234567890123456789';
const add = (state, username, text, extra) => mutate(state, 'add', {username, text, ...extra}, originalDate);
const request = (state, source, targetUsername) => ({accountKey: resolveAuthor(state, source).key, targetUsername});
const apply = (state, payload, merge = false) => mutate(state, 'moveNotes', {...payload, merge, expectedRevision: state.revision}, moveDate);

test('moving all notes preserves the original handle, dates, source, history and statuses', () => {
  let state = add(emptyState(), 'old_handle', 'First note', {sourceUrl: post, tags: ['research'], color: 'blue'});
  const noteId = resolveAuthor(state, 'old_handle').notes[0].id;
  state = mutate(state, 'edit', {username: 'old_handle', noteId, expectedVersion: 1, text: 'Edited note', sourceUrl: post}, originalDate);
  state = mutate(state, 'archive', {username: 'old_handle', noteId, expectedVersion: 2}, originalDate);
  state = add(state, 'old_handle', 'Deleted');
  const trashId = resolveAuthor(state, 'old_handle').notes[0].id;
  state = mutate(state, 'trash', {username: 'old_handle', noteId: trashId, expectedVersion: 1}, originalDate);
  state = add(state, 'old_handle', 'Active');
  const before = structuredClone(state);
  const payload = request(state, 'old_handle', ' @NEW_Handle ');
  const preview = previewMove(state, payload);
  assert.deepEqual(preview.sourceCounts, {active: 1, archived: 1, trash: 1});
  assert.equal(preview.targetCounts, null);
  const moved = apply(state, payload);
  assert.deepEqual(state, before);
  assert.equal(moved.revision, state.revision + 1);
  assert.equal(resolveAuthor(moved, 'old_handle'), undefined);
  const target = resolveAuthor(moved, 'new_handle');
  const prior = resolveAuthor(before, 'old_handle');
  assert.equal(target.key, prior.key);
  assert.equal(target.color, prior.color);
  assert.deepEqual(target.tags, prior.tags);
  assert.deepEqual(target.notes, prior.notes.map(note => ({...note, savedHandle: 'old_handle'})));
  const again = apply(moved, request(moved, 'new_handle', 'third_handle'));
  assert.deepEqual(resolveAuthor(again, 'third_handle').notes, target.notes);
});

test('merging requires explicit confirmation and preserves colliding note IDs as separate notes', () => {
  const state = add(add(emptyState(), 'old_handle', 'Source', {tags: ['source', 'shared']}),
    'new_handle', 'Destination', {tags: ['shared', 'destination'], color: 'rose'});
  const source = resolveAuthor(state, 'old_handle');
  const target = resolveAuthor(state, 'new_handle');
  const targetId = target.notes[0].id;
  source.notes[0].id = targetId;
  const payload = request(state, 'old_handle', 'new_handle');
  const preview = previewMove(state, payload);
  assert.deepEqual(preview.targetCounts, {active: 1, archived: 0, trash: 0});
  assert.throws(() => apply(state, payload), /Review and confirm/);
  const merged = mutate(state, 'moveNotes', {...payload, merge: true, expectedRevision: state.revision}, moveDate, () => 'fresh-id');
  const result = resolveAuthor(merged, 'new_handle');
  assert.equal(merged.authors.length, 1);
  assert.equal(result.key, target.key);
  assert.equal(result.color, 'rose');
  assert.deepEqual(result.tags, ['shared', 'destination', 'source']);
  assert.deepEqual(result.notes, [target.notes[0], {...source.notes[0], id: 'fresh-id', savedHandle: 'old_handle'}]);
  assert.deepEqual(result.notes.map(noteStatus), ['active', 'active']);
});

test('a move rejects the same handle, outdated previews and merges above the tag limit', () => {
  const a = add(emptyState(), 'old_handle', 'Original', {tags: Array.from({length: 12}, (_, index) => 'tag' + index)});
  assert.throws(() => previewMove(a, request(a, 'old_handle', '@OLD_Handle')), /different X username/);
  const before = structuredClone(a);
  const move = request(a, 'old_handle', 'new_handle');
  const preview = previewMove(a, move);
  const changed = add(a, 'new_handle', 'New note', {tags: ['extra']});
  assert.throws(() => mutate(changed, 'moveNotes', {...move, merge: false, expectedRevision: preview.revision}), /changed after the preview/);
  assert.equal(previewMove(changed, move).canMerge, false);
  assert.throws(() => apply(changed, move, true), /12-tag limit/);
  assert.deepEqual(a, before);
});

test('moved notes retain provenance across a backup round trip and replay', () => {
  const original = add(emptyState(), 'old_handle', 'Original', {sourceUrl: post});
  assert.equal(backup(original).schemaVersion, 1);
  const moved = apply(original, request(original, 'old_handle', 'new_handle'));
  const file = backup(moved);
  assert.equal(file.schemaVersion, 2);
  const restored = importBackup(emptyState(), file).state;
  assert.deepEqual(resolveAuthor(restored, 'new_handle').notes, resolveAuthor(moved, 'new_handle').notes);
  assert.equal(importBackup(restored, file).report.duplicates, 1);
  file.authors[0].notes[0].savedHandle = '<invalid>';
  assert.throws(() => importBackup(restored, file), /X username/);
});
