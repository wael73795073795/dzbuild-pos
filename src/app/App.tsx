import { QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, useNavigate } from "react-router";
import { Toaster } from "sonner";
import { OnScreenKeyboard } from "@/components/osk/OnScreenKeyboard";
import { Splash } from "@/components/splash";
import { LoginScreen } from "@/features/auth/LoginScreen";
import type { CustomShortcutEntry } from "@/features/settings/KeysSettings";
import { formatShortcutFromEvent } from "@/lib/hotkeys";
import { i18n, loadBackOffice } from "@/lib/i18n";
import { useAppReady, useStartupError } from "@/lib/ipc/app";
import { useSession } from "@/lib/ipc/auth";
import { toAppError } from "@/lib/ipc/client";
import { useApplyDisplay } from "@/lib/ipc/display";
import { useLicenseStatus } from "@/lib/ipc/license";
import { useThemePreference } from "@/lib/ipc/settings";
import { useSetupStatus } from "@/lib/ipc/setup";
import { createQueryClient } from "@/lib/query";
import { applyTheme } from "@/lib/theme";
import { useLang } from "@/lib/use-language";
import { ClosingOverlay } from "./ClosingOverlay";
import { HostCloseGuard } from "./HostCloseGuard";
import { AppRoutes } from "./routes";
import { StartupNotices } from "./StartupNotices";

// Off the till's route (NFR-010, finding 28): the first-run wizard and the fatal screen are chunks
// of their own, read when they show. The wizard's activity templates and scale step speak the
// packs' texts, which are the back office's: it waits for them.
const SetupWizard = lazy(() =>
  Promise.all([import("@/features/setup/SetupWizard"), loadBackOffice()]).then(([m]) => ({
    default: m.SetupWizard,
  })),
);
const FatalScreen = lazy(() => import("./FatalScreen").then((m) => ({ default: m.FatalScreen })));
// M9: a chunk of its own too, read only on a new install without a licence.
const ActivationScreen = lazy(() =>
  Promise.all([import("@/features/license/ActivationScreen"), loadBackOffice()]).then(([m]) => ({
    default: m.ActivationScreen,
  })),
);

const CUSTOM_SHORTCUTS_STORAGE_KEY = "dzpos.custom.shortcuts.v1";

function readCustomShortcutsList(): CustomShortcutEntry[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SHORTCUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is CustomShortcutEntry =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as CustomShortcutEntry).id === "string" &&
          typeof (item as CustomShortcutEntry).label === "string" &&
          typeof (item as CustomShortcutEntry).target === "string" &&
          typeof (item as CustomShortcutEntry).key === "string" &&
          (item as CustomShortcutEntry).key.trim().length > 0 &&
          (item as CustomShortcutEntry).target.trim().length > 0 &&
          (item as CustomShortcutEntry).enabled !== false,
      )
      .map((item) => ({
        ...item,
        key: item.key.trim(),
        target: item.target.trim(),
        enabled: true,
      }));
  } catch {
    return [];
  }
}

function findMatchingDomElement(target: string, label: string): HTMLElement | null {
  const cleanTarget = target.trim();
  const cleanLabel = label.trim();

  if (
    cleanTarget.startsWith("#") ||
    cleanTarget.includes("[") ||
    cleanTarget.includes(">") ||
    cleanTarget.includes(".")
  ) {
    try {
      const matched = document.querySelector<HTMLElement>(cleanTarget);
      if (matched) return matched;
    } catch {
      // Ignore invalid selector syntax
    }
  }

  const byAttr = document.querySelector<HTMLElement>(
    `[data-shortcut-target="${CSS.escape(cleanTarget)}"], [data-testid="${CSS.escape(cleanTarget)}"]`,
  );
  if (byAttr) return byAttr;

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button, a, [role='button'], [role='tab'], [role='menuitem']",
    ),
  );

  const normalizedTarget = cleanTarget.toLowerCase();
  const normalizedLabel = cleanLabel.toLowerCase();

  for (const el of candidates) {
    const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    const title = (el.getAttribute("title") || "").trim().toLowerCase();
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (
      (normalizedTarget &&
        (aria === normalizedTarget || title === normalizedTarget || text === normalizedTarget)) ||
      (normalizedLabel &&
        (aria === normalizedLabel || title === normalizedLabel || text === normalizedLabel))
    ) {
      return el;
    }
  }

  return null;
}

/** Runs user-defined custom shortcuts globally with exact target matching. */
function CustomShortcutsRunner() {
  const navigate = useNavigate();
  const [shortcuts, setShortcuts] = useState<CustomShortcutEntry[]>(() => readCustomShortcutsList());

  useEffect(() => {
    const syncShortcuts = () => setShortcuts(readCustomShortcutsList());
    syncShortcuts();
    window.addEventListener("dzpos:custom-shortcuts-updated", syncShortcuts);
    window.addEventListener("storage", syncShortcuts);
    return () => {
      window.removeEventListener("dzpos:custom-shortcuts-updated", syncShortcuts);
      window.removeEventListener("storage", syncShortcuts);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const pressedKey = formatShortcutFromEvent(event);
      if (!pressedKey) return;

      const target = event.target as HTMLElement | null;
      const inEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      const hasModifier = event.ctrlKey || event.altKey || event.shiftKey;
      const isFunctionKey = /^F([1-9]|1[0-2])$/i.test(pressedKey);
      if (inEditable && !hasModifier && !isFunctionKey) return;

      const matchedCustom = shortcuts.find(
        (item) => item.enabled !== false && item.key.trim().toLowerCase() === pressedKey.toLowerCase(),
      );
      if (!matchedCustom) return;

      event.preventDefault();
      event.stopPropagation();

      const rawTarget = matchedCustom.target.trim();
      if (
        matchedCustom.targetKind === "page" ||
        (rawTarget.startsWith("/") && !rawTarget.includes(" ") && !rawTarget.includes(">"))
      ) {
        void navigate(rawTarget);
        return;
      }

      const domTarget = findMatchingDomElement(rawTarget, matchedCustom.label);
      if (domTarget) {
        domTarget.click();
        return;
      }

      window.dispatchEvent(
        new CustomEvent("dzpos:custom-shortcut", {
          detail: {
            id: matchedCustom.id,
            target: matchedCustom.target,
            label: matchedCustom.label,
            key: pressedKey,
          },
        }),
      );
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [navigate, shortcuts]);

  return null;
}

export function App() {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <Suspense fallback={<Splash />}>
          <Root />
        </Suspense>
        <StartupNotices />
        <HostCloseGuard />
        <ClosingOverlay />
        <AppToaster />
        <OnScreenKeyboard />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

/** Toasts at the bottom-end corner, 4 s (spec §10.4). They stay pressable while a modal dialog
 * holds the page (a failed receipt's "Réimprimer" arrives under the sale-done dialog). */
function AppToaster() {
  const rtl = useLang() === "ar";
  return (
    <Toaster
      dir={rtl ? "rtl" : "ltr"}
      position={rtl ? "bottom-left" : "bottom-right"}
      duration={4_000}
      className="pointer-events-auto"
      style={{ pointerEvents: "auto" }}
    />
  );
}

function Root() {
  const startup = useStartupError();
  const ready = startup.isSuccess && startup.data === null;
  const setup = useSetupStatus(ready);
  // M9: a new install without a valid licence opens on the activation screen. The webview
  // is not the boundary: a failed status call leaves the app as it was.
  const license = useLicenseStatus(ready);
  const session = useSession(setup.data?.completed === true);
  const theme = useThemePreference(ready);
  useEffect(() => applyTheme(theme), [theme]);
  // This PC's light mode and text size, from the first paint on (the login and the wizard too).
  useApplyDisplay();
  // NFR-003: the cold start ends when the activation, setup, login or sale screen is up.
  useAppReady(
    ready && setup.isSuccess && (setup.data.completed ? session.isSuccess : !license.isPending),
  );

  if (startup.isPending) return <Splash />;
  if (startup.isError) {
    return <FatalScreen failure={{ error: toAppError(startup.error), dataDir: "" }} />;
  }
  if (startup.data) return <FatalScreen failure={startup.data} />;
  if (setup.isPending) return <Splash />;
  if (setup.isError) {
    return <FatalScreen failure={{ error: toAppError(setup.error), dataDir: "" }} />;
  }
  if (!setup.data.completed) {
    if (license.isPending) return <Splash />;
    if (license.data && !license.data.canWrite) return <ActivationScreen status={license.data} />;
    return <SetupWizard />;
  }
  if (session.isPending) return <Splash />;
  if (!session.data) return <LoginScreen />;
  return (
    <MemoryRouter>
      <CustomShortcutsRunner />
      {import.meta.env.VITE_E2E === "1" ? <E2eNavigator /> : null}
      <AppRoutes session={session.data} />
    </MemoryRouter>
  );
}

/** E2E only (`VITE_E2E=1`): the specs move the in-memory router without a reload, which would
 * restart the fake shop. */
function E2eNavigator() {
  const navigate = useNavigate();
  useEffect(() => {
    window.__dzposNavigate = (to) => void navigate(to);
    return () => {
      delete window.__dzposNavigate;
    };
  }, [navigate]);
  return null;
}
