/**
 * Store the attachments a v0.39 file embeds, for a Load or Merge the browser performs.
 *
 *   POST /api/workspaces/:id/documents/import
 *   { docs: [{ id, name, type, dataUrl }] }      — importLegacy's `attachments`, as they are
 *   → 200 { stored: n, skipped: [{ id, reason }] }
 *
 * The browser parses the file, so it already holds each attachment's bytes as the file's base64
 * dataUrl; sending them on as they are saves decoding and re-encoding every file on the client.
 * Each is stored under its own id — the id the rows the client writes already reference — and
 * held to the rules a single upload is: over the size cap or undecodable, it is skipped with a
 * sentence saying so, and the others are stored regardless.
 *
 * Ids are stored as given, so a retry, or a Merge of a file this workspace exported, replaces
 * rather than duplicates. A large file can be sent in several requests for the same reason.
 */
import { z } from 'zod';
import type { EmbeddedDocument } from '@raci/core';
import { recordAudit, storeEmbeddedDocuments } from '@raci/db';

const Body = z.object({ docs: z.array(z.unknown()) });

/** One entry. Only the id and the bytes are essential; a name or type that is off is dropped. */
const Entry = z.object({
  id: z.string().min(1).max(256),
  name: z.string().catch(''),
  type: z.string().catch(''),
  dataUrl: z.string(),
});

/** Enough of a refused entry to say which one it was. */
const EntryId = z.object({ id: z.string() });

export default defineEventHandler(async (event) => {
  const { session, workspaceId } = await requireDocumentWorkspace(event, 'editor');
  const body = await readValidatedBody(event, Body.parse);

  // Entries are checked one by one rather than all-or-nothing: the file came from somewhere else,
  // and one malformed entry must not stop the rest of its attachments arriving.
  const docs: EmbeddedDocument[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const raw of body.docs) {
    const entry = Entry.safeParse(raw);
    if (entry.success) {
      docs.push(entry.data);
    } else {
      const named = EntryId.safeParse(raw);
      skipped.push({
        id: named.success ? named.data.id : '',
        reason: 'Not a document entry — each needs a string id and dataUrl. Skipped.',
      });
    }
  }

  const db = useDb();
  const result = await storeEmbeddedDocuments(db, {
    workspaceId,
    uploadedBy: session.userId,
    docs,
  });
  skipped.push(...result.skipped);

  await recordAudit(db, {
    organizationId: session.organizationId,
    workspaceId,
    userId: session.userId,
    action: 'document.import',
    detail: { stored: result.stored, skipped: skipped.length },
  });

  return { stored: result.stored, skipped };
});
