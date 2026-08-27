/**
 * "Save as template" — the same dialog from the wizard and from a finished job,
 * because it is the same act: name this filter and these actions so they can be
 * run again (SPEC §6).
 */

import { useEffect, useState } from "react";
import { Banner, BlockStack, Modal, Text, TextField } from "@shopify/polaris";

export function SaveTemplateModal({
  open,
  defaultName,
  summary,
  saving,
  error,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Pre-filled name — the action summary, which is what a merchant would type. */
  defaultName: string;
  /** What is being saved, restated so the name is chosen for the right thing. */
  summary: string;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(defaultName);

  // Re-seed each time it opens: the actions may have moved on since last time,
  // and a stale suggested name is worse than none.
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save as template"
      primaryAction={{
        content: "Save template",
        onAction: () => onSave(name),
        disabled: !name.trim(),
        loading: saving,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {error ? (
            <Banner tone="critical">
              <p>{error}</p>
            </Banner>
          ) : null}
          <TextField
            label="Template name"
            value={name}
            onChange={setName}
            maxLength={80}
            autoComplete="off"
          />
          <Text as="p" variant="bodySm" tone="subdued">
            Saves {summary}. The filter and the actions are kept — never the list
            of products, so running it again edits whatever matches then.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
