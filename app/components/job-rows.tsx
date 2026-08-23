/**
 * The per-row result table on a job page.
 *
 * Same visual grammar as the preview diff table — struck-through before, plain
 * after — on purpose: a merchant should recognise the applied result as the
 * thing they approved, not have to re-read it in a new format.
 */

import {
  Badge,
  BlockStack,
  IndexTable,
  InlineStack,
  Text,
} from "@shopify/polaris";

import { fieldLabel } from "../lib/jobs";

export interface JobRowView {
  id: string;
  /** Product title, or the raw GID if the product has since been deleted. */
  title: string;
  /** Variant name, for rows that are variants. */
  detail: string | null;
  fieldPath: string;
  before: string;
  after: string;
  applied: boolean;
  drifted: boolean;
  error: string | null;
}

export function JobRowsTable({
  rows,
  isUndo,
}: {
  rows: JobRowView[];
  isUndo: boolean;
}) {
  return (
    <IndexTable
      resourceName={{ singular: "change", plural: "changes" }}
      itemCount={rows.length}
      selectable={false}
      headings={[
        { title: "Item" },
        { title: "Field" },
        { title: isUndo ? "Restored from" : "Before" },
        { title: isUndo ? "Restored to" : "After" },
        { title: "Result" },
      ]}
    >
      {rows.map((row, index) => (
        <IndexTable.Row id={row.id} key={row.id} position={index}>
          <IndexTable.Cell>
            <BlockStack gap="050">
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {row.title}
              </Text>
              {row.detail ? (
                <Text as="span" variant="bodySm" tone="subdued">
                  {row.detail}
                </Text>
              ) : null}
            </BlockStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" variant="bodyMd">
              {fieldLabel(row.fieldPath)}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" variant="bodyMd" tone="subdued">
              <s>{row.before}</s>
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" variant="bodyMd" fontWeight="medium">
              {row.after}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <ResultCell row={row} />
          </IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );
}

function ResultCell({ row }: { row: JobRowView }) {
  if (row.error) {
    return (
      <BlockStack gap="050">
        <Badge tone="critical">Failed</Badge>
        <Text as="span" variant="bodySm" tone="critical">
          {row.error}
        </Text>
      </BlockStack>
    );
  }

  if (!row.applied) {
    return <Badge>Pending</Badge>;
  }

  return (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      <Badge tone="success">Applied</Badge>
      {/* SPEC §5: an undo still applies when the value moved underneath it,
          but the merchant has to be told which rows those were. */}
      {row.drifted ? <Badge tone="attention">Changed since</Badge> : null}
    </InlineStack>
  );
}
