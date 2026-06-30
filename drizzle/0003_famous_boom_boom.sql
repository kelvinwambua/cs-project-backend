CREATE TABLE "driver_payout_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bank_code" text NOT NULL,
	"bank_name" text,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"paystack_recipient_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "driver_payout_account_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "driver_payout_account" ADD CONSTRAINT "driver_payout_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;