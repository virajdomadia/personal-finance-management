export type SelectOption = { value: string; label: string };

// The next highlighted index. Stops at the ends; from nothing, down starts at the top and up at the bottom.
export function moveActive(active: number, by: 1 | -1, length: number): number {
  if (length === 0) return -1;
  if (active < 0) return by === 1 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, active + by));
}

// The option whose label starts with what was typed, searching onward from `from` so that pressing
// the same letter again steps through the matches. A longer query stays on `from` if it still fits.
export function typeaheadMatch(options: SelectOption[], query: string, from: number): number {
  const wanted = query.toLowerCase();
  const start = query.length > 1 ? Math.max(from, 0) : from + 1;
  for (let i = 0; i < options.length; i++) {
    const index = (start + i) % options.length;
    if (options[index].label.toLowerCase().startsWith(wanted)) return index;
  }
  return -1;
}

// An exact match shows everything, so reopening a filled-in field still offers the other choices.
export function filterOptions(options: SelectOption[], text: string): SelectOption[] {
  const wanted = text.trim().toLowerCase();
  if (wanted === "" || options.some((o) => o.label.toLowerCase() === wanted)) return options;
  return options.filter((o) => o.label.toLowerCase().includes(wanted));
}

const GAP = 4;
const SCREEN_MARGIN = 8;
const MAX_HEIGHT = 240;

type PopupInput = {
  trigger: { top: number; bottom: number; left: number; width: number };
  popupHeight: number;
  viewport: { width: number; height: number };
};

// Where to place the open list: below the trigger, or above it when that has room and below doesn't.
export function popupPosition({ trigger, popupHeight, viewport }: PopupInput) {
  const below = viewport.height - trigger.bottom - GAP - SCREEN_MARGIN;
  const above = trigger.top - GAP - SCREEN_MARGIN;
  const wanted = Math.min(popupHeight, MAX_HEIGHT);
  const flip = below < wanted && above > below;
  const maxHeight = Math.min(MAX_HEIGHT, flip ? above : below);
  const height = Math.min(wanted, maxHeight);
  return {
    top: flip ? trigger.top - GAP - height : trigger.bottom + GAP,
    left: Math.max(SCREEN_MARGIN, Math.min(trigger.left, viewport.width - trigger.width - SCREEN_MARGIN)),
    width: trigger.width,
    maxHeight,
  };
}
