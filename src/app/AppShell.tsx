import { Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router";
import { Splash } from "@/components/splash";
import { HelpHotkey } from "@/features/help/HelpHotkey";
import { LicenseBanner } from "@/features/license/LicenseBanner";
import type { CustomShortcutEntry } from "@/features/settings/KeysSettings";
import { UpdateReadyDialog } from "@/features/updates/UpdateReadyDialog";
import { useTillKeyMap } from "@/lib/ipc/privacy";
import type { Session } from "@/lib/ipc/types";
import { hotkeyOf, isTillKey, readCustomKeyMap, type TillAction } from "@/lib/key-map";
import { BackupAlerts } from "./BackupAlerts";
import { DemoRibbon } from "./DemoRibbon";
import { LanBanner } from "./LanBanner";
import { NavRail } from "./NavRail";
import { MainScroll } from "./ScrollToTop";
import { TopBar } from "./TopBar";

const CUSTOM_SHORTCUTS_STORAGE_KEY = "dzpos.custom.shortcuts.v1";

const ROUTE_ALIASES: Record<string, string> = {
  pos: "/pos",
  sale: "/pos",
  sales: "/sales",
  settings: "/settings",
  products: "/catalog/products",
  categories: "/catalog/categories",
  customers: "/customers",
  suppliers: "/suppliers",
  inventory: "/inventory",
  reports: "/reports",
};

function readCustomShortcutsList(): CustomShortcutEntry[] {
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
        typeof (item as CustomShortcutEntry).key === "string" &&
        isTillKey((item as CustomShortcutEntry).key),
    );
  } catch {
    return [];
  }
}

function resolveRouteTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return trimmed;
  const normalized = trimmed.toLowerCase();
  return ROUTE_ALIASES[normalized] ?? null;
}

function ShellCustomShortcuts() {
  const navigate = useNavigate();
  const { data: tillMap } = useTillKeyMap();
  const [shortcuts, setShortcuts] = useState<CustomShortcutEntry[]>(() => readCustomShortcutsList());
  const [customKeyMap, setCustomKeyMap] = useState<Partial<Record<TillAction, string>>>(() =>
    readCustomKeyMap(),
  );

  useEffect(() => {
    const syncShortcuts = () => setShortcuts(readCustomShortcutsList());
    const syncKeyMap = () => setCustomKeyMap(readCustomKeyMap());
    window.addEventListener("dzpos:custom-shortcuts-updated", syncShortcuts);
    window.addEventListener("dzpos:key-map-updated", syncKeyMap);
    window.addEventListener("storage", syncShortcuts);
    window.addEventListener("storage", syncKeyMap);
    return () => {
      window.removeEventListener("dzpos:custom-shortcuts-updated", syncShortcuts);
      window.removeEventListener("dzpos:key-map-updated", syncKeyMap);
      window.removeEventListener("storage", syncShortcuts);
      window.removeEventListener("storage", syncKeyMap);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const pressedKey = hotkeyOf(event);
      if (!pressedKey) return;

      const target = event.target as HTMLElement | null;
      const inEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      const isFunctionOrEsc =
        event.key === "Escape" || /^F([1-9]|1[0-2])$/.test(event.key) || event.ctrlKey || event.altKey;
      if (inEditable && !isFunctionOrEsc) return;

      const matchedCustom = shortcuts.find((item) => item.key === pressedKey);
      if (matchedCustom) {
        const route = resolveRouteTarget(matchedCustom.target);
        if (route) {
          event.preventDefault();
          void navigate(route);
          return;
        }
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("dzpos:custom-shortcut", {
            detail: { target: matchedCustom.target, label: matchedCustom.label, key: pressedKey },
          }),
        );
        return;
      }

      const mappedAction = (
        Object.entries(customKeyMap) as Array<[TillAction, string | undefined]>
      ).find(([, key]) => key === pressedKey)?.[0];
      const backendAction = (tillMap ?? []).find(([, key]) => key === pressedKey)?.[0];
      const actionName = mappedAction ?? backendAction;
      if (actionName && actionName in ROUTE_ALIASES) {
        const route = ROUTE_ALIASES[actionName];
        if (route) {
          event.preventDefault();
          void navigate(route);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [customKeyMap, navigate, shortcuts, tillMap]);

  return null;
}

export function AppShell({ session }: { session: Session }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-dvh bg-bg text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-surface focus:p-2"
      >
        {t("nav:skipToContent")}
      </a>
      <NavRail session={session} />
      <div className="flex min-w-0 flex-1 flex-col">
        <DemoRibbon />
        <LicenseBanner />
        <TopBar session={session} />
        <BackupAlerts session={session} />
        <LanBanner />
        <UpdateReadyDialog session={session} />
        <HelpHotkey />
        <ShellCustomShortcuts />
        {/* back to the top on every page change, and the floating "back to top" button */}
        <MainScroll />
        {/* focusable (tabIndex -1) for the skip link and the "back to top" button, never in the Tab order */}
        <main
          id="main"
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto pb-[var(--osk-inset,0px)] outline-none"
        >
          <div className="max-w-[1280px] px-6 py-6">
            {/* A back-office screen loads its chunk on first use: the rail and the top bar stay. */}
            <Suspense fallback={<Splash inline />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
