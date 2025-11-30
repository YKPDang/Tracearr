ALTER TABLE "users" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plex_account_id" varchar(255);--> statement-breakpoint
CREATE INDEX "users_plex_account_id_idx" ON "users" USING btree ("plex_account_id");--> statement-breakpoint
CREATE INDEX "users_username_idx" ON "users" USING btree ("username");