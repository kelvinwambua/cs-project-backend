import express from "express";
import { eq, desc, and, or, count, sum, avg, sql } from "drizzle-orm";
import db from "../db/connection";
import { delivery } from "../db/schema";

const router = express.Router();

router.get("/overview", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [totals] = await db
    .select({
      total: count(),
      delivered: count(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN 1 END`,
      ),
      cancelled: count(
        sql`CASE WHEN ${delivery.status} = 'cancelled' THEN 1 END`,
      ),
      pending: count(sql`CASE WHEN ${delivery.status} = 'pending' THEN 1 END`),
      accepted: count(
        sql`CASE WHEN ${delivery.status} = 'accepted' THEN 1 END`,
      ),
      pickedUp: count(
        sql`CASE WHEN ${delivery.status} = 'picked_up' THEN 1 END`,
      ),
      totalRevenue: sum(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN ${delivery.price}::numeric END`,
      ),
      avgPrice: avg(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN ${delivery.price}::numeric END`,
      ),
      avgDistance: avg(delivery.distanceKm),
    })
    .from(delivery);

  const total = Number(totals.total) || 0;
  const delivered = Number(totals.delivered) || 0;
  const cancelled = Number(totals.cancelled) || 0;

  return res.json({
    total,
    delivered,
    cancelled,
    pending: Number(totals.pending) || 0,
    accepted: Number(totals.accepted) || 0,
    pickedUp: Number(totals.pickedUp) || 0,
    completionRate: total > 0 ? ((delivered / total) * 100).toFixed(1) : "0.0",
    cancellationRate:
      total > 0 ? ((cancelled / total) * 100).toFixed(1) : "0.0",
    totalRevenue: Number(totals.totalRevenue || 0).toFixed(2),
    avgOrderValue: Number(totals.avgPrice || 0).toFixed(2),
    avgDistanceKm: Number(totals.avgDistance || 0).toFixed(2),
  });
});

router.get("/business/volume", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "business") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const period = (req.query.period as string) || "daily";
  const trunc =
    period === "monthly" ? "month" : period === "weekly" ? "week" : "day";

  const rows = await db
    .select({
      period: sql<string>`date_trunc('${sql.raw(trunc)}', ${delivery.createdAt})`,
      total: count(),
      delivered: count(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN 1 END`,
      ),
      cancelled: count(
        sql`CASE WHEN ${delivery.status} = 'cancelled' THEN 1 END`,
      ),
      spend: sum(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN ${delivery.price}::numeric END`,
      ),
    })
    .from(delivery)
    .where(eq(delivery.businessId, session.user.id))
    .groupBy(sql`date_trunc('${sql.raw(trunc)}', ${delivery.createdAt})`)
    .orderBy(sql`date_trunc('${sql.raw(trunc)}', ${delivery.createdAt})`);

  return res.json(
    rows.map((r) => ({
      period: r.period,
      total: Number(r.total),
      delivered: Number(r.delivered),
      cancelled: Number(r.cancelled),
      spend: Number(r.spend || 0).toFixed(2),
    })),
  );
});

router.get("/geo", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const pickupNeighborhoods = await db
    .select({
      neighborhood: delivery.pickupNeighborhood,
      city: delivery.pickupCity,
      count: count(),
    })
    .from(delivery)
    .where(sql`${delivery.pickupNeighborhood} is not null`)
    .groupBy(delivery.pickupNeighborhood, delivery.pickupCity)
    .orderBy(desc(count()))
    .limit(10);

  const dropoffNeighborhoods = await db
    .select({
      neighborhood: delivery.dropoffNeighborhood,
      city: delivery.dropoffCity,
      count: count(),
    })
    .from(delivery)
    .where(sql`${delivery.dropoffNeighborhood} is not null`)
    .groupBy(delivery.dropoffNeighborhood, delivery.dropoffCity)
    .orderBy(desc(count()))
    .limit(10);

  const corridors = await db
    .select({
      from: delivery.pickupNeighborhood,
      to: delivery.dropoffNeighborhood,
      count: count(),
    })
    .from(delivery)
    .where(
      and(
        sql`${delivery.pickupNeighborhood} is not null`,
        sql`${delivery.dropoffNeighborhood} is not null`,
      ),
    )
    .groupBy(delivery.pickupNeighborhood, delivery.dropoffNeighborhood)
    .orderBy(desc(count()))
    .limit(10);

  return res.json({
    topPickupAreas: pickupNeighborhoods.map((r) => ({
      ...r,
      count: Number(r.count),
    })),
    topDropoffAreas: dropoffNeighborhoods.map((r) => ({
      ...r,
      count: Number(r.count),
    })),
    topCorridors: corridors.map((r) => ({ ...r, count: Number(r.count) })),
  });
});

router.get("/business/overview", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "business") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [totals] = await db
    .select({
      total: count(),
      delivered: count(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN 1 END`,
      ),
      cancelled: count(
        sql`CASE WHEN ${delivery.status} = 'cancelled' THEN 1 END`,
      ),
      pending: count(sql`CASE WHEN ${delivery.status} = 'pending' THEN 1 END`),
      totalSpend: sum(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN ${delivery.price}::numeric END`,
      ),
      avgOrderValue: avg(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN ${delivery.price}::numeric END`,
      ),
      avgDistance: avg(delivery.distanceKm),
      avgEstimatedMinutes: avg(delivery.estimatedMinutes),
    })
    .from(delivery)
    .where(eq(delivery.businessId, session.user.id));

  const total = Number(totals.total) || 0;
  const delivered = Number(totals.delivered) || 0;
  const cancelled = Number(totals.cancelled) || 0;

  return res.json({
    total,
    delivered,
    cancelled,
    pending: Number(totals.pending) || 0,
    completionRate: total > 0 ? ((delivered / total) * 100).toFixed(1) : "0.0",
    cancellationRate:
      total > 0 ? ((cancelled / total) * 100).toFixed(1) : "0.0",
    totalSpend: Number(totals.totalSpend || 0).toFixed(2),
    avgOrderValue: Number(totals.avgOrderValue || 0).toFixed(2),
    avgDistanceKm: Number(totals.avgDistance || 0).toFixed(2),
    avgEstimatedMinutes: Number(totals.avgEstimatedMinutes || 0).toFixed(1),
  });
});

router.get("/business/volume", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "business") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const period = (req.query.period as string) || "daily";
  const trunc =
    period === "monthly" ? "month" : period === "weekly" ? "week" : "day";

  const rows = await db
    .select({
      period: sql<string>`date_trunc(${trunc}, ${delivery.createdAt})`,
      total: count(),
      delivered: count(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN 1 END`,
      ),
      cancelled: count(
        sql`CASE WHEN ${delivery.status} = 'cancelled' THEN 1 END`,
      ),
      spend: sum(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN ${delivery.price}::numeric END`,
      ),
    })
    .from(delivery)
    .where(eq(delivery.businessId, session.user.id))
    .groupBy(sql`date_trunc(${trunc}, ${delivery.createdAt})`)
    .orderBy(sql`date_trunc(${trunc}, ${delivery.createdAt})`);

  return res.json(
    rows.map((r) => ({
      period: r.period,
      total: Number(r.total),
      delivered: Number(r.delivered),
      cancelled: Number(r.cancelled),
      spend: Number(r.spend || 0).toFixed(2),
    })),
  );
});

// ---------------------------------------------------------------------------
// GET /api/analytics/business/history
// Paginated full delivery history for a business
// ---------------------------------------------------------------------------
router.get("/business/history", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "business") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;
  const status = req.query.status as string | undefined;

  const conditions = [eq(delivery.businessId, session.user.id)];
  if (status) {
    conditions.push(sql`${delivery.status} = ${status}`);
  }

  const rows = await db
    .select()
    .from(delivery)
    .where(and(...conditions))
    .orderBy(desc(delivery.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: count() })
    .from(delivery)
    .where(and(...conditions));

  return res.json({
    data: rows,
    total: Number(total),
    limit,
    offset,
  });
});

router.get("/driver/overview", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "driver") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [totals] = await db
    .select({
      total: count(),
      delivered: count(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN 1 END`,
      ),
      cancelled: count(
        sql`CASE WHEN ${delivery.status} = 'cancelled' THEN 1 END`,
      ),
      totalEarnings: sum(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN ${delivery.price}::numeric END`,
      ),
      avgDistance: avg(delivery.distanceKm),
      avgEstimatedMinutes: avg(delivery.estimatedMinutes),
      otpIssued: count(
        sql`CASE WHEN ${delivery.otpHash} IS NOT NULL THEN 1 END`,
      ),
    })
    .from(delivery)
    .where(eq(delivery.driverId, session.user.id));

  const total = Number(totals.total) || 0;
  const delivered = Number(totals.delivered) || 0;

  return res.json({
    total,
    delivered,
    cancelled: Number(totals.cancelled) || 0,
    completionRate: total > 0 ? ((delivered / total) * 100).toFixed(1) : "0.0",
    totalEarnings: Number(totals.totalEarnings || 0).toFixed(2),
    avgDistanceKm: Number(totals.avgDistance || 0).toFixed(2),
    avgEstimatedMinutes: Number(totals.avgEstimatedMinutes || 0).toFixed(1),

    pendingOtpVerifications: Number(totals.otpIssued) || 0,
  });
});

router.get("/driver/volume", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "driver") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const period = (req.query.period as string) || "daily";
  const trunc =
    period === "monthly" ? "month" : period === "weekly" ? "week" : "day";

  const rows = await db
    .select({
      period: sql<string>`date_trunc(${trunc}, ${delivery.createdAt})`,
      total: count(),
      delivered: count(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN 1 END`,
      ),
      earnings: sum(
        sql`CASE WHEN ${delivery.status} = 'delivered' THEN ${delivery.price}::numeric END`,
      ),
    })
    .from(delivery)
    .where(eq(delivery.driverId, session.user.id))
    .groupBy(sql`date_trunc(${trunc}, ${delivery.createdAt})`)
    .orderBy(sql`date_trunc(${trunc}, ${delivery.createdAt})`);

  return res.json(
    rows.map((r) => ({
      period: r.period,
      total: Number(r.total),
      delivered: Number(r.delivered),
      earnings: Number(r.earnings || 0).toFixed(2),
    })),
  );
});

router.get("/driver/history", async (req, res) => {
  const session = (req as any).authSession;
  if (session.user.role !== "driver") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;
  const status = req.query.status as string | undefined;

  const conditions = [eq(delivery.driverId, session.user.id)];
  if (status) {
    conditions.push(sql`${delivery.status} = ${status}`);
  }

  const rows = await db
    .select()
    .from(delivery)
    .where(and(...conditions))
    .orderBy(desc(delivery.updatedAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: count() })
    .from(delivery)
    .where(and(...conditions));

  return res.json({
    data: rows,
    total: Number(total),
    limit,
    offset,
  });
});

export default router;
