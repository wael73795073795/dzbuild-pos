import { useEffect, useRef, useState } from "react";

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
  | `Ctrl+${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export interface CustomShortcutBinding {
  id: string;
  label: string;
  target: string;
  key: string;
}

const CUSTOM_SHORTCUTS_STORAGE_KEY = "dzpos.custom.shortcuts.v1";

function readCustomShortcuts(): CustomShortcutBinding[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SHORTCUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CustomShortcutBinding =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as CustomShortcutBinding).id === "string" &&
        typeof (item as CustomShortcutBinding).target === "string" &&
        typeof (item as CustomShortcutBinding).key === "string",
    );
  } catch {
    return [];
  }
}

function normalizePressedKey(event: KeyboardEvent): string | null {
  if (event.altKey || event.metaKey) return null;
  const digit =
    /^Digit([0-9])$/.exec(event.code)?.[1] ?? (/^[0-9]$/.test(event.key) ? event.key : null);
  if (event.ctrlKey) {
    if (digit !== null) return `Ctrl+${digit}`;
    const letterMatch = /^Key([A-Z])$/.exec(event.code)?.[1];
    if (letterMatch) return `Ctrl+${letterMatch.toUpperCase()}`;
    if (event.key && event.key.length === 1) return `Ctrl+${event.key.toUpperCase()}`;
    return null;
  }
  if (/^F([1-9]|1[0-2])$/.test(event.key)) return event.key;
  if (event.key === "Escape") return "Escape";
  return event.key || null;
}

function triggerCustomTarget(target: string, onNavigate?: (route: string) => void): void {
  const trimmed = target.trim();
  if (!trimmed) return;
  if (onNavigate) {
    onNavigate(trimmed);
    return;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    window.open(trimmed, "_blank", "noopener,noreferrer");
    return;
  }
  const normalizedHashRoute = trimmed.startsWith("#") ? trimmed : `#${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  if (window.location.hash !== normalizedHashRoute) {
    window.location.hash = normalizedHashRoute;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

/** F-keys, Esc and Ctrl+digit for a screen (UX-017; the packs' till keys are Ctrl+1…Ctrl+9). A
 * dialog, when open, owns the keyboard. The digit is read from the physical key too, so an
 * AZERTY or Arabic layout (where the top row types `&é"'…` without Shift) gives the same key. */
export function useHotkeys(map: Partial<Record<Hotkey, () => void>>, enabled = true): void {
  const current = useRef(map);
  useEffect(() => {
    current.current = map;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const digit = /^Digit([0-9])$/.exec(event.code)?.[1] ?? (/^[0-9]$/.test(event.key) ? event.key : null);
      const key = event.ctrlKey ? (digit === null ? null : `Ctrl+${digit}`) : event.key;
      const action = key === null ? undefined : current.current[key as Hotkey];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** A Ctrl shortcut of a screen (Ctrl+S saves a draft, Ctrl+D loads a quote at the till): read
 * while a field has the focus too, by the physical key so an AZERTY or Arabic layout types it
 * the same. A dialog, when open, owns the keyboard. */
export function useCtrlHotkey(letter: string, action: () => void, enabled = true): void {
  const current = useRef(action);
  useEffect(() => {
    current.current = action;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const code = `Key${letter.toUpperCase()}`;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.code !== code && event.key.toLowerCase() !== letter.toLowerCase()) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      current.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, letter]);
}

/** Runs custom shortcuts saved from `KeysSettings` across the app when no dialog is open. */
export function useCustomShortcuts(
  onNavigate?: (route: string) => void,
  enabled = true,
): CustomShortcutBinding[] {
  const [shortcuts, setShortcuts] = useState<CustomShortcutBinding[]>(() => readCustomShortcuts());
  const navRef = useRef(onNavigate);
  const listRef = useRef(shortcuts);

  useEffect(() => {
    navRef.current = onNavigate;
  });

  useEffect(() => {
    listRef.current = shortcuts;
  }, [shortcuts]);

  useEffect(() => {
    const sync = () => setShortcuts(readCustomShortcuts());
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<CustomShortcutBinding[]>).detail;
      if (Array.isArray(detail)) {
        setShortcuts(detail);
      } else {
        sync();
      }
    };
    window.addEventListener("storage", sync);
    window.addEventListener("dzpos:custom-shortcuts-updated", onCustomEvent);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("dzpos:custom-shortcuts-updated", onCustomEvent);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const target = event.target as HTMLElement | null;
      const isTypingField =
        Boolean(target) &&
        (target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.tagName === "SELECT" ||
          target?.isContentEditable);

      const pressed = normalizePressedKey(event);
      if (!pressed) return;

      const matched = listRef.current.find(
        (item) => item.key.toLowerCase() === pressed.toLowerCase(),
      );
      if (!matched) return;

      // Avoid hijacking single character typing inside inputs unless Ctrl or Function key is used
      const isFunctionKey = /^F([1-9]|1[0-2])$/.test(pressed);
      const isCtrlCombo = pressed.startsWith("Ctrl+");
      if (isTypingField && !isFunctionKey && !isCtrlCombo) return;

      event.preventDefault();
      triggerCustomTarget(matched.target, navRef.current);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);

  return shortcuts;
}
