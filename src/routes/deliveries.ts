import express from "express";
import { eq, desc, and, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import db from "../db/connection";
import { delivery, businessProfile, deliveryLocation } from "../db/schema";
import crypto from "crypto";
import twilio from "twilio";

const router = express.Router();

const BASE_FEE = 50;
const PER_KM_RATE = 20;

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
console.log(
  "Using Paystack key:",
  PAYSTACK_SECRET_KEY?.slice(0, 12),
  PAYSTACK_SECRET_KEY?.length,
);
function asyncHandler<
  P extends Record<string, string> = Record<string, string>,
>(fn: (req: express.Request<P>, res: express.Response) => Promise<any>) {
  return (req: express.Request<P>, res: express.Response) => {
    fn(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    });
  };
}

function isValidCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

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

router.post(
  "/initiate",
  asyncHandler(async (req, res) => {
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
      !isValidCoord(pickupLat) ||
      !isValidCoord(pickupLng) ||
      !dropoffAddress ||
      !dropoffPlaceId ||
      !isValidCoord(dropoffLat) ||
      !isValidCoord(dropoffLng)
    ) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    let distanceKm: number;
    let durationMinutes: number;
    try {
      const result = await getDistanceAndDuration(
        pickupLat,
        pickupLng,
        dropoffLat,
        dropoffLng,
      );
      distanceKm = result.distanceKm;
      durationMinutes = result.durationMinutes;
    } catch (err) {
      console.error("Failed to compute route:", err);
      res.status(502).json({ error: "Could not calculate route distance" });
      return;
    }

    const price = calculatePrice(distanceKm);
    const deliveryId = nanoid();
    const paystackReference = `dlv_${deliveryId}_${Date.now()}`;

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

    await db.insert(delivery).values({
      id: deliveryId,
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
      status: "awaiting_payment",
      paystackReference,
    });

    const paystackRes = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: session.user.email,
          amount: Math.round(price * 100),
          currency: "KES",
          reference: paystackReference,
          callback_url: `${FRONTEND_URL}/business/requests/callback`,
          metadata: {
            deliveryId,
            businessId: session.user.id,
          },
        }),
      },
    );

    const paystackData = await paystackRes.json();

    if (!paystackData.status || !paystackData.data?.authorization_url) {
      console.error("Paystack init failed:", paystackData);
      await db.delete(delivery).where(eq(delivery.id, deliveryId));
      res.status(502).json({ error: "Could not initialize payment" });
      return;
    }

    res.status(201).json({
      deliveryId,
      authorizationUrl: paystackData.data.authorization_url,
    });
  }),
);

router.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const { reference } = req.query;

    if (!reference || typeof reference !== "string") {
      res.redirect(`${FRONTEND_URL}/business/requests?payment=invalid`);
      return;
    }

    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      },
    );

    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data?.status !== "success") {
      console.error("Paystack verification failed:", verifyData);
      res.redirect(`${FRONTEND_URL}/business/requests?payment=failed`);
      return;
    }

    const [updated] = await db
      .update(delivery)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(delivery.paystackReference, reference),
          eq(delivery.status, "awaiting_payment"),
        ),
      )
      .returning();

    if (!updated) {
      res.redirect(
        `${FRONTEND_URL}/business/requests?payment=already_processed`,
      );
      return;
    }

    res.redirect(
      `${FRONTEND_URL}/business/requests/${updated.id}?payment=success`,
    );
  }),
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

const OTP_TTL_MS = 5 * 60 * 1000;

function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return `+${digits}`;
  if (digits.startsWith("0")) return `+254${digits.slice(1)}`;
  return `+${digits}`;
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

router.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const session = (req as any).authSession;
    if (session.user.role !== "business") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const { pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;
    if (
      !isValidCoord(pickupLat) ||
      !isValidCoord(pickupLng) ||
      !isValidCoord(dropoffLat) ||
      !isValidCoord(dropoffLng)
    ) {
      res.status(400).json({ error: "Missing or invalid coordinates" });
      return;
    }

    try {
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
    } catch (err) {
      console.error("Failed to compute route preview:", err);
      res.status(502).json({ error: "Could not calculate route distance" });
    }
  }),
);

router.get(
  "/available-deliveries",
  asyncHandler(async (req, res) => {
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
  }),
);

router.get(
  "/active",
  asyncHandler(async (req, res) => {
    const session = (req as any).authSession;

    if (session.user.role !== "driver") {
      res.status(403).json({
        error: "Only drivers can access their active delivery.",
      });
      return;
    }

    const [activeDelivery] = await db
      .select()
      .from(delivery)
      .where(
        and(
          eq(delivery.driverId, session.user.id),
          or(eq(delivery.status, "accepted"), eq(delivery.status, "picked_up")),
        ),
      );

    if (!activeDelivery) {
      res.status(404).json({
        error: "No active delivery found.",
      });
      return;
    }

    res.json(activeDelivery);
  }),
);
router.get(
  "/business/history",
  asyncHandler(async (req, res) => {
    const session = (req as any).authSession;
    if (session.user.role !== "business") {
      res
        .status(403)
        .json({ error: "Only businesses can view delivery history" });
      return;
    }
    const history = await db
      .select()
      .from(delivery)
      .where(
        and(
          eq(delivery.businessId, session.user.id),
          or(
            eq(delivery.status, "delivered"),
            eq(delivery.status, "cancelled"),
          ),
        ),
      )
      .orderBy(desc(delivery.updatedAt));
    res.json(history);
  }),
);

router.get(
  "/history",
  asyncHandler(async (req, res) => {
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
          or(
            eq(delivery.status, "delivered"),
            eq(delivery.status, "cancelled"),
          ),
        ),
      )
      .orderBy(desc(delivery.updatedAt));
    res.json(history);
  }),
);

router.post(
  "/:id/otp",
  asyncHandler<{ id: string }>(async (req, res) => {
    const session = (req as any).authSession;

    if (session.user.role !== "driver") {
      res.status(403).json({ error: "Only drivers can request an OTP." });
      return;
    }

    const { id } = req.params;

    const [found] = await db.select().from(delivery).where(eq(delivery.id, id));

    if (!found) {
      res.status(404).json({ error: "Delivery not found." });
      return;
    }
    if (found.driverId !== session.user.id) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }
    if (found.status !== "picked_up") {
      res.status(409).json({
        error: "OTP can only be sent once the parcel has been picked up.",
      });
      return;
    }

    const otp = generateOtp();
    const otpHash = hashOtp(otp);
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

    await db
      .update(delivery)
      .set({ otpHash, otpExpiresAt, updatedAt: new Date() })
      .where(eq(delivery.id, id));

    const phone = toE164(found.recipientPhone);

    try {
      await twilioClient.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
        to: `whatsapp:${phone}`,
        body:
          `Hello ${found.recipientName}, your delivery is here! 🚚\n\n` +
          `Your confirmation code is: *${otp}*\n\n` +
          `Share this code with your rider to complete the handoff. ` +
          `Valid for 5 minutes.`,
      });
    } catch (err) {
      console.error("WhatsApp send error:", err);
      res
        .status(502)
        .json({ error: "Could not send WhatsApp message. Please try again." });
      return;
    }

    res.json({
      success: true,
      message: `WhatsApp sent to number ending in ${phone.slice(-4)}.`,
      expiresAt: otpExpiresAt,
    });
  }),
);

router.post(
  "/:id/verify-otp",
  asyncHandler<{ id: string }>(async (req, res) => {
    const session = (req as any).authSession;

    if (session.user.role !== "driver") {
      res.status(403).json({ error: "Only drivers can verify an OTP." });
      return;
    }

    const { id } = req.params;
    const { otp } = req.body;

    if (!otp || typeof otp !== "string") {
      res.status(400).json({ error: "OTP is required." });
      return;
    }

    const [found] = await db.select().from(delivery).where(eq(delivery.id, id));

    if (!found) {
      res.status(404).json({ error: "Delivery not found." });
      return;
    }
    if (found.driverId !== session.user.id) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }
    if (found.status !== "picked_up") {
      res.status(409).json({ error: "Delivery is not in a verifiable state." });
      return;
    }
    if (!found.otpHash || !found.otpExpiresAt) {
      res
        .status(409)
        .json({ error: "No OTP has been issued. Request one first." });
      return;
    }
    if (new Date() > new Date(found.otpExpiresAt)) {
      res
        .status(410)
        .json({ error: "OTP has expired. Please request a new one." });
      return;
    }
    if (hashOtp(otp.trim()) !== found.otpHash) {
      res.status(422).json({ error: "Incorrect OTP." });
      return;
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

    res.json(delivered);
  }),
);

router.get(
  "/:id",
  asyncHandler<{ id: string }>(async (req, res) => {
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
    if (
      session.user.role === "driver" &&
      found.driverId !== session.user.id &&
      found.status !== "pending"
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json(found);
  }),
);

router.patch(
  "/:id",
  asyncHandler<{ id: string }>(async (req, res) => {
    const session = (req as any).authSession;
    const { id } = req.params;
    const { action } = req.body;

    switch (action) {
      case "accept": {
        if (session.user.role !== "driver") {
          res.status(403).json({ error: "Only drivers can accept deliveries" });
          return;
        }

        const active = await db
          .select()
          .from(delivery)
          .where(
            and(
              eq(delivery.driverId, session.user.id),
              or(
                eq(delivery.status, "accepted"),
                eq(delivery.status, "picked_up"),
              ),
            ),
          );

        if (active.length > 0) {
          res.status(403).json({
            error: "Driver already has an active delivery.",
          });
          return;
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
          res.status(409).json({ error: "Delivery is no longer pending" });
          return;
        }
        res.json(accepted[0]);
        return;
      }

      case "pick_up": {
        if (session.user.role !== "driver") {
          res
            .status(403)
            .json({ error: "Only drivers can pick up deliveries" });
          return;
        }

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
          res.status(409).json({ error: "Delivery not accepted" });
          return;
        }
        res.json(picked[0]);
        return;
      }

      case "deliver": {
        res.status(400).json({
          error:
            "Deliveries must be marked delivered via OTP verification. Use /:id/otp then /:id/verify-otp.",
        });
        return;
      }

      case "cancel": {
        if (session.user.role !== "business") {
          res.status(403).json({ error: "Only businesses can cancel orders" });
          return;
        }

        const cancelled = await db
          .update(delivery)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(
            and(
              eq(delivery.id, id),
              or(
                eq(delivery.status, "pending"),
                eq(delivery.status, "awaiting_payment"),
              ),
              eq(delivery.businessId, session.user.id),
            ),
          )
          .returning();

        if (cancelled.length === 0) {
          res.status(409).json({ error: "Delivery cancellation failed" });
          return;
        }
        res.json(cancelled[0]);
        return;
      }

      default:
        res.status(400).json({ error: "Invalid action" });
    }
  }),
);

router.patch(
  "/:id/location",
  asyncHandler<{ id: string }>(async (req, res) => {
    const session = (req as any).authSession;
    const { id: deliveryId } = req.params;
    const { latitude, longitude } = req.body;

    if (session.user.role !== "driver") {
      res
        .status(403)
        .json({ error: "Only drivers can update delivery location" });
      return;
    }

    if (!isValidCoord(latitude) || !isValidCoord(longitude)) {
      res.status(400).json({ error: "Missing or invalid coordinates" });
      return;
    }

    const [found] = await db
      .select()
      .from(delivery)
      .where(eq(delivery.id, deliveryId));

    if (!found) {
      res.status(404).json({ error: "Delivery not found" });
      return;
    }
    if (found.driverId !== session.user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (found.status !== "accepted" && found.status !== "picked_up") {
      res.status(409).json({ error: "Delivery is not active" });
      return;
    }

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
        recordedAt,
      })
      .onConflictDoUpdate({
        target: deliveryLocation.deliveryId,
        set: {
          lat: latitude,
          lng: longitude,
          recordedAt,
        },
      });
    res.json({ success: true });
  }),
);

router.get(
  "/:id/location",
  asyncHandler<{ id: string }>(async (req, res) => {
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

    if (session.user.role === "driver" && found.driverId !== session.user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const [location] = await db
      .select()
      .from(deliveryLocation)
      .where(eq(deliveryLocation.deliveryId, id));

    if (!location) {
      res.status(404).json({ error: "Driver location unavailable" });
      return;
    }

    res.json({ delivery: found, location });
  }),
);

export default router;
