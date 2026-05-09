/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

interface UseProviderCommandReturn {
  isProviderDialogOpen: boolean;
  openProviderDialog: () => void;
  closeProviderDialog: () => void;
}

/**
 * Drives the `/provider` dialog open/close state.
 * Brand-new file (Category C) — no rebase fences required.
 */
export const useProviderCommand = (): UseProviderCommandReturn => {
  const [isProviderDialogOpen, setIsProviderDialogOpen] = useState(false);

  const openProviderDialog = useCallback(() => {
    setIsProviderDialogOpen(true);
  }, []);

  const closeProviderDialog = useCallback(() => {
    setIsProviderDialogOpen(false);
  }, []);

  return {
    isProviderDialogOpen,
    openProviderDialog,
    closeProviderDialog,
  };
};
