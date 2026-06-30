ALTER TYPE "public"."delivery_status" ADD VALUE 'awaiting_payment' BEFORE 'pending';--> statement-breakpoint
ALTER TABLE "delivery" ALTER COLUMN "status" SET DEFAULT 'awaiting_payment';--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "paystack_reference" text;