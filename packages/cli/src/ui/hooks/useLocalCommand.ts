/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

interface UseLocalCommandReturn {
  isLocalDialogOpen: boolean;
  openLocalDialog: () => void;
  closeLocalDialog: () => void;
}

// --- LOCAL FORK ADDITION ---
// Mirrors useModelCommand. Drives the /local dialog open/close state.
export const useLocalCommand = (): UseLocalCommandReturn => {
  const [isLocalDialogOpen, setIsLocalDialogOpen] = useState(false);

  const openLocalDialog = useCallback(() => {
    setIsLocalDialogOpen(true);
  }, []);

  const closeLocalDialog = useCallback(() => {
    setIsLocalDialogOpen(false);
  }, []);

  return {
    isLocalDialogOpen,
    openLocalDialog,
    closeLocalDialog,
  };
};
