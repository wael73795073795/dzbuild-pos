import { type ReactNode, Suspense, lazy, useEffect } from "react";
import type { Hotkey } from "@/lib/hotkeys";
import type {
  ExchangeDone,
  Module,
  PaymentPreview,
  ProductHit,
  ReturnDone,
  SaleDone,
  Session,
} from "@/lib/ipc/types";
import type { TillAction } from "@/lib/key-map";
import { UnprintedSheet } from "@/app/PrintFailures";
import { OpenSessionDialog } from "@/features/cash/OpenSessionDialog";
import { LoadQuoteDialog } from "@/features/documents/LoadQuoteDialog";
import { loadBackOffice } from "@/lib/i18n";
import { toCart, useCart } from "./cart-store";
import { useExtras } from "./extras-store";
import { CustomerPicker } from "./CustomerPicker";
import { DiscountDialog } from "./DiscountDialog";
import { useCommitDone } from "./finish-sale";
import { HeldTicketsSheet } from "./HeldTicketsSheet";
import { HelpDialog } from "./HelpDialog";
import { HoldDialog } from "./HoldDialog";
import { LineEditDialog } from "./LineEditDialog";
import { NoSaleDialog } from "./NoSaleDialog";
import { OpenItemDialog } from "./OpenItemDialog";
import { PackDialog } from "./pack-slots";
import { PaymentDialog } from "./PaymentDialog";
import type { Tender } from "./payment-model";
import { PosMenu } from "./PosMenu";
import { PriceCheckDialog } from "./PriceCheckDialog";
import { SaleDoneDialog } from "./SaleDoneDialog";
import type { WeighedAdd } from "./ScalePanel";
import type { Weighing } from "./use-customer-display";

const ServicePickup = lazy(() =>
  Promise.all([import("@/features/services/ServicePickup"), loadBackOffice()]).then(([m]) => ({
    default: m.ServicePickup,
  })),
);

const InstalmentDialog = lazy(() =>
  Promise.all([import("@/features/instalments/InstalmentDialog"), loadBackOffice()]).then(([m]) => ({
    default: m.InstalmentDialog,
  })),
);
const OrderDialog = lazy(() =>
  Promise.all([import("@/features/customer-orders/OrderDialog"), loadBackOffice()]).then(([m]) => ({
    default: m.OrderDialog,
  })),
);
const OrderFulfil = lazy(() =>
  Promise.all([import("@/features/customer-orders/OrderFulfil"), loadBackOffice()]).then(([m]) => ({
    default: m.OrderFulfil,
  })),
);

const TILL_PIECES = { PaymentDialog, useCart, PackDialog };

const ReturnDialog = lazy(() => import("./ReturnDialog").then((m) => ({ default: m.ReturnDialog })));
const ScalePanel = lazy(() => import("./ScalePanel").then((m) => ({ default: m.ScalePanel })));

/** Empties the till once its cart became a signed contract or a recorded order. */
const clearTill = () => useCart.getState().clear(useCart.getState().lang);

const SellVoucherDialog = lazy(() =>
  Promise.all([import("@/features/loyalty/SellVoucherDialog"), loadBackOffice()]).then(([module]) => ({
    default: module.SellVoucherDialog,
  })),
);

export type Done =
  | { kind: "sale"; result: SaleDone }
  | { kind: "exchange"; result: ExchangeDone }
  | { kind: "return"; result: ReturnDone };

export type PosDialog =
  | { kind: "customer" }
  | { kind: "edit"; index: number }
  | { kind: "discount" }
  | { kind: "hold" }
  | { kind: "held" }
  | { kind: "price" }
  | { kind: "drawer" }
  | { kind: "openItem" }
  | { kind: "menu" }
  | { kind: "help" }
  | { kind: "openSession" }
  | { kind: "pay"; tenders?: Tender[]; error?: unknown }
  | { kind: "return"; number?: string }
  | { kind: "unprinted" }
  | { kind: "quote" }
  | { kind: "scale" }
  | { kind: "pickup"; ticketId: string }
  | { kind: "instalment" }
  | { kind: "order" }
  | { kind: "fulfil"; orderId: string }
  | { kind: "giftVoucher" }
  | { kind: "pack"; view: PackView }
  | { kind: "done"; done: Done };

export type PackView =
  | { kind: "flexy" }
  | { kind: "serial"; line: number }
  | { kind: "variants"; parent: ProductHit }
  | { kind: "van" }
  | { kind: "checkout" };

export interface TillProduct {
  id: string;
  kind: string;
  unitCode: string;
  sellPrice: number;
  nameAr: string;
  nameFr: string;
  nameEn: string;
}

export interface PosContext {
  session: Session;
  preview: PaymentPreview | undefined;
  run: <T>(action: () => Promise<T>) => Promise<T>;
  voidLine: (index: number) => Promise<boolean>;
  reduceQty: (index: number, qty: number) => Promise<boolean>;
  cancelSale: () => Promise<void>;
  recallHeld: (id: string) => Promise<void>;
  notify: (tone: "info" | "error", text: string) => void;
  open: (dialog: PosDialog) => void;
  categoryId: string | null;
  addWeighed: (add: WeighedAdd) => void;
  onWeighing: (weighing: Weighing | null) => void;
  modules: readonly Module[];
  keys: Record<TillAction, Hotkey>;
  actions: readonly TillAction[];
  addProduct: (product: TillProduct, qty: number, unitDecimals: number) => void;
  checkoutDone: () => void;
  toggleDepartments: () => void;
}

const DIRECT_DIALOG_KINDS = new Set<PosDialog["kind"]>([
  "customer",
  "discount",
  "hold",
  "held",
  "price",
  "drawer",
  "openItem",
  "menu",
  "help",
  "openSession",
  "unprinted",
  "quote",
  "scale",
  "instalment",
  "order",
  "giftVoucher",
]);

function resolveDialogKindFromTarget(target: string): PosDialog["kind"] | null {
  const cleaned = target.replace(/^#/, "").trim().toLowerCase();
  if (!cleaned) return null;
  if (DIRECT_DIALOG_KINDS.has(cleaned as PosDialog["kind"])) {
    return cleaned as PosDialog["kind"];
  }
  const suffix = cleaned.split("/").filter(Boolean).at(-1) ?? "";
  if (DIRECT_DIALOG_KINDS.has(suffix as PosDialog["kind"])) {
    return suffix as PosDialog["kind"];
  }
  if (suffix === "price-check" || suffix === "pricecheck") return "price";
  if (suffix === "open-item" || suffix === "openitem") return "openItem";
  if (suffix === "held-tickets" || suffix === "heldtickets") return "held";
  if (suffix === "gift-voucher" || suffix === "giftvoucher" || suffix === "voucher") return "giftVoucher";
  return null;
}

export function PosDialogs({
  dialog,
  onClose,
  ctx,
}: {
  dialog: PosDialog | null;
  onClose: () => void;
  ctx: PosContext;
}): ReactNode {
  const commitDone = useCommitDone((done) => ctx.open({ kind: "done", done }));

  useEffect(() => {
    const onDirectDialog = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string; kind?: PosDialog["kind"] }>).detail;
      const kind =
        detail?.kind ?? (typeof detail?.target === "string" ? resolveDialogKindFromTarget(detail.target) : null);
      if (!kind || !DIRECT_DIALOG_KINDS.has(kind)) return;
      ctx.open({ kind } as PosDialog);
    };
    window.addEventListener("dzpos:open-pos-dialog", onDirectDialog);
    return () => window.removeEventListener("dzpos:open-pos-dialog", onDirectDialog);
  }, [ctx]);

  switch (dialog?.kind) {
    case "customer":
      return <CustomerPicker ctx={ctx} onClose={onClose} />;
    case "edit":
      return <LineEditDialog index={dialog.index} ctx={ctx} onClose={onClose} />;
    case "discount":
      return <DiscountDialog onClose={onClose} />;
    case "hold":
      return <HoldDialog ctx={ctx} onClose={onClose} />;
    case "held":
      return <HeldTicketsSheet ctx={ctx} onClose={onClose} />;
    case "price":
      return <PriceCheckDialog onClose={onClose} />;
    case "drawer":
      return <NoSaleDialog ctx={ctx} onClose={onClose} />;
    case "openItem":
      return <OpenItemDialog onClose={onClose} />;
    case "menu":
      return <PosMenu ctx={ctx} onClose={onClose} />;
    case "help":
      return <HelpDialog keys={ctx.keys} actions={ctx.actions} onClose={onClose} />;
    case "openSession":
      return <OpenSessionDialog open onOpenChange={(open) => (open ? undefined : onClose())} />;
    case "pay":
      return (
        <PaymentDialog
          onClose={onClose}
          initialTenders={dialog.tenders}
          initialError={dialog.error}
          onDone={commitDone}
        />
      );
    case "return":
      return (
        <Suspense fallback={null}>
          <ReturnDialog number={dialog.number} ctx={ctx} onClose={onClose} />
        </Suspense>
      );
    case "done":
      return <SaleDoneDialog done={dialog.done} onNewSale={onClose} />;
    case "unprinted":
      return <UnprintedSheet onClose={onClose} />;
    case "quote":
      return <LoadQuoteDialog ctx={ctx} onClose={onClose} />;
    case "scale":
      return (
        <Suspense fallback={null}>
          <ScalePanel
            categoryId={ctx.categoryId}
            onAdd={ctx.addWeighed}
            onWeighing={ctx.onWeighing}
            onClose={onClose}
          />
        </Suspense>
      );
    case "pickup":
      return (
        <Suspense fallback={null}>
          <ServicePickup ticketId={dialog.ticketId} ctx={ctx} till={TILL_PIECES} onClose={onClose} />
        </Suspense>
      );
    case "instalment":
      return (
        <Suspense fallback={null}>
          <InstalmentDialog
            cart={toCart(useCart.getState())}
            extras={useExtras.getState().toExtras()}
            onSigned={clearTill}
            onClose={onClose}
          />
        </Suspense>
      );
    case "order":
      return (
        <Suspense fallback={null}>
          <OrderDialog
            cart={toCart(useCart.getState())}
            total={ctx.preview?.settlement.totalTtc ?? null}
            onCreated={clearTill}
            onClose={onClose}
          />
        </Suspense>
      );
    case "fulfil":
      return (
        <Suspense fallback={null}>
          <OrderFulfil orderId={dialog.orderId} ctx={ctx} till={TILL_PIECES} onClose={onClose} />
        </Suspense>
      );
    case "giftVoucher":
      return (
        <Suspense fallback={null}>
          <SellVoucherDialog onClose={onClose} />
        </Suspense>
      );
    case "pack":
      return (
        <Suspense fallback={null}>
          <PackDialog view={dialog.view} ctx={ctx} onClose={onClose} />
        </Suspense>
      );
    default:
      return null;
  }
}
