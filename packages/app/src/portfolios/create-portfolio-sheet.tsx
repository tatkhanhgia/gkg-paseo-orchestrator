import { useCallback, useMemo, useReducer } from "react";
import { useMutation } from "@tanstack/react-query";
import type { PortfolioRecord } from "@getpaseo/protocol/portfolio/rpc-schemas";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { toErrorMessage } from "@/utils/error-messages";

interface CreatePortfolioSheetProps {
  visible: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<PortfolioRecord>;
  onCreated: (portfolio: PortfolioRecord) => void;
}

const CREATE_PORTFOLIO_HEADER = { title: "Create portfolio" };
const CREATE_PORTFOLIO_SNAP_POINTS = ["45%", "70%"];

export function CreatePortfolioSheet({
  visible,
  onClose,
  onCreate,
  onCreated,
}: CreatePortfolioSheetProps) {
  const [name, setName] = useReducer((_current: string, next: string) => next, "");
  const [inputRevision, bumpInputRevision] = useReducer((revision: number) => revision + 1, 0);
  const createMutation = useMutation({
    mutationFn: async () => onCreate(name.trim()),
    onSuccess: (portfolio) => {
      setName("");
      bumpInputRevision();
      onCreated(portfolio);
    },
  });

  const handleClose = useCallback(() => {
    if (createMutation.isPending) return;
    createMutation.reset();
    setName("");
    bumpInputRevision();
    onClose();
  }, [createMutation, onClose]);
  const handleCreate = useCallback(() => {
    createMutation.reset();
    createMutation.mutate();
  }, [createMutation]);

  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          onPress={handleClose}
          disabled={createMutation.isPending}
          testID="create-portfolio-cancel"
        >
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={handleCreate}
          loading={createMutation.isPending}
          disabled={!name.trim()}
          testID="create-portfolio-submit"
        >
          {createMutation.isPending ? "Creating..." : "Create"}
        </Button>
      </View>
    ),
    [createMutation.isPending, handleClose, handleCreate, name],
  );

  return (
    <AdaptiveModalSheet
      header={CREATE_PORTFOLIO_HEADER}
      visible={visible}
      onClose={handleClose}
      footer={footer}
      snapPoints={CREATE_PORTFOLIO_SNAP_POINTS}
      testID="create-portfolio-sheet"
    >
      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        <AdaptiveTextInput
          initialValue={name}
          resetKey={`portfolio-name-${inputRevision}`}
          onChangeText={setName}
          placeholder="Product suite"
          autoCapitalize="sentences"
          autoCorrect={false}
          editable={!createMutation.isPending}
          testID="create-portfolio-name"
          style={styles.input}
        />
        <Text style={styles.helper}>A portfolio groups Projects from this Host.</Text>
      </View>
      {createMutation.error ? (
        <Text style={styles.error} testID="create-portfolio-error">
          {toErrorMessage(createMutation.error)}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    minHeight: 44,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
