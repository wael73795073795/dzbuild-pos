import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTillKeyMap } from "@/lib/ipc/privacy";
import type { Hotkey } from "./hotkeys";

export const CUSTOM_KEY_MAP_STORAGE_KEY = "dzpos.key_map.custom.v1";
export const CUSTOM_KEY_MAP_EVENT = "dzpos:key-map-updated";

/**
 * Till actions, screens, and quick buttons with default shortcuts.
 * Custom assignments persist locally in `localStorage` and can also layer over `till.key_map`.
 */
export const DEFAULT_KEYS = {
  help: "F1",
  search: "F2",
  customer: "F3",
  price_check: "F4",
  discount: "F5",
  hold: "F6",
  held: "F7",
  return: "F8",
  drawer: "F9",
  repeat_last: "F10",
  checkout: "F12",
  menu: "Escape",
  floor: "Ctrl+1",
  flexy: "Ctrl+2",
  gift_voucher: "Ctrl+3",
  serial: "Ctrl+4",
  department_keys: "Ctrl+5",
  quick_price: "Ctrl+6",
  quick_weight: "Ctrl+7",
  calculator: "Ctrl+8",
  toggle_rail: "Ctrl+9",
  screen_pos: "Alt+1",
  screen_products: "Alt+2",
  screen_sales: "Alt+3",
  screen_customers: "Alt+4",
  screen_stock: "Alt+5",
  screen_settings: "Alt+6",
} as const satisfies Record<string, string>;

export type TillAction = keyof typeof DEFAULT_KEYS;

/** Validates a shortcut string (F1–F12, Escape, Ctrl+0..9, Alt+0..9). */
export function isTillKey(key: string): key is Hotkey {
  return /^(F([1-9]|1[0-2])|Escape|(Ctrl|Alt)\+[0-9])$/.test(key);
}

export function readCustomKeyMap(): Partial<Record<TillAction, Hotkey>> {
  try {
    const raw = globalThis.localStorage?.getItem(CUSTOM_KEY_MAP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<TillAction, Hotkey>> = {};
    for (const [action, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (action in DEFAULT_KEYS && typeof key === "string" && isTillKey(key)) {
        out[action as TillAction] = key;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeCustomKeyMap(nextMap: Record<TillAction, Hotkey>): void {
  try {
    const overrides: Partial<Record<TillAction, Hotkey>> = {};
    for (const action of Object.keys(DEFAULT_KEYS) as TillAction[]) {
      const val = nextMap[action];
      if (val && isTillKey(val) && val !== DEFAULT_KEYS[action]) {
        overrides[action] = val;
      }
    }
    globalThis.localStorage?.setItem(CUSTOM_KEY_MAP_STORAGE_KEY, JSON.stringify(overrides));
    globalThis.dispatchEvent(new CustomEvent(CUSTOM_KEY_MAP_EVENT, { detail: overrides }));
  } catch {
    // ignore storage errors
  }
}

/** The active keys: defaults overridden by backend `till.key_map` and local custom overrides. */
export function useKeyMap(): Record<TillAction, Hotkey> {
  const { data } = useTillKeyMap();
  const [customOverrides, setCustomOverrides] = useState<Partial<Record<TillAction, Hotkey>>>(() =>
    readCustomKeyMap(),
  );

  useEffect(() => {
    const sync = () => setCustomOverrides(readCustomKeyMap());
    window.addEventListener(CUSTOM_KEY_MAP_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CUSTOM_KEY_MAP_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return useMemo(() => {
    const map: Record<TillAction, Hotkey> = { ...DEFAULT_KEYS };
    for (const [action, key] of data ?? []) {
      if (action in map && isTillKey(key)) map[action as TillAction] = key;
    }
    for (const [action, key] of Object.entries(customOverrides)) {
      if (action in map && key && isTillKey(key)) {
        map[action as TillAction] = key;
      }
    }
    return map;
  }, [customOverrides, data]);
}

/** `aria-keyshortcuts` of a key: "F12", "Escape", "Control+5", "Alt+2". */
export function ariaKey(key: Hotkey): string {
  if (key.startsWith("Ctrl+")) return `Control+${key.slice(5)}`;
  return key;
}

/** The keycap of a key in the UI language. */
export function keyLabel(key: Hotkey, t: TFunction): string {
  if (key.startsWith("Ctrl+")) {
    return t("common:keys.ctrlDigit", { digit: key.slice(5), defaultValue: `Ctrl+${key.slice(5)}` });
  }
  if (key.startsWith("Alt+")) {
    return `Alt+${key.slice(4)}`;
  }
  return t(`common:keys.${key.toLowerCase()}`, { defaultValue: key });
}

/** Captures a shortcut from a KeyboardEvent: F1–F12, Escape, Ctrl+0..9, or Alt+0..9. */
export function hotkeyOf(event: KeyboardEvent): Hotkey | null {
  if (event.metaKey) return null;
  if (event.ctrlKey && event.altKey) return null;
  if (event.shiftKey) return null;

  if (event.ctrlKey) {
    const digit = /^\d$/.test(event.key) ? event.key : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    const candidate = digit === undefined ? null : `Ctrl+${digit}`;
    return candidate && isTillKey(candidate) ? candidate : null;
  }

  if (event.altKey) {
    const digit = /^\d$/.test(event.key) ? event.key : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    const candidate = digit === undefined ? null : `Alt+${digit}`;
    return candidate && isTillKey(candidate) ? candidate : null;
  }

  if (event.key === "Escape") return "Escape";
  if (/^F([1-9]|1[0-2])$/.test(event.key) && isTillKey(event.key)) {
    return event.key as Hotkey;
  }
  return null;
}
