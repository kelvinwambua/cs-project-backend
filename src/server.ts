import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import multer from "multer";
import db from "./db/connection";
import { user as users } from "./db/schema";
import { auth } from "./lib/auth";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import cookieParser from "cookie-parser";
import { eq } from "drizzle-orm";
import deliveryRoutes from "./routes/deliveries";
import analyticsRoutes from "./routes/analytics";
import { businessProfile } from "./db/schema";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname),
    );
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  },
});

app.use(cookieParser());
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`);
  });
  next();
});

app.use(
  "/uploads",
  (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "http://localhost:5173");
    res.header("Access-Control-Allow-Methods", "GET");
    next();
  },
  express.static(path.join(__dirname, "public", "uploads")),
);

const requireAuth = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session?.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    (req as any).authSession = session;
    next();
  } catch (error) {
    console.error("Auth error:", error);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
};

app.all("/api/auth/*", toNodeHandler(auth));
app.use(express.json());
app.use("/api/deliveries", requireAuth, deliveryRoutes);
app.use("/api/analytics", requireAuth, analyticsRoutes);

app.post("/api/set-role", requireAuth, async (req, res) => {
  try {
    const session = (req as any).authSession;
    const { role } = req.body;
    if (!["driver", "business"].includes(role)) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }
    await db.update(users).set({ role }).where(eq(users.id, session.user.id));
    res.json({ ok: true });
  } catch (error) {
    console.error("Set role error:", error);
    res.status(500).json({ error: "Failed to set role" });
  }
});

app.get("/api/business-profile", requireAuth, async (req, res) => {
  const session = (req as any).authSession;
  const [profile] = await db
    .select()
    .from(businessProfile)
    .where(eq(businessProfile.userId, session.user.id));
  res.json(profile ?? null);
});

app.get("/api/places/autocomplete", requireAuth, async (req, res) => {
  const { input } = req.query;
  if (!input) {
    res.status(400).json({ error: "Missing input" });
    return;
  }
  const r = await fetch(
    "https://places.googleapis.com/v1/places:autocomplete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY!,
      },
      body: JSON.stringify({ input }),
    },
  );
  const data = await r.json();
  res.json(data);
});

app.get("/api/places/details", requireAuth, async (req, res) => {
  const { placeId } = req.query;
  if (!placeId) {
    res.status(400).json({ error: "Missing placeId" });
    return;
  }
  const r = await fetch(
    `https://places.googleapis.com/v1/places/${placeId}?fields=location,formattedAddress`,
    {
      headers: {
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY!,
        "X-Goog-FieldMask": "location,formattedAddress",
      },
    },
  );
  const data = await r.json();
  res.json(data);
});

app.patch("/api/profile", requireAuth, async (req, res) => {
  const session = (req as any).authSession;
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  const [updated] = await db
    .update(users)
    .set({ name: name.trim() })
    .where(eq(users.id, session.user.id))
    .returning();
  res.json(updated);
});

app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error(err.stack);
    res
      .status(500)
      .json({ error: "Something went wrong!", message: err.message });
  },
);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Backend URL: ${BACKEND_URL}`);
  console.log(`Database url ${process.env.DATABASE_URL}`);
});

export default app;
