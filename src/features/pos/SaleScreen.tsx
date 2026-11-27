import { useQueryClient } from "@tanstack/react-query";
import {
  Barcode,
  Calculator,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Delete,
  Equal,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  Menu,
  Minimize2,
  Move,
  Pause,
  Percent,
  Pin,
  PinOff,
  RotateCcw,
  Scale,
  ShieldCheck,
  Tag,
  Trash2,
  Undo2,
  User,
  Wallet,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type PointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Amount } from "@/components/amount";
import { EmptyState } from "@/components/empty-state";
import { useApproval } from "@/components/manager-approval";
import { Button } from "@/components/ui/button";
import { isApprovalCancelled } from "@/lib/approval";
import { useCurrentSession } from "@/lib/ipc/cash";
import { useTaxRates, useUnits } from "@/lib/ipc/catalog";
import { useCompany } from "@/lib/ipc/company";
import { useSerialScans } from "@/lib/ipc/devices";
import { useHardwareConfig, useScannerOptions } from "@/lib/ipc/hardware";
import { useSearchHost, useSyncNow, useTillLink } from "@/lib/ipc/lan";
import { usePackModules } from "@/lib/ipc/pack-state";
import { useFetchCustomer } from "@/lib/ipc/customers";
import { useFindByCode } from "@/lib/ipc/products";
import { useHeldCarts, usePreviewSale, useRecallCart, useRecordCartEvent } from "@/lib/ipc/sales";
import type { Module, ProductHit, ScanHit, Session } from "@/lib/ipc/types";
import { formatAmountInput, formatDZD } from "@/lib/format";
import { type Hotkey, useCtrlHotkey, useHotkeys } from "@/lib/hotkeys";
import { DEFAULT_KEYS, type TillAction, ariaKey, keyLabel, useKeyMap } from "@/lib/key-map";
import { localizedName } from "@/lib/names";
import { formatQty, parseAmount } from "@/lib/numeric";
import { useScanner } from "@/lib/scanner";
import { BackupAlerts } from "@/app/BackupAlerts";
import { DemoRibbon } from "@/app/DemoRibbon";
import { LanBanner } from "@/app/LanBanner";
import { backOfficeHome } from "@/app/nav";
import { PrinterDot } from "@/app/PrintFailures";
import { SyncPill } from "@/app/SyncPill";
import { beep } from "@/lib/sounds";
import { useErrorText } from "@/lib/use-error-text";
import { useLang } from "@/lib/use-language";
import { cn } from "@/lib/utils";
import { CartPanel } from "./CartPanel";
import { toCart, useCart } from "./cart-store";
import { CustomerStrip } from "./CustomerPicker";
import { useExtras } from "./extras-store";
import { receiptByDefault, useCommitDone, useFinishSale } from "./finish-sale";
import { loadRecalled } from "./HeldTicketsSheet";
import { DepartmentKeysPanel, LineNotices, VanBanner, loadTillPacks } from "./pack-slots";
import { type Tender, exactAmount, newTender, toInputs } from "./payment-model";
import { type PosContext, type PosDialog, PosDialogs, type TillProduct } from "./PosDialogs";
import { ProductGrid } from "./ProductGrid";
import type { WeighedAdd } from "./ScalePanel";
import { ScanField } from "./ScanField";
import { useTillPayment } from "./till-payment";
import { unitDecimalsOf } from "./unit-decimals";
import { useCartPreview, usePricedLines } from "./use-cart-preview";
import { useCustomerDisplayFeed, type Weighing } from "./use-customer-display";

interface Notice {
  tone: "info" | "error";
  text: string;
}

type PosZoneId = "receipt" | "actions" | "products";
type DockOrientation = "vertical" | "horizontal";
type PosPresetId = "default" | "receipt_focus" | "products_focus";

interface PosZoneState {
  docked: boolean;
  compact: boolean;
  hidden: boolean;
  offsetX: number;
  offsetY: number;
  width: number | null;
  height: number | null;
}

interface PosLayoutConfig {
  order: [PosZoneId, PosZoneId, PosZoneId];
  toolbarOrientation: DockOrientation;
  locked: boolean;
  zones: Record<PosZoneId, PosZoneState>;
}

const CHECKOUT_MODULES: Module[] = ["serials", "pharmacy", "jewellery"];
const VOUCHER_MODULES: Module[] = ["gift_vouchers", "loyalty", "orders", "repairs"];

const DEPARTMENTS_KEY = "dzpos.till.departments";
const SPLIT_WIDTH_KEY = "dzpos.till.splitWidth";
const SPLIT_PINNED_KEY = "dzpos.till.splitPinned";
const RAIL_COLLAPSED_KEY = "dzpos.till.railCollapsed";
const POS_LAYOUT_KEY = "dzpos.till.layout.v2";

const DEFAULT_NO_BARCODE_NAME = "صنف بدون باركود";
const NO_BARCODE_LOOKUP_CODE = "0000000000000";

const DEFAULT_LEFT_WIDTH = 520;
const MIN_LEFT_WIDTH = 300;
const MAX_LEFT_WIDTH = 860;
const MIN_RIGHT_WIDTH = 340;

const CART_TRACK_CAPACITY = 20;
const PAUSE_WAIT_THRESHOLD_MS = 12_000;
const IDLE_ROAM_THRESHOLD_MS = 20_000;

const DEFAULT_POS_LAYOUT: PosLayoutConfig = {
  order: ["receipt", "actions", "products"],
  toolbarOrientation: "vertical",
  locked: false,
  zones: {
    receipt: {
      docked: false,
      compact: false,
      hidden: false,
      offsetX: 0,
      offsetY: 0,
      width: null,
      height: null,
    },
    actions: {
      docked: false,
      compact: false,
      hidden: false,
      offsetX: 0,
      offsetY: 0,
      width: null,
      height: null,
    },
    products: {
      docked: false,
      compact: false,
      hidden: false,
      offsetX: 0,
      offsetY: 0,
      width: null,
      height: null,
    },
  },
};

function readPosLayout(): PosLayoutConfig {
  try {
    const raw = window.localStorage.getItem(POS_LAYOUT_KEY);
    if (!raw) return DEFAULT_POS_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<PosLayoutConfig>;
    const validIds: PosZoneId[] = ["receipt", "actions", "products"];
    const orderList = Array.isArray(parsed.order)
      ? parsed.order.filter((id): id is PosZoneId => validIds.includes(id as PosZoneId))
      : [];
    for (const id of validIds) {
      if (!orderList.includes(id)) orderList.push(id);
    }
    const order: [PosZoneId, PosZoneId, PosZoneId] = [
      orderList[0] ?? "receipt",
      orderList[1] ?? "actions",
      orderList[2] ?? "products",
    ];
    const toolbarOrientation: DockOrientation =
      parsed.toolbarOrientation === "horizontal" ? "horizontal" : "vertical";
    const locked = Boolean(parsed.locked);

    const mergeZone = (id: PosZoneId): PosZoneState => {
      const z = parsed.zones?.[id];
      return {
        docked: Boolean(z?.docked),
        compact: Boolean(z?.compact),
        hidden: Boolean(z?.hidden),
        offsetX: typeof z?.offsetX === "number" && Number.isFinite(z.offsetX) ? z.offsetX : 0,
        offsetY: typeof z?.offsetY === "number" && Number.isFinite(z.offsetY) ? z.offsetY : 0,
        width: typeof z?.width === "number" && Number.isFinite(z.width) && z.width > 80 ? z.width : null,
        height:
          typeof z?.height === "number" && Number.isFinite(z.height) && z.height > 48 ? z.height : null,
      };
    };

    return {
      order,
      toolbarOrientation,
      locked,
      zones: {
        receipt: mergeZone("receipt"),
        actions: mergeZone("actions"),
        products: mergeZone("products"),
      },
    };
  } catch {
    return DEFAULT_POS_LAYOUT;
  }
}

function savePosLayout(layout: PosLayoutConfig): void {
  try {
    window.localStorage.setItem(POS_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // ignore storage errors
  }
}

function rememberedDepartments(): boolean {
  try {
    return window.localStorage.getItem(DEPARTMENTS_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDepartments(on: boolean): void {
  try {
    window.localStorage.setItem(DEPARTMENTS_KEY, on ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

function rememberedSplitWidth(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_WIDTH_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed >= MIN_LEFT_WIDTH && parsed <= MAX_LEFT_WIDTH) {
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_LEFT_WIDTH;
}

function rememberSplitWidth(width: number): void {
  try {
    window.localStorage.setItem(SPLIT_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // ignore storage errors
  }
}

function rememberedSplitPinned(): boolean {
  try {
    return window.localStorage.getItem(SPLIT_PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberSplitPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(SPLIT_PINNED_KEY, pinned ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

function rememberedRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberRailCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

function evaluateBasicMath(expr: string): string {
  const cleaned = expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/\s+/g, "");
  if (!cleaned) return "0";
  if (!/^[0-9+\-*/().]+$/.test(cleaned)) return "خطأ";

  const tokens = cleaned.match(/(\d+(?:\.\d+)?|[+\-*/()])/g);
  if (!tokens || tokens.join("") !== cleaned) return "خطأ";

  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const consume = (): string | undefined => tokens[pos++];

  const parseExpression = (): number | null => {
    let value = parseTerm();
    if (value === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseTerm();
      if (right === null) return null;
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };

  const parseTerm = (): number | null => {
    let value = parseFactor();
    if (value === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = consume();
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/") {
        if (right === 0) return null;
        value = value / right;
      } else {
        value = value * right;
      }
    }
    return value;
  };

  const parseFactor = (): number | null => {
    const token = peek();
    if (!token) return null;
    if (token === "+" || token === "-") {
      consume();
      const next = parseFactor();
      if (next === null) return null;
      return token === "-" ? -next : next;
    }
    if (token === "(") {
      consume();
      const inside = parseExpression();
      if (inside === null || peek() !== ")") return null;
      consume();
      return inside;
    }
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      consume();
      const num = Number(token);
      return Number.isFinite(num) ? num : null;
    }
    return null;
  };

  const result = parseExpression();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) {
    return "خطأ";
  }

  const rounded = Math.round(result * 1_000_000) / 1_000_000;
  return String(rounded);
}

function QuickPriceModal({
  open,
  onClose,
  onSubmitPrice,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitPrice: (params: { unitPrice: number; customName?: string }) => Promise<void>;
}) {
  const [priceInput, setPriceInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const priceRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPriceInput("");
    setNameInput("");
    setSubmitting(false);
    window.setTimeout(() => priceRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const unitPrice = parseAmount(priceInput);
    if (unitPrice === null || unitPrice <= 0) {
      toast.error("أدخل سعراً صحيحاً أكبر من صفر");
      priceRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const trimmed = nameInput.trim();
      await onSubmitPrice({
        unitPrice,
        customName: trimmed.length > 0 ? trimmed : undefined,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="سعر سريع"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="w-full max-w-[360px] rounded-xl border border-line bg-surface p-4 text-ink shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between border-b border-line pb-2">
          <div className="flex items-center gap-2">
            <Tag aria-hidden className="size-4 text-brand" />
            <span className="text-base font-bold">سعر سريع</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-semibold">
            <span>السعر</span>
            <input
              ref={priceRef}
              type="number"
              step="any"
              min="0.001"
              dir="ltr"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              placeholder="0.00"
              className="h-11 rounded-lg border border-line bg-surface-2 px-3 text-lg font-bold text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-semibold">
            <span>اسم الصنف (اختياري)</span>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={DEFAULT_NO_BARCODE_NAME}
              className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </label>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            إضافة للفاتورة
          </Button>
        </div>
      </form>
    </div>
  );
}

function QuickWeightModal({
  open,
  onClose,
  onSubmitWeight,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitWeight: (params: { weightValue: number; barcode: string }) => Promise<void>;
}) {
  const [weightInput, setWeightInput] = useState("");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const weightRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setWeightInput("");
    setBarcodeInput("");
    setSubmitting(false);
    window.setTimeout(() => weightRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const w = Number(weightInput.replace(",", "."));
    const code = barcodeInput.trim();
    if (!Number.isFinite(w) || w <= 0) {
      toast.error("أدخل الوزن بشكل صحيح");
      weightRef.current?.focus();
      return;
    }
    if (!code) {
      toast.error("أدخل أو امسح باركود الصنف");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmitWeight({ weightValue: w, barcode: code });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="وزن سريع"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="w-full max-w-[360px] rounded-xl border border-line bg-surface p-4 text-ink shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between border-b border-line pb-2">
          <div className="flex items-center gap-2">
            <Barcode aria-hidden className="size-4 text-brand" />
            <span className="text-base font-bold">وزن سريع</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-semibold">
            <span>الوزن (كما يظهر في الليبل / الجرام)</span>
            <input
              ref={weightRef}
              type="number"
              step="any"
              min="0.001"
              dir="ltr"
              value={weightInput}
              onChange={(e) => setWeightInput(e.target.value)}
              placeholder="مثال: 500 أو 0.5"
              className="h-11 rounded-lg border border-line bg-surface-2 px-3 text-lg font-bold text-ink focus:border-brand focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-semibold">
            <span>باركود الصنف</span>
            <input
              type="text"
              dir="ltr"
              value={barcodeInput}
              onChange={(e) => setBarcodeInput(e.target.value)}
              placeholder="امسح أو اكتب الباركود"
              className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm font-semibold text-ink focus:border-brand focus:outline-none"
            />
          </label>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            حساب وإضافة
          </Button>
        </div>
      </form>
    </div>
  );
}

function PosCalculatorModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [expr, setExpr] = useState("");
  const [display, setDisplay] = useState("0");

  const appendToken = useCallback((token: string) => {
    setExpr((prev) => {
      const base = prev === "خطأ" ? "" : prev;
      const next = `${base}${token}`;
      setDisplay(next || "0");
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setExpr("");
    setDisplay("0");
  }, []);

  const backspace = useCallback(() => {
    setExpr((prev) => {
      if (!prev || prev === "خطأ") {
        setDisplay("0");
        return "";
      }
      const next = prev.slice(0, -1);
      setDisplay(next || "0");
      return next;
    });
  }, []);

  const calculate = useCallback(() => {
    setExpr((prev) => {
      const target = prev || display;
      const res = evaluateBasicMath(target);
      setDisplay(res);
      return res === "خطأ" ? "" : res;
    });
  }, [display]);

  const copyResult = useCallback(() => {
    const val = display;
    if (!val || val === "خطأ") return;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(val).then(
        () => toast.success(`تم نسخ النتيجة: ${val}`),
        () => toast.info(`النتيجة: ${val}`),
      );
    } else {
      toast.info(`النتيجة: ${val}`);
    }
  }, [display]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (/^[0-9.]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        appendToken(e.key);
        return;
      }
      if (["+", "-", "*", "/"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        appendToken(e.key);
        return;
      }
      if (e.key === "Enter" || e.key === "=") {
        e.preventDefault();
        e.stopPropagation();
        calculate();
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        backspace();
        return;
      }
      if (e.key === "Delete" || e.key.toLowerCase() === "c") {
        e.preventDefault();
        e.stopPropagation();
        clearAll();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [appendToken, backspace, calculate, clearAll, onClose, open]);

  if (!open) return null;

  const padButtons: Array<{ label: string; onClick: () => void; tone?: "op" | "eq" | "muted" }> = [
    { label: "C", onClick: clearAll, tone: "muted" },
    { label: "÷", onClick: () => appendToken("÷"), tone: "op" },
    { label: "×", onClick: () => appendToken("×"), tone: "op" },
    { label: "⌫", onClick: backspace, tone: "muted" },
    { label: "7", onClick: () => appendToken("7") },
    { label: "8", onClick: () => appendToken("8") },
    { label: "9", onClick: () => appendToken("9") },
    { label: "-", onClick: () => appendToken("-"), tone: "op" },
    { label: "4", onClick: () => appendToken("4") },
    { label: "5", onClick: () => appendToken("5") },
    { label: "6", onClick: () => appendToken("6") },
    { label: "+", onClick: () => appendToken("+"), tone: "op" },
    { label: "1", onClick: () => appendToken("1") },
    { label: "2", onClick: () => appendToken("2") },
    { label: "3", onClick: () => appendToken("3") },
    { label: "=", onClick: calculate, tone: "eq" },
    { label: "0", onClick: () => appendToken("0") },
    { label: "00", onClick: () => appendToken("00") },
    { label: ".", onClick: () => appendToken(".") },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="آلة حاسبة"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[320px] rounded-xl border border-line bg-surface p-3.5 text-ink shadow-xl">
        <div className="mb-2.5 flex items-center justify-between border-b border-line pb-2">
          <div className="flex items-center gap-2">
            <Calculator aria-hidden className="size-4 text-brand" />
            <span className="text-sm font-bold">آلة حاسبة</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={copyResult}
              title="نسخ النتيجة"
              aria-label="نسخ النتيجة"
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <Copy aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="إغلاق"
              aria-label="إغلاق"
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </div>

        <div className="mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-end">
          <div className="min-h-4 truncate text-xs text-ink-2" dir="ltr">
            {expr || " "}
          </div>
          <div className="truncate text-2xl font-bold text-ink" dir="ltr">
            {display}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5" dir="ltr">
          {padButtons.slice(0, 15).map((btn) => (
            <button
              key={btn.label}
              type="button"
              onClick={btn.onClick}
              className={cn(
                "flex h-11 items-center justify-center rounded-lg border text-base font-bold transition-colors",
                btn.tone === "op" && "border-brand/40 bg-brand-soft text-brand",
                btn.tone === "muted" && "border-line bg-surface-2 text-ink-2 hover:text-ink",
                !btn.tone && "border-line bg-surface hover:bg-surface-2",
              )}
            >
              {btn.label === "⌫" ? <Delete aria-hidden className="size-4" /> : btn.label}
            </button>
          ))}

          <button
            type="button"
            onClick={calculate}
            className="row-span-2 flex items-center justify-center rounded-lg bg-brand text-lg font-bold text-brand-ink transition-opacity hover:opacity-95"
            aria-label="يساوي"
          >
            <Equal aria-hidden className="size-5" />
          </button>

          {padButtons.slice(15).map((btn) => (
            <button
              key={btn.label}
              type="button"
              onClick={btn.onClick}
              className="flex h-11 items-center justify-center rounded-lg border border-line bg-surface text-base font-bold transition-colors hover:bg-surface-2"
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SupermarketCartIcon({
  fillRatio,
  roaming,
  justAdded,
}: {
  fillRatio: number;
  roaming: boolean;
  justAdded: boolean;
}) {
  const clamped = Math.max(0, Math.min(1, fillRatio));
  const fillHeight = Math.round(clamped * 9);
  const fillY = 12 - fillHeight;
  const nearFull = !roaming && clamped >= 0.85;

  return (
    <svg
      viewBox="0 0 28 24"
      className={cn(
        "h-6 w-7 shrink-0 transition-transform duration-300",
        roaming && "animate-pulse",
        justAdded && "scale-110",
      )}
      aria-hidden="true"
    >
      {clamped > 0 ? (
        <rect
          x="8.5"
          y={fillY}
          width="11"
          height={fillHeight}
          rx="1.5"
          className={cn(
            "transition-all duration-300",
            nearFull ? "fill-success/80" : "fill-primary/70",
          )}
        />
      ) : null}
      <path
        d="M2.5 3.5h3.2l2.4 11.2a2 2 0 0 0 2 1.6h10.4a2 2 0 0 0 1.95-1.55L24.5 7H7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10.5" cy="20" r="1.7" fill="currentColor" />
      <circle cx="20.5" cy="20" r="1.7" fill="currentColor" />
    </svg>
  );
}

export function SaleScreen({ session, withTables = false }: { session: Session; withTables?: boolean }) {
  const { t } = useTranslation();
  const lang = useLang();
  const navigate = useNavigate();
  const location = useLocation();
  const errorText = useErrorText();
  const company = useCompany();
  const hardware = useHardwareConfig();
  const scanner = useScannerOptions();
  const till = useCurrentSession();
  const can = (p: Session["permissions"][number]) => session.permissions.includes(p);
  const held = useHeldCarts(can("sales.hold"));
  const findByCode = useFindByCode();
  const lan = useTillLink();
  const searchHost = useSearchHost();
  const syncNow = useSyncNow();
  const recordEvent = useRecordCartEvent();
  const recall = useRecallCart();
  const approval = useApproval();
  const preview = useCartPreview();
  const units = useUnits().data;
  const taxRates = useTaxRates().data ?? [];
  const defaultTaxRateId =
    taxRates.find((r) => r.active)?.id ?? taxRates[0]?.id ?? null;
  const tillPayment = useTillPayment();
  const finishSale = useFinishSale(approval.run);
  const previewSale = usePreviewSale().mutateAsync;
  const fetchCustomer = useFetchCustomer();
  const quickPaying = useRef(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [isVoiding, setIsVoiding] = useState(false);
  const lines = useCart((s) => s.lines);
  const priced = usePricedLines(lines, preview);
  const selected = useCart((s) => s.selected);
  const multiplier = useCart((s) => s.multiplier);
  const lastScan = useCart((s) => s.lastScan);
  const exchange = useCart((s) => s.exchange);
  const fromQuote = useCart((s) => s.fromQuote);
  const queryClient = useQueryClient();
  const modules = usePackModules();
  const keys = useKeyMap();
  const van = useExtras((s) => s.van);
  const [departmentsOn, setDepartmentsOn] = useState(rememberedDepartments);
  const departments = departmentsOn && modules.includes("department_keys");

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState<number>(rememberedSplitWidth);
  const [splitPinned, setSplitPinned] = useState<boolean>(rememberedSplitPinned);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(rememberedRailCollapsed);
  const [draggingSplit, setDraggingSplit] = useState(false);

  const [posLayout, setPosLayout] = useState<PosLayoutConfig>(() => {
    const loaded = readPosLayout();
    return {
      ...loaded,
      zones: {
        ...loaded.zones,
        actions: {
          ...loaded.zones.actions,
          compact: loaded.zones.actions.compact || rememberedRailCollapsed(),
        },
      },
    };
  });
  const [activeDragZone, setActiveDragZone] = useState<PosZoneId | null>(null);

  const updatePosLayout = useCallback((updater: (prev: PosLayoutConfig) => PosLayoutConfig) => {
    setPosLayout((prev) => {
      const next = updater(prev);
      savePosLayout(next);
      return next;
    });
  }, []);

  const toggleLayoutLock = useCallback(() => {
    updatePosLayout((prev) => ({ ...prev, locked: !prev.locked }));
  }, [updatePosLayout]);

  const toggleToolbarOrientation = useCallback(() => {
    updatePosLayout((prev) => {
      if (prev.locked) {
        toast.info("التخطيط مقفل — فك القفل أولاً لتغيير اتجاه شريط الأزرار");
        return prev;
      }
      const nextOrientation: DockOrientation =
        prev.toolbarOrientation === "vertical" ? "horizontal" : "vertical";
      return {
        ...prev,
        toolbarOrientation: nextOrientation,
        zones: {
          ...prev.zones,
          actions: {
            ...prev.zones.actions,
            height: nextOrientation === "horizontal" ? 76 : null,
            width: nextOrientation === "horizontal" ? null : prev.zones.actions.width,
          },
        },
      };
    });
  }, [updatePosLayout]);

  const swapZones = useCallback(
    (first: PosZoneId, second: PosZoneId) => {
      if (first === second) return;
      updatePosLayout((prev) => {
        if (prev.locked) {
          toast.info("التخطيط مقفل — فك القفل أولاً لتبديل الأجزاء");
          return prev;
        }
        const nextOrder = [...prev.order] as [PosZoneId, PosZoneId, PosZoneId];
        const idxA = nextOrder.indexOf(first);
        const idxB = nextOrder.indexOf(second);
        if (idxA !== -1 && idxB !== -1) {
          nextOrder[idxA] = second;
          nextOrder[idxB] = first;
        }
        return {
          ...prev,
          order: nextOrder,
        };
      });
    },
    [updatePosLayout],
  );

  const cycleZonePosition = useCallback(
    (zoneId: PosZoneId) => {
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
      updatePosLayout((prev) => {
        if (prev.locked) {
          toast.info("التخطيط مقفل — فك القفل أولاً لتحريك الأجزاء");
          return prev;
        }
        const idx = prev.order.indexOf(safeZoneId);
        if (idx === -1) return prev;
        const nextIdx = (idx + 1) % prev.order.length;
        const nextOrder = [...prev.order] as [PosZoneId, PosZoneId, PosZoneId];
        const [moved] = nextOrder.splice(idx, 1);
        nextOrder.splice(nextIdx, 0, moved ?? safeZoneId);
        return {
          ...prev,
          order: nextOrder,
        };
      });
    },
    [updatePosLayout],
  );

  const toggleZoneCompact = useCallback(
    (zoneId: PosZoneId) => {
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
      updatePosLayout((prev) => {
        const currentZone = prev.zones[safeZoneId];
        const nextCompact = !currentZone.compact;
        if (safeZoneId === "actions") {
          setRailCollapsed(nextCompact);
          rememberRailCollapsed(nextCompact);
        }
        return {
          ...prev,
          zones: {
            ...prev.zones,
            [safeZoneId]: {
              ...currentZone,
              compact: nextCompact,
              hidden: false,
            },
          },
        };
      });
    },
    [updatePosLayout],
  );

  const minimizeZoneToIcon = useCallback(
    (zoneId: PosZoneId) => {
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
      updatePosLayout((prev) => ({
        ...prev,
        zones: {
          ...prev.zones,
          [safeZoneId]: {
            ...prev.zones[safeZoneId],
            hidden: true,
          },
        },
      }));
    },
    [updatePosLayout],
  );

  const restoreZone = useCallback(
    (zoneId: PosZoneId) => {
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
      updatePosLayout((prev) => ({
        ...prev,
        zones: {
          ...prev.zones,
          [safeZoneId]: {
            ...prev.zones[safeZoneId],
            hidden: false,
            compact: false,
            offsetX: 0,
            offsetY: 0,
            width: null,
            height: null,
          },
        },
      }));
    },
    [updatePosLayout],
  );

  const clampLeftWidth = useCallback((desired: number): number => {
    const containerWidth = splitContainerRef.current?.clientWidth ?? window.innerWidth;
    const maxAllowedByViewport = Math.max(MIN_LEFT_WIDTH, containerWidth - MIN_RIGHT_WIDTH);
    const upper = Math.min(MAX_LEFT_WIDTH, maxAllowedByViewport);
    return Math.max(MIN_LEFT_WIDTH, Math.min(upper, desired));
  }, []);

  const applyPreset = useCallback(
    (preset: PosPresetId) => {
      updatePosLayout((prev) => {
        if (prev.locked) {
          toast.info("التخطيط مقفل — فك القفل أولاً لاختيار قالب");
          return prev;
        }
        if (preset === "receipt_focus") {
          setLeftWidth(clampLeftWidth(660));
          return {
            ...prev,
            order: ["receipt", "actions", "products"],
            zones: {
              receipt: { ...prev.zones.receipt, hidden: false, compact: false, offsetX: 0, offsetY: 0, width: null, height: null },
              actions: { ...prev.zones.actions, hidden: false, offsetX: 0, offsetY: 0 },
              products: { ...prev.zones.products, hidden: false, compact: false, offsetX: 0, offsetY: 0, width: null, height: null },
            },
          };
        }
        if (preset === "products_focus") {
          setLeftWidth(clampLeftWidth(380));
          return {
            ...prev,
            order: ["products", "actions", "receipt"],
            zones: {
              receipt: { ...prev.zones.receipt, hidden: false, compact: false, offsetX: 0, offsetY: 0, width: null, height: null },
              actions: { ...prev.zones.actions, hidden: false, offsetX: 0, offsetY: 0 },
              products: { ...prev.zones.products, hidden: false, compact: false, offsetX: 0, offsetY: 0, width: null, height: null },
            },
          };
        }
        setLeftWidth(clampLeftWidth(DEFAULT_LEFT_WIDTH));
        return {
          ...DEFAULT_POS_LAYOUT,
          locked: false,
        };
      });
    },
    [clampLeftWidth, updatePosLayout],
  );

  const startZoneDrag = useCallback(
    (zoneId: PosZoneId, e: PointerEvent<HTMLElement>) => {
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
      if (posLayout.locked) return;
      if ((e.target as HTMLElement).closest("button, input, select, textarea")) return;
      e.preventDefault();
      setActiveDragZone(safeZoneId);
      setDraggingSplit(true);
      const startX = e.clientX;
      const startY = e.clientY;
      const initialZone = posLayout.zones[safeZoneId];
      const baseX = initialZone.offsetX;
      const baseY = initialZone.offsetY;

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        const clampedX = Math.max(-360, Math.min(360, baseX + dx));
        const clampedY = Math.max(-240, Math.min(240, baseY + dy));
        updatePosLayout((prev) => ({
          ...prev,
          zones: {
            ...prev.zones,
            [safeZoneId]: {
              ...prev.zones[safeZoneId],
              offsetX: Math.round(clampedX),
              offsetY: Math.round(clampedY),
            },
          },
        }));
      };

      const onUp = () => {
        setActiveDragZone(null);
        setDraggingSplit(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [posLayout.locked, posLayout.zones, updatePosLayout],
  );

  const startZoneResize = useCallback(
    (zoneId: PosZoneId, e: PointerEvent<HTMLElement>) => {
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
      if (posLayout.locked) return;
      e.preventDefault();
      e.stopPropagation();
      setActiveDragZone(safeZoneId);
      setDraggingSplit(true);
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = e.currentTarget.parentElement?.getBoundingClientRect();
      const startW = posLayout.zones[safeZoneId].width ?? rect?.width ?? 400;
      const startH = posLayout.zones[safeZoneId].height ?? rect?.height ?? 320;

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const nextW = Math.max(160, Math.min(1100, Math.round(startW + (moveEvent.clientX - startX))));
        const nextH = Math.max(64, Math.min(900, Math.round(startH + (moveEvent.clientY - startY))));
        updatePosLayout((prev) => ({
          ...prev,
          zones: {
            ...prev.zones,
            [safeZoneId]: {
              ...prev.zones[safeZoneId],
              width: nextW,
              height: nextH,
            },
          },
        }));
      };

      const onUp = () => {
        setActiveDragZone(null);
        setDraggingSplit(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [posLayout.locked, posLayout.zones, updatePosLayout],
  );

  const [calcOpen, setCalcOpen] = useState(false);
  const [quickPriceOpen, setQuickPriceOpen] = useState(false);
  const [quickWeightOpen, setQuickWeightOpen] = useState(false);
  const anySubModal = calcOpen || quickPriceOpen || quickWeightOpen;

  const routed = location.state as { returnNumber?: string; pickup?: string; fulfil?: string } | null;
  const returnNumber = routed?.returnNumber;
  const pickup = routed?.pickup;
  const fulfil = routed?.fulfil;
  const [dialog, setDialog] = useState<PosDialog | null>(() =>
    returnNumber
      ? { kind: "return", number: returnNumber }
      : pickup
        ? { kind: "pickup", ticketId: pickup }
        : fulfil
          ? { kind: "fulfil", orderId: fulfil }
          : null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [text, setText] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [weighing, setWeighing] = useState<Weighing | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const docLang = company.data?.defaultDocLang ?? session.lang;
  const empty = lines.length === 0;

  const prevLinesLengthRef = useRef<number>(lines.length);
  const [lastActivityAt, setLastActivityAt] = useState<number>(() => Date.now());
  const [waitingForNextItem, setWaitingForNextItem] = useState(false);
  const [idleRoaming, setIdleRoaming] = useState(false);
  const [roamPercent, setRoamPercent] = useState(0);
  const [justAddedPulse, setJustAddedPulse] = useState(false);

  useEffect(() => {
    const onResize = () => {
      setLeftWidth((prev) => clampLeftWidth(prev));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampLeftWidth]);

  const togglePin = useCallback(() => {
    setSplitPinned((prev) => {
      const next = !prev;
      rememberSplitPinned(next);
      return next;
    });
  }, []);

  const toggleRailCollapsed = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      rememberRailCollapsed(next);
      updatePosLayout((layoutPrev) => ({
        ...layoutPrev,
        zones: {
          ...layoutPrev.zones,
          actions: {
            ...layoutPrev.zones.actions,
            compact: next,
          },
        },
      }));
      return next;
    });
  }, [updatePosLayout]);

  const handleDividerPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (splitPinned || posLayout.locked) {
        toast.info("التقسيم مثبت — فك التثبيت أو القفل أولاً لتغيير العرض");
        return;
      }
      e.preventDefault();
      setDraggingSplit(true);
      const startX = e.clientX;
      const startWidth = clampLeftWidth(leftWidth);

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextWidth = clampLeftWidth(startWidth + deltaX);
        setLeftWidth(nextWidth);
      };

      const onUp = (upEvent: globalThis.PointerEvent) => {
        const deltaX = upEvent.clientX - startX;
        const finalWidth = clampLeftWidth(startWidth + deltaX);
        setLeftWidth(finalWidth);
        rememberSplitWidth(finalWidth);
        setDraggingSplit(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clampLeftWidth, leftWidth, posLayout.locked, splitPinned],
  );

  useEffect(() => {
    const grew = lines.length > prevLinesLengthRef.current;
    prevLinesLengthRef.current = lines.length;
    setLastActivityAt(Date.now());
    setWaitingForNextItem(false);
    setIdleRoaming(false);
    setRoamPercent(0);

    if (!grew) return;
    setJustAddedPulse(true);
    const pulseTimer = window.setTimeout(() => {
      setJustAddedPulse(false);
    }, 650);
    return () => window.clearTimeout(pulseTimer);
  }, [lines.length]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - lastActivityAt;
      const hasOpenCart = lines.length > 0;
      setWaitingForNextItem(hasOpenCart && elapsed >= PAUSE_WAIT_THRESHOLD_MS);

      const shouldRoam =
        !hasOpenCart && dialog === null && !anySubModal && !approval.pending && elapsed >= IDLE_ROAM_THRESHOLD_MS;
      setIdleRoaming(shouldRoam);
      if (shouldRoam) {
        const nextRandom = Math.round(8 + Math.random() * 68);
        setRoamPercent(nextRandom);
      } else {
        setRoamPercent(0);
      }
    }, 2500);

    return () => window.clearInterval(timer);
  }, [anySubModal, approval.pending, dialog, lastActivityAt, lines.length]);

  useEffect(() => {
    if (empty) useCart.getState().setLang(docLang);
  }, [docLang, empty]);

  useEffect(() => {
    if (dialog === null && !anySubModal && !approval.pending) scanRef.current?.focus();
  }, [anySubModal, approval.pending, dialog]);

  useEffect(() => {
    if (returnNumber || pickup || fulfil) void navigate(location.pathname, { replace: true, state: null });
  }, [returnNumber, pickup, fulfil, location.pathname, navigate]);

  const notify = useCallback(
    (tone: Notice["tone"], message: string) => setNotice({ tone, text: message }),
    [],
  );

  const askSerials = useCallback(
    async (productId: string) => {
      const line = useCart.getState().selected;
      const packs = await loadTillPacks();
      if (line !== null && (await packs.tracksSerials(queryClient, productId))) {
        setDialog((current) => current ?? { kind: "pack", view: { kind: "serial", line } });
      }
    },
    [queryClient],
  );

  const addProduct = useCallback(
    (product: TillProduct, qty: number, unitDecimals: number, separate = false) => {
      if (product.kind === "variant_parent") {
        if (modules.includes("variant_grid")) {
          setDialog({ kind: "pack", view: { kind: "variants", parent: product as ProductHit } });
          return;
        }
        beep("error");
        notify("error", t("pos:scan.variantParent"));
        return;
      }
      useCart.getState().addProduct({
        productId: product.id,
        qty,
        display: {
          name: localizedName(product, lang),
          unitCode: product.unitCode,
          unitDecimals,
          price: product.sellPrice,
          latinName: product.nameFr.trim() || product.nameEn.trim(),
        },
        separate,
      });
      beep("ok");
      setNotice(null);
      if (modules.includes("serials")) void askSerials(product.id).catch(() => undefined);
    },
    [askSerials, lang, modules, notify, t],
  );

  const handleQuickPriceSubmit = useCallback(
    async ({ unitPrice, customName }: { unitPrice: number; customName?: string }) => {
      const trimmedName = (customName ?? "").trim();
      const finalName = trimmedName || DEFAULT_NO_BARCODE_NAME;

      if (!trimmedName) {
        try {
          const hit = await findByCode.mutateAsync(NO_BARCODE_LOOKUP_CODE);
          if (hit) {
            const hitName = localizedName(hit.product, lang).trim() || DEFAULT_NO_BARCODE_NAME;
            useCart.getState().addLine(
              {
                productId: hit.product.id,
                description: hitName,
                qty: 1_000,
                unitPrice,
                discount: { kind: "none" },
                taxRateId: defaultTaxRateId,
                note: null,
                expectedUnitPrice: unitPrice,
              },
              {
                name: hitName,
                unitCode: hit.product.unitCode || "PCS",
                unitDecimals: unitDecimalsOf(hit.product, units),
                price: unitPrice,
                latinName: hit.product.nameFr.trim() || hit.product.nameEn.trim() || hitName,
              },
            );
            beep("ok");
            setNotice(null);
            return;
          }
        } catch {
          // Fallback to open item line
        }
      }

      useCart.getState().addLine(
        {
          productId: null,
          description: finalName,
          qty: 1_000,
          unitPrice,
          discount: { kind: "none" },
          taxRateId: defaultTaxRateId,
          note: null,
          expectedUnitPrice: null,
        },
        {
          name: finalName,
          unitCode: "PCS",
          unitDecimals: 0,
          price: unitPrice,
          latinName: finalName,
        },
      );
      beep("ok");
      setNotice(null);
    },
    [defaultTaxRateId, findByCode, lang, units],
  );

  const handleQuickWeightSubmit = useCallback(
    async ({ weightValue, barcode }: { weightValue: number; barcode: string }) => {
      const qtyThousandths =
        weightValue < 10 && !Number.isInteger(weightValue)
          ? Math.round(weightValue * 1_000)
          : Math.round(weightValue);
      if (qtyThousandths <= 0) {
        toast.error("الوزن غير صالح");
        return;
      }

      try {
        const hit = await findByCode.mutateAsync(barcode);
        if (!hit) {
          beep("error");
          toast.error(`لم يتم العثور على باركود: ${barcode}`);
          return;
        }
        addProduct(hit.product, qtyThousandths, 3, false);
      } catch (error) {
        beep("error");
        toast.error(errorText(error));
      }
    },
    [addProduct, errorText, findByCode],
  );

  const addHit = useCallback(
    (hit: ScanHit) => {
      addProduct(hit.product, hit.packQty, unitDecimalsOf(hit.product, units), false);
      if (hit.scale && hit.scale.difference !== 0) {
        notify(
          "info",
          t("pos:scan.scaleDifference", { amount: formatDZD(Math.abs(hit.scale.difference), lang) }),
        );
      }
    },
    [addProduct, lang, notify, t, units],
  );

  const addWeighed = useCallback(
    ({ product, reading }: WeighedAdd) => {
      addProduct(product, reading.net, 3, false);
      setDialog(null);
    },
    [addProduct],
  );

  const addTile = useCallback(
    (hit: ProductHit) => addProduct(hit, 1_000, unitDecimalsOf(hit, units)),
    [addProduct, units],
  );

  const pickProduct = useCallback(
    (hit: ProductHit) => {
      setText("");
      addTile(hit);
    },
    [addTile],
  );

  const lookup = useCallback(
    async (code: string) => {
      setText("");
      try {
        const hit = await findByCode.mutateAsync(code);
        const packCode =
          !hit && modules.some((m) => VOUCHER_MODULES.includes(m))
            ? await (await loadTillPacks()).readPackCode(code, modules, t, lang)
            : null;
        if (hit) {
          addHit(hit);
        } else if (packCode) {
          if (packCode.customerId) useCart.getState().setCustomer(packCode.customerId);
          beep("ok");
          notify("info", packCode.notice);
        } else if (lan.isTill && lan.online) {
          const hits = await searchHost.mutateAsync({
            text: code,
            limit: 5,
            categoryId: null,
            includeArchived: false,
          });
          if (hits.length > 0) {
            notify("info", t("sync:lan.shell.foundOnHost"));
            syncNow.mutate();
          } else {
            beep("error");
            notify("error", t("sync:lan.shell.notFoundAnywhere"));
          }
        } else {
          beep("error");
          notify("error", t("pos:scan.notFound", { code }));
        }
      } catch (error) {
        beep("error");
        notify("error", errorText(error));
      }
    },
    [addHit, errorText, findByCode, lan.isTill, lan.online, lang, modules, notify, searchHost, syncNow, t],
  );

  const onScan = (code: string) => {
    if (approval.pending || anySubModal) return;
    if (quickPaying.current) {
      beep("error");
      return;
    }
    if (dialog === null) {
      void lookup(code);
    } else if (dialog.kind === "done") {
      setDialog(null);
      void lookup(code);
    } else {
      beep("error");
      toast.warning(t("pos:scan.closeDialog"));
    }
  };
  const ownScanField = dialog?.kind === "return" || dialog?.kind === "price" || dialog?.kind === "quote";
  useScanner(onScan, { ...scanner, enabled: till.data !== null && !ownScanField && !anySubModal });
  useSerialScans(onScan, till.data !== null && !ownScanField && !anySubModal);
  useCustomerDisplayFeed(dialog?.kind === "scale" ? weighing : null);

  const journaling = useRef(false);
  const runApproved = approval.run;

  const voidLine = useCallback(
    async (index: number): Promise<boolean> => {
      const state = useCart.getState();
      const draft = state.lines[index];
      if (!draft || journaling.current) return false;

      if (!draft.line.productId) {
        state.remove(index);
        return true;
      }

      const event = { kind: "line_voided", cart: toCart(state), index } as const;
      journaling.current = true;
      setIsVoiding(true);
      try {
        await runApproved(() => recordEvent.mutateAsync(event));
        const now = useCart.getState();
        const at = now.lines.findIndex((l) => l.key === draft.key);
        if (at >= 0) now.remove(at);
        return true;
      } catch (error) {
        if (!isApprovalCancelled(error)) notify("error", errorText(error));
        return false;
      } finally {
        journaling.current = false;
        setIsVoiding(false);
      }
    },
    [errorText, notify, recordEvent, runApproved],
  );

  useEffect(() => {
    if (dialog !== null || anySubModal || approval.pending || quickBusy || isVoiding) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const currentSelected = useCart.getState().selected;
      if (currentSelected === null || !useCart.getState().lines[currentSelected]) return;
      event.preventDefault();
      void voidLine(currentSelected);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anySubModal, approval.pending, dialog, isVoiding, quickBusy, voidLine]);

  const reduceQty = useCallback(
    async (index: number, qty: number): Promise<boolean> => {
      const state = useCart.getState();
      const draft = state.lines[index];
      if (!draft || journaling.current || qty <= 0 || qty >= draft.line.qty) return false;
      const event = { kind: "qty_reduced", cart: toCart(state), index, qty } as const;
      journaling.current = true;
      try {
        await runApproved(() => recordEvent.mutateAsync(event));
        const now = useCart.getState();
        const at = now.lines.findIndex((l) => l.key === draft.key);
        if (at >= 0) now.setQty(at, qty);
        return true;
      } catch (error) {
        if (!isApprovalCancelled(error)) notify("error", errorText(error));
        return false;
      } finally {
        journaling.current = false;
      }
    },
    [errorText, notify, recordEvent, runApproved],
  );

  const cancelSale = useCallback(async () => {
    const state = useCart.getState();
    if (state.lines.length === 0 || journaling.current) return;
    const event = { kind: "cart_cancelled", cart: toCart(state) } as const;
    journaling.current = true;
    try {
      await runApproved(() => recordEvent.mutateAsync(event));
      useCart.getState().clear(docLang);
      notify("info", t("pos:cancelled"));
    } catch (error) {
      if (!isApprovalCancelled(error)) notify("error", errorText(error));
    } finally {
      journaling.current = false;
    }
  }, [docLang, errorText, notify, recordEvent, runApproved, t]);

  const recallCart = recall.mutateAsync;
  const recallHeld = useCallback(
    async (id: string) => {
      if (useCart.getState().lines.length > 0) {
        notify("error", t("pos:held.busy"));
        return;
      }
      if (useCart.getState().exchange) {
        notify("error", t("pos:returns.exchangeFirst"));
        return;
      }
      const recalled = await recallCart(id);
      loadRecalled(recalled, notify, t);
      setDialog((current) => (current?.kind === "held" ? null : current));
    },
    [notify, recallCart, t],
  );

  const openDialog = useCallback(
    (next: PosDialog) => {
      if ((next.kind === "hold" || next.kind === "held") && useCart.getState().exchange) {
        notify("error", t("pos:returns.exchangeFirst"));
        return;
      }
      setDialog(next);
    },
    [notify, t],
  );

  const hold = () => {
    if (useCart.getState().lines.length === 0) notify("info", t("pos:hold.empty"));
    else openDialog({ kind: "hold" });
  };

  const commitDone = useCommitDone((done) => setDialog({ kind: "done", done }));

  const takePayment = async () => {
    const fixed = tillPayment.fixed;
    if (quickPaying.current) return;
    if (!fixed || useCart.getState().exchange || !hardware.isSuccess) {
      setDialog({ kind: "pay" });
      return;
    }
    quickPaying.current = true;
    setQuickBusy(true);
    let tenders: Tender[] | undefined;
    try {
      const customerId = useCart.getState().customerId;
      const customerLang = customerId ? (await fetchCustomer(customerId)).lang : null;
      if (customerLang) useCart.getState().setLang(customerLang);
      const cart = toCart(useCart.getState());
      const due = await previewSale({ cart, tenders: [], storeCredit: null });
      const tender = newTender(
        fixed.method,
        formatAmountInput(exactAmount(fixed.method, due.settlement), lang),
      );
      tenders = [
        fixed.type
          ? { ...tender, type: { id: fixed.type.id, name: localizedName(fixed.type, lang) } }
          : tender,
      ];
      const inputs = toInputs(tenders) ?? [];
      const check = await previewSale({ cart, tenders: inputs, storeCredit: null });
      if (check.settlement.missing !== 0) {
        setDialog({ kind: "pay", tenders });
        return;
      }
      const done = await finishSale.finish({
        tenders,
        inputs,
        printReceipt: receiptByDefault(hardware.data),
        exchange: null,
      });
      if (done) commitDone(done);
    } catch (error) {
      if (!isApprovalCancelled(error)) setDialog({ kind: "pay", tenders, error });
    } finally {
      quickPaying.current = false;
      setQuickBusy(false);
    }
  };

  const pay = () => {
    if (useCart.getState().lines.length === 0 || preview.error || quickPaying.current) return;
    const steps = modules.some((m) => CHECKOUT_MODULES.includes(m));
    if (steps) setDialog({ kind: "pack", view: { kind: "checkout" } });
    else void takePayment();
  };

  const toggleDepartments = () => {
    rememberDepartments(!departments);
    setDepartmentsOn(!departments);
  };
  const flexy = () => setDialog({ kind: "pack", view: { kind: "flexy" } });

  const handlers: Partial<Record<TillAction, () => void>> = {
    help: () => setDialog({ kind: "help" }),
    search: () => scanRef.current?.focus(),
    customer: () => setDialog({ kind: "customer" }),
    price_check: () => setDialog({ kind: "price" }),
    discount: () => setDialog({ kind: "discount" }),
    hold,
    held: () => openDialog({ kind: "held" }),
    return: () => setDialog({ kind: "return" }),
    drawer: () => setDialog({ kind: "drawer" }),
    repeat_last: () => useCart.getState().repeatLast(),
    checkout: pay,
    menu: () => setDialog({ kind: "menu" }),
  };
  if (modules.includes("restaurant")) handlers.floor = () => void navigate("/pos/floor");
  if (modules.includes("flexy")) handlers.flexy = flexy;
  if (modules.includes("department_keys")) handlers.department_keys = toggleDepartments;
  if (modules.includes("gift_vouchers") && can("sales.create")) {
    handlers.gift_voucher = () => setDialog({ kind: "giftVoucher" });
  }
  if (modules.includes("serials")) {
    handlers.serial = () => {
      const line = useCart.getState().selected;
      if (line !== null) setDialog({ kind: "pack", view: { kind: "serial", line } });
    };
  }
  const bound = (Object.keys(DEFAULT_KEYS) as TillAction[]).filter((action) => handlers[action]);
  const hotkeys: Partial<Record<Hotkey, () => void>> = { F11: () => setDialog({ kind: "scale" }) };
  for (const action of bound) hotkeys[keys[action]] = handlers[action];
  const activeHotkeys: Record<string, () => void> = {};
  for (const [hotkeyKey, handlerFn] of Object.entries(hotkeys)) {
    if (hotkeyKey && handlerFn) {
      activeHotkeys[hotkeyKey] = handlerFn;
    }
  }
  useHotkeys(activeHotkeys, dialog === null && !anySubModal && !approval.pending && !quickBusy);

  const cap = (action: TillAction) => ({
    shortcut: ariaKey(keys[action]),
    shortcutLabel: keyLabel(keys[action], t),
  });

  useCtrlHotkey(
    "d",
    () => openDialog({ kind: "quote" }),
    dialog === null && !anySubModal && !approval.pending && can("sales.create"),
  );

  const ctx: PosContext = {
    session,
    preview: preview.data,
    run: approval.run,
    voidLine,
    reduceQty,
    cancelSale,
    recallHeld,
    notify,
    open: openDialog,
    categoryId: category,
    addWeighed,
    onWeighing: setWeighing,
    modules,
    keys,
    actions: bound,
    addProduct,
    checkoutDone: () => {
      setDialog(null);
      void takePayment();
    },
    toggleDepartments,
  };

  const replaceLine = async (index: number, generic: TillProduct) => {
    const draft = useCart.getState().lines[index];
    if (!draft) return;
    if (await voidLine(index)) addProduct(generic, draft.line.qty, unitDecimalsOf(generic, units));
  };

  const refocus = (event: PointerEvent<HTMLDivElement>) => {
    if (dialog !== null || anySubModal || approval.pending || draggingSplit) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    window.setTimeout(() => {
      if (!document.querySelector("[role='dialog']")) scanRef.current?.focus();
    }, 0);
  };

  void priced;
  const selectedLine = selected !== null ? lines[selected] : undefined;
  const selectedSubtotal =
    selectedLine !== undefined
      ? Math.round((selectedLine.display.price * selectedLine.line.qty) / 1_000)
      : 0;
  const needsOwnerApproval = !can("sales.void_line");

  const itemCount = lines.length;
  const cycleStep = itemCount === 0 ? 0 : ((itemCount - 1) % CART_TRACK_CAPACITY) + 1;
  const cyclePercent = itemCount === 0 ? 0 : Math.round((cycleStep / CART_TRACK_CAPACITY) * 100);
  const trackPercent = idleRoaming ? roamPercent : cyclePercent;
  const cartFillRatio = idleRoaming ? 0 : cycleStep / CART_TRACK_CAPACITY;

  const isHorizontalToolbar = posLayout.toolbarOrientation === "horizontal";
  const actionsCompact = isHorizontalToolbar ? false : (railCollapsed || posLayout.zones.actions.compact);

  const pos = cn(
    "text-sm [&_kbd]:ms-0",
    isHorizontalToolbar
      ? "h-10 shrink-0 flex-row gap-1.5 px-2.5"
      : cn("min-h-12 w-full flex-col gap-0.5", actionsCompact ? "px-1 [&_span]:sr-only" : "px-1.5"),
  );

  const actions = (
    <div
      className={cn(
        "flex gap-1.5",
        isHorizontalToolbar ? "flex-row flex-wrap items-center justify-between w-full" : "flex-col",
      )}
    >
      <div
        className={cn(
          "flex gap-1.5",
          isHorizontalToolbar ? "flex-row flex-wrap items-center" : "flex-col",
        )}
      >
        {!isHorizontalToolbar ? (
          <button
            type="button"
            onClick={toggleRailCollapsed}
            title={actionsCompact ? "تمديد الشريط الوسطاني" : "تصغير الشريط الوسطاني"}
            aria-label={actionsCompact ? "تمديد الشريط الوسطاني" : "تصغير الشريط الوسطاني"}
            aria-expanded={!actionsCompact}
            className="mb-0.5 inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-line bg-surface text-xs font-semibold text-ink-2 transition-colors hover:border-brand hover:text-ink"
          >
            {actionsCompact ? (
              <ChevronRight aria-hidden className="size-4 rtl:rotate-180" />
            ) : (
              <>
                <ChevronLeft aria-hidden className="size-4 rtl:rotate-180" />
                <span>تصغير</span>
              </>
            )}
          </button>
        ) : null}

        <Button
          type="button"
          variant="secondary"
          className={pos}
          title="سعر سريع"
          onClick={() => setQuickPriceOpen(true)}
        >
          <Tag aria-hidden />
          <span>سعر سريع</span>
        </Button>
        <Button
          type="button"
          variant="secondary"
          className={pos}
          title="وزن سريع"
          onClick={() => setQuickWeightOpen(true)}
        >
          <Barcode aria-hidden />
          <span>وزن سريع</span>
        </Button>

        <div
          className={cn(
            isHorizontalToolbar ? "mx-1 h-6 w-px bg-line" : "my-0.5 border-t border-line",
          )}
        />

        <Button
          className={pos}
          title={t("pos:actions.customer")}
          onClick={() => setDialog({ kind: "customer" })}
          {...cap("customer")}
        >
          <User aria-hidden />
          <span>{t("pos:actions.customer")}</span>
        </Button>
        <Button
          className={pos}
          title={t("pos:actions.discount")}
          onClick={() => setDialog({ kind: "discount" })}
          {...cap("discount")}
        >
          <Percent aria-hidden />
          <span>{t("pos:actions.discount")}</span>
        </Button>
        <Button
          className={pos}
          title={t("pos:actions.hold")}
          onClick={hold}
          disabled={!can("sales.hold")}
          {...cap("hold")}
        >
          <Pause aria-hidden />
          <span>{t("pos:actions.hold")}</span>
        </Button>
        <Button
          className={pos}
          title={t("pos:actions.return")}
          onClick={() => setDialog({ kind: "return" })}
          {...cap("return")}
        >
          <Undo2 aria-hidden className="rtl:-scale-x-100" />
          <span>{t("pos:actions.return")}</span>
        </Button>
        <Button
          className={pos}
          title={t("pos:actions.drawer")}
          onClick={() => setDialog({ kind: "drawer" })}
          disabled={!can("cash.paid_in_out")}
          {...cap("drawer")}
        >
          <Wallet aria-hidden />
          <span>{t("pos:actions.drawer")}</span>
        </Button>
        <Button
          className={pos}
          title={t("pos:actions.menu")}
          onClick={() => setDialog({ kind: "menu" })}
          {...cap("menu")}
        >
          <Menu aria-hidden />
          <span>{t("pos:actions.menu")}</span>
        </Button>
      </div>
    </div>
  );

  const orderedZones: PosZoneId[] = [
    posLayout.order[0] ?? "receipt",
    posLayout.order[1] ?? "actions",
    posLayout.order[2] ?? "products",
  ];
  const heldCount = held.data?.length ?? 0;

  const closed = till.isSuccess && till.data === null;
  const closedView = (
    <div className="grid flex-1 place-items-center p-6">
      <EmptyState
        icon={Lock}
        title={t("pos:closed.title")}
        body={t("pos:closed.body")}
        action={
          <div className="flex gap-2">
            {can("cash.open") ? (
              <Button variant="primary" size="lg" onClick={() => setDialog({ kind: "openSession" })}>
                <Wallet aria-hidden />
                {t("pos:closed.open")}
              </Button>
            ) : null}
            <Button variant="outline" size="lg" onClick={() => void navigate(backOfficeHome(session))}>
              {t("pos:closed.back")}
            </Button>
          </div>
        }
      />
    </div>
  );

  const zoneMeta: Record<PosZoneId, { title: string; badge: string }> = useMemo(
    () => ({
      receipt: {
        title: "الإيصال",
        badge: `${lines.length} صنف`,
      },
      actions: {
        title: "أزرار الكاشير",
        badge: isHorizontalToolbar ? "أفقي" : "رأسي",
      },
      products: {
        title: "الباركود والمنتجات",
        badge: category ? "قسم محدد" : "الكل",
      },
    }),
    [category, isHorizontalToolbar, lines.length],
  );

  const hiddenZones = (["receipt", "actions", "products"] as PosZoneId[]).filter(
    (id) => posLayout.zones[id].hidden,
  );

  const renderZoneHeader = (zoneId: PosZoneId, extraRight?: React.ReactNode) => {
    const safeId: PosZoneId = zoneId ?? "receipt";
    const z = posLayout.zones[safeId];
    const isCompact = safeId === "actions" ? actionsCompact : z.compact;
    return (
      <div
        onPointerDown={(e) => startZoneDrag(safeId, e)}
        className={cn(
          "flex shrink-0 items-center justify-between gap-1.5 border-b border-line bg-surface-2/80 px-2.5 py-1.5 text-xs",
          !posLayout.locked && "cursor-move select-none",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {!posLayout.locked ? <Move aria-hidden className="size-3.5 shrink-0 text-ink-2" /> : null}
          <span className="truncate font-bold text-ink">{zoneMeta[safeId].title}</span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-ink-2">
            {zoneMeta[safeId].badge}
          </span>
          {extraRight}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={posLayout.locked}
            onClick={() => cycleZonePosition(safeId)}
            title="تبديل موضع الجزء"
            aria-label={`تبديل موضع ${zoneMeta[safeId].title}`}
            className="inline-flex size-6 items-center justify-center rounded border border-line bg-surface text-ink-2 transition-colors hover:border-brand hover:text-ink disabled:opacity-40"
          >
            <Layers aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => toggleZoneCompact(safeId)}
            title={isCompact ? "تمديد الجزء" : "تصغير الجزء"}
            aria-label={isCompact ? `تمديد ${zoneMeta[safeId].title}` : `تصغير ${zoneMeta[safeId].title}`}
            className="inline-flex size-6 items-center justify-center rounded border border-line bg-surface text-ink-2 transition-colors hover:border-brand hover:text-ink"
          >
            <Minimize2 aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            disabled={posLayout.locked}
            onClick={() => minimizeZoneToIcon(safeId)}
            title="إنزال كأيقونة في الصفحة"
            aria-label={`إنزال ${zoneMeta[safeId].title} كأيقونة`}
            className="inline-flex size-6 items-center justify-center rounded border border-line bg-surface text-ink-2 transition-colors hover:border-brand hover:text-ink disabled:opacity-40"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>
    );
  };

  const renderResizeHandle = (zoneId: PosZoneId) => {
    const safeId: PosZoneId = zoneId ?? "receipt";
    if (posLayout.locked) return null;
    return (
      <div
        onPointerDown={(e) => startZoneResize(safeId, e)}
        title="تمديد حر بالماوس"
        aria-label={`تمديد ${zoneMeta[safeId].title}`}
        className="absolute bottom-1 end-1 z-20 flex size-4 cursor-nwse-resize items-end justify-end rounded-sm bg-surface-2/90 p-0.5 text-ink-2 hover:bg-brand hover:text-brand-ink"
      >
        <span className="block size-2 border-b-2 border-e-2 border-current" />
      </div>
    );
  };

  const renderZoneCard = (zoneId: PosZoneId) => {
    const safeId: PosZoneId = zoneId ?? "receipt";
    const z = posLayout.zones[safeId];
    if (z.hidden) return null;

    const customStyle: React.CSSProperties = {
      transform:
        z.offsetX !== 0 || z.offsetY !== 0
          ? `translate3d(${z.offsetX}px, ${z.offsetY}px, 0)`
          : undefined,
      ...(z.width ? { width: `${z.width}px` } : {}),
      ...(z.height ? { height: `${z.height}px` } : {}),
    };

    if (safeId === "receipt") {
      const receiptWidth = z.width ?? leftWidth;
      return (
        <div
          key="receipt"
          dir="rtl"
          style={{
            width: `${receiptWidth}px`,
            ...(z.height ? { height: `${z.height}px` } : {}),
            transform: customStyle.transform,
          }}
          className={cn(
            "relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface transition-shadow",
            activeDragZone === "receipt" && "z-20 ring-2 ring-brand shadow-xl",
            z.compact && "max-h-44",
          )}
        >
          {renderZoneHeader("receipt")}
          <div className="flex min-h-0 flex-1">
            <CartPanel
              className="w-full"
              lines={lines}
              selected={selected}
              preview={preview.data}
              priced={priced}
              stale={preview.isPlaceholderData}
              error={preview.error}
              customer={<CustomerStrip session={session} onOpen={() => setDialog({ kind: "customer" })} />}
              onSelect={(index) => useCart.getState().select(index)}
              onEdit={(index) => setDialog({ kind: "edit", index })}
              notices={
                modules.includes("pharmacy")
                  ? (index, productId) => (
                      <Suspense fallback={null}>
                        <LineNotices
                          productId={productId}
                          onReplace={(generic) => void replaceLine(index, generic)}
                        />
                      </Suspense>
                    )
                  : undefined
              }
              onApproval={() =>
                void approval
                  .run(async () => {
                    const result = await preview.refetch();
                    if (result.error) throw result.error;
                    return result.data;
                  })
                  .catch(() => undefined)
              }
              payButton={
                <Button
                  variant="primary"
                  className="min-h-14 w-full text-2xl font-bold"
                  disabled={lines.length === 0 || Boolean(preview.error) || quickBusy}
                  onClick={pay}
                  {...cap("checkout")}
                >
                  {t("payments:pay")}
                </Button>
              }
              banner={
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCalcOpen(true)}
                    title="آلة حاسبة"
                    aria-label="آلة حاسبة"
                    className="inline-flex size-8 items-center justify-center rounded-md border border-line bg-surface-2 text-ink transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand"
                  >
                    <Calculator aria-hidden className="size-4" />
                  </button>
                  {withTables ? (
                    <Button variant="outline" onClick={() => void navigate("/pos/floor")}>
                      {t("pos:actions.tables")}
                    </Button>
                  ) : null}
                  {hardware.isSuccess ? (
                    <PrinterDot
                      configured={Boolean(hardware.data.receiptPrinterId)}
                      onOpen={() => openDialog({ kind: "unprinted" })}
                    />
                  ) : null}
                  <SyncPill session={session} />
                  {fromQuote ? (
                    <span role="status" className="rounded-full bg-info-soft px-3 py-1 font-semibold text-info">
                      {t("billing:offer.chip", { number: fromQuote.number })}
                    </span>
                  ) : null}
                  {exchange ? (
                    <span
                      role="status"
                      aria-label={t("pos:returns.exchangeActive")}
                      className="flex items-center gap-1 rounded-full bg-info-soft ps-3 font-semibold text-info"
                    >
                      {t("pos:returns.exchangeChip")} <Amount value={exchange.value} />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full"
                        aria-label={t("pos:returns.cancelExchange")}
                        title={t("pos:returns.cancelExchange")}
                        onClick={() => useCart.getState().startExchange(null)}
                      >
                        <X aria-hidden />
                      </Button>
                    </span>
                  ) : null}
                  {hardware.data?.scale ? (
                    <Button
                      variant="outline"
                      onClick={() => setDialog({ kind: "scale" })}
                      shortcut="F11"
                      shortcutLabel={t("common:keys.f11")}
                    >
                      <Scale aria-hidden />
                      {t("pos:weigh.title")}
                    </Button>
                  ) : null}
                  {heldCount > 0 ? (
                    <Button variant="outline" onClick={() => openDialog({ kind: "held" })} {...cap("held")}>
                      {t("pos:actions.held", { count: heldCount })}
                    </Button>
                  ) : null}
                </div>
              }
              actions={null}
              actionsCollapsed={actionsCompact}
            />
          </div>
          {renderResizeHandle("receipt")}
        </div>
      );
    }

    if (safeId === "actions") {
      return (
        <div
          key="actions"
          dir="rtl"
          style={customStyle}
          className={cn(
            "relative flex shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface-2/80 transition-shadow",
            isHorizontalToolbar ? "w-full" : actionsCompact ? "w-14" : "w-36",
            activeDragZone === "actions" && "z-20 ring-2 ring-brand shadow-xl",
          )}
        >
          {renderZoneHeader(
            "actions",
            <button
              type="button"
              onClick={toggleToolbarOrientation}
              title={isHorizontalToolbar ? "تحويل الشريط لعمودي" : "تمديد الشريط أفقياً"}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-ink hover:border-brand"
            >
              {isHorizontalToolbar ? "رأسي" : "أفقي"}
            </button>,
          )}
          <div className="p-1.5">{actions}</div>
          {renderResizeHandle("actions")}
        </div>
      );
    }

    return (
      <main
        key="products"
        dir="rtl"
        style={customStyle}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto rounded-lg border border-line bg-surface/40 p-4 transition-shadow",
          activeDragZone === "products" && "z-20 ring-2 ring-brand shadow-xl",
          z.compact && "max-h-48",
        )}
      >
        <div className="-mx-4 -mt-4 mb-1">{renderZoneHeader("products")}</div>
        <ScanField
          inputRef={scanRef}
          value={text}
          onValueChange={setText}
          multiplier={multiplier}
          onCode={(code) => void lookup(code)}
          onEmptyEnter={tillPayment.fixed ? pay : undefined}
          onPick={pickProduct}
          onMultiplier={(qty) => useCart.getState().setMultiplier(qty)}
          onBump={(direction) => {
            const state = useCart.getState();
            const index = state.selected;
            const line = index === null ? undefined : state.lines[index];
            if (index === null || !line) return;
            if (direction === 1) state.bump(index, 1);
            else if (line.line.qty > 1_000) void reduceQty(index, line.line.qty - 1_000);
          }}
          onVoid={() => {
            const index = useCart.getState().selected;
            if (index !== null) void voidLine(index);
          }}
          onMove={(delta) => useCart.getState().move(delta)}
        />
        <div
          className={cn(
            "relative flex h-9 items-center overflow-hidden rounded-control border border-line bg-surface-2/70 px-3 transition-colors",
            justAddedPulse && "border-primary/50 bg-surface-2",
          )}
        >
          <div className="pointer-events-none absolute inset-x-3 top-1/2 h-0.5 -translate-y-1/2 bg-line/60" />
          <div
            className="relative z-10 flex items-center gap-1.5 text-ink transition-all duration-500 ease-out"
            style={{ marginInlineStart: `${trackPercent}%` }}
          >
            <SupermarketCartIcon
              fillRatio={cartFillRatio}
              roaming={idleRoaming}
              justAdded={justAddedPulse}
            />
            <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-ink-2">
              {idleRoaming ? "خمول" : `${cyclePercent}%`}
            </span>
          </div>
          {waitingForNextItem ? (
            <span
              role="status"
              className="ms-auto inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-0.5 text-xs font-semibold text-warning animate-pulse"
            >
              <Clock aria-hidden className="h-3.5 w-3.5" />
              بانتظار الصنف التالي
            </span>
          ) : null}
        </div>
        {selectedLine ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface-2/80 px-3 py-2 transition-colors">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate font-semibold">{selectedLine.display.name}</span>
              <span className="rounded-full bg-surface px-2.5 py-0.5 text-sm font-semibold text-ink-2">
                <bdi dir="ltr">
                  {formatQty(selectedLine.line.qty, lang)} {selectedLine.display.unitCode}
                </bdi>
              </span>
              <span className="rounded-full bg-surface px-2.5 py-0.5 text-sm font-bold text-ink">
                <Amount value={selectedSubtotal} />
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
                  needsOwnerApproval
                    ? "bg-warning-soft text-warning"
                    : "bg-info-soft text-info",
                )}
              >
                {needsOwnerApproval ? (
                  <>
                    <KeyRound aria-hidden className="h-3.5 w-3.5" />
                    موافقة المالك
                  </>
                ) : (
                  <>
                    <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
                    صلاحية مفعلة
                  </>
                )}
              </span>
              <Button
                type="button"
                variant="danger"
                disabled={approval.pending || quickBusy || isVoiding}
                onClick={() => {
                  if (selected !== null) void voidLine(selected);
                }}
                shortcut="Delete"
                shortcutLabel="Delete"
              >
                {isVoiding ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <Trash2 aria-hidden />
                )}
                حذف
              </Button>
            </div>
          </div>
        ) : null}
        {notice ? (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "rounded-control p-3 font-semibold",
              notice.tone === "error" ? "bg-danger-soft text-danger" : "bg-info-soft text-info",
            )}
          >
            {notice.text}
          </p>
        ) : lastScan ? (
          <p className="flex items-center justify-between rounded-control bg-surface p-3 text-lg">
            <span>{t("pos:lastScan", { name: lastScan.name })}</span>
            <Amount value={lastScan.price} className="font-bold" />
          </p>
        ) : null}
        {modules.includes("department_keys") || modules.includes("flexy") ? (
          <div className="flex flex-wrap gap-2">
            {modules.includes("department_keys") ? (
              <Button
                variant={departments ? "secondary" : "outline"}
                aria-pressed={departments}
                onClick={toggleDepartments}
                {...cap("department_keys")}
              >
                {t("pos:actions.departments")}
              </Button>
            ) : null}
            {modules.includes("flexy") ? (
              <Button variant="outline" onClick={flexy} {...cap("flexy")}>
                {t("pos:actions.flexy")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {departments ? (
          <Suspense fallback={null}>
            <DepartmentKeysPanel />
          </Suspense>
        ) : (
          <ProductGrid onPick={pickProduct} category={category} onCategory={setCategory} />
        )}
        {renderResizeHandle("products")}
      </main>
    );
  };

  return (
    <div
      className={cn(
        "relative flex h-dvh flex-col bg-bg text-[1.125rem] text-ink",
        draggingSplit && "select-none",
      )}
      onPointerUp={refocus}
    >
      <DemoRibbon />
      <BackupAlerts session={session} />
      <LanBanner />
      {van ? (
        <Suspense fallback={null}>
          <VanBanner />
        </Suspense>
      ) : null}

      <div
        dir="rtl"
        className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/80 px-3 py-1.5 text-xs"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={toggleLayoutLock}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border px-2 font-semibold transition-colors",
              posLayout.locked
                ? "border-amber-500 bg-amber-500 text-slate-950"
                : "border-line bg-surface text-ink hover:border-brand",
            )}
          >
            {posLayout.locked ? <Pin aria-hidden className="size-3.5" /> : <PinOff aria-hidden className="size-3.5" />}
            <span>{posLayout.locked ? "مثبّت" : "تعديل حر"}</span>
          </button>

          <button
            type="button"
            onClick={() => swapZones("receipt", "products")}
            disabled={posLayout.locked}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 font-semibold text-ink hover:border-brand disabled:opacity-40"
          >
            <Layers aria-hidden className="size-3.5" />
            <span>تبديل الإيصال والمنتجات</span>
          </button>

          <button
            type="button"
            onClick={toggleToolbarOrientation}
            disabled={posLayout.locked}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 font-semibold text-ink hover:border-brand disabled:opacity-40"
          >
            <span>{isHorizontalToolbar ? "أزرار رأسية" : "أزرار أفقية"}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => applyPreset("default")}
            disabled={posLayout.locked}
            className="h-7 rounded-md border border-line bg-surface px-2 font-semibold text-ink-2 hover:border-brand hover:text-ink disabled:opacity-40"
          >
            افتراضي
          </button>
          <button
            type="button"
            onClick={() => applyPreset("receipt_focus")}
            disabled={posLayout.locked}
            className="h-7 rounded-md border border-line bg-surface px-2 font-semibold text-ink-2 hover:border-brand hover:text-ink disabled:opacity-40"
          >
            تركيز الإيصال
          </button>
          <button
            type="button"
            onClick={() => applyPreset("products_focus")}
            disabled={posLayout.locked}
            className="h-7 rounded-md border border-line bg-surface px-2 font-semibold text-ink-2 hover:border-brand hover:text-ink disabled:opacity-40"
          >
            تركيز المنتجات
          </button>
          <button
            type="button"
            onClick={() => applyPreset("default")}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 font-semibold text-ink hover:border-brand"
          >
            <RotateCcw aria-hidden className="size-3.5" />
            <span>استعادة</span>
          </button>
        </div>
      </div>

      {closed ? (
        closedView
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            ref={splitContainerRef}
            dir="ltr"
            className={cn(
              "relative flex min-h-0 flex-1 gap-2 overflow-hidden p-2",
              isHorizontalToolbar ? "flex-col" : "flex-row",
            )}
          >
            {!isHorizontalToolbar ? (
              <div
                style={{ left: `${leftWidth}px` }}
                className={cn(
                  "pointer-events-auto fixed inset-y-0 z-30 flex w-2 -translate-x-1/2 flex-col items-center border-x border-line bg-surface-2/40 transition-colors",
                  !splitPinned && !posLayout.locked && "cursor-col-resize hover:bg-surface-2",
                  draggingSplit && "bg-surface-2",
                )}
                onPointerDown={handleDividerPointerDown}
              >
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={togglePin}
                  title={splitPinned ? "إلغاء تثبيت العرض" : "تثبيت العرض"}
                  aria-label={splitPinned ? "إلغاء تثبيت العرض" : "تثبيت العرض"}
                  aria-pressed={splitPinned}
                  className={cn(
                    "mt-2 inline-flex size-6 items-center justify-center rounded-md border shadow-xs transition-colors",
                    splitPinned
                      ? "border-amber-500 bg-amber-500 text-slate-950"
                      : "border-line bg-surface text-ink-2 hover:border-amber-500 hover:text-amber-500",
                  )}
                >
                  {splitPinned ? <Pin aria-hidden className="size-3.5" /> : <PinOff aria-hidden className="size-3.5" />}
                </button>
              </div>
            ) : null}

            {orderedZones.map((zoneId) => renderZoneCard(zoneId))}
          </div>

          {hiddenZones.length > 0 ? (
            <div
              dir="rtl"
              className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2/90 px-3 py-1.5 text-xs"
            >
              <span className="font-semibold text-ink-2">أجزاء مصغّرة كأيقونات (نشطة بالخلفية):</span>
              {hiddenZones.map((zoneId) => (
                <button
                  key={zoneId}
                  type="button"
                  onClick={() => restoreZone(zoneId)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-brand/50 bg-surface px-3 font-bold text-ink shadow-xs transition-colors hover:bg-brand hover:text-brand-ink"
                >
                  <span>{zoneMeta[zoneId].title}</span>
                  <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                    {zoneMeta[zoneId].badge}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}

      <QuickPriceModal
        open={quickPriceOpen}
        onClose={() => setQuickPriceOpen(false)}
        onSubmitPrice={handleQuickPriceSubmit}
      />
      <QuickWeightModal
        open={quickWeightOpen}
        onClose={() => setQuickWeightOpen(false)}
        onSubmitWeight={handleQuickWeightSubmit}
      />
      <PosCalculatorModal open={calcOpen} onClose={() => setCalcOpen(false)} />
      <PosDialogs dialog={dialog} onClose={() => setDialog(null)} ctx={ctx} />
      {approval.dialog}
    </div>
  );
}
