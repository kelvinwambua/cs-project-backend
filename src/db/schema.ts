import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { numeric, doublePrecision } from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at"),
});

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const deliveryStatusEnum = pgEnum("delivery_status", [
  "pending",
  "accepted",
  "picked_up",
  "delivered",
  "cancelled",
]);

export const locationTypeEnum = pgEnum("location_type", [
  "house",
  "apartment",
  "office",
]);

export const businessProfile = pgTable("business_profile", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  businessName: text("business_name").notNull(),
  phone: text("phone"),
  address: text("address"),
  placeId: text("place_id"),
  building: text("building"),
  neighborhood: text("neighborhood"),
  city: text("city"),
  locationType: locationTypeEnum("location_type"),
  locationNote: text("location_note"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const delivery = pgTable("delivery", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => user.id),
  driverId: text("driver_id").references(() => user.id),
  recipientName: text("recipient_name").notNull(),
  recipientPhone: text("recipient_phone").notNull(),

  pickupAddress: text("pickup_address").notNull(),
  pickupPlaceId: text("pickup_place_id").notNull(),
  pickupBuilding: text("pickup_building"),
  pickupNeighborhood: text("pickup_neighborhood"),
  pickupCity: text("pickup_city"),
  pickupLocationType: locationTypeEnum("pickup_location_type"),
  pickupLocationNote: text("pickup_location_note"),
  pickupLat: doublePrecision("pickup_lat").notNull(),
  pickupLng: doublePrecision("pickup_lng").notNull(),

  dropoffAddress: text("dropoff_address").notNull(),
  dropoffPlaceId: text("dropoff_place_id").notNull(),
  dropoffBuilding: text("dropoff_building"),
  dropoffNeighborhood: text("dropoff_neighborhood"),
  dropoffCity: text("dropoff_city"),
  dropoffLocationType: locationTypeEnum("dropoff_location_type"),
  dropoffLocationNote: text("dropoff_location_note"),
  dropoffLat: doublePrecision("dropoff_lat").notNull(),
  dropoffLng: doublePrecision("dropoff_lng").notNull(),

  notes: text("notes"),
  distanceKm: doublePrecision("distance_km").notNull(),
  estimatedMinutes: doublePrecision("estimated_minutes").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  status: deliveryStatusEnum("status").default("pending").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  otpHash: text("otp_hash"),
  otpExpiresAt: timestamp("otp_expires_at"),
});

export const deliveryLocation = pgTable("delivery_location", {
  id: text("id").primaryKey(),
  deliveryId: text("delivery_id")
    .unique()
    .notNull()
    .references(() => delivery.id, { onDelete: "cascade" }),
  driverId: text("driver_id")
    .notNull()
    .references(() => user.id),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
});

export const businessProfileRelations = relations(
  businessProfile,
  ({ one }) => ({
    user: one(user, {
      fields: [businessProfile.userId],
      references: [user.id],
    }),
  }),
);

export const deliveryRelations = relations(delivery, ({ one, many }) => ({
  business: one(user, {
    fields: [delivery.businessId],
    references: [user.id],
  }),
  driver: one(user, {
    fields: [delivery.driverId],
    references: [user.id],
  }),
  locations: many(deliveryLocation),
}));

export const deliveryLocationRelations = relations(
  deliveryLocation,
  ({ one }) => ({
    delivery: one(delivery, {
      fields: [deliveryLocation.deliveryId],
      references: [delivery.id],
    }),
    driver: one(user, {
      fields: [deliveryLocation.driverId],
      references: [user.id],
    }),
  }),
);
