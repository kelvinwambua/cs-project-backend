import express from "express";
import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import db from "../db/connection";
import { delivery, businessProfile } from "../db/schema";

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

export default router;
