import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { admin, magicLink, emailOTP, jwt } from "better-auth/plugins";
import db from "../db/connection";
import * as schema from "../db/schema";
import { resend } from "../lib/resend";

const VALID_ROLES = ["driver", "business"] as const;
type RegisterRole = (typeof VALID_ROLES)[number];

function isValidRole(value: unknown): value is RegisterRole {
  return (
    typeof value === "string" && VALID_ROLES.includes(value as RegisterRole)
  );
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: schema,
  }),
  trustedOrigins: ["http://localhost:3000", "http://localhost:5173"],
  plugins: [
    jwt({
      jwt: {
        expirationTime: "7d",
        definePayload: ({ user }) => ({
          id: user.id,
          email: user.email,
          role: (user as any).role,
        }),
      },
    }),
    admin({
      defaultRole: "business",
      adminRoles: ["admin"],
    }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await resend.emails.send({
          from: "Dispatch <noreply@widgetflow-email.singularity.co.ke>",
          to: email,
          subject: "Sign in to Dispatch",
          html: `
            <p>Click the link below to sign in to Dispatch.</p>
            <p><a href="${url}">Sign in</a></p>
            <p>If you did not request this email, you can safely ignore it.</p>
          `,
        });
      },
    }),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        const subject =
          type === "sign-in"
            ? "Your Dispatch sign-in code"
            : type === "email-verification"
              ? "Verify your Dispatch email"
              : "Your Dispatch password reset code";

        await resend.emails.send({
          from: "Dispatch <noreply@widgetflow-email.singularity.co.ke>",
          to: email,
          subject,
          html: `
            <p>Your verification code is:</p>
            <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${otp}</p>
            <p>This code will expire shortly. If you did not request this, you can safely ignore it.</p>
          `,
        });
      },
    }),
  ],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/magic-link") {
        const callbackURL = ctx.body?.callbackURL as string | undefined;
        if (callbackURL) {
          const role = new URL(
            callbackURL,
            "http://placeholder",
          ).searchParams.get("role");
          if (role && isValidRole(role)) {
            ctx.context.pendingRegisterRole = role;
          }
        }
        return;
      }

      if (ctx.path === "/sign-in/email-otp") {
        const role = ctx.body?.role;
        if (role !== undefined && !isValidRole(role)) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid role. Must be 'driver' or 'business'.",
          });
        }
        if (isValidRole(role)) {
          ctx.context.pendingRegisterRole = role;
        }
        return;
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          const role = ctx?.context?.pendingRegisterRole;
          if (role && isValidRole(role)) {
            return {
              data: {
                ...user,
                role,
              },
            };
          }
          return { data: user };
        },
      },
    },
  },
});
