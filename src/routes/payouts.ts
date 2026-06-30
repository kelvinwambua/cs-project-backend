import express from "express";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import db from "../db/connection";
import { driverPayoutAccount } from "../db/schema";

const router = express.Router();

const PAYSTACK_LIVE_KEY = process.env.PAYSTACK_SECRET_KEY_LIVE!;
const PAYSTACK_TEST_KEY = process.env.PAYSTACK_SECRET_KEY!;

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

function cleanString(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

function cleanAccountNumber(value: unknown): string {
  return String(value ?? "")
    .replace(/[\s-]+/g, "")
    .trim();
}

function isMobileMoneyCode(bankCode: string): boolean {
  return (
    bankCode === "MPESA" || bankCode === "MPPAYBILL" || bankCode === "MPTILL"
  );
}

router.get(
  "/bank-account",
  asyncHandler(async (req, res) => {
    const session = (req as any).authSession;
    if (session.user.role !== "driver") {
      res.status(403).json({ error: "Only drivers have payout accounts" });
      return;
    }

    const [account] = await db
      .select()
      .from(driverPayoutAccount)
      .where(eq(driverPayoutAccount.userId, session.user.id));

    res.json(account ?? null);
  }),
);

router.get(
  "/banks",
  asyncHandler(async (req, res) => {
    const session = (req as any).authSession;
    if (session.user.role !== "driver") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const r = await fetch("https://api.paystack.co/bank?currency=KES", {
      headers: { Authorization: `Bearer ${PAYSTACK_LIVE_KEY}` },
    });
    const data = await r.json();

    if (!data.status) {
      res
        .status(502)
        .json({ error: data.message || "Could not fetch bank list" });
      return;
    }

    res.json(
      (data.data as any[]).map((b) => ({
        name: b.name,
        code: b.code,
        slug: b.slug,
        currency: b.currency,
        type: b.type,
      })),
    );
  }),
);

router.post(
  "/verify-account",
  asyncHandler(async (req, res) => {
    const session = (req as any).authSession;
    if (session.user.role !== "driver") {
      res
        .status(403)
        .json({ error: "Only drivers can verify payout accounts" });
      return;
    }

    const accountNumber = cleanAccountNumber(req.body.accountNumber);
    const bankCode = cleanString(req.body.bankCode);

    if (!accountNumber || !bankCode) {
      res
        .status(400)
        .json({ error: "accountNumber and bankCode are required" });
      return;
    }

    if (isMobileMoneyCode(bankCode)) {
      res.json({
        accountName: "M-PESA",
        accountNumber,
      });
      return;
    }

    const r = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(
        accountNumber,
      )}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_LIVE_KEY}` } },
    );
    const data = await r.json();

    if (!data.status) {
      res
        .status(422)
        .json({ error: data.message || "Could not verify account" });
      return;
    }

    res.json({
      accountName: data.data.account_name,
      accountNumber: data.data.account_number,
    });
  }),
);

router.post(
  "/bank-account",
  asyncHandler(async (req, res) => {
    const session = (req as any).authSession;
    if (session.user.role !== "driver") {
      res.status(403).json({ error: "Only drivers can save payout accounts" });
      return;
    }

    const accountNumber = cleanAccountNumber(req.body.accountNumber);
    const bankCode = cleanString(req.body.bankCode);
    const bankName = req.body.bankName;

    if (!accountNumber || !bankCode) {
      res
        .status(400)
        .json({ error: "accountNumber and bankCode are required" });
      return;
    }

    const mobileMoney = isMobileMoneyCode(bankCode);
    let accountName = "M-PESA";

    if (!mobileMoney) {
      const resolveRes = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(
          accountNumber,
        )}&bank_code=${encodeURIComponent(bankCode)}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_LIVE_KEY}` } },
      );
      const resolveData = await resolveRes.json();

      if (!resolveData.status) {
        res.status(422).json({
          error: resolveData.message || "Could not verify account",
        });
        return;
      }

      accountName = resolveData.data.account_name;
    }

    const recipientType = !mobileMoney
      ? "nuban"
      : bankCode === "MPESA"
        ? "mobile_money"
        : "mobile_money_business";

    const recipientRes = await fetch(
      "https://api.paystack.co/transferrecipient",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_TEST_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: recipientType,
          name: accountName,
          account_number: accountNumber,
          bank_code: bankCode,
          currency: "KES",
        }),
      },
    );
    const recipientData = await recipientRes.json();

    if (!recipientData.status) {
      res.status(502).json({
        error: recipientData.message || "Could not create transfer recipient",
      });
      return;
    }

    await db
      .insert(driverPayoutAccount)
      .values({
        id: nanoid(),
        userId: session.user.id,
        bankCode,
        bankName: bankName ?? null,
        accountNumber,
        accountName,
        paystackRecipientCode: recipientData.data.recipient_code,
      })
      .onConflictDoUpdate({
        target: driverPayoutAccount.userId,
        set: {
          bankCode,
          bankName: bankName ?? null,
          accountNumber,
          accountName,
          paystackRecipientCode: recipientData.data.recipient_code,
          updatedAt: new Date(),
        },
      });

    res.json({ success: true, accountName });
  }),
);

router.post(
  "/transfer",
  asyncHandler(async (req, res) => {
    const session = (req as any).authSession;
    if (session.user.role !== "driver") {
      res.status(403).json({ error: "Only drivers can request a payout" });
      return;
    }

    const { amount, reason } = req.body;
    if (typeof amount !== "number" || amount <= 0) {
      res.status(400).json({ error: "Invalid amount" });
      return;
    }

    const [account] = await db
      .select()
      .from(driverPayoutAccount)
      .where(eq(driverPayoutAccount.userId, session.user.id));

    if (!account?.paystackRecipientCode) {
      res
        .status(409)
        .json({ error: "No payout account on file. Add one first." });
      return;
    }

    const transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_TEST_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "balance",
        amount: Math.round(amount * 100),
        recipient: account.paystackRecipientCode,
        reason: reason ?? "Driver payout",
      }),
    });
    const transferData = await transferRes.json();

    if (!transferData.status) {
      res
        .status(502)
        .json({ error: transferData.message || "Transfer failed" });
      return;
    }

    res.json(transferData.data);
  }),
);

export default router;
