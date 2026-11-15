'use client';

import { useEffect } from 'react';
import { withoutRecoveredMarker } from '../../../lib/recovered-marker';

/** Знімає позначку відновлення сесії з адреси, щойно сторінка відкрилась. */
export function DropRecoveredMarker() {
  useEffect(() => {
    const href = withoutRecoveredMarker(window.location.href);
    if (href) window.history.replaceState(window.history.state, '', href);
  }, []);
  return null;
}
