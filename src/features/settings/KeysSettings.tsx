import {
  Check,
  Crosshair,
  Keyboard,
  Move,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  Trash2,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HostOnlyNote } from "@/features/network/HostOnlyNote";
import { type Hotkey, formatShortcutFromEvent } from "@/lib/hotkeys";
import { useTillLink } from "@/lib/ipc/lan";
import { useSetTillKeyMap, useTillKeyMap } from "@/lib/ipc/privacy";
import {
  DEFAULT_KEYS,
  type TillAction,
  hotkeyOf,
  isTillKey,
  readCustomKeyMap,
  readDisabledKeys,
  writeCustomKeyMap,
  writeDisabledKeys,
} from "@/lib/key-map";
import { useErrorText } from "@/lib/use-error-text";
import { cn } from "@/lib/utils";

type KeyMap = Record<TillAction, Hotkey>;

export interface CustomShortcutEntry {
  id: string;
  label: string;
  target: string;
  targetKind: "element" | "page" | "action";
  key: Hotkey;
  enabled: boolean;
}

interface PickedTargetInfo {
  label: string;
  target: string;
  targetKind: "element" | "page" | "action";
}

const CUSTOM_SHORTCUTS_STORAGE_KEY = "dzpos.custom.shortcuts.v1";
const CUSTOM_SHORTCUTS_EVENT = "dzpos:custom-shortcuts-updated";
const PICKER_ACTIVE_STORAGE_KEY = "dzpos.picker.active.v1";
const PICKER_PAUSED_STORAGE_KEY = "dzpos.picker.paused.v1";
const PICKER_STATE_EVENT = "dzpos:picker-state-updated";

const ACTIONS = Object.keys(DEFAULT_KEYS) as TillAction[];

function isAction(value: string): value is TillAction {
  return value in DEFAULT_KEYS;
}

function isValidShortcut(value: string): value is Hotkey {
  return typeof value === "string" && value.trim().length > 0;
}

function readPickerState(): { open: boolean; paused: boolean } {
  try {
    return {
      open: window.localStorage.getItem(PICKER_ACTIVE_STORAGE_KEY) === "1",
      paused: window.localStorage.getItem(PICKER_PAUSED_STORAGE_KEY) === "1",
    };
  } catch {
    return { open: false, paused: false };
  }
}

function writePickerState(next: { open?: boolean; paused?: boolean }): void {
  try {
    const current = readPickerState();
    const open = next.open ?? current.open;
    const paused = next.paused ?? current.paused;
    window.localStorage.setItem(PICKER_ACTIVE_STORAGE_KEY, open ? "1" : "0");
    window.localStorage.setItem(PICKER_PAUSED_STORAGE_KEY, paused ? "1" : "0");
    window.dispatchEvent(new CustomEvent(PICKER_STATE_EVENT, { detail: { open, paused } }));
  } catch {
    // تجاهل أخطاء التخزين المحلي
  }
}

function loadCustomShortcuts(): CustomShortcutEntry[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SHORTCUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (
          item,
        ): item is {
          id: string;
          label: string;
          target: string;
          targetKind?: unknown;
          key: string;
          enabled?: unknown;
        } =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string" &&
          typeof (item as { label?: unknown }).label === "string" &&
          typeof (item as { target?: unknown }).target === "string" &&
          typeof (item as { key?: unknown }).key === "string",
      )
      .map((item) => ({
        id: item.id,
        label: item.label,
        target: item.target,
        targetKind:
          item.targetKind === "page" || item.targetKind === "action" ? item.targetKind : "element",
        key: isValidShortcut(item.key) ? item.key.trim() : "F9",
        enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      }));
  } catch {
    return [];
  }
}

function saveCustomShortcuts(items: CustomShortcutEntry[]): void {
  try {
    window.localStorage.setItem(CUSTOM_SHORTCUTS_STORAGE_KEY, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent(CUSTOM_SHORTCUTS_EVENT, { detail: items }));
  } catch {
    // تجاهل أخطاء التخزين المحلي
  }
}

function describeElementTarget(el: HTMLElement): PickedTargetInfo {
  const explicitTarget =
    el.getAttribute("data-shortcut-target") ||
    el.getAttribute("data-testid") ||
    el.id ||
    "";
  const ariaLabel = el.getAttribute("aria-label")?.trim() || "";
  const titleAttr = el.getAttribute("title")?.trim() || "";
  const innerText = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const humanLabel =
    ariaLabel ||
    (innerText.length > 0 && innerText.length <= 60 ? innerText : "") ||
    titleAttr ||
    explicitTarget ||
    `عنصر <${el.tagName.toLowerCase()}>`;

  const selectorParts: string[] = [];
  let current: HTMLElement | null = el;
  let depth = 0;
  while (current && depth < 4 && current.tagName.toLowerCase() !== "body") {
    const tag = current.tagName.toLowerCase();
    if (current.id) {
      selectorParts.unshift(`#${current.id}`);
      break;
    }
    const cls = Array.from(current.classList)
      .filter((c) => !c.startsWith("hover:") && !c.startsWith("focus:"))
      .slice(0, 2);
    selectorParts.unshift(cls.length > 0 ? `${tag}.${cls.join(".")}` : tag);
    current = current.parentElement;
    depth += 1;
  }

  const target = explicitTarget || selectorParts.join(" > ") || humanLabel;
  return {
    label: humanLabel,
    target,
    targetKind: "element",
  };
}

export function ElementPagePickerOverlay({
  open,
  paused,
  onTogglePause,
  onClose,
  onPick,
}: {
  open: boolean;
  paused: boolean;
  onTogglePause: () => void;
  onClose: () => void;
  onPick: (picked: PickedTargetInfo) => void;
}) {
  const [hoverRect, setHoverRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    label: string;
  } | null>(null);

  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [draggingBar, setDraggingBar] = useState(false);

  const startBarDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      setDraggingBar(true);
      const startX = event.clientX;
      const startY = event.clientY;
      const baseX = offset.x;
      const baseY = offset.y;

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        const maxX = Math.max(400, window.innerWidth);
        const maxY = Math.max(300, window.innerHeight);
        setOffset({
          x: Math.max(-maxX, Math.min(maxX, baseX + dx)),
          y: Math.max(-maxY, Math.min(maxY, baseY + dy)),
        });
      };

      const onUp = () => {
        setDraggingBar(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [offset.x, offset.y],
  );

  const pickCurrentPage = useCallback(() => {
    const path = window.location.pathname || "/";
    const title = document.title?.trim() || `صفحة ${path}`;
    onPick({
      label: title,
      target: path,
      targetKind: "page",
    });
  }, [onPick]);

  useEffect(() => {
    if (!open || paused) {
      setHoverRect(null);
      return;
    }

    const isPickerUi = (node: EventTarget | null): boolean => {
      if (!(node instanceof HTMLElement)) return false;
      return Boolean(node.closest("[data-picker-overlay='true']"));
    };

    const onMouseMove = (event: MouseEvent) => {
      if (isPickerUi(event.target)) {
        setHoverRect(null);
        return;
      }
      const targetEl = event.target as HTMLElement | null;
      if (!targetEl) return;
      const interactive =
        (targetEl.closest(
          "button, a, [role='button'], [role='tab'], [role='menuitem'], input, select, textarea, [data-shortcut-target]",
        ) as HTMLElement | null) ?? targetEl;
      const rect = interactive.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const info = describeElementTarget(interactive);
      setHoverRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        label: info.label,
      });
    };

    const onClickCapture = (event: MouseEvent) => {
      if (isPickerUi(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const targetEl = event.target as HTMLElement | null;
      if (!targetEl) return;
      const interactive =
        (targetEl.closest(
          "button, a, [role='button'], [role='tab'], [role='menuitem'], input, select, textarea, [data-shortcut-target]",
        ) as HTMLElement | null) ?? targetEl;
      onPick(describeElementTarget(interactive));
    };

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("click", onClickCapture, true);
    };
  }, [onPick, open, paused]);

  if (!open) return null;

  return (
    <div data-picker-overlay="true" className="fixed inset-0 z-50 pointer-events-none">
      {!paused && hoverRect ? (
        <div
          style={{
            top: `${hoverRect.top}px`,
            left: `${hoverRect.left}px`,
            width: `${hoverRect.width}px`,
            height: `${hoverRect.height}px`,
          }}
          className="fixed z-50 rounded-md border-2 border-brand bg-brand/15 transition-all duration-75"
        >
          <span className="absolute -top-7 start-0 max-w-xs truncate rounded bg-ink px-2 py-0.5 text-xs font-bold text-surface shadow">
            {hoverRect.label}
          </span>
        </div>
      ) : null}

      <div
        onPointerDown={startBarDrag}
        style={{
          transform:
            offset.x !== 0 || offset.y !== 0
              ? `translate3d(${offset.x}px, ${offset.y}px, 0)`
              : undefined,
        }}
        className={cn(
          "pointer-events-auto fixed bottom-5 inset-x-0 z-50 mx-auto flex w-fit max-w-[95vw] flex-wrap items-center justify-center gap-2.5 rounded-2xl border border-line bg-surface px-4 py-3 text-ink shadow-2xl select-none",
          draggingBar ? "cursor-grabbing ring-2 ring-brand" : "cursor-grab",
        )}
      >
        <div className="flex items-center gap-2 text-sm font-bold">
          <Move aria-hidden className="size-4 text-ink-2" />
          <Crosshair
            aria-hidden
            className={cn("size-4", paused ? "text-amber-500" : "text-brand animate-pulse")}
          />
          <span>
            {paused
              ? "الملقاط في وضع إيقاف مؤقت: تنقل أو انزل تحت براحتك ثم اضغط تشغيل للالتقاط"
              : "الملقاط يعمل الآن: اضغط على العنصر المطلوب أو التقط الصفحة الحالية"}
          </span>
        </div>

        <Button
          type="button"
          variant={paused ? "primary" : "secondary"}
          size="md"
          onClick={onTogglePause}
        >
          {paused ? (
            <>
              <Play aria-hidden className="size-4" />
              تشغيل الالتقاط
            </>
          ) : (
            <>
              <Pause aria-hidden className="size-4" />
              إيقاف مؤقت
            </>
          )}
        </Button>

        <Button type="button" variant="primary" size="md" onClick={pickCurrentPage}>
          التقاط الصفحة الحالية
        </Button>

        <Button type="button" variant="outline" size="md" onClick={onClose}>
          <X aria-hidden className="size-4" />
          إغلاق
        </Button>
      </div>
    </div>
  );
}

export function KeysSettings() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const stored = useTillKeyMap();
  const save = useSetTillKeyMap();
  const till = useTillLink();

  const [draft, setDraft] = useState<Partial<KeyMap>>({});
  const [disabledActions, setDisabledActions] = useState<Partial<Record<TillAction, boolean>>>(() =>
    readDisabledKeys(),
  );
  const [capturing, setCapturing] = useState<TillAction | null>(null);
  const [capturingCustomId, setCapturingCustomId] = useState<string | null>(null);
  const [capturingComposerKey, setCapturingComposerKey] = useState(false);
  const [taken, setTaken] = useState<{ key: string; name: string } | null>(null);

  const [pickerState, setPickerState] = useState<{ open: boolean; paused: boolean }>(() =>
    readPickerState(),
  );
  const [customShortcuts, setCustomShortcuts] = useState<CustomShortcutEntry[]>(() =>
    loadCustomShortcuts(),
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [targetKind, setTargetKind] = useState<"element" | "page" | "action">("element");
  const [shortcutInput, setShortcutInput] = useState<string>("Alt+S");

  const updatePicker = useCallback((next: { open?: boolean; paused?: boolean }) => {
    writePickerState(next);
    setPickerState(readPickerState());
  }, []);

  useEffect(() => {
    const syncPicker = () => setPickerState(readPickerState());
    window.addEventListener(PICKER_STATE_EVENT, syncPicker);
    window.addEventListener("storage", syncPicker);
    return () => {
      window.removeEventListener(PICKER_STATE_EVENT, syncPicker);
      window.removeEventListener("storage", syncPicker);
    };
  }, []);

  const current = useMemo(() => {
    const map: KeyMap = { ...DEFAULT_KEYS };
    for (const [action, key] of stored.data ?? []) {
      if (isAction(action) && isTillKey(key)) map[action] = key.trim();
    }
    const localCustom = readCustomKeyMap();
    for (const [action, key] of Object.entries(localCustom)) {
      if (isAction(action) && key && isTillKey(key)) map[action] = key.trim();
    }
    return map;
  }, [stored.data]);

  const keys = useMemo<KeyMap>(() => ({ ...current, ...draft }), [current, draft]);
  const labelOfKey = (key: string) =>
    !key ? "متوقف" : key === "Escape" ? t("common:keys.escape") : key;
  const actionName = (action: TillAction) =>
    t(`config:keys.actions.${action}`, { defaultValue: action });

  const findKeyConflict = (
    candidateKey: string,
    ignoreBuiltIn?: TillAction,
    ignoreCustomId?: string,
  ): string | null => {
    const normalized = candidateKey.trim().toLowerCase();
    if (!normalized) return null;
    const builtInConflict = ACTIONS.find(
      (a) =>
        a !== ignoreBuiltIn &&
        !disabledActions[a] &&
        keys[a].trim().toLowerCase() === normalized,
    );
    if (builtInConflict) return actionName(builtInConflict);

    const customConflict = customShortcuts.find(
      (c) => c.id !== ignoreCustomId && c.enabled && c.key.trim().toLowerCase() === normalized,
    );
    if (customConflict) return customConflict.label || customConflict.target;

    return null;
  };

  useEffect(() => {
    const isCapturingAny =
      capturing !== null || capturingCustomId !== null || capturingComposerKey;
    if (!isCapturingAny) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (capturing !== null) {
        const key = hotkeyOf(event);
        if (key === null) return;
        event.preventDefault();
        event.stopImmediatePropagation();

        const conflictName = findKeyConflict(key, capturing, undefined);
        if (conflictName) {
          setTaken({ key, name: conflictName });
          return;
        }
        setTaken(null);
        setDraft((previous) => {
          const updated = { ...previous, [capturing]: key };
          writeCustomKeyMap({ ...current, ...updated });
          return updated;
        });
        setCapturing(null);
        return;
      }

      const captured = formatShortcutFromEvent(event);
      if (!captured) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      if (capturingCustomId !== null) {
        const conflictName = findKeyConflict(captured, undefined, capturingCustomId);
        if (conflictName) {
          setTaken({ key: captured, name: conflictName });
          return;
        }
        setTaken(null);
        setCustomShortcuts((prev) => {
          const next = prev.map((item) =>
            item.id === capturingCustomId ? { ...item, key: captured } : item,
          );
          saveCustomShortcuts(next);
          return next;
        });
        setCapturingCustomId(null);
        return;
      }

      if (capturingComposerKey) {
        const conflictName = findKeyConflict(captured, undefined, editingId ?? undefined);
        if (conflictName) {
          setTaken({ key: captured, name: conflictName });
          return;
        }
        setTaken(null);
        setShortcutInput(captured);
        setCapturingComposerKey(false);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    capturing,
    capturingComposerKey,
    capturingCustomId,
    current,
    customShortcuts,
    disabledActions,
    editingId,
    keys,
  ]);

  const changed = ACTIONS.some((a) => keys[a] !== current[a]);
  const anyCapturing =
    capturing !== null || capturingCustomId !== null || capturingComposerKey;

  const toggleBuiltInAction = (action: TillAction) => {
    setDisabledActions((prev) => {
      const next = { ...prev, [action]: !prev[action] };
      writeDisabledKeys(next);
      toast.success(next[action] ? "تم إيقاف الاختصار مؤقتاً" : "تم تفعيل الاختصار");
      return next;
    });
  };

  const send = (map: Record<string, string>, done: string) =>
    save.mutate(map, {
      onSuccess: () => {
        if (Object.keys(map).length === 0) {
          writeCustomKeyMap({ ...DEFAULT_KEYS });
          setDisabledActions({});
          writeDisabledKeys({});
        } else {
          writeCustomKeyMap(keys);
        }
        setDraft({});
        setCapturing(null);
        setCapturingCustomId(null);
        setCapturingComposerKey(false);
        setTaken(null);
        toast.success(done);
      },
    });

  const handlePickedTarget = useCallback(
    (picked: PickedTargetInfo) => {
      updatePicker({ open: false, paused: false });
      setEditingId(null);
      setTargetInput(picked.target);
      setTargetKind(picked.targetKind);
      setLabelInput(picked.label);
      setTaken(null);
      toast.success(`تم التقاط: ${picked.label}`);
    },
    [updatePicker],
  );

  const resetComposer = () => {
    setEditingId(null);
    setLabelInput("");
    setTargetInput("");
    setTargetKind("element");
    setShortcutInput("Alt+S");
    setCapturingComposerKey(false);
    setTaken(null);
  };

  const handleSaveCustomShortcut = () => {
    const cleanTarget = targetInput.trim();
    const cleanKey = shortcutInput.trim();
    if (!cleanTarget) {
      toast.error("التقط عنصراً أو صفحة أو اكتب الهدف أولاً");
      return;
    }
    if (!cleanKey) {
      toast.error("حدد مفتاح أو تركيبة الاختصار أولاً");
      return;
    }
    const conflictName = findKeyConflict(cleanKey, undefined, editingId ?? undefined);
    if (conflictName) {
      setTaken({ key: cleanKey, name: conflictName });
      return;
    }

    const cleanLabel = labelInput.trim() || cleanTarget;

    if (editingId) {
      const next = customShortcuts.map((item) =>
        item.id === editingId
          ? {
              ...item,
              label: cleanLabel,
              target: cleanTarget,
              targetKind,
              key: cleanKey,
            }
          : item,
      );
      setCustomShortcuts(next);
      saveCustomShortcuts(next);
      resetComposer();
      toast.success("تم تحديث الاختصار وتفعيله فوراً");
      return;
    }

    const entry: CustomShortcutEntry = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: cleanLabel,
      target: cleanTarget,
      targetKind,
      key: cleanKey,
      enabled: true,
    };

    const next = [...customShortcuts, entry];
    setCustomShortcuts(next);
    saveCustomShortcuts(next);
    if (isAction(cleanTarget) && isTillKey(cleanKey)) {
      const updated = { ...keys, [cleanTarget]: cleanKey };
      setDraft(updated);
      writeCustomKeyMap(updated);
    }
    resetComposer();
    toast.success("تم حفظ الاختصار وتفعيله فوراً");
  };

  const handleStartEditCustom = (item: CustomShortcutEntry) => {
    setCapturing(null);
    setCapturingCustomId(null);
    setCapturingComposerKey(false);
    setTaken(null);
    setEditingId(item.id);
    setLabelInput(item.label);
    setTargetInput(item.target);
    setTargetKind(item.targetKind);
    setShortcutInput(item.key);
  };

  const handleToggleCustomEnabled = (id: string) => {
    const next = customShortcuts.map((item) =>
      item.id === id ? { ...item, enabled: !item.enabled } : item,
    );
    setCustomShortcuts(next);
    saveCustomShortcuts(next);
    toast.success("تم تحديث حالة الاختصار");
  };

  const handleDeleteCustomShortcut = (id: string) => {
    const next = customShortcuts.filter((item) => item.id !== id);
    setCustomShortcuts(next);
    saveCustomShortcuts(next);
    if (capturingCustomId === id) setCapturingCustomId(null);
    if (editingId === id) resetComposer();
    toast.success("تم حذف الاختصار");
  };

  return (
    <>
      <ElementPagePickerOverlay
        open={pickerState.open}
        paused={pickerState.paused}
        onTogglePause={() => updatePicker({ paused: !pickerState.paused })}
        onClose={() => updatePicker({ open: false, paused: false })}
        onPick={handlePickedTarget}
      />

      <Card aria-labelledby="keys-title">
        <h2 id="keys-title" className="text-xl font-bold">
          {t("config:keys.title")}
        </h2>
        <p className="text-ink-2">{t("config:keys.intro", { escape: t("common:keys.escape") })}</p>
        <HostOnlyNote />

        {stored.error ? (
          <p role="alert" className="text-danger">
            {errorText(stored.error)}
          </p>
        ) : null}

        <table className="w-full border-collapse">
          <thead className="text-sm text-ink-2">
            <tr className="h-10">
              <th scope="col" className="text-start font-semibold">
                {t("config:keys.action")}
              </th>
              <th scope="col" className="text-start font-semibold">
                {t("config:keys.key")}
              </th>
              <th scope="col" className="text-start font-semibold">
                الحالة
              </th>
              <th scope="col">
                <span className="sr-only">{t("config:keys.change")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ACTIONS.map((action) => {
              const isOff = Boolean(disabledActions[action]);
              return (
                <tr
                  key={action}
                  className={cn(
                    "h-12 border-t border-line",
                    capturing === action ? "bg-brand-soft" : "even:bg-surface-2",
                    isOff && "opacity-65",
                  )}
                >
                  <th scope="row" className="text-start font-semibold">
                    {actionName(action)}
                  </th>
                  <td>
                    {capturing === action ? (
                      <span role="status" className="text-ink-2">
                        {t("config:keys.press")}
                      </span>
                    ) : (
                      <kbd
                        dir="ltr"
                        className={cn(
                          "rounded-sm border border-line bg-surface px-2 py-1 font-semibold tabular-nums",
                          keys[action] !== current[action] && "border-brand",
                        )}
                      >
                        {labelOfKey(keys[action])}
                      </kbd>
                    )}
                  </td>
                  <td>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold",
                        isOff ? "bg-danger-soft text-danger" : "bg-emerald-500/15 text-emerald-600",
                      )}
                    >
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          isOff ? "bg-danger" : "bg-emerald-500",
                        )}
                      />
                      {isOff ? "متوقف" : "مفعّل"}
                    </span>
                  </td>
                  <td className="text-end">
                    <div className="inline-flex items-center justify-end gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title={isOff ? "تفعيل الاختصار" : "إيقاف الاختصار"}
                        aria-label={isOff ? "تفعيل الاختصار" : "إيقاف الاختصار"}
                        onClick={() => toggleBuiltInAction(action)}
                      >
                        <Power
                          aria-hidden
                          className={cn("size-4", isOff ? "text-ink-2" : "text-emerald-600")}
                        />
                      </Button>
                      {till.isTill ? null : capturing === action ? (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setCapturing(null);
                            setTaken(null);
                          }}
                        >
                          {t("common:actions.cancel")}
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          aria-label={t("config:keys.changeFor", { action: actionName(action) })}
                          onClick={() => {
                            setTaken(null);
                            setCapturingCustomId(null);
                            setCapturingComposerKey(false);
                            setCapturing(action);
                          }}
                        >
                          <Keyboard aria-hidden />
                          {t("config:keys.change")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-bold text-ink">
                {editingId
                  ? "تعديل اختصار مخصص"
                  : "مُركّب الاختصارات الحر وملقاط العناصر والصفحات"}
              </h3>
              <p className="text-xs text-ink-2">
                افتح الملقاط، ثم أوقفه مؤقتاً أثناء التنقل أو النزول للأسفل، وشغّله وقت الالتقاط ثم أغلقه متى شئت.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={pickerState.open ? "primary" : "secondary"}
                onClick={() => {
                  setTaken(null);
                  setCapturing(null);
                  setCapturingCustomId(null);
                  setCapturingComposerKey(false);
                  if (!pickerState.open) {
                    updatePicker({ open: true, paused: false });
                  } else {
                    updatePicker({ open: false, paused: false });
                  }
                }}
              >
                <Crosshair aria-hidden className="size-4" />
                {pickerState.open ? "إغلاق الملقاط" : "ملقاط عنصر / صفحة"}
              </Button>
              {editingId ? (
                <Button type="button" variant="ghost" size="md" onClick={resetComposer}>
                  إلغاء التعديل
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-12">
            <label className="flex flex-col gap-1 text-xs font-semibold sm:col-span-3">
              <span>اسم الاختصار</span>
              <input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="مثال: فتح شاشة البيع أو زر حفظ"
                className="h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-brand focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold sm:col-span-4">
              <span>العنصر أو الصفحة المستهدفة</span>
              <input
                type="text"
                dir="auto"
                value={targetInput}
                onChange={(e) => {
                  setTargetInput(e.target.value);
                  if (!labelInput.trim()) setLabelInput(e.target.value);
                }}
                placeholder="التقط بالملقاط أو اكتب المسار / اسم العنصر"
                className="h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-brand focus:outline-none"
              />
            </label>

            <div className="flex flex-col gap-1 text-xs font-semibold sm:col-span-3">
              <span>مفتاح أو تركيبة الاختصار</span>
              {capturingComposerKey ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-10"
                  onClick={() => setCapturingComposerKey(false)}
                >
                  {t("config:keys.press")}
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    dir="ltr"
                    value={shortcutInput}
                    onChange={(e) => {
                      setTaken(null);
                      setShortcutInput(e.target.value);
                    }}
                    placeholder="Alt+S"
                    className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-semibold text-ink focus:border-brand focus:outline-none"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="h-10 w-10 shrink-0"
                    title="التقاط ضغطة من لوحة المفاتيح"
                    aria-label="التقاط ضغطة من لوحة المفاتيح"
                    onClick={() => {
                      setTaken(null);
                      setCapturing(null);
                      setCapturingCustomId(null);
                      setCapturingComposerKey(true);
                    }}
                  >
                    <Keyboard aria-hidden className="size-4" />
                  </Button>
                </div>
              )}
            </div>

            <div className="flex items-end sm:col-span-2">
              <Button
                type="button"
                variant="primary"
                className="h-10 w-full"
                onClick={handleSaveCustomShortcut}
              >
                {editingId ? (
                  <>
                    <Check aria-hidden className="size-4" />
                    تحديث وحفظ
                  </>
                ) : (
                  <>
                    <Plus aria-hidden className="size-4" />
                    إضافة وحفظ
                  </>
                )}
              </Button>
            </div>
          </div>

          {customShortcuts.length > 0 ? (
            <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-surface-2 text-xs text-ink-2">
                  <tr className="h-9">
                    <th className="px-3 text-start font-semibold">الاختصار / العنصر</th>
                    <th className="px-3 text-start font-semibold">الهدف</th>
                    <th className="px-3 text-start font-semibold">المفتاح</th>
                    <th className="px-3 text-start font-semibold">الحالة</th>
                    <th className="px-3 text-end font-semibold">تحكم</th>
                  </tr>
                </thead>
                <tbody>
                  {customShortcuts.map((item) => (
                    <tr
                      key={item.id}
                      className={cn(
                        "h-11 border-t border-line",
                        capturingCustomId === item.id && "bg-brand-soft",
                        !item.enabled && "opacity-60",
                      )}
                    >
                      <td className="px-3 font-semibold">{item.label}</td>
                      <td className="px-3 text-xs text-ink-2" dir="ltr">
                        {item.target}
                      </td>
                      <td className="px-3">
                        {capturingCustomId === item.id ? (
                          <span role="status" className="text-xs text-ink-2">
                            {t("config:keys.press")}
                          </span>
                        ) : (
                          <kbd
                            dir="ltr"
                            className="rounded-sm border border-brand bg-surface px-2 py-0.5 text-xs font-bold tabular-nums"
                          >
                            {labelOfKey(item.key)}
                          </kbd>
                        )}
                      </td>
                      <td className="px-3">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold",
                            item.enabled
                              ? "bg-emerald-500/15 text-emerald-600"
                              : "bg-danger-soft text-danger",
                          )}
                        >
                          <span
                            className={cn(
                              "size-2 rounded-full",
                              item.enabled ? "bg-emerald-500" : "bg-danger",
                            )}
                          />
                          {item.enabled ? "مفعّل" : "متوقف"}
                        </span>
                      </td>
                      <td className="px-3 text-end">
                        <div className="inline-flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title={item.enabled ? "تعطيل الاختصار" : "تفعيل الاختصار"}
                            aria-label={item.enabled ? "تعطيل الاختصار" : "تفعيل الاختصار"}
                            onClick={() => handleToggleCustomEnabled(item.id)}
                          >
                            <Power
                              aria-hidden
                              className={cn(
                                "size-4",
                                item.enabled ? "text-emerald-600" : "text-ink-2",
                              )}
                            />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title="تعديل الاختصار"
                            aria-label={`تعديل ${item.label}`}
                            onClick={() => handleStartEditCustom(item)}
                          >
                            <Pencil aria-hidden className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title="تغيير المفتاح مباشرة"
                            aria-label={`تغيير مفتاح ${item.label}`}
                            onClick={() => {
                              setTaken(null);
                              setCapturing(null);
                              setCapturingComposerKey(false);
                              setCapturingCustomId(
                                capturingCustomId === item.id ? null : item.id,
                              );
                            }}
                          >
                            <Keyboard aria-hidden className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title="حذف الاختصار"
                            aria-label={`حذف ${item.label}`}
                            onClick={() => handleDeleteCustomShortcut(item.id)}
                          >
                            <Trash2 aria-hidden className="size-4 text-danger" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        {taken ? (
          <p role="alert" className="mt-3 rounded-control bg-danger-soft p-3 text-danger">
            {t("config:keys.taken", { key: labelOfKey(taken.key), action: taken.name })}
          </p>
        ) : null}

        {save.error ? (
          <p role="alert" className="mt-2 text-danger">
            {errorText(save.error)}
          </p>
        ) : null}

        {till.isTill ? null : (
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={() => send({}, t("config:keys.resetDone"))}
            >
              {t("config:keys.reset")}
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending || !changed || anyCapturing}
              onClick={() =>
                send(
                  Object.fromEntries(
                    ACTIONS.filter((a) => keys[a] !== DEFAULT_KEYS[a]).map((a) => [a, keys[a]]),
                  ),
                  t("config:keys.saved"),
                )
              }
            >
              {t("config:keys.save")}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
