import type { GridLayout } from '../TerminalGrid';

export function getVisibleCount(layout: GridLayout): number {
  switch (layout) {
    case '1x1': return 1;
    case '1x2': return 2;
    case '2x2': return 4;
  }
}

export function getGridClass(layout: GridLayout): string {
  switch (layout) {
    case '1x1': return 'grid-cols-1 grid-rows-1';
    case '1x2': return 'grid-cols-2 grid-rows-1';
    case '2x2': return 'grid-cols-2 grid-rows-2';
  }
}
