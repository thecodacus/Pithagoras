import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';

export interface CanvasRow { id: string; session_id: string; title: string; content: string; revision: number; status: string; active_call: string | null; agent_read_revision: number | null; updated_at: string; persisted: boolean }
export const canvasEvents = new EventEmitter();
canvasEvents.setMaxListeners(0);
// Temporary canvases survive tab reconnects, but never a server restart.
const temporary = new Map<string, CanvasRow>();
/**
 * The revision each active write started from, by call.
 *
 * A write streams in as many saved prefixes, and each one is the same write:
 * counting them made a first draft r601. Every prefix is saved as the revision
 * after this one, so a whole write is one revision however it arrives.
 */
const writeBase = new Map<string, number>();
function update(row: CanvasRow, patch: Partial<CanvasRow>): CanvasRow {
  const next = {...row,...patch};
  if (next.persisted) {
    getDb().prepare(`UPDATE canvases SET title=?, content=?, revision=?, status=?, active_call=?, agent_read_revision=?, updated_at=? WHERE id=? AND session_id=?`).run(next.title,next.content,next.revision,next.status,next.active_call,next.agent_read_revision,next.updated_at,next.id,next.session_id);
  } else temporary.set(next.id,next);
  return next;
}
export function persistCanvas(session:string,id:string): CanvasRow {
  const row=readCanvas(session,id);
  if(row.persisted) return row;
  getDb().prepare('INSERT INTO canvases (id,session_id,title,content,revision,status,active_call,agent_read_revision,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(row.id,row.session_id,row.title,row.content,row.revision,row.status,row.active_call,row.agent_read_revision,row.updated_at);
  temporary.delete(id);
  return notify({...row,persisted:true});
}
export function listCanvases(session: string): CanvasRow[] {
  const stored=getDb().prepare('SELECT *, 1 AS persisted FROM canvases WHERE session_id = ?').all(session) as CanvasRow[];
  return [...stored.map(row=>({...row,persisted:true})),...Array.from(temporary.values()).filter(row=>row.session_id===session)].sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
}
export function readCanvas(session: string, id: string): CanvasRow {
  const draft=temporary.get(id);
  if(draft?.session_id===session) return {...draft};
  const row=getDb().prepare('SELECT * FROM canvases WHERE session_id = ? AND id = ?').get(session,id) as CanvasRow | undefined;
  if(!row) throw new Error('Canvas not found in this session');
  return {...row,persisted:true};
}
export function focusCanvas(session:string,id:string) { const row=readCanvas(session,id);canvasEvents.emit(session,{type:'focus',canvas:row});return row; }
function notify(row: CanvasRow) { canvasEvents.emit(row.session_id, { type: 'update', canvas: row }); return row; }
export function createCanvas(session: string, title: string): CanvasRow {
  if (!getDb().prepare('SELECT id FROM sessions WHERE id = ?').get(session)) throw new Error('Session not found');
  if (!title.trim() || title.length > 200) throw new Error('Title must contain 1–200 characters');
  const id = nanoid();
  temporary.set(id,{id,session_id:session,title:title.trim(),content:'',revision:0,status:'draft',active_call:null,agent_read_revision:null,updated_at:new Date().toISOString(),persisted:false});
  const row=readCanvas(session,id);canvasEvents.emit(session,{type:'create',canvas:row});return row;
}
export function editCanvas(session: string, id: string, revision: number, title: string, content: string): CanvasRow {
  if (!title.trim() || title.length > 200 || content.length > 1_000_000) throw new Error('Invalid canvas title or content size');
  const row = readCanvas(session,id);
  if (row.active_call || row.revision !== revision) throw new Error('Canvas changed or is being written. Reload before editing.');
  update(row,{title:title.trim(),content,revision:row.revision+1,status:'edited',updated_at:new Date().toISOString()});
  return notify(readCanvas(session,id));
}
export function deleteCanvas(session: string,id: string,revision: number) {
  const row=readCanvas(session,id);
  if(row.active_call || row.revision!==revision) throw new Error('Canvas changed or is being written. Reload before deleting.');
  if(row.persisted) getDb().prepare('DELETE FROM canvases WHERE id = ? AND session_id = ?').run(id,session);
  else temporary.delete(id);
  canvasEvents.emit(session,{type:'delete',id});
}
export function markCanvasRead(session:string,id:string): CanvasRow {
  const row=readCanvas(session,id);
  update(row,{agent_read_revision:row.revision});
  return readCanvas(session,id);
}
export function beginCanvasWrite(session: string,id: string,revision: number,call: string): CanvasRow {
  const row=readCanvas(session,id);
  if(row.agent_read_revision!==row.revision) throw new Error('Read this canvas with canvas_read before editing; it is unread or was edited by the user.');
  // A future revision cannot describe an older document; recover from model guesses.
  // Keep stale revisions and concurrent writes protected below.
  revision=Math.min(revision,row.revision);
  if(row.active_call || row.revision!==revision) throw new Error('Canvas changed or is being written. Use its current revision.');
  update(row,{active_call:call,status:'writing'});
  writeBase.set(call,row.revision);
  return notify(readCanvas(session,id));
}
export function saveCanvasPrefix(session: string,id: string,call: string,content: string): CanvasRow {
  if(content.length>1_000_000) throw new Error('Canvas exceeds one million characters');
  const row=readCanvas(session,id);
  if(row.active_call!==call) throw new Error('Canvas write is no longer active');
  if(row.content===content) return row;
  update(row,{content,revision:(writeBase.get(call)??row.revision)+1,updated_at:new Date().toISOString()});
  return notify(readCanvas(session,id));
}
export function finishCanvasWrite(session: string,id: string,call: string,interrupted: boolean) {
  const row=readCanvas(session,id);
  if(row.active_call!==call) return;
  writeBase.delete(call);
  return notify(update(row,{active_call:null,agent_read_revision:row.revision,status:interrupted?'interrupted':'saved',updated_at:new Date().toISOString()}));
}
