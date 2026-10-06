# Temporary and stored canvases

New canvases are temporary and held in server memory. They remain available across tab refreshes but disappear when the server restarts. Choose **Store canvas** in the panel header to save the current document permanently; subsequent applied human edits and streamed AI writes auto-save to the database. Existing saved canvases remain permanent.

The header also offers **Download canvas**, which exports Markdown (including the current inline edit draft). Applying inline edits to a temporary canvas does not store it permanently. Interrupted AI writes retain their partial content with the same temporary/stored lifetime.


A canvas is a document associated with a conversation. Open **Canvases** to browse,
read, create, edit inline, or delete the session's documents. The same panel
works during chat and voice mode. Documents can contain plain text or Markdown.

Ask the agent to create a canvas and write into it. The text appears live while
its write arguments stream, rather than waiting for the entire tool call.
Decoded text is retained as it arrives, in memory for temporary canvases and in SQLite for stored canvases. A stored canvas is written to the database about once a second at most while the text streams in, and once more when the write ends, so a long document does not slow the other chats; a server that stops in the middle of a write loses at most the last moment of it. If interrupted, the current text remains as a **Partial draft retained**; incomplete JSON escapes are not invented. Stored partial drafts also survive server restarts.

A write that replaces the document and is cut off (you stopped it, the model ran out of output or failed, the server restarted) leaves only what had streamed in, and the rest of the old document would be gone. So the portal keeps the document as it was before the write until the write is done. While the draft is partial, **Restore the version before the interrupted write** puts that text back, as a revision of its own: you can still copy the partial draft first. It is let go as soon as a write goes through, or you edit the document yourself, and a write that is tried again after a cut-off keeps the text from before the first one.

Choose **Edit inline**, make changes in the same panel, and **Apply changes** (temporary) or **Save changes** (stored).
Your save marks the canvas **Edited by you**. The AI must read it before making
its next change. It can continue its own edits without rereading; an unread
canvas also requires an initial read. Revisions prevent stale edits from
silently overwriting newer text. While an AI write is streaming, finish or
interrupt it before editing manually. A conflicting manual draft stays in the
editor so you can copy it before reloading the document.

If the document you are editing is deleted meanwhile, by the agent or from another tab, the edit ends with a
notice and your draft stays below it, read-only, with **Copy draft**; the panel stays usable.

A canvas can show pictures from the chat's folder: `![Sales by month](plots/sales.png)`
draws `plots/sales.png`, by a path relative to the folder or an absolute one
inside it. The agent is told it can do this, so a report can carry the chart it
made. A picture from another website is not loaded, here as everywhere in the portal: it shows where it
would have come from instead (see [Security](/guide/security)). A path outside the folder is not shown.

The agent has five tools: `canvas_create`, `canvas_list`, `canvas_read`,
`canvas_write` (replace or append), and `canvas_delete`. Write arguments specify
the document and revision before the content so live writes have an unambiguous
target. No content is guessed to complete an interrupted call.

At most two work panels — the browser, the terminal, [Files](/guide/files) and canvases — are visible alongside the orb. Opening a third minimizes
the least recently opened panel. On desktop, a single work panel sits on the
right with the full orb on the left. Two panels use the compact orb dock below;
the canvas gets more width than the terminal. Minimizing a document does not
remove it or discard an unsaved edit.

Stored canvases live in the `canvases` table of the existing session database and are
removed when their owning session is deleted, and so are the temporary ones, which go from memory at once. Include `portal.db` in backups.
