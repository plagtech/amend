import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

// No shop-domain form (App Store requirement 2.3.1): Amend is installed from
// the Shopify App Store, never by typing a myshopify.com domain.
export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>
          Amend: bulk edit your Shopify products, with preview and undo
        </h1>
        <p className={styles.text}>
          Change prices, tags and text across your whole catalog, see every
          change first, and undo any edit.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Stack edits in one job.</strong> Prices, tags, status,
            titles, SEO, SKUs and more, applied together.
          </li>
          <li>
            <strong>Preview every row.</strong> See the before and after value
            of each product before anything is written.
          </li>
          <li>
            <strong>Undo any edit.</strong> Every job saves the old values
            first, so one click puts them back.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="https://amendinbulk.app">amendinbulk.app</a>
        </p>
      </div>
    </div>
  );
}
