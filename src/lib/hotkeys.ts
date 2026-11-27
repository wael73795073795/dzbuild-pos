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
