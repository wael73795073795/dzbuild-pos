import { Eraser } from "lucide-react";
import { type ReactNode, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ImportLink } from "@/features/imports/import-entities";
import { WasteScreen, YieldScreen } from "@/features/packs/pack-screens";
import { usePackState } from "@/lib/ipc/pack-state";
import { useAdjustStock } from "@/lib/ipc/stock";
import { useLevelsView } from "@/lib/ipc/stock-m2";
import { useErrorText } from "@/lib/use-error-text";
import { cn } from "@/lib/utils";
import { CountsTab } from "./CountsTab";
import { ExpiryTab } from "./ExpiryTab";
import { LevelsTab } from "./LevelsTab";
import { MovementsTab } from "./MovementsTab";
import { SerialsTab } from "./SerialsTab";
import { useCan } from "./stock-parts";
import { TransfersTab } from "./TransferDialog";

type Tab = "levels" | "movements" | "counts" | "transfers" | "expiry" | "serials" | "yield" | "waste";

const PANELS: Record<Tab, () => ReactNode> = {
  levels: () => <LevelsTab />,
  movements: () => <MovementsTab />,
  counts: () => <CountsTab />,
  transfers: () => <TransfersTab />,
  expiry: () => <ExpiryTab />,
  serials: () => <SerialsTab />,
  // M8 butcher: each a chunk of its own, shown while its module is on
  yield: () => <YieldScreen />,
  waste: () => <WasteScreen />,
};

/** `/stock`: levels per location, the movement log, counts, transfers, expiry and serial numbers
 * (STK-002…015, PRD-050/052), and the butcher's cutting and day's waste while their modules are
 * on (VRT-011, STK-026). A counter holding only `stock.count` sees the counts alone; the tab is
 * kept in `?tab=`. */
export function StockScreen() {
  const { t } = useTranslation();
  const can = useCan();
  const errorText = useErrorText();
  const [params, setParams] = useSearchParams();
  const modules = usePackState().data?.modules ?? [];
  const adjustStock = useAdjustStock();
  const [zeroingAll, setZeroingAll] = useState(false);

  const canAdjust = can("stock.adjust");
  const allLevels = useLevelsView({
    text: "",
    locationId: null,
    categoryId: null,
    onlyBelowMin: false,
    includeZero: false,
    limit: 10_000,
  });

  const handleZeroAllStock = async () => {
    if (!canAdjust || zeroingAll || adjustStock.isPending) return;
    const confirmed = window.confirm(
      "تحذير: هل أنت متأكد من تصفير جميع أرصدة المخزون في كل المواقع؟",
    );
    if (!confirmed) return;

    setZeroingAll(true);
    let zeroedCount = 0;

    try {
      const rows = (allLevels.data ?? []).filter((r) => r.qty !== 0);
      for (const row of rows) {
        await new Promise<void>((resolve, reject) => {
          adjustStock.mutate(
            {
              productId: row.productId,
              locationId: row.locationId,
              qtyDelta: -row.qty,
              reason: "correction",
              unitCost: null,
              note: "تصفير أرصدة المخزون",
            },
            {
              onSuccess: () => {
                zeroedCount += 1;
                resolve();
              },
              onError: (err) => reject(err),
            },
          );
        });
      }

      toast.success(
        zeroedCount > 0
          ? `تم تصفير ${zeroedCount} رصيد مخزون بنجاح`
          : "جميع أرصدة المخزون مصفّرة بالفعل",
      );
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setZeroingAll(false);
    }
  };

  const tabs: Tab[] = [
    ...(can("stock.view") ? (["levels", "movements"] as const) : []),
    ...(can("stock.view") || can("stock.count") ? (["counts"] as const) : []),
    ...(can("stock.view") ? (["transfers", "expiry", "serials"] as const) : []),
    ...(can("stock.view") && modules.includes("yield") ? (["yield"] as const) : []),
    ...(can("stock.view") && modules.includes("waste") ? (["waste"] as const) : []),
  ];
  const requested = params.get("tab");
  const tab = tabs.find((k) => k === requested) ?? tabs[0];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-3xl font-bold">{t("stock:title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {canAdjust ? (
            <Button
              type="button"
              variant="danger"
              disabled={zeroingAll || adjustStock.isPending || allLevels.isPending}
              onClick={() => void handleZeroAllStock()}
            >
              <Eraser aria-hidden />
              تصفير أرصدة المخزون
            </Button>
          ) : null}
          <ImportLink entities={["opening_stock", "count_lines"]} />
        </div>
      </div>
      <div
        role="tablist"
        aria-label={t("stock:tabs.label")}
        className="flex flex-wrap gap-2 border-b border-line pb-2"
      >
        {tabs.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`stock-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`stock-panel-${k}`}
            onClick={() => setParams({ tab: k }, { replace: true })}
            className={cn(
              "min-h-11 rounded-control px-4 font-semibold",
              tab === k ? "bg-brand-soft" : "text-ink-2 hover:bg-surface-2",
            )}
          >
            {k === "yield" || k === "waste" ? t(`butcher:tabs.${k}`) : t(`stock:tabs.${k}`)}
          </button>
        ))}
      </div>
      {tab ? (
        <div role="tabpanel" id={`stock-panel-${tab}`} aria-labelledby={`stock-tab-${tab}`}>
          <Suspense fallback={null}>{PANELS[tab]()}</Suspense>
        </div>
      ) : null}
    </div>
  );
}
