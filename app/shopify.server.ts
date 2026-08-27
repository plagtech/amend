import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import {
  PRO_CURRENCY,
  PRO_PLAN,
  PRO_PRICE,
  PRO_TRIAL_DAYS,
} from "./lib/billing.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // One plan (SPEC §7). Declared here rather than in the Partner Dashboard so
  // the price sits next to the gates it pays for — see `billing.server.ts` for
  // why this and not Managed Pricing.
  billing: {
    [PRO_PLAN]: {
      trialDays: PRO_TRIAL_DAYS,
      lineItems: [
        {
          amount: PRO_PRICE,
          currencyCode: PRO_CURRENCY,
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // Ensure a Shop row exists (and is marked active) on every install/reauth.
      // This is the record the uninstall/redact webhooks act on.
      await prisma.shop.upsert({
        where: { id: session.shop },
        create: { id: session.shop, active: true },
        update: { active: true, uninstalledAt: null },
      });
      await shopify.registerWebhooks({ session });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
