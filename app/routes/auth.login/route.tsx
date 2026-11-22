import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Banner,
  BlockStack,
  Card,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { login } from "../../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

/**
 * The configured login path. No shop-domain form (App Store requirement
 * 2.3.1): merchants install from the App Store, and the admin opens the app
 * embedded with `shop` and `host` already set.
 *
 * Still reached two ways:
 *   - `?shop=<domain>` — `login()` validates it and throws a redirect to the
 *     store's install page. It only returns when the domain is invalid.
 *   - bare, when `authenticate.admin` finds no usable `shop` (a top-level
 *     visit outside the admin). That gets the message below.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const invalidShop = url.searchParams.get("shop")
    ? Boolean((await login(request)).shop)
    : false;

  return { invalidShop, polarisTranslations };
};

export default function Auth() {
  const { invalidShop, polarisTranslations } = useLoaderData<typeof loader>();

  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page narrowWidth>
        <BlockStack gap="400">
          {invalidShop ? (
            <Banner tone="critical">
              <p>That shop link isn&apos;t valid.</p>
            </Banner>
          ) : null}
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                Open Amend from your Shopify admin
              </Text>
              <Text as="p">
                Amend is installed from the Shopify App Store. Once installed,
                open it from Apps in your Shopify admin.
              </Text>
              <Text as="p">
                <Link url="https://amendinbulk.app">amendinbulk.app</Link>
              </Text>
            </BlockStack>
          </Card>
        </BlockStack>
      </Page>
    </PolarisAppProvider>
  );
}
