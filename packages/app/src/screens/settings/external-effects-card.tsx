import equal from "fast-deep-equal";
import { Plus, Save, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ExternalEffectCatalogEntry } from "@getpaseo/protocol/external-effect-catalog";

import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";

import {
  addCatalogEntry,
  catalogValidationError,
  normalizeCatalogForSave,
  removeCatalogEntry,
  updateCatalogEntry,
  EXTERNAL_EFFECT_CATALOG_LIMIT,
} from "./external-effects-config";

function CatalogRow({
  entry,
  disabled,
  onChange,
  onRemove,
}: {
  entry: ExternalEffectCatalogEntry;
  disabled: boolean;
  onChange: (
    id: string,
    patch: Partial<Pick<ExternalEffectCatalogEntry, "label" | "grant">>,
  ) => void;
  onRemove: (id: string) => void;
}) {
  const handleLabelChange = useCallback(
    (label: string) => onChange(entry.id, { label }),
    [entry.id, onChange],
  );
  const handleGrantChange = useCallback(
    (grant: string) => onChange(entry.id, { grant }),
    [entry.id, onChange],
  );
  const handleRemove = useCallback(() => onRemove(entry.id), [entry.id, onRemove]);

  return (
    <View style={styles.row} testID={`external-effect-row-${entry.id}`}>
      <View style={styles.rowFields}>
        <Field label="Name">
          <FormTextInput
            size="sm"
            initialValue={entry.label}
            onChangeText={handleLabelChange}
            editable={!disabled}
            placeholder="Postgres prddev"
            accessibilityLabel="Grant name"
            testID={`external-effect-row-${entry.id}-label`}
          />
        </Field>
        <Field label="Access granted" hint="The exact wording handed to the assignment.">
          <FormTextInput
            size="sm"
            initialValue={entry.grant}
            onChangeText={handleGrantChange}
            editable={!disabled}
            placeholder="read/write the prddev Postgres database; never prd"
            accessibilityLabel="Access granted"
            testID={`external-effect-row-${entry.id}-grant`}
            style={styles.grantInput}
            multiline
            numberOfLines={2}
            textAlignVertical="top"
          />
        </Field>
      </View>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Trash2}
        onPress={handleRemove}
        disabled={disabled}
        accessibilityLabel="Remove grant"
        testID={`external-effect-row-${entry.id}-remove`}
      />
    </View>
  );
}

export function ExternalEffectsCard({ serverId }: { serverId: string }) {
  const supported = useHostFeature(serverId, "externalEffectCatalog");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const saved = config?.externalEffectCatalog;
  const [draft, setDraft] = useState<ExternalEffectCatalogEntry[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(saved ? [...saved] : []);
    setError(null);
  }, [saved]);

  const handleAdd = useCallback(() => setDraft(addCatalogEntry), []);
  const handleChange = useCallback(
    (id: string, patch: Partial<Pick<ExternalEffectCatalogEntry, "label" | "grant">>) =>
      setDraft((entries) => updateCatalogEntry(entries, id, patch)),
    [],
  );
  const handleRemove = useCallback(
    (id: string) => setDraft((entries) => removeCatalogEntry(entries, id)),
    [],
  );

  const validationError = catalogValidationError(draft);
  const normalized = normalizeCatalogForSave(draft);
  const isDirty = !equal(normalized, saved ?? []);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    setError(null);
    void patchConfig({ externalEffectCatalog: normalizeCatalogForSave(draft) })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setIsSaving(false));
  }, [draft, patchConfig]);

  if (!supported) return null;

  return (
    <View style={settingsStyles.card} testID="host-external-effects-card">
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={settingsStyles.rowTitle}>External access presets</Text>
          <Text style={settingsStyles.rowHint}>
            Named grants you can tick when creating an assignment, instead of retyping them. A
            ticked preset is written into the assignment contract for the agent to obey; it does not
            sandbox anything, so keep the credentials themselves scoped too.
          </Text>
        </View>
        <Button
          variant="default"
          size="sm"
          leftIcon={Save}
          onPress={handleSave}
          disabled={isSaving || !isDirty || validationError !== null}
          loading={isSaving}
          testID="external-effects-save"
        >
          Save
        </Button>
      </View>

      <View style={styles.body}>
        {draft.length === 0 ? (
          <Text style={settingsStyles.rowHint} testID="external-effects-empty">
            No presets yet. Assignments can still be granted access by typing it in the composer.
          </Text>
        ) : (
          draft.map((entry) => (
            <CatalogRow
              key={entry.id}
              entry={entry}
              disabled={isSaving}
              onChange={handleChange}
              onRemove={handleRemove}
            />
          ))
        )}
        {validationError ? (
          <Text style={settingsStyles.rowError} testID="external-effects-validation-error">
            {validationError}
          </Text>
        ) : null}
        {error ? (
          <Text style={settingsStyles.rowError} testID="external-effects-error">
            {error}
          </Text>
        ) : null}
        <View style={styles.addRow}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={handleAdd}
            disabled={isSaving || draft.length >= EXTERNAL_EFFECT_CATALOG_LIMIT}
            testID="external-effects-add"
          >
            Add grant
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  headerCopy: { flex: 1 },
  body: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  rowFields: {
    flex: 1,
    gap: theme.spacing[2],
  },
  grantInput: {
    minHeight: 56,
  },
  addRow: {
    flexDirection: "row",
  },
}));
