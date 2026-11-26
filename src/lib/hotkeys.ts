import { useEffect } from "react";

export type Hotkey =
  | "F1"
  | "F2"
  | "F3"
  | "F4"
  | "F5"
  | "F6"
  | "F7"
  | "F8"
  | "F9"
  | "F10"
  | "F11"
  | "F12"
  | "Escape"
  | `Ctrl+${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | `Alt+${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

function matchesEvent(event: KeyboardEvent, hotkey: Hotkey): boolean {
  if (event.metaKey) return false;

  if (hotkey.startsWith("Ctrl+")) {
    const digit = hotkey.slice(5);
    if (!event.ctrlKey || event.altKey || event.shiftKey) return false;
    const pressed = /^\d$/.test(event.key)
      ? event.key
      : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    return pressed === digit;
  }

  if (hotkey.startsWith("Alt+")) {
    const digit = hotkey.slice(4);
    if (!event.altKey || event.ctrlKey || event.shiftKey) return false;
    const pressed = /^\d$/.test(event.key)
      ? event.key
      : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    return pressed === digit;
  }

  if (event.ctrlKey || event.altKey || event.shiftKey) return false;

  if (hotkey === "Escape") {
    return event.key === "Escape";
  }

  return event.key.toUpperCase() === hotkey.toUpperCase();
}

export function useHotkeys(
  bindings: Partial<Record<Hotkey, () => void>>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;

      // Allow Escape and function keys even if focus is inside an input, except plain typing keys
      const isFunctionOrEsc =
        event.key === "Escape" || /^F([1-9]|1[0-2])$/.test(event.key) || event.ctrlKey || event.altKey;
      if (inEditable && !isFunctionOrEsc) return;

      for (const [key, handler] of Object.entries(bindings) as Array<[Hotkey, (() => void) | undefined]>) {
        if (!handler) continue;
        if (matchesEvent(event, key)) {
          event.preventDefault();
          event.stopPropagation();
          handler();
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [bindings, enabled]);
}

export function useCtrlHotkey(
  key: string,
  handler: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;

    const targetKey = key.toLowerCase();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== targetKey) return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, handler, key]);
}
