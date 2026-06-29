CREATE TYPE "public"."location_type" AS ENUM('house', 'apartment', 'office');--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "building" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "neighborhood" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "location_type" "location_type";--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "location_note" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "pickup_building" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "pickup_neighborhood" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "pickup_city" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "pickup_location_type" "location_type";--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "pickup_location_note" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "dropoff_building" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "dropoff_neighborhood" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "dropoff_city" text;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "dropoff_location_type" "location_type";--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "dropoff_location_note" text;--> statement-breakpoint
ALTER TABLE "delivery_location" ADD CONSTRAINT "delivery_location_delivery_id_unique" UNIQUE("delivery_id");
