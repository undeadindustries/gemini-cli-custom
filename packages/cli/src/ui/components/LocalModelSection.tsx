/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useCallback, useContext } from 'react';
import { Box, Text } from 'ink';
import {
  type LocalModelInfo,
  isLocalModelId,
  mergeLocalModelsIntoOptions,
  switchModelAcrossBoundary,
  ModelSlashCommandEvent,
  logModelSlashCommand,
} from '@google/gemini-cli-core';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';

interface LocalModelSectionProps {
  localModels: LocalModelInfo[];
  currentModel: string;
  onClose: () => void;
  persistMode: boolean;
}

/**
 * Standalone Ink component that renders the "Local Models" section in the
 * model picker dialog.  Designed to be conditionally inserted into
 * ModelDialog.tsx with a single line.
 */
export function LocalModelSection({
  localModels,
  currentModel,
  onClose,
  persistMode,
}: LocalModelSectionProps): React.JSX.Element | null {
  const config = useContext(ConfigContext);

  const options = useMemo(() => {
    const merged = mergeLocalModelsIntoOptions(localModels);
    return merged.map((o) => ({
      value: o.modelId,
      title: o.name,
      description: o.description,
      key: o.modelId,
    }));
  }, [localModels]);

  const initialIndex = useMemo(() => {
    if (!isLocalModelId(currentModel)) return 0;
    const idx = options.findIndex((o) => o.value === currentModel);
    return idx !== -1 ? idx : 0;
  }, [currentModel, options]);

  const handleSelect = useCallback(
    (modelId: string) => {
      if (!config) return;
      switchModelAcrossBoundary(config, modelId, persistMode ? false : true);
      const event = new ModelSlashCommandEvent(modelId);
      logModelSlashCommand(config, event);
      onClose();
    },
    [config, onClose, persistMode],
  );

  if (options.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={theme.text.primary}>
        Local Models
      </Text>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={options}
          onSelect={handleSelect}
          initialIndex={initialIndex}
          showNumbers={true}
        />
      </Box>
    </Box>
  );
}
