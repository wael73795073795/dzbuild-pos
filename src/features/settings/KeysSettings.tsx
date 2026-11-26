import { Keyboard, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HostOnlyNote } from "@/features/network/HostOnlyNote";
import { useTillLink } from "@/lib/ipc/lan";
import { useSetTillKeyMap, useTillKeyMap } from "@/lib/ipc/privacy";
import { DEFAULT_KEYS, hotkeyOf, type TillAction } from "@/lib/key-map";
import { useErrorText } from "@/lib/use-error-text";
import { cn } from "@/lib/utils";

type KeyMap = Record<TillAction, string>;

export interface CustomShortcutEntry {
  id: string;
  label: string;
  target: string;
  key: string;
}

const CUSTOM_SHORTCUTS_STORAGE_KEY = "dzpos.custom.shortcuts.v1";

const COMMON_PAGE_TARGETS: Array<{ label: string; route: string }> = [
  { label: "شاشة البيع (POS)", route: "/pos" },
  { label: "إعدادات البرنامج", route: "/settings" },
  { label: "المنتجات والأصناف", route: "/catalog/products" },
  { label: "التصنيفات", route: "/catalog/categories" },
  { label: "سجل المبيعات", route: "/sales" },
  { label: "العملاء", route: "/customers" },
  { label: "الموردون", route: "/suppliers" },
  { label: "المخزون والجرد", route: "/inventory" },
  { label: "التقارير", route: "/reports" },
];

const ACTIONS = Object.keys(DEFAULT_KEYS) as TillAction[];

function isAction(value: string): value is TillAction {
  return value in DEFAULT_KEYS;
}

function loadCustomShortcuts(): CustomShortcutEntry[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SHORTCUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CustomShortcutEntry =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as CustomShortcutEntry).id === "string" &&
        typeof (item as CustomShortcutEntry).label === "string" &&
        typeof (item as CustomShortcutEntry).target === "string" &&
        typeof (item as CustomShortcutEntry).key === "string",
    );
  } catch {
    return [];
  }
}

function saveCustomShortcuts(items: CustomShortcutEntry[]): void {
  try {
    window.localStorage.setItem(CUSTOM_SHORTCUTS_STORAGE_KEY, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent("dzpos:custom-shortcuts-updated", { detail: items }));
  } catch {
    // ignore storage errors
  }
}

export function KeysSettings() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const stored = useTillKeyMap();
  const save = useSetTillKeyMap();
  const till = useTillLink();

  const [draft, setDraft] = useState<Partial<KeyMap>>({});
  const [capturing, setCapturing] = useState<TillAction | null>(null);
  const [capturingCustomId, setCapturingCustomId] = useState<string | null>(null);
  const [capturingNewKey, setCapturingNewKey] = useState(false);
  const [taken, setTaken] = useState<{ key: string; name: string } | null>(null);

  const [customShortcuts, setCustomShortcuts] = useState<CustomShortcutEntry[]>(() =>
    loadCustomShortcuts(),
  );
  const [newLabel, setNewLabel] = useState("");
  const [newTarget, setNewTarget] = useState("/settings");
  const [newKey, setNewKey] = useState<string>("F9");

  const current = useMemo(() => {
    const map: KeyMap = { ...DEFAULT_KEYS };
    for (const [action, key] of stored.data ?? []) {
      if (isAction(action)) map[action] = key;
    }
    return map;
  }, [stored.data]);

  const keys = useMemo<KeyMap>(() => ({ ...current, ...draft }), [current, draft]);
  const label = (key: string) => (key === "Escape" ? t("common:keys.escape") : key);
  const actionName = (action: TillAction) => t(`config:keys.actions.${action}`);

  const findKeyConflict = (
    candidateKey: string,
    ignoreBuiltIn?: TillAction,
    ignoreCustomId?: string,
  ): string | null => {
    const builtInConflict = ACTIONS.find(
      (a) => a !== ignoreBuiltIn && keys[a] === candidateKey,
    );
    if (builtInConflict) return actionName(builtInConflict);

    const customConflict = customShortcuts.find(
      (c) => c.id !== ignoreCustomId && c.key === candidateKey,
    );
    if (customConflict) return customConflict.label || customConflict.target;

    return null;
  };

  useEffect(() => {
    const isCapturingAny =
      capturing !== null || capturingCustomId !== null || capturingNewKey;
    if (!isCapturingAny) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const key = hotkeyOf(event);
      if (key === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      if (capturing !== null) {
        const conflictName = findKeyConflict(key, capturing, undefined);
        if (conflictName) {
          setTaken({ key, name: conflictName });
          return;
        }
        setTaken(null);
        setDraft((previous) => ({ ...previous, [capturing]: key }));
        setCapturing(null);
        return;
      }

      if (capturingCustomId !== null) {
        const conflictName = findKeyConflict(key, undefined, capturingCustomId);
        if (conflictName) {
          setTaken({ key, name: conflictName });
          return;
        }
        setTaken(null);
        setCustomShortcuts((prev) => {
          const next = prev.map((item) =>
            item.id === capturingCustomId ? { ...item, key } : item,
          );
          saveCustomShortcuts(next);
          return next;
        });
        setCapturingCustomId(null);
        return;
      }

      if (capturingNewKey) {
        const conflictName = findKeyConflict(key, undefined, undefined);
        if (conflictName) {
          setTaken({ key, name: conflictName });
          return;
        }
        setTaken(null);
        setNewKey(key);
        setCapturingNewKey(false);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, capturingCustomId, capturingNewKey, customShortcuts, keys]);

  const changed = ACTIONS.some((a) => keys[a] !== current[a]);
  const anyCapturing = capturing !== null || capturingCustomId !== null || capturingNewKey;

  const send = (map: Record<string, string>, done: string) =>
    save.mutate(map, {
      onSuccess: () => {
        setDraft({});
        setCapturing(null);
        setCapturingCustomId(null);
        setCapturingNewKey(false);
        setTaken(null);
        toast.success(done);
      },
    });

  const handleAddCustomShortcut = () => {
    const trimmedTarget = newTarget.trim();
    const trimmedLabel = newLabel.trim() || trimmedTarget;
    if (!trimmedTarget) {
      toast.error("أدخل مسار الصفحة أو اسم الإجراء");
      return;
    }
    if (!newKey.trim()) {
      toast.error("حدد مفتاح الاختصار أولاً");
      return;
    }
    const conflictName = findKeyConflict(newKey.trim(), undefined, undefined);
    if (conflictName) {
      setTaken({ key: newKey.trim(), name: conflictName });
      return;
    }

    const entry: CustomShortcutEntry = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: trimmedLabel,
      target: trimmedTarget,
      key: newKey.trim(),
    };
    const next = [...customShortcuts, entry];
    setCustomShortcuts(next);
    saveCustomShortcuts(next);
    setNewLabel("");
    setTaken(null);
    toast.success("تمت إضافة الاختصار المخصص");
  };

  const handleDeleteCustomShortcut = (id: string) => {
    const next = customShortcuts.filter((item) => item.id !== id);
    setCustomShortcuts(next);
    saveCustomShortcuts(next);
    if (capturingCustomId === id) setCapturingCustomId(null);
    toast.success("تم حذف الاختصار المخصص");
  };

  return (
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

      {/* Custom shortcut builder for any page or feature */}
      <div className="rounded-xl border border-line bg-surface-2/60 p-3.5">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-ink">إضافة اختصار جديد لأي صفحة أو ميزة</h3>
          <div className="flex flex-wrap gap-1.5">
            {COMMON_PAGE_TARGETS.slice(0, 5).map((preset) => (
              <button
                key={preset.route}
                type="button"
                onClick={() => {
                  setNewTarget(preset.route);
                  if (!newLabel.trim()) setNewLabel(preset.label);
                }}
                className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-2 transition-colors hover:border-brand hover:text-ink"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-12">
          <label className="flex flex-col gap-1 text-xs font-semibold sm:col-span-4">
            <span>اسم الاختصار / الميزة</span>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="مثال: فتح الإعدادات"
              className="h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold sm:col-span-4">
            <span>مسار الصفحة أو الإجراء</span>
            <input
              type="text"
              dir="ltr"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              placeholder="/settings"
              className="h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <div className="flex flex-col gap-1 text-xs font-semibold sm:col-span-2">
            <span>المفتاح</span>
            {capturingNewKey ? (
              <Button
                type="button"
                variant="outline"
                className="h-10"
                onClick={() => setCapturingNewKey(false)}
              >
                {t("config:keys.press")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                className="h-10 justify-between px-3"
                onClick={() => {
                  setTaken(null);
                  setCapturing(null);
                  setCapturingCustomId(null);
                  setCapturingNewKey(true);
                }}
              >
                <kbd dir="ltr" className="font-semibold tabular-nums">
                  {label(newKey)}
                </kbd>
                <Keyboard aria-hidden className="size-3.5" />
              </Button>
            )}
          </div>

          <div className="flex items-end sm:col-span-2">
            <Button
              type="button"
              variant="primary"
              className="h-10 w-full"
              onClick={handleAddCustomShortcut}
            >
              <Plus aria-hidden className="size-4" />
              إضافة
            </Button>
          </div>
        </div>
      </div>

      <table className="w-full border-collapse">
        <thead className="text-sm text-ink-2">
          <tr className="h-10">
            <th scope="col" className="text-start font-semibold">
              {t("config:keys.action")}
            </th>
            <th scope="col" className="text-start font-semibold">
              {t("config:keys.key")}
            </th>
            <th scope="col">
              <span className="sr-only">{t("config:keys.change")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ACTIONS.map((action) => (
            <tr
              key={action}
              className={cn(
                "h-12 border-t border-line",
                capturing === action ? "bg-brand-soft" : "even:bg-surface-2",
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
                    {label(keys[action])}
                  </kbd>
                )}
              </td>
              <td className="text-end">
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
                      setCapturingNewKey(false);
                      setCapturing(action);
                    }}
                  >
                    <Keyboard aria-hidden />
                    {t("config:keys.change")}
                  </Button>
                )}
              </td>
            </tr>
          ))}

          {customShortcuts.map((item) => (
            <tr
              key={item.id}
              className={cn(
                "h-12 border-t border-line",
                capturingCustomId === item.id ? "bg-brand-soft" : "even:bg-surface-2",
              )}
            >
              <th scope="row" className="text-start font-semibold">
                <div className="flex flex-col">
                  <span>{item.label}</span>
                  <span className="text-xs font-normal text-ink-2" dir="ltr">
                    {item.target}
                  </span>
                </div>
              </th>
              <td>
                {capturingCustomId === item.id ? (
                  <span role="status" className="text-ink-2">
                    {t("config:keys.press")}
                  </span>
                ) : (
                  <kbd
                    dir="ltr"
                    className="rounded-sm border border-brand bg-surface px-2 py-1 font-semibold tabular-nums"
                  >
                    {label(item.key)}
                  </kbd>
                )}
              </td>
              <td className="text-end">
                <div className="inline-flex items-center justify-end gap-1.5">
                  {capturingCustomId === item.id ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setCapturingCustomId(null);
                        setTaken(null);
                      }}
                    >
                      {t("common:actions.cancel")}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setTaken(null);
                        setCapturing(null);
                        setCapturingNewKey(false);
                        setCapturingCustomId(item.id);
                      }}
                    >
                      <Keyboard aria-hidden />
                      {t("config:keys.change")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
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

      {taken ? (
        <p role="alert" className="rounded-control bg-danger-soft p-3 text-danger">
          {t("config:keys.taken", { key: label(taken.key), action: taken.name })}
        </p>
      ) : null}

      {save.error ? (
        <p role="alert" className="text-danger">
          {errorText(save.error)}
        </p>
      ) : null}

      {till.isTill ? null : (
        <div className="flex flex-wrap justify-end gap-2">
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
  );
}
