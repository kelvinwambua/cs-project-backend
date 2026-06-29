ALTER TABLE "delivery" ADD COLUMN "otp_hash" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "otp_expires_at" timestamp;