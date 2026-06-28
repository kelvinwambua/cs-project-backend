import express from "express";
import { eq, desc, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import db from "../db/connection";
import { delivery, businessProfile, deliveryLocation } from "../db/schema";

const router = express.Router();

const BASE_FEE = 50;
const PER_KM_RATE = 20;

async function getDistanceAndDuration(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
): Promise<{ distanceKm: number; durationMinutes: number }> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const res = await fetch(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key!,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: {
          location: { latLng: { latitude: originLat, longitude: originLng } },
        },
        destination: {
          location: { latLng: { latitude: destLat, longitude: destLng } },
        },
        travelMode: "TWO_WHEELER",
        routingPreference: "TRAFFIC_AWARE",
      }),
    },
  );
  const data = await res.json();
  console.log("Routes API response:", JSON.stringify(data, null, 2));
  if (!data.routes || !data.routes[0]) {
    throw new Error(`Routes API error: ${JSON.stringify(data)}`);
  }
  const route = data.routes[0];
  const distanceKm = route.distanceMeters / 1000;
  const durationMinutes = parseInt(route.duration.replace("s", "")) / 60;
  return { distanceKm, durationMinutes };
}

function calculatePrice(distanceKm: number): number {
  return BASE_FEE + distanceKm * PER_KM_RATE;
}

router.post("/", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "business") {
    res.status(403).json({ error: "Only businesses can create deliveries" });
    return;
  }

  const {
    recipientName,
    recipientPhone,
    pickupAddress,
    pickupPlaceId,
    pickupLat,
    pickupLng,
    dropoffAddress,
    dropoffPlaceId,
    dropoffLat,
    dropoffLng,
    notes,
  } = req.body;

  if (
    !recipientName ||
    !recipientPhone ||
    !pickupAddress ||
    !pickupPlaceId ||
    !pickupLat ||
    !pickupLng ||
    !dropoffAddress ||
    !dropoffPlaceId ||
    !dropoffLat ||
    !dropoffLng
  ) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const { distanceKm, durationMinutes } = await getDistanceAndDuration(
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,
  );

  const price = calculatePrice(distanceKm);

  await db
    .insert(businessProfile)
    .values({
      id: nanoid(),
      userId: session.user.id,
      businessName: session.user.name,
      address: pickupAddress,
      placeId: pickupPlaceId,
      lat: pickupLat,
      lng: pickupLng,
    })
    .onConflictDoUpdate({
      target: businessProfile.userId,
      set: {
        address: pickupAddress,
        placeId: pickupPlaceId,
        lat: pickupLat,
        lng: pickupLng,
      },
    });

  const newDelivery = await db
    .insert(delivery)
    .values({
      id: nanoid(),
      businessId: session.user.id,
      recipientName,
      recipientPhone,
      pickupAddress,
      pickupPlaceId,
      pickupLat,
      pickupLng,
      dropoffAddress,
      dropoffPlaceId,
      dropoffLat,
      dropoffLng,
      notes: notes ?? null,
      distanceKm,
      estimatedMinutes: durationMinutes,
      price: price.toFixed(2),
      status: "pending",
    })
    .returning();

  res.status(201).json(newDelivery[0]);
});

router.get("/", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role === "business") {
    const deliveries = await db
      .select()
      .from(delivery)
      .where(eq(delivery.businessId, session.user.id))
      .orderBy(desc(delivery.createdAt));
    res.json(deliveries);
    return;
  }
  res.status(403).json({ error: "Forbidden" });
});

router.post("/preview", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "business") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const { pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;
  if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
    res.status(400).json({ error: "Missing coordinates" });
    return;
  }
  const { distanceKm, durationMinutes } = await getDistanceAndDuration(
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,
  );
  const price = calculatePrice(distanceKm);
  res.json({
    distanceKm,
    estimatedMinutes: durationMinutes,
    price: price.toFixed(2),
  });
});

// returns all delivery requests that are available
router.get("/available-deliveries", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "driver") {
    res
      .status(403)
      .json({ error: "Only drivers can see available deliveries" });
    return;
  }
  const available_deliveries = await db
    .select()
    .from(delivery)
    .where(eq(delivery.status, "pending"))
    .orderBy(desc(delivery.createdAt));
  res.json(available_deliveries);
  return;
});

router.get("/:id", async (req, res) => {
  const session = (req as any).authSession;
  const { id } = req.params;
  const [found] = await db.select().from(delivery).where(eq(delivery.id, id));
  if (!found) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }
  if (
    session.user.role === "business" &&
    found.businessId !== session.user.id
  ) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(found);
});

// update a delivery request
router.patch("/:id", async (req, res) => {
  const session = (req as any).authSession;
  const { id } = req.params;
  const { action } = req.body;
  switch (action) {
    // accept a delivery
    case "accept":
      const accepted = await db
        .update(delivery)
        .set({
          driverId: session.user.id,
          status: "accepted",
          updatedAt: new Date(),
        })
        .where(and(eq(delivery.id, id), eq(delivery.status, "pending")))
        .returning();
      if (accepted.length === 0) {
        return res.status(409).json({
          error: "Delivery is no longer pending",
        });
      }
      return res.json(accepted[0]);

    // mark as picked_up
    case "pick_up":
      const picked = await db
        .update(delivery)
        .set({
          status: "picked_up",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(delivery.id, id),
            eq(delivery.driverId, session.user.id),
            eq(delivery.status, "accepted"),
          ),
        )
        .returning();
      if (picked.length === 0) {
        return res.status(409).json({ error: "Delivery not accepted" });
      }

      return res.json(picked[0]);

    case "deliver":
      // mark as delivered
      const delivered = await db
        .update(delivery)
        .set({
          status: "delivered",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(delivery.id, id),
            eq(delivery.driverId, session.user.id),
            eq(delivery.status, "picked_up"),
          ),
        )
        .returning();
      if (delivered.length === 0) {
        return res.status(409).json({ error: "Delivery not picked up" });
      }
      return res.json(delivered[0]);

    case "cancel":
      // cancel a request (for businesses only)
      if (session.user.role !== "business") {
        return res
          .status(403)
          .json({ error: "Only businesses can cancel orders" });
      }
      const cancelled = await db
        .update(delivery)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(delivery.id, id),
            eq(delivery.status, "pending"),
            eq(delivery.businessId, session.user.id),
          ),
        )
        .returning();
      if (cancelled.length === 0) {
        return res.status(409).json({ error: "Delivery cancellation failed" });
      }
      return res.json(cancelled[0]);
    default:
      return res.status(400).json({
        error: "Invalid action",
      });
  }
});

router.patch("/:id/location", async (req, res) => {
  const { id: deliveryId } = req.params;
  const session = (req as any).authSession;
  const { latitude, longitude } = req.body;
  const driverId = session.user.id;
  const recordedAt = new Date();
  await db
    .insert(deliveryLocation)
    .values({
      id: crypto.randomUUID(),
      deliveryId,
      driverId,
      lat: latitude,
      lng: longitude,
      recordedAt: recordedAt,
    })
    .onConflictDoUpdate({
      target: deliveryLocation.deliveryId,
      set: {
        lat: latitude,
        lng: longitude,
        recordedAt: recordedAt,
      },
    });
  res.json({
    success: true,
  });
});

export default router;
