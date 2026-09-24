-- document_blob is keyed by (workspace_id, id) instead of id alone: doc ids come from the client and
-- from imported files, so two workspaces loaded from one file hold the same ids.
--
-- Hand-finished: 0000 declared the old key inline on "id", so Postgres named it document_blob_pkey,
-- a name drizzle-kit cannot read back and so leaves the drop commented out. Every existing row is
-- unique on "id" alone, so it is unique on (workspace_id, id) too, and the new key cannot fail on
-- data already there. The index on workspace_id is dropped because the new key leads with it.
ALTER TABLE "document_blob" DROP CONSTRAINT "document_blob_pkey";--> statement-breakpoint
ALTER TABLE "document_blob" ADD CONSTRAINT "document_blob_workspace_id_id_pk" PRIMARY KEY("workspace_id","id");--> statement-breakpoint
DROP INDEX "document_blob_workspace_idx";
