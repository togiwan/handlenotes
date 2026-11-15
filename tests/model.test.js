import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, mutate, resolveAuthor, username, sourceURL, backup, importBackup, validateBackup } from '../extension/lib/model.js';
const time='2026-11-02T12:00:00.000Z';
const add=(state,p={})=>mutate(state,'add',{username:'ornek_hesap',text:'First observation',...p},time);
test('normalizes X handles independently of the system locale',()=>{
  assert.equal(username('  @ORNEK_ISIM  '),'ornek_isim');
  assert.equal(username('X'),'x');
  assert.equal(username('a12345678901234'),'a12345678901234');
  for(const handle of ['İSİM','two words','/x','@','abcdefghijklmnop','@https://x.com/test'])assert.throws(()=>username(handle));
});
test('source links canonicalize X and Twitter posts and reject unsafe or non-post links',()=>{
  assert.equal(sourceURL('https://x.com/ORNEK_HESAP/status/1890123456789012345?s=20#test'),'https://x.com/ornek_hesap/status/1890123456789012345');
  assert.equal(sourceURL('https://twitter.com/Example/status/123'),'https://x.com/example/status/123');
  for(const url of ['javascript:alert(1)','https://x.com.evil.test/name/status/123','https://foo@x.com/name/status/123','https://x.com:444/name/status/123','https://x.com/name','http://x.com/name/status/123'])assert.throws(()=>sourceURL(url));
});
test('adding multiple notes is immutable and keeps timestamps and tags',()=>{
  const first=add(emptyState(),{tags:'aviation, read again'});const second=add(first,{text:'Second observation'});
  assert.equal(first.authors[0].notes.length,1);assert.equal(second.authors[0].notes.length,2);
  assert.deepEqual(second.authors[0].tags,['aviation','read again']);assert.equal(second.authors[0].notes[0].createdAt,time);
});
test('composes one account across case variants but keeps different X handles separate',()=>{
  const first=add(emptyState());
  const second=add(first,{username:'@ORNEK_HESAP',text:'Bir not daha'});
  const third=add(second,{username:'ornek_hesap2',text:'Different account'});
  assert.equal(third.authors.length,2);
  assert.equal(resolveAuthor(third,'@Ornek_Hesap').notes.length,2);
  assert.equal(resolveAuthor(third,'ornek_hesap2').notes.length,1);
});
test('rejects EkşiBellek backups even when handles happen to be valid on X',()=>{
  const file=backup(add(emptyState()));
  file.format='eksi-defter';
  assert.throws(()=>validateBackup(file),/HandleNotes backup/);
});
test('edits keep the previous source and text, stale editors are rejected',()=>{
  const state=add(emptyState(),{sourceUrl:'https://x.com/ornek_hesap/status/123'});const note=state.authors[0].notes[0];
  const payload={username:'ornek_hesap',noteId:note.id,expectedVersion:1,text:'Updated observation',sourceUrl:''};
  const edited=mutate(state,'edit',payload,'2026-11-02T13:00:00.000Z');
  assert.equal(edited.authors[0].notes[0].history[0].text,'First observation');assert.equal(edited.authors[0].notes[0].history[0].sourceUrl,'https://x.com/ornek_hesap/status/123');
  assert.throws(()=>mutate(edited,'edit',payload),/changed in another window/);
});
test('archive and restore preserve full note history',()=>{
  const state=add(emptyState());const note=state.authors[0].notes[0];
  const archived=mutate(state,'archive',{username:'ornek_hesap',noteId:note.id,expectedVersion:1},time);
  const restored=mutate(archived,'restore',{username:'ornek_hesap',noteId:note.id,expectedVersion:2});
  assert.equal(restored.authors[0].notes[0].archivedAt,null);assert.equal(restored.authors[0].notes[0].text,note.text);
});
test('export/import round trip retains notes, revisions and archive; replay is idempotent',()=>{
  let state=add(emptyState());const note=state.authors[0].notes[0];
  state=mutate(state,'edit',{username:'ornek_hesap',noteId:note.id,expectedVersion:1,text:'Edited note'});
  state=mutate(state,'archive',{username:'ornek_hesap',noteId:note.id,expectedVersion:2});
  const file=backup(state);const imported=importBackup(emptyState(),file);
  assert.deepEqual(imported.state.authors[0].notes,state.authors[0].notes);
  assert.equal(importBackup(imported.state,file).report.newNotes,0);
});
test('same note ID with different text is kept as a separate note; reimport deduplicates',()=>{
  const state=add(emptyState());const raw=backup(state);raw.authors[0].notes[0].text='Different version in the backup';
  const result=importBackup(state,raw);
  assert.equal(result.report.conflicts.length,1);assert.equal(result.state.authors[0].notes.length,2);
  assert.equal(result.state.authors[0].notes[0].text,'First observation');
  assert.equal(importBackup(result.state,raw).report.newNotes,0);
  assert.equal(importBackup(state,raw,'skip').state.authors[0].notes.length,1);
});
test('storage reordering of history object keys does not create import conflicts',()=>{
  const initial=add(emptyState());const note=initial.authors[0].notes[0];
  const state=mutate(initial,'edit',{username:'ornek_hesap',noteId:note.id,expectedVersion:1,text:'Yeni metin'});
  const old=state.authors[0].notes[0].history[0];
  state.authors[0].notes[0].history[0]={savedAt:old.savedAt,sourceTitle:old.sourceTitle,sourceUrl:old.sourceUrl,text:old.text};
  const result=importBackup(state,backup(state));assert.equal(result.report.conflicts.length,0);assert.equal(result.report.newNotes,0);
});
test('malformed backup is rejected atomically and never changes existing data',()=>{
  const state=add(emptyState());const saved=structuredClone(state);const raw=backup(state);
  raw.authors.push({...raw.authors[0],key:'another',username:'ikinci',notes:[{...raw.authors[0].notes[0],sourceUrl:'javascript:alert(1)'}]});
  assert.throws(()=>importBackup(state,raw));assert.deepEqual(state,saved);
  assert.throws(()=>validateBackup({format:'x-bellek',schemaVersion:3,authors:[]}));
});
test('untrusted backup object fields do not enter the data model',()=>{
  const raw=backup(add(emptyState()));raw.authors[0].notes[0].html='<script>bad()</script>';raw.authors[0].notes[0].text='<img src=x onerror=alert(1)>';
  const clean=validateBackup(raw);assert.equal(clean.authors[0].notes[0].html,undefined);assert.equal(clean.authors[0].notes[0].text,'<img src=x onerror=alert(1)>');
});
test('an export of an older revision leaves newer changes marked as unexported',()=>{
  const state=add(add(emptyState()));const exported=mutate(state,'exported',{revision:1});assert.equal(exported.lastExportRevision,1);assert.equal(exported.revision,2);
});
