import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTillKeyMap } from "@/lib/ipc/privacy";
import type { Hotkey } from "./hotkeys";

export const CUSTOM_KEY_MAP_STORAGE_KEY = "dzpos.key_map.custom.v1";
export const CUSTOM_KEY_MAP_EVENT = "dzpos:key-map-updated";
export const DISABLED_KEYS_STORAGE_KEY = "dzpos.key_map.disabled.v1";

/**
 * الاختصارات الأساسية لنقطة البيع فقط.
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
} as const satisfies Record<string, string>;

export type TillAction = keyof typeof DEFAULT_KEYS;

/** التحقق من صحة الاختصار الأساسي أو الاختصار الحر. */
export function isTillKey(key: string): key is Hotkey {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  if (!trimmed) return false;
  if (/^(F([1-9]|1[0-2])|Escape|(Ctrl|Alt|Shift)\+[0-9])$/i.test(trimmed)) {
    return true;
  }
  return /^(?:(Ctrl|Alt|Shift)\+)*[A-Za-z0-9]$/.test(trimmed);
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
        out[action as TillAction] = key.trim();
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
      if (val && isTillKey(val) && val.trim() !== DEFAULT_KEYS[action]) {
        overrides[action] = val.trim();
      }
    }
    globalThis.localStorage?.setItem(CUSTOM_KEY_MAP_STORAGE_KEY, JSON.stringify(overrides));
    globalThis.dispatchEvent(new CustomEvent(CUSTOM_KEY_MAP_EVENT, { detail: overrides }));
  } catch {
    // تجاهل أخطاء التخزين المحلي
  }
}

export function readDisabledKeys(): Partial<Record<TillAction, boolean>> {
  try {
    const raw = globalThis.localStorage?.getItem(DISABLED_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<TillAction, boolean>> = {};
    for (const [action, disabled] of Object.entries(parsed as Record<string, unknown>)) {
      if (action in DEFAULT_KEYS && typeof disabled === "boolean") {
        out[action as TillAction] = disabled;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeDisabledKeys(disabledMap: Partial<Record<TillAction, boolean>>): void {
  try {
    globalThis.localStorage?.setItem(DISABLED_KEYS_STORAGE_KEY, JSON.stringify(disabledMap));
    globalThis.dispatchEvent(new CustomEvent(CUSTOM_KEY_MAP_EVENT, { detail: disabledMap }));
  } catch {
    // تجاهل أخطاء التخزين المحلي
  }
}

/** الاختصارات الفعالة الحالية بعد دمج التخصيصات وحالة التفعيل. */
export function useKeyMap(): Record<TillAction, Hotkey> {
  const { data } = useTillKeyMap();
  const [customOverrides, setCustomOverrides] = useState<Partial<Record<TillAction, Hotkey>>>(() =>
    readCustomKeyMap(),
  );
  const [disabledMap, setDisabledMap] = useState<Partial<Record<TillAction, boolean>>>(() =>
    readDisabledKeys(),
  );

  useEffect(() => {
    const sync = () => {
      setCustomOverrides(readCustomKeyMap());
      setDisabledMap(readDisabledKeys());
    };
    window.addEventListener(CUSTOM_KEY_MAP_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CUSTOM_KEY_MAP_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return useMemo(() => {
    const map = { ...DEFAULT_KEYS } as Record<TillAction, Hotkey>;
    for (const [action, key] of data ?? []) {
      if (action in map && isTillKey(key)) map[action as TillAction] = key.trim();
    }
    for (const [action, key] of Object.entries(customOverrides)) {
      if (action in map && key && isTillKey(key)) {
        map[action as TillAction] = key.trim();
      }
    }
    for (const action of Object.keys(DEFAULT_KEYS) as TillAction[]) {
      if (disabledMap[action]) {
        map[action] = "";
      }
    }
    return map;
  }, [customOverrides, data, disabledMap]);
}

/** قيمة `aria-keyshortcuts` للاختصار. */
export function ariaKey(key: Hotkey): string {
  if (!key) return "";
  if (key.startsWith("Ctrl+")) return `Control+${key.slice(5)}`;
  return key;
}

/** عرض اسم المفتاح في الواجهة. */
export function keyLabel(key: Hotkey, t: TFunction): string {
  if (!key) return "متوقف";
  if (key.startsWith("Ctrl+")) {
    return t("common:keys.ctrlDigit", { digit: key.slice(5), defaultValue: key });
  }
  if (key.startsWith("Alt+")) {
    return key;
  }
  return t(`common:keys.${key.toLowerCase()}`, { defaultValue: key });
}

/** التقاط اختصار من لوحة المفاتيح. */
export function hotkeyOf(event: KeyboardEvent): Hotkey | null {
  if (event.metaKey) return null;
  if (event.ctrlKey && event.altKey) return null;
  if (event.shiftKey) return null;

  if (event.ctrlKey) {
    const digit = /^\d$/.test(event.key)
      ? event.key
      : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    const candidate = digit === undefined ? null : `Ctrl+${digit}`;
    return candidate && isTillKey(candidate) ? candidate : null;
  }

  if (event.altKey) {
    const digit = /^\d$/.test(event.key)
      ? event.key
      : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    const candidate = digit === undefined ? null : `Alt+${digit}`;
    return candidate && isTillKey(candidate) ? candidate : null;
  }

  if (event.key === "Escape") return "Escape";
  if (/^F([1-9]|1[0-2])$/.test(event.key) && isTillKey(event.key)) {
    return event.key as Hotkey;
  }
  return null;
}
