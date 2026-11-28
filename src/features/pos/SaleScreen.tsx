import { useQueryClient } from "@tanstack/react-query";
import {
  Barcode,
  BookmarkCheck,
  Calculator,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  Delete,
  Equal,
  KeyRound,
  Loader2,
  Lock,
  Maximize2,
  Menu,
  Minimize2,
  Move,
  Pause,
  Percent,
  RotateCcw,
  Rows2,
  Scale,
  ShieldCheck,
  Tag,
  Trash2,
  Undo2,
  User,
  Volume2,
  VolumeX,
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
type CustomSlotId = "slot1" | "slot2";

type PosModeId =
  | "v_default"
  | "v_actions_top_right"
  | "v_receipt_center"
  | "v_products_left"
  | "v_receipt_right"
  | "v_actions_left"
  | "h_top_receipt_left"
  | "h_top_products_left"
  | "h_bottom_receipt_left"
  | "h_bottom_products_left"
  | "h_receipt_top_products_bottom"
  | "h_products_top_receipt_bottom"
  | "free_mode";

interface PosPresetDefinition {
  id: PosModeId;
  label: string;
  orientation: DockOrientation;
  order: [PosZoneId, PosZoneId, PosZoneId];
  leftWidth?: number;
}

const POS_MODES: PosPresetDefinition[] = [
  { id: "v_default", label: "1. افتراضي (رأسي)", orientation: "vertical", order: ["receipt", "actions", "products"], leftWidth: 500 },
  { id: "v_actions_top_right", label: "2. مفاتيح أعلى اليمين", orientation: "vertical", order: ["receipt", "products", "actions"], leftWidth: 460 },
  { id: "v_receipt_center", label: "3. الإيصال بالوسط", orientation: "vertical", order: ["products", "receipt", "actions"], leftWidth: 460 },
  { id: "v_products_left", label: "4. المنتجات يسار", orientation: "vertical", order: ["products", "actions", "receipt"], leftWidth: 460 },
  { id: "v_receipt_right", label: "5. الإيصال يمين", orientation: "vertical", order: ["actions", "products", "receipt"], leftWidth: 460 },
  { id: "v_actions_left", label: "6. مفاتيح يسار", orientation: "vertical", order: ["actions", "receipt", "products"], leftWidth: 460 },
  { id: "h_top_receipt_left", label: "7. أفقي: إيصال يسار", orientation: "horizontal", order: ["actions", "receipt", "products"], leftWidth: 500 },
  { id: "h_top_products_left", label: "8. أفقي: منتجات يسار", orientation: "horizontal", order: ["actions", "products", "receipt"], leftWidth: 500 },
  { id: "h_bottom_receipt_left", label: "9. أفقي سفلي: إيصال يسار", orientation: "horizontal", order: ["receipt", "products", "actions"], leftWidth: 500 },
  { id: "h_bottom_products_left", label: "10. أفقي سفلي: منتجات يسار", orientation: "horizontal", order: ["products", "receipt", "actions"], leftWidth: 500 },
  { id: "h_receipt_top_products_bottom", label: "11. إيصال علوي / منتجات سفلي", orientation: "horizontal", order: ["receipt", "actions", "products"], leftWidth: 520 },
  { id: "h_products_top_receipt_bottom", label: "12. منتجات علوي / إيصال سفلي", orientation: "horizontal", order: ["products", "receipt", "actions"], leftWidth: 520 },
  { id: "free_mode", label: "الوضع الحر", orientation: "vertical", order: ["receipt", "actions", "products"], leftWidth: 500 },
];

interface PosZoneState {
  compact: boolean;
  hidden: boolean;
  fullscreen: boolean;
  offsetX: number;
  offsetY: number;
  width: number | null;
  height: number | null;
}

interface PosLayoutConfig {
  mode: PosModeId;
  order: [PosZoneId, PosZoneId, PosZoneId];
  toolbarOrientation: DockOrientation;
  zones: Record<PosZoneId, PosZoneState>;
}

const CHECKOUT_MODULES: Module[] = ["serials", "pharmacy", "jewellery"];
const VOUCHER_MODULES: Module[] = ["gift_vouchers", "loyalty", "orders", "repairs"];

const DEPARTMENTS_KEY = "dzpos.till.departments";
const SPLIT_WIDTH_KEY = "dzpos.till.splitWidth";
const RAIL_COLLAPSED_KEY = "dzpos.till.railCollapsed";
const POS_LAYOUT_KEY = "dzpos.till.layout.v4";
const CUSTOM_SLOTS_KEY = "dzpos.till.customLayouts.v1";
const SOUND_CHIME_KEY = "dzpos.till.softChime.v1";

const DEFAULT_NO_BARCODE_NAME = "صنف بدون باركود";
const NO_BARCODE_LOOKUP_CODE = "0000000000000";

const DEFAULT_LEFT_WIDTH = 500;
const MIN_LEFT_WIDTH = 280;
const MAX_LEFT_WIDTH = 920;
const MIN_RIGHT_WIDTH = 300;

const POS_3D_BTN =
  "border border-line/90 shadow-[0_3px_0_0_rgba(15,23,42,0.22),0_4px_10px_-2px_rgba(15,23,42,0.18)] transition-all duration-150 hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[0_1px_0_0_rgba(15,23,42,0.2)]";

const POS_3D_PRIMARY =
  "border border-amber-500/80 bg-amber-400 text-slate-950 shadow-[0_4px_0_0_rgb(180,83,9),0_8px_16px_-4px_rgba(245,158,11,0.45)] transition-all duration-150 hover:-translate-y-0.5 hover:bg-amber-300 active:translate-y-0.5 active:shadow-[0_1px_0_0_rgb(180,83,9)]";

const POS_3D_PANEL =
  "rounded-xl border border-line bg-surface shadow-[0_6px_18px_-4px_rgba(15,23,42,0.16),inset_0_1px_0_0_rgba(255,255,255,0.12)]";

const DEFAULT_POS_LAYOUT: PosLayoutConfig = {
  mode: "v_default",
  order: ["receipt", "actions", "products"],
  toolbarOrientation: "vertical",
  zones: {
    receipt: { compact: false, hidden: false, fullscreen: false, offsetX: 0, offsetY: 0, width: null, height: null },
    actions: { compact: false, hidden: false, fullscreen: false, offsetX: 0, offsetY: 0, width: null, height: null },
    products: { compact: false, hidden: false, fullscreen: false, offsetX: 0, offsetY: 0, width: null, height: null },
  },
};

function readSoftChimeEnabled(): boolean {
  try {
    return window.localStorage.getItem(SOUND_CHIME_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeSoftChimeEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SOUND_CHIME_KEY, enabled ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

function playSoftChime(kind: "add" | "error", enabled: boolean): void {
  if (!enabled) return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === "add" ? "sine" : "triangle";
    const now = ctx.currentTime;
    if (kind === "add") {
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
      gain.gain.setValueAtTime(0.045, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.095);
    } else {
      osc.frequency.setValueAtTime(290, now);
      osc.frequency.linearRampToValueAtTime(210, now + 0.14);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.16);
    }
    osc.onended = () => {
      void ctx.close().catch(() => undefined);
    };
  } catch {
    // ignore audio errors
  }
}

function readPosLayout(): PosLayoutConfig {
  try {
    const raw = window.localStorage.getItem(POS_LAYOUT_KEY);
    if (!raw) return DEFAULT_POS_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<PosLayoutConfig>;
    const validModes = new Set(POS_MODES.map((m) => m.id));
    const mode: PosModeId = parsed.mode && validModes.has(parsed.mode) ? parsed.mode : "v_default";
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

    const mergeZone = (id: PosZoneId): PosZoneState => {
      const z = parsed.zones?.[id];
      return {
        compact: Boolean(z?.compact),
        hidden: Boolean(z?.hidden),
        fullscreen: Boolean(z?.fullscreen),
        offsetX: typeof z?.offsetX === "number" && Number.isFinite(z.offsetX) ? z.offsetX : 0,
        offsetY: typeof z?.offsetY === "number" && Number.isFinite(z.offsetY) ? z.offsetY : 0,
        width: typeof z?.width === "number" && Number.isFinite(z.width) && z.width > 80 ? z.width : null,
        height:
          typeof z?.height === "number" && Number.isFinite(z.height) && z.height > 48 ? z.height : null,
      };
    };

    return {
      mode,
      order,
      toolbarOrientation,
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

function readCustomSlots(): Partial<Record<CustomSlotId, PosLayoutConfig>> {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SLOTS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<Record<CustomSlotId, PosLayoutConfig>>;
  } catch {
    return {};
  }
}

function writeCustomSlots(slots: Partial<Record<CustomSlotId, PosLayoutConfig>>): void {
  try {
    window.localStorage.setItem(CUSTOM_SLOTS_KEY, JSON.stringify(slots));
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
        className={cn("w-full max-w-[360px] p-4 text-ink shadow-2xl", POS_3D_PANEL)}
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
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md bg-surface-2 text-ink-2 hover:text-ink",
              POS_3D_BTN,
            )}
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
          <Button type="button" variant="outline" className={POS_3D_BTN} onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button type="submit" className={POS_3D_PRIMARY} disabled={submitting}>
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
        className={cn("w-full max-w-[360px] p-4 text-ink shadow-2xl", POS_3D_PANEL)}
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
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md bg-surface-2 text-ink-2 hover:text-ink",
              POS_3D_BTN,
            )}
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
          <Button type="button" variant="outline" className={POS_3D_BTN} onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button type="submit" className={POS_3D_PRIMARY} disabled={submitting}>
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
      <div className={cn("w-full max-w-[320px] p-3.5 text-ink shadow-2xl", POS_3D_PANEL)}>
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
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-md bg-surface-2 text-ink-2 hover:text-ink",
                POS_3D_BTN,
              )}
            >
              <Copy aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="إغلاق"
              aria-label="إغلاق"
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-md bg-surface-2 text-ink-2 hover:text-ink",
                POS_3D_BTN,
              )}
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </div>

        <div className="mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-end shadow-inner">
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
                "flex h-11 items-center justify-center rounded-lg text-base font-bold",
                POS_3D_BTN,
                btn.tone === "op" && "border-brand/40 bg-brand-soft text-brand",
                btn.tone === "muted" && "bg-surface-2 text-ink-2 hover:text-ink",
                !btn.tone && "bg-surface hover:bg-surface-2",
              )}
            >
              {btn.label === "⌫" ? <Delete aria-hidden className="size-4" /> : btn.label}
            </button>
          ))}

          <button
            type="button"
            onClick={calculate}
            className={cn(
              "row-span-2 flex items-center justify-center rounded-lg text-lg font-bold",
              POS_3D_PRIMARY,
            )}
            aria-label="يساوي"
          >
            <Equal aria-hidden className="size-5" />
          </button>

          {padButtons.slice(15).map((btn) => (
            <button
              key={btn.label}
              type="button"
              onClick={btn.onClick}
              className={cn(
                "flex h-11 items-center justify-center rounded-lg bg-surface text-base font-bold hover:bg-surface-2",
                POS_3D_BTN,
              )}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>
    </div>
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

  const [softChimeEnabled, setSoftChimeEnabled] = useState<boolean>(readSoftChimeEnabled);
  const toggleSoftChime = useCallback(() => {
    setSoftChimeEnabled((prev) => {
      const next = !prev;
      writeSoftChimeEnabled(next);
      toast.info(next ? "تم تفعيل التنبيه الصوتي الخفيف" : "تم إيقاف التنبيه الصوتي الخفيف");
      return next;
    });
  }, []);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState<number>(rememberedSplitWidth);
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
  const [lastPresetMode, setLastPresetMode] = useState<PosModeId>(() =>
    posLayout.mode !== "free_mode" ? posLayout.mode : "v_default",
  );
  const [dockNotice, setDockNotice] = useState<string | null>(null);
  const [customSlots, setCustomSlots] = useState<Partial<Record<CustomSlotId, PosLayoutConfig>>>(
    readCustomSlots,
  );

  const isFreeMode = posLayout.mode === "free_mode";

  const updatePosLayout = useCallback((updater: (prev: PosLayoutConfig) => PosLayoutConfig) => {
    setPosLayout((prev) => {
      const next = updater(prev);
      savePosLayout(next);
      return next;
    });
  }, []);

  const clampLeftWidth = useCallback((desired: number): number => {
    const containerWidth = splitContainerRef.current?.clientWidth ?? window.innerWidth;
    const maxAllowedByViewport = Math.max(MIN_LEFT_WIDTH, containerWidth - MIN_RIGHT_WIDTH);
    const upper = Math.min(MAX_LEFT_WIDTH, maxAllowedByViewport);
    return Math.max(MIN_LEFT_WIDTH, Math.min(upper, desired));
  }, []);

  const selectMode = useCallback(
    (modeId: PosModeId) => {
      if (modeId !== "free_mode") {
        setLastPresetMode(modeId);
      }
      const preset = POS_MODES.find((m) => m.id === modeId) ?? POS_MODES[0]!;
      const nextLeft = clampLeftWidth(preset.leftWidth ?? DEFAULT_LEFT_WIDTH);
      setLeftWidth(nextLeft);
      rememberSplitWidth(nextLeft);

      updatePosLayout((prev) => ({
        mode: preset.id,
        order: [...preset.order] as [PosZoneId, PosZoneId, PosZoneId],
        toolbarOrientation: preset.orientation,
        zones: {
          receipt: {
            ...prev.zones.receipt,
            hidden: false,
            compact: false,
            fullscreen: false,
            offsetX: 0,
            offsetY: 0,
            width: null,
            height: null,
          },
          actions: {
            ...prev.zones.actions,
            hidden: false,
            compact: preset.orientation === "vertical" ? railCollapsed : false,
            fullscreen: false,
            offsetX: 0,
            offsetY: 0,
            width: null,
            height: preset.orientation === "horizontal" ? 72 : null,
          },
          products: {
            ...prev.zones.products,
            hidden: false,
            compact: false,
            fullscreen: false,
            offsetX: 0,
            offsetY: 0,
            width: null,
            height: null,
          },
        },
      }));
    },
    [clampLeftWidth, railCollapsed, updatePosLayout],
  );

  const resetFreeModeDimensions = useCallback(() => {
    const nextLeft = clampLeftWidth(DEFAULT_LEFT_WIDTH);
    setLeftWidth(nextLeft);
    rememberSplitWidth(nextLeft);
    updatePosLayout((prev) => ({
      ...prev,
      zones: {
        receipt: {
          ...prev.zones.receipt,
          offsetX: 0,
          offsetY: 0,
          width: null,
          height: null,
          fullscreen: false,
          compact: false,
          hidden: false,
        },
        actions: {
          ...prev.zones.actions,
          offsetX: 0,
          offsetY: 0,
          width: null,
          height: prev.toolbarOrientation === "horizontal" ? 72 : null,
          fullscreen: false,
          hidden: false,
        },
        products: {
          ...prev.zones.products,
          offsetX: 0,
          offsetY: 0,
          width: null,
          height: null,
          fullscreen: false,
          compact: false,
          hidden: false,
        },
      },
    }));
    toast.success("تم تصفير مقاسات ومواقع الوضع الحر");
  }, [clampLeftWidth, updatePosLayout]);

  const toggleOrientationQuick = useCallback(() => {
    updatePosLayout((prev) => {
      const nextOrientation: DockOrientation =
        prev.toolbarOrientation === "vertical" ? "horizontal" : "vertical";
      return {
        ...prev,
        toolbarOrientation: nextOrientation,
        zones: {
          ...prev.zones,
          actions: {
            ...prev.zones.actions,
            compact: nextOrientation === "vertical" ? railCollapsed : false,
            height: nextOrientation === "horizontal" ? 72 : null,
          },
        },
      };
    });
  }, [railCollapsed, updatePosLayout]);

  const saveCustomSlot = useCallback(
    (slotId: CustomSlotId) => {
      const snapshot: PosLayoutConfig = {
        mode: posLayout.mode,
        order: [...posLayout.order] as [PosZoneId, PosZoneId, PosZoneId],
        toolbarOrientation: posLayout.toolbarOrientation,
        zones: {
          receipt: { ...posLayout.zones.receipt },
          actions: { ...posLayout.zones.actions },
          products: { ...posLayout.zones.products },
        },
      };
      setCustomSlots((prev) => {
        const next = { ...prev, [slotId]: snapshot };
        writeCustomSlots(next);
        return next;
      });
      toast.success(slotId === "slot1" ? "تم حفظ التخطيط المخصص 1" : "تم حفظ التخطيط المخصص 2");
    },
    [posLayout],
  );

  const loadCustomSlot = useCallback(
    (slotId: CustomSlotId) => {
      const saved = customSlots[slotId];
      if (!saved) {
        toast.info(
          slotId === "slot1"
            ? "التخطيط 1 غير محفوظ بعد — اضغط حفظ 1 لحفظ تنسيقك الحالي"
            : "التخطيط 2 غير محفوظ بعد — اضغط حفظ 2 لحفظ تنسيقك الحالي",
        );
        return;
      }
      const restored: PosLayoutConfig = {
        mode: saved.mode,
        order: [...saved.order] as [PosZoneId, PosZoneId, PosZoneId],
        toolbarOrientation: saved.toolbarOrientation,
        zones: {
          receipt: { ...saved.zones.receipt },
          actions: { ...saved.zones.actions },
          products: { ...saved.zones.products },
        },
      };
      setPosLayout(restored);
      savePosLayout(restored);
      if (restored.zones.receipt.width) {
        setLeftWidth(clampLeftWidth(restored.zones.receipt.width));
      }
      toast.success(slotId === "slot1" ? "تم تحميل التخطيط المخصص 1" : "تم تحميل التخطيط المخصص 2");
    },
    [clampLeftWidth, customSlots],
  );

  const toggleFreeMode = useCallback(() => {
    if (isFreeMode) {
      selectMode(lastPresetMode || "v_default");
    } else {
      selectMode("free_mode");
    }
  }, [isFreeMode, lastPresetMode, selectMode]);

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

  const toggleZoneFullscreen = useCallback(
    (zoneId: PosZoneId) => {
      if (zoneId === "actions") return;
      updatePosLayout((prev) => {
        const nextFs = !prev.zones[zoneId].fullscreen;
        return {
          ...prev,
          zones: {
            receipt: {
              ...prev.zones.receipt,
              fullscreen: zoneId === "receipt" ? nextFs : false,
              hidden: false,
            },
            products: {
              ...prev.zones.products,
              fullscreen: zoneId === "products" ? nextFs : false,
              hidden: false,
            },
            actions: {
              ...prev.zones.actions,
              fullscreen: false,
            },
          },
        };
      });
    },
    [updatePosLayout],
  );

  const minimizeZoneToDock = useCallback(
    (zoneId: PosZoneId) => {
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
      updatePosLayout((prev) => ({
        ...prev,
        zones: {
          ...prev.zones,
          [safeZoneId]: {
            ...prev.zones[safeZoneId],
            hidden: true,
            fullscreen: false,
          },
        },
      }));
      const label =
        safeZoneId === "receipt"
          ? "الإيصال"
          : safeZoneId === "actions"
            ? "المفاتيح"
            : "المنتجات والباركود";
      setDockNotice(`تم إنزال "${label}" للأسفل — الاختصارات والباركود ما زالا نشطين`);
    },
    [updatePosLayout],
  );

  useEffect(() => {
    if (!dockNotice) return;
    const t = window.setTimeout(() => setDockNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [dockNotice]);

  const restoreZoneFromDock = useCallback(
    (zoneId: PosZoneId) => {
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
      updatePosLayout((prev) => ({
        ...prev,
        zones: {
          receipt: {
            ...prev.zones.receipt,
            hidden: safeZoneId === "receipt" ? false : prev.zones.receipt.hidden,
            compact: safeZoneId === "receipt" ? false : prev.zones.receipt.compact,
            fullscreen: false,
          },
          actions: {
            ...prev.zones.actions,
            hidden: safeZoneId === "actions" ? false : prev.zones.actions.hidden,
            compact: safeZoneId === "actions" ? false : prev.zones.actions.compact,
            fullscreen: false,
          },
          products: {
            ...prev.zones.products,
            hidden: safeZoneId === "products" ? false : prev.zones.products.hidden,
            compact: safeZoneId === "products" ? false : prev.zones.products.compact,
            fullscreen: false,
          },
        },
      }));
    },
    [updatePosLayout],
  );

  const startZoneDrag = useCallback(
    (zoneId: PosZoneId, e: PointerEvent<HTMLElement>) => {
      if (!isFreeMode) return;
      const safeZoneId: PosZoneId = zoneId ?? "receipt";
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
        const maxBoundX = Math.max(900, window.innerWidth);
        const maxBoundY = Math.max(700, window.innerHeight);
        const clampedX = Math.max(-maxBoundX, Math.min(maxBoundX, baseX + dx));
        const clampedY = Math.max(-maxBoundY, Math.min(maxBoundY, baseY + dy));
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
    [isFreeMode, posLayout.zones, updatePosLayout],
  );

  const startEdgeResize = useCallback(
    (
      zoneId: PosZoneId,
      edge: "right" | "left" | "bottom" | "top" | "corner",
      e: PointerEvent<HTMLElement>,
    ) => {
      const safeId: PosZoneId = zoneId ?? "receipt";
      if (!isFreeMode) return;
      e.preventDefault();
      e.stopPropagation();
      setActiveDragZone(safeId);
      setDraggingSplit(true);
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = e.currentTarget.parentElement?.getBoundingClientRect();
      const startW = posLayout.zones[safeId].width ?? rect?.width ?? 400;
      const startH = posLayout.zones[safeId].height ?? rect?.height ?? 320;
      const startOffsetX = posLayout.zones[safeId].offsetX;
      const startOffsetY = posLayout.zones[safeId].offsetY;

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        let nextW = startW;
        let nextH = startH;
        let nextOffsetX = startOffsetX;
        let nextOffsetY = startOffsetY;

        if (edge === "right") {
          nextW = Math.max(120, Math.min(window.innerWidth, Math.round(startW + dx)));
        } else if (edge === "left") {
          const candidateW = Math.max(120, Math.min(window.innerWidth, Math.round(startW - dx)));
          nextOffsetX = Math.round(startOffsetX + (startW - candidateW));
          nextW = candidateW;
        } else if (edge === "bottom") {
          nextH = Math.max(60, Math.min(window.innerHeight, Math.round(startH + dy)));
        } else if (edge === "top") {
          const candidateH = Math.max(60, Math.min(window.innerHeight, Math.round(startH - dy)));
          nextOffsetY = Math.round(startOffsetY + (startH - candidateH));
          nextH = candidateH;
        } else if (edge === "corner") {
          nextW = Math.max(120, Math.min(window.innerWidth, Math.round(startW + dx)));
          nextH = Math.max(60, Math.min(window.innerHeight, Math.round(startH + dy)));
        }

        updatePosLayout((prev) => ({
          ...prev,
          zones: {
            ...prev.zones,
            [safeId]: {
              ...prev.zones[safeId],
              width: nextW,
              height: nextH,
              offsetX: nextOffsetX,
              offsetY: nextOffsetY,
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
    [isFreeMode, posLayout.zones, updatePosLayout],
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

  useEffect(() => {
    const onResize = () => {
      setLeftWidth((prev) => clampLeftWidth(prev));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampLeftWidth]);

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
        playSoftChime("error", softChimeEnabled);
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
      playSoftChime("add", softChimeEnabled);
      setNotice(null);
      if (modules.includes("serials")) void askSerials(product.id).catch(() => undefined);
    },
    [askSerials, lang, modules, notify, softChimeEnabled, t],
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
            playSoftChime("add", softChimeEnabled);
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
      playSoftChime("add", softChimeEnabled);
      setNotice(null);
    },
    [defaultTaxRateId, findByCode, lang, softChimeEnabled, units],
  );

  const handleQuickWeightSubmit = useCallback(
    async ({ weightValue, barcode }: { weightValue: number; barcode: string }) => {
      const qtyThousandths =
        weightValue < 10 && !Number.isInteger(weightValue)
          ? Math.round(weightValue * 1_000)
          : Math.round(weightValue);
      if (qtyThousandths <= 0) {
        playSoftChime("error", softChimeEnabled);
        toast.error("الوزن غير صالح");
        return;
      }

      try {
        const hit = await findByCode.mutateAsync(barcode);
        if (!hit) {
          beep("error");
          playSoftChime("error", softChimeEnabled);
          toast.error(`لم يتم العثور على باركود: ${barcode}`);
          return;
        }
        addProduct(hit.product, qtyThousandths, 3, false);
      } catch (error) {
        beep("error");
        playSoftChime("error", softChimeEnabled);
        toast.error(errorText(error));
      }
    },
    [addProduct, errorText, findByCode, softChimeEnabled],
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
          playSoftChime("add", softChimeEnabled);
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
            playSoftChime("error", softChimeEnabled);
            notify("error", t("sync:lan.shell.notFoundAnywhere"));
          }
        } else {
          beep("error");
          playSoftChime("error", softChimeEnabled);
          notify("error", t("pos:scan.notFound", { code }));
        }
      } catch (error) {
        beep("error");
        playSoftChime("error", softChimeEnabled);
        notify("error", errorText(error));
      }
    },
    [
      addHit,
      errorText,
      findByCode,
      lan.isTill,
      lan.online,
      lang,
      modules,
      notify,
      searchHost,
      softChimeEnabled,
      syncNow,
      t,
    ],
  );

  const onScan = (code: string) => {
    if (approval.pending || anySubModal) return;
    if (quickPaying.current) {
      beep("error");
      playSoftChime("error", softChimeEnabled);
      return;
    }
    if (dialog === null) {
      void lookup(code);
    } else if (dialog.kind === "done") {
      setDialog(null);
      void lookup(code);
    } else {
      beep("error");
      playSoftChime("error", softChimeEnabled);
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
  const hotkeys: Partial<Record<Hotkey, () => void>> = {
    F11: () => setDialog({ kind: "scale" }),
    F12: pay,
    Escape: () => setDialog((current) => (current ? null : { kind: "menu" })),
  };
  for (const action of bound) {
    if (keys[action]) hotkeys[keys[action]] = handlers[action];
  }
  const activeHotkeys: Record<string, () => void> = {};
  for (const [hotkeyKey, handlerFn] of Object.entries(hotkeys)) {
    if (hotkeyKey && handlerFn) {
      activeHotkeys[hotkeyKey] = handlerFn;
    }
  }
  useHotkeys(activeHotkeys, !anySubModal && !approval.pending && !quickBusy);

  const cap = (action: TillAction) => ({
    shortcut: ariaKey(keys[action]),
    shortcutLabel: keyLabel(keys[action], t),
  });

  useCtrlHotkey(
    "d",
    () => openDialog({ kind: "quote" }),
    !anySubModal && !approval.pending && can("sales.create"),
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

  const receiptTotalSummary = useMemo(() => {
    let total = 0;
    for (const item of lines) {
      total += Math.round((item.display.price * item.line.qty) / 1_000);
    }
    return total;
  }, [lines]);

  const isHorizontalToolbar = posLayout.toolbarOrientation === "horizontal";
  const actionsCompact = isHorizontalToolbar ? false : (railCollapsed || posLayout.zones.actions.compact);

  const posBtnClass = cn(
    "text-sm [&_kbd]:ms-0",
    POS_3D_BTN,
    isHorizontalToolbar
      ? "h-10 shrink-0 flex-row gap-1.5 px-2.5"
      : cn("min-h-12 w-full flex-col gap-0.5", actionsCompact ? "px-1 [&_span]:sr-only" : "px-1.5"),
  );

  const actionsContent = (
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
            title={actionsCompact ? "تمديد الشريط" : "تصغير الشريط"}
            aria-label={actionsCompact ? "تمديد الشريط" : "تصغير الشريط"}
            aria-expanded={!actionsCompact}
            className={cn(
              "mb-0.5 inline-flex h-7 w-full items-center justify-center gap-1 rounded-lg bg-surface text-xs font-semibold text-ink-2 hover:text-ink",
              POS_3D_BTN,
            )}
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
          className={posBtnClass}
          title="سعر سريع"
          onClick={() => setQuickPriceOpen(true)}
        >
          <Tag aria-hidden />
          <span>سعر سريع</span>
        </Button>

        <Button
          type="button"
          variant="secondary"
          className={posBtnClass}
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
          className={posBtnClass}
          title={t("pos:actions.customer")}
          onClick={() => setDialog({ kind: "customer" })}
          {...cap("customer")}
        >
          <User aria-hidden />
          <span>{t("pos:actions.customer")}</span>
        </Button>

        <Button
          className={posBtnClass}
          title={t("pos:actions.discount")}
          onClick={() => setDialog({ kind: "discount" })}
          {...cap("discount")}
        >
          <Percent aria-hidden />
          <span>{t("pos:actions.discount")}</span>
        </Button>

        <Button
          className={posBtnClass}
          title={t("pos:actions.hold")}
          onClick={hold}
          disabled={!can("sales.hold")}
          {...cap("hold")}
        >
          <Pause aria-hidden />
          <span>{t("pos:actions.hold")}</span>
        </Button>

        <Button
          className={posBtnClass}
          title={t("pos:actions.return")}
          onClick={() => setDialog({ kind: "return" })}
          {...cap("return")}
        >
          <Undo2 aria-hidden className="rtl:-scale-x-100" />
          <span>{t("pos:actions.return")}</span>
        </Button>

        <Button
          className={posBtnClass}
          title={t("pos:actions.drawer")}
          onClick={() => setDialog({ kind: "drawer" })}
          disabled={!can("cash.paid_in_out")}
          {...cap("drawer")}
        >
          <Wallet aria-hidden />
          <span>{t("pos:actions.drawer")}</span>
        </Button>

        <Button
          className={posBtnClass}
          title="حفظ / تحصيل (F12)"
          onClick={pay}
          disabled={lines.length === 0 || Boolean(preview.error) || quickBusy}
          shortcut="F12"
          shortcutLabel="F12"
        >
          <Equal aria-hidden />
          <span>حفظ F12</span>
        </Button>

        <Button
          className={posBtnClass}
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
              <Button className={POS_3D_PRIMARY} size="lg" onClick={() => setDialog({ kind: "openSession" })}>
                <Wallet aria-hidden />
                {t("pos:closed.open")}
              </Button>
            ) : null}
            <Button variant="outline" className={POS_3D_BTN} size="lg" onClick={() => void navigate(backOfficeHome(session))}>
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
        title: "المفاتيح",
        badge: isHorizontalToolbar ? "أفقي" : "رأسي",
      },
      products: {
        title: "المنتجات والباركود",
        badge: category ? "قسم" : "الكل",
      },
    }),
    [category, isHorizontalToolbar, lines.length],
  );

  const dockedZones = (["receipt", "actions", "products"] as PosZoneId[]).filter(
    (id) => posLayout.zones[id].hidden,
  );

  const visibleZonesCount = (["receipt", "actions", "products"] as PosZoneId[]).filter(
    (id) => !posLayout.zones[id].hidden,
  ).length;

  const renderZoneHeader = (zoneId: PosZoneId) => {
    const safeId: PosZoneId = zoneId ?? "receipt";
    const z = posLayout.zones[safeId];
    const supportsFullscreen = safeId === "receipt" || safeId === "products";

    return (
      <div
        onPointerDown={(e) => startZoneDrag(safeId, e)}
        className={cn(
          "flex shrink-0 items-center justify-start gap-2 border-b border-line bg-surface-2/90 px-2.5 py-1.5 text-xs shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1)]",
          isFreeMode && "cursor-move select-none",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {isFreeMode ? <Move aria-hidden className="size-3.5 shrink-0 text-brand" /> : null}
          <span className="truncate font-bold text-ink">{zoneMeta[safeId].title}</span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-ink-2">
            {zoneMeta[safeId].badge}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => toggleZoneCompact(safeId)}
            title="تصغير / تمديد"
            aria-label={`تصغير ${zoneMeta[safeId].title}`}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md bg-surface text-ink-2 hover:text-ink",
              POS_3D_BTN,
              z.compact && "border-amber-500 text-amber-500",
            )}
          >
            <Minimize2 aria-hidden className="size-3.5" />
          </button>

          {supportsFullscreen ? (
            <button
              type="button"
              onClick={() => toggleZoneFullscreen(safeId)}
              title={z.fullscreen ? "خروج من ملء الشاشة" : "ملء الشاشة"}
              aria-label={`ملء الشاشة ${zoneMeta[safeId].title}`}
              className={cn(
                "inline-flex size-6 items-center justify-center rounded-md bg-surface text-ink-2 hover:text-ink",
                POS_3D_BTN,
                z.fullscreen && "border-amber-500 bg-amber-400 text-slate-950",
              )}
            >
              <Maximize2 aria-hidden className="size-3.5" />
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => minimizeZoneToDock(safeId)}
            title="إنزال إلى شريط المهام السفلي"
            aria-label={`إنزال ${zoneMeta[safeId].title} للأسفل`}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md bg-surface text-ink-2 hover:text-danger",
              POS_3D_BTN,
            )}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>
    );
  };

  const renderResizeHandles = (zoneId: PosZoneId) => {
    const safeId: PosZoneId = zoneId ?? "receipt";
    if (!isFreeMode || posLayout.zones[safeId].fullscreen) return null;
    return (
      <>
        <div
          onPointerDown={(e) => startEdgeResize(safeId, "top", e)}
          title="تمديد من الأعلى"
          aria-label={`تمديد ${zoneMeta[safeId].title} من الأعلى`}
          className="absolute inset-x-2 top-0 z-20 h-1.5 cursor-ns-resize hover:bg-brand/50"
        />
        <div
          onPointerDown={(e) => startEdgeResize(safeId, "bottom", e)}
          title="تمديد من الأسفل"
          aria-label={`تمديد ${zoneMeta[safeId].title} من الأسفل`}
          className="absolute inset-x-2 bottom-0 z-20 h-1.5 cursor-ns-resize hover:bg-brand/50"
        />
        <div
          onPointerDown={(e) => startEdgeResize(safeId, "left", e)}
          title="تمديد من اليسار"
          aria-label={`تمديد ${zoneMeta[safeId].title} من اليسار`}
          className="absolute inset-y-2 left-0 z-20 w-1.5 cursor-ew-resize hover:bg-brand/50"
        />
        <div
          onPointerDown={(e) => startEdgeResize(safeId, "right", e)}
          title="تمديد من اليمين"
          aria-label={`تمديد ${zoneMeta[safeId].title} من اليمين`}
          className="absolute inset-y-2 right-0 z-20 w-1.5 cursor-ew-resize hover:bg-brand/50"
        />
        <div
          onPointerDown={(e) => startEdgeResize(safeId, "corner", e)}
          title="تمديد حر من الزاوية"
          aria-label={`تمديد ${zoneMeta[safeId].title}`}
          className="absolute bottom-1 end-1 z-20 flex size-4 cursor-nwse-resize items-end justify-end rounded-sm bg-surface-2/90 p-0.5 text-ink-2 hover:bg-brand hover:text-brand-ink"
        >
          <span className="block size-2 border-b-2 border-e-2 border-current" />
        </div>
      </>
    );
  };

  const renderZoneCard = (zoneId: PosZoneId = "receipt") => {
    const safeId: PosZoneId = zoneId ?? "receipt";
    const z = posLayout.zones[safeId];
    const isSoloFullScreen = z.fullscreen && visibleZonesCount === 1;
    const isLocalFullScreen = z.fullscreen && visibleZonesCount > 1;

    const customStyle: React.CSSProperties =
      isFreeMode && !z.fullscreen
        ? {
            transform:
              z.offsetX !== 0 || z.offsetY !== 0
                ? `translate3d(${z.offsetX}px, ${z.offsetY}px, 0)`
                : undefined,
            ...(z.width ? { width: `${z.width}px` } : {}),
            ...(z.height ? { height: `${z.height}px` } : {}),
          }
        : {};

    if (safeId === "receipt") {
      const receiptWidth =
        isSoloFullScreen || isLocalFullScreen
          ? undefined
          : isFreeMode && z.width
            ? z.width
            : isHorizontalToolbar
              ? undefined
              : leftWidth;

      return (
        <div
          key="receipt"
          dir="rtl"
          style={{
            ...(receiptWidth ? { width: `${receiptWidth}px` } : {}),
            ...(isFreeMode && z.height && !z.fullscreen ? { height: `${z.height}px` } : {}),
            transform: customStyle.transform,
          }}
          className={cn(
            "relative flex min-h-0 flex-col overflow-hidden",
            POS_3D_PANEL,
            z.hidden && "hidden",
            !isSoloFullScreen && !isLocalFullScreen && !isHorizontalToolbar && "shrink-0",
            (isSoloFullScreen || isLocalFullScreen) && "flex-1 w-full h-full z-20",
            isHorizontalToolbar && !z.fullscreen && "flex-1 min-h-[180px]",
            activeDragZone === "receipt" && "z-20 ring-2 ring-brand",
            z.compact && !z.fullscreen && "max-h-44",
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
                  className={cn("min-h-14 w-full text-2xl font-extrabold", POS_3D_PRIMARY)}
                  disabled={lines.length === 0 || Boolean(preview.error) || quickBusy}
                  onClick={pay}
                  shortcut="F12"
                  shortcutLabel="F12"
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
                    className={cn(
                      "inline-flex size-8 items-center justify-center rounded-lg bg-surface-2 text-ink hover:bg-brand-soft hover:text-brand",
                      POS_3D_BTN,
                    )}
                  >
                    <Calculator aria-hidden className="size-4" />
                  </button>
                  {withTables ? (
                    <Button variant="outline" className={POS_3D_BTN} onClick={() => void navigate("/pos/floor")}>
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
                      className={POS_3D_BTN}
                      onClick={() => setDialog({ kind: "scale" })}
                      shortcut="F11"
                      shortcutLabel={t("common:keys.f11")}
                    >
                      <Scale aria-hidden />
                      {t("pos:weigh.title")}
                    </Button>
                  ) : null}
                  {heldCount > 0 ? (
                    <Button variant="outline" className={POS_3D_BTN} onClick={() => openDialog({ kind: "held" })} {...cap("held")}>
                      {t("pos:actions.held", { count: heldCount })}
                    </Button>
                  ) : null}
                </div>
              }
              actions={null}
              actionsCollapsed={actionsCompact}
            />
          </div>
          {renderResizeHandles("receipt")}
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
            "relative flex shrink-0 flex-col overflow-hidden",
            POS_3D_PANEL,
            "bg-surface-2/90",
            z.hidden && "hidden",
            isHorizontalToolbar ? "w-full" : actionsCompact ? "w-14" : "w-36",
            activeDragZone === "actions" && "z-20 ring-2 ring-brand",
          )}
        >
          {renderZoneHeader("actions")}
          <div className="p-1.5">{actionsContent}</div>
          {renderResizeHandles("actions")}
        </div>
      );
    }

    const productsHiddenVisually = z.hidden;
    return (
      <main
        key="products"
        dir="rtl"
        style={customStyle}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto p-4",
          POS_3D_PANEL,
          "bg-surface/60",
          productsHiddenVisually && "hidden",
          (z.fullscreen || isLocalFullScreen) && "z-20 h-full w-full",
          activeDragZone === "products" && "z-20 ring-2 ring-brand",
          z.compact && !z.fullscreen && "max-h-48",
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

        {selectedLine ? (
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2/90 px-3 py-2",
              POS_3D_BTN,
            )}
          >
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
                  needsOwnerApproval ? "bg-warning-soft text-warning" : "bg-info-soft text-info",
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
                className={POS_3D_BTN}
                disabled={approval.pending || quickBusy || isVoiding}
                onClick={() => {
                  if (selected !== null) void voidLine(selected);
                }}
                shortcut="Delete"
                shortcutLabel="Delete"
              >
                {isVoiding ? <Loader2 aria-hidden className="animate-spin" /> : <Trash2 aria-hidden />}
                حذف
              </Button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "rounded-lg p-3 font-semibold",
              notice.tone === "error" ? "bg-danger-soft text-danger" : "bg-info-soft text-info",
            )}
          >
            {notice.text}
          </p>
        ) : lastScan ? (
          <p className="flex items-center justify-between rounded-lg bg-surface p-3 text-lg shadow-xs">
            <span>{t("pos:lastScan", { name: lastScan.name })}</span>
            <Amount value={lastScan.price} className="font-bold" />
          </p>
        ) : null}

        {modules.includes("department_keys") || modules.includes("flexy") ? (
          <div className="flex flex-wrap gap-2">
            {modules.includes("department_keys") ? (
              <Button
                variant={departments ? "secondary" : "outline"}
                className={POS_3D_BTN}
                aria-pressed={departments}
                onClick={toggleDepartments}
                {...cap("department_keys")}
              >
                {t("pos:actions.departments")}
              </Button>
            ) : null}
            {modules.includes("flexy") ? (
              <Button variant="outline" className={POS_3D_BTN} onClick={flexy} {...cap("flexy")}>
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
        {renderResizeHandles("products")}
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
        className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/90 px-3 py-1.5 text-xs shadow-[0_2px_8px_-2px_rgba(15,23,42,0.14)]"
      >
        <div
          role="radiogroup"
          aria-label="أوضاع الشاشة"
          className="flex flex-wrap items-center gap-1.5"
        >
          {POS_MODES.map((m) => {
            const checked = posLayout.mode === m.id;
            return (
              <label
                key={m.id}
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 font-bold select-none",
                  POS_3D_BTN,
                  checked
                    ? "border-amber-500 bg-amber-400 text-slate-950"
                    : "bg-surface text-ink-2 hover:text-ink",
                )}
              >
                <input
                  type="radio"
                  name="pos-screen-mode"
                  value={m.id}
                  checked={checked}
                  onChange={() => selectMode(m.id)}
                  className="size-3.5 accent-slate-950 cursor-pointer"
                />
                <span>{m.label}</span>
              </label>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {isFreeMode ? (
            <button
              type="button"
              onClick={resetFreeModeDimensions}
              title="تصفير مقاسات ومواقع الوضع الحر"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 font-bold text-amber-500 hover:bg-amber-500/25",
                POS_3D_BTN,
              )}
            >
              <RotateCcw aria-hidden className="size-3.5" />
              <span>تصفير مقاسات الوضع الحر</span>
            </button>
          ) : null}

          <button
            type="button"
            onClick={toggleOrientationQuick}
            title="تبديل سريع بين الرأسي والأفقي"
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-lg bg-surface px-2.5 font-bold text-ink hover:text-brand",
              POS_3D_BTN,
            )}
          >
            {isHorizontalToolbar ? (
              <Columns2 aria-hidden className="size-3.5" />
            ) : (
              <Rows2 aria-hidden className="size-3.5" />
            )}
            <span>{isHorizontalToolbar ? "تحويل رأسي" : "تحويل أفقي"}</span>
          </button>

          <button
            type="button"
            onClick={() => (customSlots.slot1 ? loadCustomSlot("slot1") : saveCustomSlot("slot1"))}
            onContextMenu={(e) => {
              e.preventDefault();
              saveCustomSlot("slot1");
            }}
            title={customSlots.slot1 ? "تحميل تخطيط 1 (كليك يمين للحفظ)" : "حفظ التخطيط 1"}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-lg px-2 font-bold",
              POS_3D_BTN,
              customSlots.slot1
                ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-500"
                : "bg-surface text-ink-2 hover:text-ink",
            )}
          >
            <BookmarkCheck aria-hidden className="size-3.5" />
            <span>{customSlots.slot1 ? "تخطيط 1" : "حفظ 1"}</span>
          </button>

          <button
            type="button"
            onClick={() => (customSlots.slot2 ? loadCustomSlot("slot2") : saveCustomSlot("slot2"))}
            onContextMenu={(e) => {
              e.preventDefault();
              saveCustomSlot("slot2");
            }}
            title={customSlots.slot2 ? "تحميل تخطيط 2 (كليك يمين للحفظ)" : "حفظ التخطيط 2"}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-lg px-2 font-bold",
              POS_3D_BTN,
              customSlots.slot2
                ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-500"
                : "bg-surface text-ink-2 hover:text-ink",
            )}
          >
            <BookmarkCheck aria-hidden className="size-3.5" />
            <span>{customSlots.slot2 ? "تخطيط 2" : "حفظ 2"}</span>
          </button>

          <button
            type="button"
            onClick={toggleSoftChime}
            title="تنبيه صوتي خفيف اختياري عند تأكيد الإضافة أو خطأ الباركود"
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-lg px-2 font-bold",
              POS_3D_BTN,
              softChimeEnabled
                ? "border-sky-500/60 bg-sky-500/15 text-sky-500"
                : "bg-surface text-ink-2 hover:text-ink",
            )}
          >
            {softChimeEnabled ? (
              <Volume2 aria-hidden className="size-3.5" />
            ) : (
              <VolumeX aria-hidden className="size-3.5" />
            )}
            <span>صوت خفيف</span>
          </button>

          <button
            type="button"
            onClick={toggleFreeMode}
            title="تبديل سريع بين الوضع الحر والوضع السابق"
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-lg px-2.5 font-bold",
              POS_3D_BTN,
              isFreeMode
                ? "border-amber-500 bg-amber-400 text-slate-950"
                : "bg-surface text-ink hover:text-brand",
            )}
          >
            <Move aria-hidden className="size-3.5" />
            <span>{isFreeMode ? "رجوع للوضع السابق" : "تبديل للوضع الحر"}</span>
          </button>

          <button
            type="button"
            onClick={() => selectMode("v_default")}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-lg bg-surface px-2.5 font-bold text-ink hover:text-brand",
              POS_3D_BTN,
            )}
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
            {orderedZones.map((zoneId) => renderZoneCard(zoneId ?? "receipt"))}
          </div>

          {dockedZones.length > 0 ? (
            <div
              dir="rtl"
              className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2/95 px-3 py-1.5 text-xs shadow-[0_-2px_10px_-2px_rgba(15,23,42,0.18)]"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-ink-2">شريط المهام السفلي:</span>
                {dockNotice ? (
                  <span
                    role="status"
                    className="rounded-md bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-bold text-emerald-500"
                  >
                    {dockNotice}
                  </span>
                ) : null}
                {posLayout.zones.receipt.hidden ? (
                  <span
                    role="status"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 font-bold text-amber-500"
                  >
                    <span>الإيصال: {lines.length} صنف</span>
                    <span>•</span>
                    <Amount value={receiptTotalSummary} />
                  </span>
                ) : null}
                {dockedZones.map((zoneId) => (
                  <button
                    key={zoneId}
                    type="button"
                    onClick={() => restoreZoneFromDock(zoneId)}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-lg bg-surface px-3 font-bold text-ink hover:bg-brand hover:text-brand-ink",
                      POS_3D_BTN,
                    )}
                  >
                    <span>{zoneMeta[zoneId].title}</span>
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                      {zoneMeta[zoneId].badge}
                    </span>
                  </button>
                ))}
              </div>

              {posLayout.zones.products.hidden ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-emerald-500">
                    ● ماسح الباركود والمنتجات نشط بالخلفية
                  </span>
                  <input
                    type="text"
                    dir="ltr"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && text.trim()) {
                        e.preventDefault();
                        void lookup(text.trim());
                      }
                    }}
                    placeholder="باركود سريع (Enter)..."
                    className="h-7 w-44 rounded-lg border border-line bg-surface px-2.5 text-xs font-semibold text-ink focus:border-brand focus:outline-none"
                  />
                </div>
              ) : null}
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