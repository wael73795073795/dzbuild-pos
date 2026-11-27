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
  | `Alt+${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | (string & {});

function normalizeKeyToken(rawKey: string): string {
  const lower = rawKey.toLowerCase();
  if (lower === " ") return "Space";
  if (lower === "esc") return "Escape";
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  if (lower.length === 1) return lower.toUpperCase();
  return rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
}

export function formatShortcutFromEvent(event: KeyboardEvent): string | null {
  if (event.metaKey) return null;
  const ignoreKeys = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"]);
  if (ignoreKeys.has(event.key)) return null;

  const digitMatch = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
  const baseKey =
    digitMatch && !event.ctrlKey && !event.altKey && !event.shiftKey
      ? digitMatch[1] ?? event.key
      : digitMatch && (event.ctrlKey || event.altKey)
        ? digitMatch[1] ?? event.key
        : normalizeKeyToken(event.key);

  if (!baseKey) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(baseKey);
  return parts.join("+");
}

function matchesEvent(event: KeyboardEvent, hotkey: string): boolean {
  if (event.metaKey) return false;

  if (hotkey.startsWith("Ctrl+") && hotkey.length === 6) {
    const digit = hotkey.slice(5);
    if (!event.ctrlKey || event.altKey || event.shiftKey) return false;
    const pressed = /^\d$/.test(event.key)
      ? event.key
      : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    return pressed === digit;
  }

  if (hotkey.startsWith("Alt+") && hotkey.length === 5) {
    const digit = hotkey.slice(4);
    if (!event.altKey || event.ctrlKey || event.shiftKey) return false;
    const pressed = /^\d$/.test(event.key)
      ? event.key
      : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    return pressed === digit;
  }

  if (hotkey === "Escape") {
    return !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Escape";
  }

  if (/^F([1-9]|1[0-2])$/i.test(hotkey)) {
    return (
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toUpperCase() === hotkey.toUpperCase()
    );
  }

  const captured = formatShortcutFromEvent(event);
  if (!captured) return false;
  return captured.toLowerCase() === hotkey.toLowerCase();
}

export function useHotkeys(
  bindings: Partial<Record<string, () => void>>,
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

      const isFunctionOrEsc =
        event.key === "Escape" || /^F([1-9]|1[0-2])$/.test(event.key) || event.ctrlKey || event.altKey;
      if (inEditable && !isFunctionOrEsc) return;

      for (const [key, handler] of Object.entries(bindings) as Array<[string, (() => void) | undefined]>) {
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
