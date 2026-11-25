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
  Loader2,
  Lock,
  Menu,
  Pause,
  Percent,
  Pin,
  PinOff,
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
import { useUnits } from "@/lib/ipc/catalog";
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
import { formatQty } from "@/lib/numeric";
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

/** The modules whose sale needs something asked before the payment (serials, prescriptions, the
 * jeweller register's buyer). */
const CHECKOUT_MODULES: Module[] = ["serials", "pharmacy", "jewellery"];
/** The modules whose vouchers or deposits a code read at the till may be. */
const VOUCHER_MODULES: Module[] = ["gift_vouchers", "loyalty", "orders", "repairs"];

/** The department keys stay in place of the product grid on this till once chosen (VRT-001). */
const DEPARTMENTS_KEY = "dzpos.till.departments";
const SPLIT_WIDTH_KEY = "dzpos.till.splitWidth";
const SPLIT_PINNED_KEY = "dzpos.till.splitPinned";
const RAIL_COLLAPSED_KEY = "dzpos.till.railCollapsed";

const DEFAULT_NO_BARCODE_NAME = "صنف بدون باركود";
const NO_BARCODE_LOOKUP_CODE = "0000000000000";

const DEFAULT_LEFT_WIDTH = 520;
const MIN_LEFT_WIDTH = 340;
const MAX_LEFT_WIDTH = 780;
const MIN_RIGHT_WIDTH = 420;

const CART_TRACK_CAPACITY = 20;
const PAUSE_WAIT_THRESHOLD_MS = 12_000;
const IDLE_ROAM_THRESHOLD_MS = 20_000;

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
    // a blocked storage only forgets the choice at the next start
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

/** Safe recursive-descent math parser supporting +, -, *, /, parentheses, and decimals. */
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
  onSubmitPrice: (params: { price: number; customName?: string }) => Promise<void>;
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
    const parsed = Number(priceInput.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error("أدخل سعراً صحيحاً أكبر من صفر");
      priceRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const trimmed = nameInput.trim();
      await onSubmitPrice({
        price: parsed,
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
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-danger-soft hover:text-danger"
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
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-danger-soft hover:text-danger"
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
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-danger-soft hover:text-danger"
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

/** `/pos` (spec §10.5): full window, keyboard-first and barcode-first (UX-010, UX-016, SAL-012).
 * `withTables`: the restaurant's floor is one tap away (UX-020, the "mixed" till mode). */
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
  // on a till, a code unknown here may be a product the main PC created a moment ago
  const lan = useTillLink();
  const searchHost = useSearchHost();
  const syncNow = useSyncNow();
  const recordEvent = useRecordCartEvent();
  const recall = useRecallCart();
  const approval = useApproval();
  const preview = useCartPreview();
  const units = useUnits().data;
  // Settings › Payments: how this till takes payment (asked, or one method at once)
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
  // M8: the pack modules on, the till's keys (UX-017) and the van it sells from (VRT-101)
  const queryClient = useQueryClient();
  const modules = usePackModules();
  const keys = useKeyMap();
  const van = useExtras((s) => s.van);
  const [departmentsOn, setDepartmentsOn] = useState(rememberedDepartments);
  const departments = departmentsOn && modules.includes("department_keys");

  // Full-height split between left POS/receipt panel and right products/search panel
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState<number>(rememberedSplitWidth);
  const [splitPinned, setSplitPinned] = useState<boolean>(rememberedSplitPinned);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(rememberedRailCollapsed);
  const [draggingSplit, setDraggingSplit] = useState(false);

  // Calculator, quick price, and quick weight modals
  const [calcOpen, setCalcOpen] = useState(false);
  const [quickPriceOpen, setQuickPriceOpen] = useState(false);
  const [quickWeightOpen, setQuickWeightOpen] = useState(false);
  const anySubModal = calcOpen || quickPriceOpen || quickWeightOpen;

  // the sales history sends a ticket to take items back from (RET-002); the repair board, a ready
  // ticket to hand back (M8, `{ pickup: ticketId }`); an order's page, the order to serve (M8,
  // `{ fulfil: orderId }`)
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
  // F11's weight, shown on the customer display while the scale panel is open (VRT-010)
  const [weighing, setWeighing] = useState<Weighing | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const docLang = company.data?.defaultDocLang ?? session.lang;
  const empty = lines.length === 0;

  // Ambient supermarket cart track state: 0..100% cycle progress, pause waiting alert, and idle roaming
  const prevLinesLengthRef = useRef<number>(lines.length);
  const [lastActivityAt, setLastActivityAt] = useState<number>(() => Date.now());
  const [waitingForNextItem, setWaitingForNextItem] = useState(false);
  const [idleRoaming, setIdleRoaming] = useState(false);
  const [roamPercent, setRoamPercent] = useState(0);
  const [justAddedPulse, setJustAddedPulse] = useState(false);

  const clampLeftWidth = useCallback((desired: number): number => {
    const containerWidth = splitContainerRef.current?.clientWidth ?? window.innerWidth;
    const maxAllowedByViewport = Math.max(MIN_LEFT_WIDTH, containerWidth - MIN_RIGHT_WIDTH);
    const upper = Math.min(MAX_LEFT_WIDTH, maxAllowedByViewport);
    return Math.max(MIN_LEFT_WIDTH, Math.min(upper, desired));
  }, []);

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
      return next;
    });
  }, []);

  const handleDividerPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (splitPinned) {
        toast.info("التقسيم مثبت — فك الدبوس أولاً لتغيير العرض");
        return;
      }
      e.preventDefault();
      setDraggingSplit(true);
      const startX = e.clientX;
      const startWidth = clampLeftWidth(leftWidth);
      const isRtl = document.dir === "rtl" || window.getComputedStyle(document.body).direction === "rtl";

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextWidth = clampLeftWidth(isRtl ? startWidth - deltaX : startWidth + deltaX);
        setLeftWidth(nextWidth);
      };

      const onUp = (upEvent: globalThis.PointerEvent) => {
        const deltaX = upEvent.clientX - startX;
        const finalWidth = clampLeftWidth(isRtl ? startWidth - deltaX : startWidth + deltaX);
        setLeftWidth(finalWidth);
        rememberSplitWidth(finalWidth);
        setDraggingSplit(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clampLeftWidth, leftWidth, splitPinned],
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

  // an empty cart (a new sale) takes the shop's document language again, whatever the last
  // receipt was printed in
  useEffect(() => {
    if (empty) useCart.getState().setLang(docLang);
  }, [docLang, empty]);

  // focus returns to the scan field whenever no dialog holds it (UX-010)
  useEffect(() => {
    if (dialog === null && !anySubModal && !approval.pending) scanRef.current?.focus();
  }, [anySubModal, approval.pending, dialog]);

  // the ticket sent by the sales history (or the repair board, or an order's page) is consumed: the
  // screen mounting again on this history entry (after a lock, say) does not open it a second time
  useEffect(() => {
    if (returnNumber || pickup || fulfil) void navigate(location.pathname, { replace: true, state: null });
  }, [returnNumber, pickup, fulfil, location.pathname, navigate]);

  const notify = useCallback(
    (tone: Notice["tone"], message: string) => setNotice({ tone, text: message }),
    [],
  );

  // SAL-025: a product sold by serial asks one serial per piece as soon as it is rung up
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
        // SAL-023: the size × colour grid of the model, with the variant grid module
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

  // Quick price: if customName is provided, use it directly without pulling an internal name;
  // otherwise use "صنف بدون باركود" (and pull its DB product if registered, else fallback).
  const handleQuickPriceSubmit = useCallback(
    async ({ price, customName }: { price: number; customName?: string }) => {
      const scaledPrice = Math.round(price * 1_000);
      if (customName) {
        useCart.getState().addProduct({
          productId: "quick-price-custom",
          qty: 1_000,
          display: {
            name: customName,
            unitCode: "PCS",
            unitDecimals: 0,
            price: scaledPrice,
            latinName: customName,
          },
          separate: true,
        });
        beep("ok");
        setNotice(null);
        return;
      }

      try {
        const hit = await findByCode.mutateAsync(NO_BARCODE_LOOKUP_CODE);
        if (hit) {
          useCart.getState().addProduct({
            productId: hit.product.id,
            qty: 1_000,
            display: {
              name: localizedName(hit.product, lang) || DEFAULT_NO_BARCODE_NAME,
              unitCode: hit.product.unitCode,
              unitDecimals: unitDecimalsOf(hit.product, units),
              price: scaledPrice,
              latinName: hit.product.nameFr.trim() || hit.product.nameEn.trim() || DEFAULT_NO_BARCODE_NAME,
            },
            separate: true,
          });
          beep("ok");
          setNotice(null);
          return;
        }
      } catch {
        // Fallback when the fixed no-barcode item is not yet added to DB
      }

      useCart.getState().addProduct({
        productId: "quick-no-barcode",
        qty: 1_000,
        display: {
          name: DEFAULT_NO_BARCODE_NAME,
          unitCode: "PCS",
          unitDecimals: 0,
          price: scaledPrice,
          latinName: DEFAULT_NO_BARCODE_NAME,
        },
        separate: true,
      });
      beep("ok");
      setNotice(null);
    },
    [findByCode, lang, units],
  );

  // Quick weight: matches scale label reading (grams in thousandths, e.g. 500 -> 500, or 0.5 -> 500),
  // looks up product by barcode, multiplies unit/kg price by weight, and adds to cart.
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
        addProduct(hit.product, qtyThousandths, 3, true);
      } catch (error) {
        beep("error");
        toast.error(errorText(error));
      }
    },
    [addProduct, errorText, findByCode],
  );

  // A scale label (spec §8) is a package of its own: its line never merges with another. A price
  // label whose weight, to the gram, costs a few centimes more or less at the till says so (HW-030).
  const addHit = useCallback(
    (hit: ScanHit) => {
      addProduct(hit.product, hit.packQty, unitDecimalsOf(hit.product, units), hit.scale !== null);
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
      addProduct(product, reading.net, 3, true);
      setDialog(null);
    },
    [addProduct],
  );
  const addTile = useCallback(
    (hit: ProductHit) => addProduct(hit, 1_000, unitDecimalsOf(hit, units)),
    [addProduct, units],
  );
  // a product picked from the search results or the grid: whatever was typed is done with
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
        // M8: a loyalty card sets the ticket's customer; a voucher is spent at the payment
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

  // The scanner is read while a dialog is open too (HW-022): its Enter must never validate a
  // payment nor type a barcode into a card reference. After a sale, a scan starts the next one;
  // elsewhere the cashier is told to close the dialog first. The return and price-check dialogs
  // read scans in their own fields (`ScanInput`).
  const onScan = (code: string) => {
    if (approval.pending || anySubModal) return;
    // the "one method" checkout is finishing the cart on screen: a code read now would be lost
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
  // a scanner in USB-COM mode reads into the same lookup (HW-020); a dialog that reads its own
  // scans gets them in its scan field instead
  useSerialScans(onScan, till.data !== null && !ownScanField && !anySubModal);
  useCustomerDisplayFeed(dialog?.kind === "scale" ? weighing : null);

  // Voids and cancellations send the cart as it stands and the backend values it (AUD-001): a
  // preview may still hold an older cart, or none when it is refused. One at a time, so that a
  // held-down Delete cannot journal a line twice or remove a line nobody journaled.
  const journaling = useRef(false);
  const runApproved = approval.run;

  const voidLine = useCallback(
    async (index: number): Promise<boolean> => {
      const state = useCart.getState();
      const draft = state.lines[index];
      if (!draft || journaling.current) return false;
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

  // Delete key on keyboard removes the selected line (with owner approval via voidLine),
  // ignoring typing inside inputs/textareas/selects/contenteditable elements.
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

  // Lowering a line's quantity is a partial void (SAL-040): journaled with the backend's figures
  // and under `sales.void_line` before the line changes. `false` when refused or cancelled.
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

  // Spec §10.4 "Undo hold" and F7: a held ticket comes back into an empty cart only, since
  // loading it would replace the lines on screen without a journal row. This screen owns the
  // mutation because the hold dialog is gone by the time its toast is clicked.
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

  // A pending exchange belongs to this customer's ticket: holding or recalling a ticket now would
  // drop the return, or pay another customer's ticket with it.
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

  // Settings › Payments, "one method": the sale is finished at once in that method, for the exact
  // amount the backend asks (in cash, the stamp duty and the cash rounding included), through the
  // same path as the payment dialog's Valider. A pending exchange (its store credit), an unknown
  // printer default or a method that cannot settle the whole amount opens the dialog instead; a
  // refusal opens it on the tender tried, with the backend's answer.
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
      // UX-004: the receipt in the language of the customer's file, as the dialog prints it
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
        printReceipt: receiptByDefault
        (hardware.data),
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

  // "Encaisser": with a pack module that asks something of the sale (serials, a prescription, the
  // buyer of a jewel), its checkout steps come first (`till-packs.tsx`), then the payment
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

  // UX-017: every action through the till's key map; a pack action only while its module is on
  // (Ctrl+3, the gift voucher, is a pack dialog bound here)
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
  // LOY-001: a gift voucher sold from the till (a pack dialog, its key from the map)
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
  useHotkeys(hotkeys, dialog === null && !anySubModal && !approval.pending && !quickBusy);
  /** A button's keycap from the key map. */
  const cap = (action: TillAction) => ({
    shortcut: ariaKey(keys[action]),
    shortcutLabel: keyLabel(keys[action], t),
  });
  // SAL-046: a quote or proforma into the empty cart
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

  // Pharmacy: a cheaper generic replaces the line as a void (journaled, AUD-001) and a new line
  const replaceLine = async (index: number, generic: TillProduct) => {
    const draft = useCart.getState().lines[index];
    if (!draft) return;
    if (await voidLine(index)) addProduct(generic, draft.line.qty, unitDecimalsOf(generic, units));
  };

  // Focus goes back to the scan field after every tap on the screen (a tile, a line, a chip), so
  // the keyboard model (+, -, *, Del, typed codes) keeps working (UX-010).
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

  const pos = cn(
    "min-h-12 w-full flex-col gap-0.5 text-sm [&_kbd]:ms-0",
    railCollapsed ? "px-1 [&_span]:sr-only" : "px-1.5",
  );
  const actions = (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={toggleRailCollapsed}
        title={railCollapsed ? "تمديد الشريط الجانبي" : "طي الشريط الجانبي"}
        aria-label={railCollapsed ? "تمديد الشريط الجانبي" : "طي الشريط الجانبي"}
        aria-expanded={!railCollapsed}
        className="mb-0.5 inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-line bg-surface text-xs font-semibold text-ink-2 transition-colors hover:border-brand hover:text-ink"
      >
        {railCollapsed ? (
          <ChevronRight aria-hidden className="size-4 rtl:rotate-180" />
        ) : (
          <>
            <ChevronLeft aria-hidden className="size-4 rtl:rotate-180" />
            <span>طي</span>
          </>
        )}
      </button>

      {/* Quick actions at the top */}
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

      <div className="my-0.5 border-t border-line" />

      {/* Core POS actions below */}
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
  );

  const heldCount = held.data?.length ?? 0;
  // One tree for the open and the closed till, so the backup alerts (the "database damaged"
  // alert above all) keep their place and state when the till's state arrives.
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
      {closed ? (
        closedView
      ) : (
        <div ref={splitContainerRef} className="relative flex min-h-0 flex-1 overflow-hidden">
          {/* Full-height red divider spanning top-to-bottom across the entire screen */}
          <div
            style={{ insetInlineStart: `${leftWidth}px` }}
            className={cn(
              "pointer-events-auto fixed inset-y-0 z-30 flex w-2.5 -translate-x-1/2 flex-col items-center border-x-2 border-danger bg-danger/15 transition-colors rtl:translate-x-1/2",
              !splitPinned && "cursor-col-resize hover:bg-danger/25",
              draggingSplit && "bg-danger/30",
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
                  ? "border-danger bg-danger text-white"
                  : "border-line bg-surface text-ink-2 hover:border-danger hover:text-danger",
              )}
            >
              {splitPinned ? <Pin aria-hidden className="size-3.5" /> : <PinOff aria-hidden className="size-3.5" />}
            </button>
          </div>

          <div style={{ width: `${leftWidth}px` }} className="flex min-h-0 shrink-0">
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
                <div className="flex items-center gap-1.5">
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
              actions={actions}
              actionsCollapsed={railCollapsed}
            />
          </div>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
            <ScanField
              inputRef={scanRef}
              value={text}
              onValueChange={setText}
              multiplier={multiplier}
              onCode={(code) => void lookup(code)}
              // with one payment method set, Enter on the empty field pays like F12
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
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-danger/30 bg-surface-2/80 px-3 py-2 transition-colors">
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
          </main>
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
