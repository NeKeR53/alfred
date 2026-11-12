export interface TooltipInteractionState {
  pointerInside: boolean;
  keyboardFocused: boolean;
  dismissed: boolean;
}

export type TooltipInteractionEvent =
  | { type: "pointer-enter" }
  | { type: "pointer-leave" }
  | { type: "focus"; visible: boolean }
  | { type: "blur" }
  | { type: "escape" };

export function createTooltipInteractionState(): TooltipInteractionState {
  return { pointerInside: false, keyboardFocused: false, dismissed: false };
}

export function transitionTooltipInteraction(
  state: TooltipInteractionState,
  event: TooltipInteractionEvent,
): TooltipInteractionState {
  switch (event.type) {
    case "pointer-enter":
      return { ...state, pointerInside: true, dismissed: false };
    case "pointer-leave":
      return { ...state, pointerInside: false };
    case "focus":
      return { ...state, keyboardFocused: event.visible, dismissed: false };
    case "blur":
      return { ...state, keyboardFocused: false };
    case "escape":
      return { ...state, dismissed: true };
  }
}

export function isTooltipInteractionOpen(state: TooltipInteractionState): boolean {
  return !state.dismissed && (state.pointerInside || state.keyboardFocused);
}
