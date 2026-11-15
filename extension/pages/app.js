import { resolveAuthor, noteStatus, backup, MAX_IMPORT_BYTES } from '../lib/model.js';

const params = new URLSearchParams(location.search);
const panel = params.has('panel');
const popup = document.documentElement.classList.contains('popup-document') || params.has('popup');
document.documentElement.classList.toggle('popup-document', popup);
document.body.className = panel ? 'panel' : popup ? 'popup' : '';
const root = document.querySelector('#app');
const { name, short_name: shortName } = chrome.runtime.getManifest();
const appName = shortName || name;
let state;
let view = panel ? 'author' : params.get('view') === 'trash' ? params.get('view') : popup ? 'add' : 'library';
let selected = null;
let query = '', tagFilter = '', scope = view==='trash'?'trash':'active', sort = 'recent';
let editing = false, working = false, refreshPending = false;
let draft = {};
let pageAuthors = [];
let preview = null;
let toastTimer;
let sizeFrame = 0, lastFrameHeight = 0;
function reportFrameSize() {
  if(!panel)return;
  cancelAnimationFrame(sizeFrame);
  sizeFrame=requestAnimationFrame(()=>{
    const main=root.querySelector('main');
    const header=root.querySelector('.compact-header');
    if(!main||!header)return;
    const height=Math.ceil(header.getBoundingClientRect().height+main.scrollHeight+2);
    if(height!==lastFrameHeight){lastFrameHeight=height;parent.postMessage({type:'x-bellek-size',height},'*');}
  });
}
const paths = { trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7', book: 'M5 3h9l5 5v13H5V3Zm9 0v5h5m-10 3 6 6m0-6-6 6', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m7-7a4 4 0 0 1 0 8m6 9v-2a4 4 0 0 0-3-3.87', plus: 'M12 5v14M5 12h14', search: 'm21 21-4.4-4.4M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16', backup: 'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5', settings: 'M4 7h16M4 17h16M8 4v6m8 4v6', expand: 'M14 3h7v7m0-7-8 8M10 21H3v-7m0 7 8-8', close: 'm6 6 12 12M6 18 18 6', arrow: 'm9 5 7 7-7 7' };
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] || paths.book); svg.append(path); return svg;
}
function el(tag, cls = '', ...children) {
  const node = document.createElement(tag); if (cls) node.className = cls;
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function button(text, fn, cls = 'secondary', symbol = '') {
  const b = el('button', `btn ${cls}`, symbol ? icon(symbol) : null, text); b.type = 'button'; b.addEventListener('click', fn); return b;
}
function link(text, href, cls = '') {
  const a = el('a', cls, text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const formatDate = value => dateFormat.format(new Date(value));
const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
function toast(text) {
  const t = document.querySelector('#toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}
async function rpc(op, extra = {}) {
  const response = await chrome.runtime.sendMessage({ channel: 'x-bellek', op, ...extra });
  if (!response?.ok) throw new Error(response?.error || 'Could not reach HandleNotes. Refresh the page and try again.');
  return response.value;
}
async function load() { state = await rpc('get'); document.documentElement.dataset.theme = state.settings.theme; }
function panelRef() { return { username: params.get('panel') }; }
function sourceRef() { return { sourceUrl: params.get('source') || '', sourceTitle: params.get('title') || '' }; }
function getSelected() { return state.authors.find(a => a.key === selected); }
function navigate(next, author = null) {
  if (editing && !confirm('Leave this page and discard your unsaved changes?')) return;
  if(next==='trash'){scope='trash';query='';tagFilter='';selected=null;}else if(next==='library'&&scope==='trash'){scope='active';query='';tagFilter='';selected=null;}
  editing = false; view = next; if (author) selected = author.key; render();
}
async function commit(op, payload) {
  working = true;
  try { await rpc(op, { payload }); await load(); editing = false; refreshPending = false; }
  finally { working = false; }
}
function openLibrary() { chrome.tabs.create({ url: chrome.runtime.getURL('pages/app.html') }); }
function requestPanelClose() {
  if (editing && !confirm('Close this panel and discard your unsaved changes?')) return;
  parent.postMessage({ type: 'x-bellek-close' }, '*');
}
function brand() {
  const img = el('img'); img.src = '../icons/48.png'; img.alt = '';
  return el('div', 'brand', img, el('div', '', appName, el('small', '', 'Private notes for X')));
}
function head(title, description = '', action = null) {
  return el('div', 'page-head', el('div', '', el('h1', '', title), description ? el('p', '', description) : null), action);
}
function render() {
  document.body.dataset.view=view;
  root.replaceChildren();
  const main = el('main', 'main');
  if (panel || popup) {
    const actions = el('div', 'actions', button('', openLibrary, 'ghost icon-btn', 'expand'));
    actions.firstChild.title = 'Open the notebook in a new tab'; actions.firstChild.setAttribute('aria-label', actions.firstChild.title);
    if (panel) actions.append(button('', requestPanelClose, 'ghost icon-btn', 'close'));
    if (panel) { actions.lastChild.title = 'Close'; actions.lastChild.setAttribute('aria-label', 'Close'); }
    root.append(el('header', 'compact-header', brand(), actions));
    if (popup) {
      const nav = el('nav', 'compact-nav'); nav.setAttribute('aria-label', `${appName} menu`);
      for (const [key, label] of [['add','Add note'],['library','Accounts'],['backup','Backup'],['settings','Settings']]) nav.append(button(label, () => navigate(key), view === key || (key==='library' && ['author','trash'].includes(view)) ? 'active' : ''));
      root.append(nav);
    }
    root.append(main);
  } else {
    const nav = el('nav', 'nav'); nav.setAttribute('aria-label', `${appName} menu`);
    for (const [key, label, symbol] of [['library','Saved accounts','users'],['add','Add note','plus'],['trash','Trash','trash'],['backup','Backup','backup'],['settings','Settings','settings']]) nav.append(button(label, () => navigate(key), view === key ? 'active' : '', symbol));
    const aside = el('aside', 'sidebar', brand(), nav, el('div', 'side-bottom', el('div', 'local', 'Stored in this browser'), el('p', 'hint', 'An independent extension for X.')));
    root.append(el('div', 'shell', aside, main));
  }
  if (refreshPending) main.append(el('div', 'notice warning', 'Notes changed in another window. Your changes will be checked against the latest version when you save.'));
  if (view === 'library' || view === 'trash') renderLibrary(main,view==='trash');
  else if (view === 'add') {
    main.append(head('New note', 'Add a private note for an X account.'));
    main.append(noteForm({ username: draft.username || '', ...draft }, null, false));
  } else if (view === 'author') {
    if(popup)main.append(button(scope==='trash'?'Back to Trash':'Back to accounts',()=>navigate(scope==='trash'?'trash':'library'),'ghost back-link'));
    const ref = panel ? panelRef() : getSelected();
    const author = ref ? resolveAuthor(state, ref.username) : null;
    if (author) { selected = author.key; main.append(authorDetail(author)); }
    else { main.append(head(ref ? `@${ref.username}` : 'Account', 'Add your first note for this account.')); main.append(noteForm({ ...ref, ...sourceRef() }, null, true)); }
  } else if (view === 'backup') renderBackup(main);
  else if (view === 'settings') renderSettings(main);
  reportFrameSize();
}
function trashCount() { return state.authors.reduce((sum, a) => sum + a.notes.filter(n => noteStatus(n) === 'trash').length, 0); }
function inScope(note) { return noteStatus(note) === scope; }
function openTrash() {
  if (panel) chrome.tabs.create({url: chrome.runtime.getURL('pages/app.html?view=trash')});
  else navigate('trash');
}
function renderLibrary(main, trash = false) {
  const count = trashCount();
  const availableAuthors = state.authors.filter(a => a.notes.some(n => !n.trashedAt));
  const activeCount = state.authors.reduce((sum, a) => sum + a.notes.filter(n => noteStatus(n) === 'active').length, 0);
  if (trash) {
    if (popup) main.append(button('Back to accounts', () => navigate('library'), 'ghost back-link'));
    const emptyButton = button('Empty Trash', async () => {
      const revision = state.revision;
      const total = trashCount();
      if (!total || !confirm(`Permanently delete ${countLabel(total, 'note')} and their edit history? This cannot be undone.`)) return;
      try { await commit('emptyTrash', {expectedRevision: revision}); selected = null; render(); toast('Trash emptied.'); }
      catch (e) { toast(e.message); }
    }, 'secondary danger', 'trash');
    emptyButton.disabled = count === 0;
    main.append(head('Trash', `${countLabel(count, 'note')} · ${countLabel(state.authors.filter(a => a.notes.some(n => n.trashedAt)).length, 'account')}`, emptyButton));
    main.append(el('div', 'notice', 'Restore notes from Trash or delete them permanently.'));
  } else {
    main.append(head('Saved accounts', `${countLabel(availableAuthors.length, 'account')} · ${countLabel(activeCount, 'active note')}`, button('Add note', () => navigate('add'), '', 'plus')));
  }
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search accounts, notes, or tags…'; search.setAttribute('aria-label', 'Search accounts, notes, or tags'); search.value = query;
  const tagSelect = el('select'); tagSelect.setAttribute('aria-label', 'Filter by tag');
  for (const tag of ['', ...new Set(state.authors.flatMap(a => a.tags))].sort((a,b) => a.localeCompare(b,'en'))) { const o = el('option', '', tag || 'All tags'); o.value = tag; tagSelect.append(o); } tagSelect.value = tagFilter;
  const mode = el('select'); mode.setAttribute('aria-label', 'Note status');
  for (const [v,t] of [['active','Active notes'],['archived','Archive'],['trash','Trash']]) { const o = el('option','',t); o.value = v; mode.append(o); } mode.value = scope;
  const sorting = el('select'); sorting.setAttribute('aria-label','Sort by');
  for (const [v,t] of [['recent','Recently updated'],['name','Account name']]) { const o=el('option','',t);o.value=v;sorting.append(o); } sorting.value=sort;
  main.append(el('div', 'toolbar', el('div','search',icon('search'),search), tagSelect, mode, sorting));
  if (!trash) main.append(el('div', 'library-utility', button(`Trash${count ? ` (${count})` : ''}`, openTrash, 'ghost', 'trash')));
  const results = el('div'); main.append(results);
  function draw() {
    const needle = query.toLowerCase();
    const authors = state.authors.filter(a => a.notes.some(inScope) && (!tagFilter || a.tags.includes(tagFilter)) && (`@${a.username}`.includes(needle) || [...a.tags, ...a.notes.filter(inScope).map(n => n.text)].join(' ').toLowerCase().includes(needle))).sort((a,b) => sort === 'name' ? a.username.localeCompare(b.username,'en') : Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    results.replaceChildren();
    if (!authors.length) {
      if (trash && !count) results.append(empty('Trash is empty', 'Notes you move to Trash will appear here.', 'Back to accounts', () => navigate('library')));
      else if (!trash && !availableAuthors.length && count) results.append(empty('No active notes', 'You can find deleted notes in Trash.', 'Open Trash', openTrash));
      else if (!state.authors.length) results.append(empty('No notes yet', 'Leave a note for an account and find it the next time you see their posts.'));
      else results.append(empty('No matching notes', 'Try another search or change your filters.', 'Clear filters', () => { query='';tagFilter='';if(!trash)scope='active';render(); }));
      return;
    }
    const list = el('div','author-list');
    const chosen = popup ? null : (authors.find(a=>a.key===selected) || authors[0]);
    if (chosen) selected=chosen.key;
    for (const author of authors) {
      const notes = author.notes.filter(inScope);
      const row = el('button',`author-row color-${author.color}${chosen?.key===author.key ? ' selected' : ''}`,el('span','avatar',author.username[0].toUpperCase()),el('span','author-copy',el('span','author-name',`@${author.username}`,el('span','count',countLabel(notes.length, 'note'))),el('span','preview',notes[0]?.text),tagList(author.tags)));
      row.type='button';row.setAttribute('aria-label',`@${author.username} — ${countLabel(notes.length, 'note')}`);
      row.addEventListener('click',()=>{selected=author.key;if(popup){view='author';render();}else draw();});list.append(row);
    }
    const layout=el('div','library-layout',list);if(chosen)layout.append(authorDetail(chosen));results.append(layout);
  }
  search.addEventListener('input',()=>{query=search.value;draw();});
  tagSelect.addEventListener('change',()=>{tagFilter=tagSelect.value;draw();});
  mode.addEventListener('change',()=>{scope=mode.value;if(scope==='trash'&&!trash)navigate('trash');else if(scope!=='trash'&&trash){view='library';render();}else draw();});
  sorting.addEventListener('change',()=>{sort=sorting.value;draw();});draw();
}
function tagList(values) { return el('span','tags',values.map(t=>el('span','tag',t))); }
function empty(title, text, action = 'Add your first note', fn = () => navigate('add')) { return el('div','empty',icon('book'),el('h2','',title),el('p','',text),button(action,fn,'')); }
async function changeNote(author, note, operation) {
  if (operation === 'purge' && !confirm('Permanently delete this note and its edit history? This cannot be undone.')) return;
  try {
    await commit(operation, {username:author.username,noteId:note.id,expectedVersion:note.version});
    if (scope==='trash' && !getSelected()?.notes.some(n=>n.trashedAt)) { selected=null;if(view==='author')view='trash'; }
    render();
    const messages={trash:'Note moved to Trash.',untrash:note.archivedAt?'Note restored to the archive.':'Note restored.',purge:'Note deleted permanently.',archive:'Note archived.',restore:'Note restored.'};
    toast(messages[operation]);
  } catch(e) { toast(e.message); }
}
async function changeAuthor(author, operation) {
  const notes=author.notes.filter(n=>operation==='trashAuthor'?!n.trashedAt:Boolean(n.trashedAt));
  if (operation==='trashAuthor' && !confirm(`Move all notes for @${author.username} to Trash, including archived notes?`)) return;
  try {
    await commit(operation,{username:author.username,expectedNotes:notes.map(n=>({id:n.id,version:n.version}))});
    if(!panel){view=operation==='trashAuthor'?'library':'trash';scope=operation==='trashAuthor'?'active':'trash';selected=null;}
    render();toast(operation==='trashAuthor'?`Moved ${countLabel(notes.length, 'note')} to Trash.`:`Restored ${countLabel(notes.length, 'note')}.`);
  } catch(e) { toast(e.message); }
}
function authorDetail(author) {
  const trash = scope==='trash';
  const detail=el('section',`detail color-${author.color}`);
  const add=trash?null:button('Add note',()=>{detail.replaceChildren(head(author.username,'Write a note for this account.'),noteForm({...author,...(panel?sourceRef():{})},null,true));},'secondary','plus');
  detail.append(el('div','detail-head',el('div','',el('h2','',`@${author.username}`),link('Open X profile ↗',`https://x.com/${author.username}`),tagList(author.tags)),add));
  const notes=author.notes.filter(inScope).sort((a,b)=>Date.parse(trash?b.trashedAt:b.createdAt)-Date.parse(trash?a.trashedAt:a.createdAt));
  if(!notes.length){detail.append(el('p','hint','No notes in this view. Check the archive or Trash.'));if(!trash&&author.notes.some(n=>n.trashedAt))detail.append(button('Open Trash',openTrash,'ghost','trash'));}
  for(const note of notes){
    const card=el('article','note');
    card.append(el('div','note-meta',el('span','',trash?`Deleted ${formatDate(note.trashedAt)}`:formatDate(note.createdAt)),el('span','',trash?(note.archivedAt?'Previously archived':''):(note.history.length?'Edited':''))),el('p','note-text',note.text));
    if(note.sourceUrl)card.append(link(note.sourceTitle||'Open post ↗',note.sourceUrl,'note-source'));
    const actions=el('div','note-actions');
    if(trash){
      actions.append(button('Restore',()=>changeNote(author,note,'untrash'),'ghost'),button('Delete permanently',()=>changeNote(author,note,'purge'),'ghost danger'));
    } else {
      actions.append(button('Edit',()=>card.replaceChildren(noteForm({...author,...note},note,true)),'ghost'),button(note.archivedAt?'Unarchive':'Archive',()=>changeNote(author,note,note.archivedAt?'restore':'archive'),'ghost'),button('Move to Trash',()=>changeNote(author,note,'trash'),'ghost danger'));
    }
    card.append(actions);
    if(note.history.length){
      const history=el('details','history',el('summary','',`Edit history (${note.history.length})`));
      for(const old of note.history){history.append(el('div','revision',el('span','hint',formatDate(old.savedAt)),el('p','',old.text),old.sourceUrl?link(old.sourceTitle||'Previous source',old.sourceUrl,'note-source'):null,trash?null:button('Restore this version',async()=>{try{await commit('edit',{username:author.username,noteId:note.id,expectedVersion:note.version,text:old.text,sourceUrl:old.sourceUrl,sourceTitle:old.sourceTitle});render();toast('Previous version restored.');}catch(e){toast(e.message);}},'ghost')));}
      card.append(history);
    }
    detail.append(card);
  }
  if(trash){if(notes.length)detail.append(el('div','author-danger-zone',button('Restore all notes for this account',()=>changeAuthor(author,'untrashAuthor'),'secondary')));}
  else {
    const profile=el('details','disclosure profile-options',el('summary','','Edit tags and badge color'));
    const tagsInput=el('input');tagsInput.value=author.tags.join(', ');tagsInput.setAttribute('aria-label','Account tags');
    const color=colorSelect(author.color);const error=el('p','error');
    profile.append(el('div','form-row',field('Tags',tagsInput),field('Badge color',color)),button('Save',async()=>{try{await commit('profile',{...author,tags:tagsInput.value,color:color.value});render();toast('Account settings saved.');}catch(e){error.textContent=e.message;}}),error);detail.append(profile);
    if(author.notes.some(n=>!n.trashedAt))detail.append(el('div','author-danger-zone',button('Move all notes to Trash',()=>changeAuthor(author,'trashAuthor'),'ghost danger','trash')));
  }
  return detail;
}
function field(title, input, hint='') { if(!input.hasAttribute('aria-label'))input.setAttribute('aria-label',title);return el('label','field',el('span','field-title',title),input,hint?el('span','hint',hint):null); }
function colorSelect(value='green') { const select=el('select');for(const [v,t]of [['green','Green'],['blue','Blue'],['amber','Amber'],['rose','Rose'],['slate','Slate']]){const o=el('option','',t);o.value=v;select.append(o);}select.value=value;return select; }
function noteForm(data, existing=null, fixed=false) {
  const form=el('form','form-surface');
  const name=el('input');name.required=true;name.maxLength=16;name.placeholder='@username';name.value=fixed ? '@'+data.username : data.username||'';name.readOnly=fixed;name.autocomplete='off';name.name='username';
  if(!fixed&&pageAuthors.length){const suggestions=el('datalist');suggestions.id='page-authors';for(const ref of pageAuthors){const option=el('option');option.value=`@${ref.username}`;suggestions.append(option);}name.setAttribute('list','page-authors');form.append(suggestions);}
  const text=el('textarea');text.required=true;text.maxLength=20000;text.placeholder='What would you like to remember about this account?';text.value=data.text||'';text.name='note';
  const labels=el('input');labels.placeholder='troll, fake';labels.value=Array.isArray(data.tags)?data.tags.join(', '):data.tags||'';
  const color=colorSelect(data.color);
  const source=el('input');source.type='url';source.placeholder='https://x.com/username/status/…';source.value=data.sourceUrl||'';
  const title=el('input');title.maxLength=300;title.placeholder='Optional';title.value=data.sourceTitle||'';
  const counter=el('div','counter',`${text.value.length} / 20,000`);text.addEventListener('input',()=>counter.textContent=`${text.value.length} / 20,000`);
  const noteField=field('Note',text);noteField.classList.add('note-field');noteField.append(counter);
  form.append(field('X username',name),noteField);
  const options=el('div','form-options');
  const extras=el('details','disclosure',el('summary','',existing?'Source options':'Tags, color, and source'));
  if(!existing)extras.append(el('div','form-row',field('Tags',labels,'Separate tags with commas.'),field('Badge color',color)));
  extras.append(field('Post URL',source),field('Source label',title));options.append(extras);form.append(options);
  const save=el('button','btn',existing?'Save changes':'Save note');save.type='submit';
  const error=el('p','error');error.setAttribute('role','alert');
  form.append(el('div','form-actions',save,(fixed||existing)?button('Cancel',()=>{editing=false;render();},'secondary'):null),error,el('p','hint form-hint','Notes are stored in this browser.'));
  form.addEventListener('input',()=>{
    editing=true;
    if(!fixed&&!existing){draft={username:name.value,text:text.value,tags:labels.value,color:color.value,sourceUrl:source.value,sourceTitle:title.value};chrome.storage.local.set({'x-bellek-draft':draft}).catch(()=>{});}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(save.disabled)return;save.disabled=true;error.textContent='';
    try{
      const payload={username:name.value,text:text.value,tags:labels.value,color:color.value,sourceUrl:source.value,sourceTitle:title.value};
      if(existing)Object.assign(payload,{noteId:existing.id,expectedVersion:existing.version});
      await commit(existing?'edit':'add',payload);
      const author=resolveAuthor(state,name.value);selected=author.key;
      if(!fixed&&!existing){draft={};await chrome.storage.local.remove('x-bellek-draft');}
      view=panel?'author':'library';scope='active';query='';tagFilter='';render();toast(existing?'Note updated.':'Note saved.');
    }catch(e){error.textContent=e.message;save.disabled=false;}
  });
  return form;
}
function renderBackup(main) {
  main.append(head('Backup','Export your notes or restore them from a backup.'));
  if(state.settings.reminders&&state.revision>state.lastExportRevision)main.append(el('div','notice warning','You have changes since your last backup.'));
  const exportDate=el('div','backup-date',state.lastExportAt ? `Last exported ${formatDate(state.lastExportAt)}` : 'No backup exported yet');
  const exportSection=el('section','section',el('h2','','Export notes'),el('p','','Download one JSON file with your accounts, notes, archive, Trash, and edit history.'),exportDate);
  exportSection.append(button('Download JSON',async()=>{
    working=true;
    try{
      await load();const revision=state.revision;
      const blob=new Blob([JSON.stringify(backup(state),null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download=`handlenotes-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
      await rpc('exported',{payload:{revision}});await load();
      exportDate.textContent=`Last exported ${formatDate(state.lastExportAt)}`;
      if(state.revision<=state.lastExportRevision)main.querySelector('.notice.warning')?.remove();
      toast('Check your downloads for the JSON backup.');
    }catch(e){toast(e.message);}finally{working=false;}
  },'','backup'));main.append(exportSection);
  const input=el('input');input.type='file';input.accept='.json,application/json';input.setAttribute('aria-label','Choose a JSON backup');
  const result=el('div');const error=el('p','error');error.setAttribute('role','alert');
  const section=el('section','section',el('h2','','Import a backup'),el('p','','Preview the changes before importing. Existing notes are preserved and duplicate notes are skipped.'),input,result,error);main.append(section);
  const previewImport=async()=>{
    preview=null;result.replaceChildren();error.textContent='';const file=input.files[0];if(!file)return;
    try{
      if(file.size>MAX_IMPORT_BYTES)throw new Error('Backups must be 20 MB or smaller.');
      const raw=JSON.parse(await file.text());const report=await rpc('previewImport',{backup:raw,mode:'preserve'});preview={raw,report};
      result.append(el('div','import-summary',`${countLabel(report.newAuthors, 'new account')} · ${countLabel(report.newNotes, 'note to add', 'notes to add')} · ${countLabel(report.duplicates, 'duplicate')} · ${countLabel(report.conflicts.length, 'conflict')}`));
      if(report.metadataConflicts)result.append(el('p','hint','Tags will be merged. Each account keeps its current badge color.'));
      for(const conflict of report.conflicts.slice(0,20))result.append(el('div','conflict',el('strong','',conflict.username),el('p','',`Existing (${({active:'Active',archived:'Archive',trash:'Trash'})[conflict.currentStatus]||'Active'}): ${conflict.current}`),el('p','',`From backup (${({active:'Active',archived:'Archive',trash:'Trash'})[conflict.incomingStatus]||'Active'}): ${conflict.incoming}`)));
      if(report.conflicts.length>20)result.append(el('p','hint',`Showing the first 20 conflicts. Your choice applies to all ${report.conflicts.length}.`));
      const mode=el('select');mode.setAttribute('aria-label','How to handle conflicting notes');for(const[v,t]of[['preserve','Keep both versions as separate notes'],['skip','Keep the existing note']]){const o=el('option','',t);o.value=v;mode.append(o);}result.append(field('Conflicting notes',mode));
      const apply=button('Confirm import',async()=>{if(!preview)return;apply.disabled=true;working=true;try{const r=await rpc('import',{backup:preview.raw,mode:mode.value,expectedRevision:preview.report.revision});await load();preview=null;render();toast(`Imported ${countLabel(r.newAuthors, 'account')} and ${countLabel(r.newNotes, 'note')}.`);}catch(e){error.textContent=e.message;apply.disabled=false;}finally{working=false;}},'');result.append(apply);
    }catch(e){error.textContent=e instanceof SyntaxError?'Could not read the file. Choose a valid JSON backup.':e.message;}
  };input.addEventListener('change',previewImport);
  main.append(el('p','hint','JSON backups contain your notes in plain text. Removing the extension deletes notes from this Chrome profile.'));
}
function renderSettings(main) {
  main.append(head('Settings','Manage appearance and backup reminders.'));
  const theme=el('select');for(const[v,t]of[['system','Match system'],['light','Light'],['dark','Dark']]){const o=el('option','',t);o.value=v;theme.append(o);}theme.value=state.settings.theme;
  const reminders=el('input');reminders.type='checkbox';reminders.checked=state.settings.reminders;
  const error=el('p','error');
  main.append(el('section','section',el('h2','','Appearance and reminders'),field('Theme',theme),el('label','check-label',reminders,'Remind me to back up after changes'),el('div','actions',button('Save settings',async()=>{try{await commit('settings',{theme:theme.value,reminders:reminders.checked});render();toast('Settings saved.');}catch(e){error.textContent=e.message;}},'')),error));
  main.append(el('section','section',el('h2','','Your notes stay in Chrome'),el('p','','Notes, usernames, tags, links, and drafts are stored in this Chrome profile. HandleNotes does not send your notes to a server.'),el('p','','On X, notes open in an extension frame. External links open when you click them.'),el('p','hint',`${appName} ${chrome.runtime.getManifest().version} · Open source · MIT license\nIndependent of X.`)));
}
function connect() {
  try {
    const port=chrome.runtime.connect({name:'x-bellek-updates'});
    port.onMessage.addListener(async()=>{if(working)return;if(editing){refreshPending=true;return;}try{await load();render();}catch(e){toast(e.message);}});
    port.onDisconnect.addListener(()=>setTimeout(connect,1500));
  }catch{setTimeout(connect,2500);}
}
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&panel)requestPanelClose();});
if(panel){new ResizeObserver(reportFrameSize).observe(root);new MutationObserver(reportFrameSize).observe(root,{childList:true,subtree:true,characterData:true});document.addEventListener('toggle',reportFrameSize,true);document.addEventListener('input',reportFrameSize);}
window.addEventListener('message',event=>{if(panel&&event.source===parent&&event.origin==='https://x.com'&&event.data?.type==='x-bellek-request-close')requestPanelClose();});
try {
  await load();
  if(popup){try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(tab?.id)pageAuthors=await chrome.tabs.sendMessage(tab.id,{channel:'x-bellek',op:'pageAuthors'})||[];}catch{}}
  draft=(await chrome.storage.local.get('x-bellek-draft'))['x-bellek-draft']||{};render();connect();
}catch(e){root.replaceChildren(el('main','main',head(`Could not open ${appName}`),el('p','error',e.message),button('Try again',()=>location.reload())));}
