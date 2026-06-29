import express from "express";
import { eq, desc, and, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import db from "../db/connection";
import { delivery, businessProfile, deliveryLocation } from "../db/schema";
import crypto from "crypto";

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
    pickupBuilding,
    pickupNeighborhood,
    pickupCity,
    pickupLocationType,
    pickupLocationNote,
    dropoffAddress,
    dropoffPlaceId,
    dropoffLat,
    dropoffLng,
    dropoffBuilding,
    dropoffNeighborhood,
    dropoffCity,
    dropoffLocationType,
    dropoffLocationNote,
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
      building: pickupBuilding ?? null,
      neighborhood: pickupNeighborhood ?? null,
      city: pickupCity ?? null,
      locationType: pickupLocationType ?? null,
      locationNote: pickupLocationNote ?? null,
      lat: pickupLat,
      lng: pickupLng,
    })
    .onConflictDoUpdate({
      target: businessProfile.userId,
      set: {
        address: pickupAddress,
        placeId: pickupPlaceId,
        building: pickupBuilding ?? null,
        neighborhood: pickupNeighborhood ?? null,
        city: pickupCity ?? null,
        locationType: pickupLocationType ?? null,
        locationNote: pickupLocationNote ?? null,
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
      pickupBuilding: pickupBuilding ?? null,
      pickupNeighborhood: pickupNeighborhood ?? null,
      pickupCity: pickupCity ?? null,
      pickupLocationType: pickupLocationType ?? null,
      pickupLocationNote: pickupLocationNote ?? null,
      pickupLat,
      pickupLng,
      dropoffAddress,
      dropoffPlaceId,
      dropoffBuilding: dropoffBuilding ?? null,
      dropoffNeighborhood: dropoffNeighborhood ?? null,
      dropoffCity: dropoffCity ?? null,
      dropoffLocationType: dropoffLocationType ?? null,
      dropoffLocationNote: dropoffLocationNote ?? null,
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

const OTP_TTL_MS = 5 * 60 * 1000;

function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

// Normalise any Kenyan number to E.164 without the leading +
// Meta's API wants the number without "+", e.g. 254712345678
function toMetaPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  return digits;
}
async function sendWhatsAppOtp(
  recipientPhone: string,
  recipientName: string,
  otp: string,
): Promise<void> {
  const phoneId = process.env.META_WHATSAPP_PHONE_ID!;
  const token = process.env.META_WHATSAPP_TOKEN!;
  const templateName =
    process.env.META_WHATSAPP_TEMPLATE_NAME ?? "delivery_otp";

  const url = `https://graph.facebook.com/v19.0/${phoneId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: toMetaPhone(recipientPhone),
    type: "template",
    template: {
      name: templateName,
      language: { code: "en_US" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: recipientName },
            { type: "text", text: otp },
          ],
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Meta WhatsApp API error ${res.status}: ${JSON.stringify(err)}`,
    );
  }
}

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

router.get("/active", async (req, res) => {
  const session = (req as any).authSession;

  if (session.user.role !== "driver") {
    return res.status(403).json({
      error: "Only drivers can access their active delivery.",
    });
  }

  const [activeDelivery] = await db
    .select()
    .from(delivery)
    .where(
      and(
        eq(delivery.driverId, session.user.id),
        or(
          eq(delivery.status, "accepted"),
          eq(delivery.status, "picked_up"),
          eq(delivery.status, "delivered"),
        ),
      ),
    );

  if (!activeDelivery) {
    return res.status(404).json({
      error: "No active delivery found.",
    });
  }

  res.json(activeDelivery);
});

router.get("/history", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "driver") {
    res.status(403).json({ error: "Only drivers can view delivery history" });
    return;
  }
  const history = await db
    .select()
    .from(delivery)
    .where(
      and(
        eq(delivery.driverId, session.user.id),
        or(eq(delivery.status, "delivered"), eq(delivery.status, "cancelled")),
      ),
    )
    .orderBy(desc(delivery.updatedAt));
  res.json(history);
});

router.post("/:id/otp", async (req, res) => {
  const session = (req as any).authSession;

  if (session.user.role !== "driver") {
    return res.status(403).json({ error: "Only drivers can request an OTP." });
  }

  const { id } = req.params;

  const [found] = await db.select().from(delivery).where(eq(delivery.id, id));

  if (!found) {
    return res.status(404).json({ error: "Delivery not found." });
  }

  if (found.driverId !== session.user.id) {
    return res.status(403).json({ error: "Forbidden." });
  }

  if (found.status !== "picked_up") {
    return res.status(409).json({
      error: "OTP can only be sent once the parcel has been picked up.",
    });
  }

  const otp = generateOtp();
  const otpHash = hashOtp(otp);
  const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db
    .update(delivery)
    .set({ otpHash, otpExpiresAt, updatedAt: new Date() })
    .where(eq(delivery.id, id));

  const phone = toMetaPhone(found.recipientPhone);

  try {
    await sendWhatsAppOtp(found.recipientPhone, found.recipientName, otp);
  } catch (waErr) {
    console.error("WhatsApp send error:", waErr);
    return res.status(502).json({
      error: "Could not send WhatsApp message. Please try again.",
    });
  }

  return res.json({
    success: true,
    message: `WhatsApp sent to recipient's number ending in ${phone.slice(-4)}.`,
    expiresAt: otpExpiresAt,
  });
});

// ---------------------------------------------------------------------------
// POST /api/deliveries/:id/verify-otp
// Driver submits the OTP the customer read out to them.
// If valid, marks the delivery as "delivered".
// ---------------------------------------------------------------------------
router.post("/:id/verify-otp", async (req, res) => {
  const session = (req as any).authSession;

  if (session.user.role !== "driver") {
    return res.status(403).json({ error: "Only drivers can verify an OTP." });
  }

  const { id } = req.params;
  const { otp } = req.body;

  if (!otp || typeof otp !== "string") {
    return res.status(400).json({ error: "OTP is required." });
  }

  const [found] = await db.select().from(delivery).where(eq(delivery.id, id));

  if (!found) {
    return res.status(404).json({ error: "Delivery not found." });
  }

  if (found.driverId !== session.user.id) {
    return res.status(403).json({ error: "Forbidden." });
  }

  if (found.status !== "picked_up") {
    return res.status(409).json({
      error: "Delivery is not in a verifiable state.",
    });
  }

  if (!found.otpHash || !found.otpExpiresAt) {
    return res.status(409).json({
      error: "No OTP has been issued for this delivery. Request one first.",
    });
  }

  if (new Date() > new Date(found.otpExpiresAt)) {
    return res.status(410).json({
      error: "OTP has expired. Please request a new one.",
    });
  }

  if (hashOtp(otp.trim()) !== found.otpHash) {
    return res.status(422).json({ error: "Incorrect OTP." });
  }

  const [delivered] = await db
    .update(delivery)
    .set({
      status: "delivered",
      otpHash: null,
      otpExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(delivery.id, id))
    .returning();

  return res.json(delivered);
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

router.patch("/:id", async (req, res) => {
  const session = (req as any).authSession;
  const { id } = req.params;
  const { action } = req.body;

  switch (action) {
    case "accept": {
      const active = await db
        .select()
        .from(delivery)
        .where(
          and(
            eq(delivery.driverId, session.user.id),
            or(
              eq(delivery.status, "accepted"),
              eq(delivery.status, "picked_up"),
              eq(delivery.status, "delivered"),
            ),
          ),
        );

      if (active.length > 0) {
        return res.status(403).json({
          error: "Driver already has an active delivery.",
        });
      }

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
        return res.status(409).json({ error: "Delivery is no longer pending" });
      }
      return res.json(accepted[0]);
    }

    case "pick_up": {
      const picked = await db
        .update(delivery)
        .set({ status: "picked_up", updatedAt: new Date() })
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
    }

    case "deliver": {
      const delivered = await db
        .update(delivery)
        .set({ status: "delivered", updatedAt: new Date() })
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
    }

    case "cancel": {
      if (session.user.role !== "business") {
        return res
          .status(403)
          .json({ error: "Only businesses can cancel orders" });
      }

      const cancelled = await db
        .update(delivery)
        .set({ status: "cancelled", updatedAt: new Date() })
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
    }

    default:
      return res.status(400).json({ error: "Invalid action" });
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
  res.json({ success: true });
});

router.get("/:id/location", async (req, res) => {
  const session = (req as any).authSession;
  const { id } = req.params;

  const [found] = await db.select().from(delivery).where(eq(delivery.id, id));

  if (!found) {
    return res.status(404).json({ error: "Delivery not found" });
  }

  if (
    session.user.role === "business" &&
    found.businessId !== session.user.id
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (session.user.role === "driver" && found.driverId !== session.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [location] = await db
    .select()
    .from(deliveryLocation)
    .where(eq(deliveryLocation.deliveryId, id));

  if (!location) {
    return res.status(404).json({ error: "Driver location unavailable" });
  }

  res.json({ delivery: found, location });
});

export default router;
