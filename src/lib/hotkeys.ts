import { useEffect, useRef } from "react";

export type Hotkey = string;

export type HotkeyHandler = (event: KeyboardEvent) => void;

export interface HotkeyBinding {
  hotkey: Hotkey;
  handler: HotkeyHandler;
  enabled?: boolean;
  allowInEditable?: boolean;
}

function normalizeKeyToken(rawKey: string, code: string): string {
  const lower = rawKey.toLowerCase();
  if (lower === " " || code === "Space") return "Space";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();

  const digitMatch = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digitMatch && digitMatch[1]) {
    return digitMatch[1];
  }

  if (rawKey.length === 1) {
    return rawKey.toUpperCase();
  }

  return rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
}

export function formatShortcutFromEvent(event: KeyboardEvent): string | null {
  if (event.metaKey) return null;
  const modifierOnlyKeys = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"]);
  if (modifierOnlyKeys.has(event.key)) return null;

  const baseKey = normalizeKeyToken(event.key, event.code);
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

  const cleaned = hotkey.trim();
  if (!cleaned) return false;

  const captured = formatShortcutFromEvent(event);
  if (!captured) return false;

  if (captured.toLowerCase() === cleaned.toLowerCase()) {
    return true;
  }

  // Fallback for Ctrl/Alt + digit across layouts/numpad
  if (/^(Ctrl|Alt)\+\d$/i.test(cleaned)) {
    const [mod, digit] = cleaned.split("+");
    const wantCtrl = mod?.toLowerCase() === "ctrl";
    const wantAlt = mod?.toLowerCase() === "alt";
    if (event.ctrlKey !== wantCtrl || event.altKey !== wantAlt || event.shiftKey) {
      return false;
    }
    const pressedDigit = /^\d$/.test(event.key)
      ? event.key
      : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    return pressedDigit === digit;
  }

  return false;
}

function isEditableElement(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    Boolean(el.isContentEditable)
  );
}

export function useHotkeys(
  bindings: HotkeyBinding[] | Record<string, HotkeyHandler>,
  enabled = true,
): void {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const current = bindingsRef.current;
      const list: HotkeyBinding[] = Array.isArray(current)
        ? current
        : Object.entries(current).map(([hotkey, handler]) => ({ hotkey, handler }));

      const inEditable = isEditableElement(event.target);
      const hasModifier = event.ctrlKey || event.altKey || event.shiftKey;

      for (const item of list) {
        if (item.enabled === false || !item.hotkey) continue;
        if (!matchesEvent(event, item.hotkey)) continue;

        const isFunctionKey = /^F([1-9]|1[0-2])$/i.test(item.hotkey.trim());
        if (inEditable && !item.allowInEditable && !hasModifier && !isFunctionKey) {
          continue;
        }

        item.handler(event);
        break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

export function useCtrlHotkey(
  keyOrHotkey: string,
  handler: HotkeyHandler,
  enabled = true,
): void {
  const normalizedHotkey = /^ctrl\+/i.test(keyOrHotkey.trim())
    ? keyOrHotkey.trim()
    : `Ctrl+${keyOrHotkey.trim()}`;

  useHotkeys([{ hotkey: normalizedHotkey, handler, enabled, allowInEditable: true }], enabled);
}
