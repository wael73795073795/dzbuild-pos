import { ScanBarcode, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Amount } from "@/components/amount";
import { Avatar } from "@/components/avatar";
import { PinPad } from "@/components/pin-pad";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ApprovalCancelled, approvalPermission } from "@/lib/approval";
import { useManagerOverride, useSession, useUserTiles } from "@/lib/ipc/auth";
import { toAppError } from "@/lib/ipc/client";
import type { OverrideGrant, Permission, UserTile } from "@/lib/ipc/types";
import { beep } from "@/lib/sounds";
import { useErrorText } from "@/lib/use-error-text";

export { isApprovalCancelled } from "@/lib/approval";

const OWNER_BARCODE_STORAGE_KEY = "dzbuild_owner_barcode_v1";
const OWNER_BARCODE_AUDIT_KEY = "dzbuild_owner_barcode_audit_v1";
const APPROVAL_WINDOW_MS = 45_000;
const MAX_FAILED_SCANS = 3;
const COOLDOWN_MS = 15_000;

function normalizeBarcodeDigits(raw: string): string {
  return raw.replace(/\D+/g, "").trim();
}

function readStoredOwnerBarcode(): string | null {
  try {
    const val = globalThis.localStorage?.getItem(OWNER_BARCODE_STORAGE_KEY);
    if (!val) return null;
    const cleaned = normalizeBarcodeDigits(val);
    return cleaned.length >= 8 ? cleaned : null;
  } catch {
    return null;
  }
}

function recordBarcodeApproval(permission: string, requesterName: string, approverName: string): void {
  try {
    const raw = globalThis.localStorage?.getItem(OWNER_BARCODE_AUDIT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = [
      {
        id: `${Date.now()}`,
        at: new Date().toISOString(),
        permission,
        requesterName,
        approverName,
        method: "barcode",
      },
      ...(Array.isArray(list) ? list : []),
    ].slice(0, 50);
    globalThis.localStorage?.setItem(OWNER_BARCODE_AUDIT_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors
  }
}

function Refusal({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const e = toAppError(error);
  if (e.code !== "credit_limit_exceeded") return null;
  const details = (e.details ?? {}) as Record<string, unknown>;
  const figures = (
    [
      ["customers:detail.balance", details.balance],
      ["customers:detail.limit", details.limit],
      ["auth:approval.balanceAfter", details.after],
    ] as [string, unknown][]
  ).flatMap(([label, value]) => (typeof value === "number" ? [{ label, value }] : []));
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-control bg-warn-soft p-3 text-warn">
      <p className="font-semibold">{t("auth:approval.limitExceeded")}</p>
      {figures.length > 0 ? (
        <dl className="grid gap-1">
          {figures.map(({ label, value }) => (
            <div key={label} className="flex justify-between gap-3">
              <dt>{t(label)}</dt>
              <dd>
                <Amount value={value} className="font-bold" />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export function ManagerApprovalDialog({
  permission,
  refusal,
  onApproved,
  onCancel,
}: {
  permission: Permission;
  refusal?: unknown;
  onApproved: (grant: OverrideGrant) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const session = useSession().data;
  const tiles = useUserTiles();
  const override = useManagerOverride();
  const [approver, setApprover] = useState<UserTile | null>(null);
  const [pin, setPin] = useState("");
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [failedScans, setFailedScans] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState<number>(0);

  const scanBufferRef = useRef("");
  const lastKeyTimeRef = useRef<number>(0);

  const others = (tiles.data ?? []).filter((tile) => tile.id !== session?.userId);

  const submitWith = useCallback(
    (targetApprover: UserTile, credential: string, fromBarcode: boolean) => {
      if (override.isPending) return;
      override.mutate(
        { approverId: targetApprover.id, pin: credential, permission },
        {
          onSuccess: (grant) => {
            setBarcodeError(null);
            setFailedScans(0);
            if (fromBarcode) {
              recordBarcodeApproval(
                permission,
                session?.displayName ?? session?.userId ?? "مستخدم",
                grant.approverName ?? targetApprover.displayName,
              );
            }
            toast.success(t("auth:approval.granted", { name: grant.approverName }));
            onApproved(grant);
          },
          onError: (err) => {
            setPin("");
            if (fromBarcode) {
              setBarcodeError(errorText(err));
            }
          },
        },
      );
    },
    [errorText, onApproved, override, permission, session?.displayName, session?.userId, t],
  );

  const submit = useCallback(() => {
    if (!approver) return;
    submitWith(approver, pin, false);
  }, [approver, pin, submitWith]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (override.isPending) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      const now = Date.now();
      const elapsed = lastKeyTimeRef.current > 0 ? now - lastKeyTimeRef.current : 0;
      lastKeyTimeRef.current = now;

      if (event.key === "Enter" || event.key === "Tab") {
        const raw = scanBufferRef.current.trim();
        scanBufferRef.current = "";
        const cleaned = normalizeBarcodeDigits(raw);

        if (cleaned.length >= 8) {
          event.preventDefault();
          event.stopPropagation();

          if (now < lockoutUntil) {
            const secLeft = Math.ceil((lockoutUntil - now) / 1000);
            beep("error");
            setBarcodeError(`تم إيقاف قراءة الباركود مؤقتاً، حاول بعد ${secLeft} ثانية`);
            return;
          }

          const expectedBarcode = readStoredOwnerBarcode();
          if (!expectedBarcode || cleaned !== expectedBarcode) {
            const nextFails = failedScans + 1;
            setFailedScans(nextFails);
            beep("error");
            if (nextFails >= MAX_FAILED_SCANS) {
              setLockoutUntil(now + COOLDOWN_MS);
              setFailedScans(0);
              setBarcodeError("تم تجاوز الحد المسموح لمحاولات الباركود؛ انتظر 15 ثانية أو استخدم الـ PIN");
            } else {
              setBarcodeError("باركود المالك غير صحيح");
            }
            return;
          }

          const ownerTile = approver ?? others[0] ?? null;
          if (!ownerTile) {
            beep("error");
            setBarcodeError("لا يوجد حساب معتمد متاح للموافقة");
            return;
          }

          setBarcodeError(null);
          setApprover(ownerTile);
          submitWith(ownerTile, cleaned, true);
        }
        return;
      }

      if (event.key.length === 1) {
        if (elapsed > 90 && scanBufferRef.current.length > 0) {
          scanBufferRef.current = "";
        }
        scanBufferRef.current += event.key;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [approver, failedScans, lockoutUntil, others, override.isPending, submitWith]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t("auth:approval.title")}
      description={t("auth:approval.why", { permission: t(`auth:permissions.${permission}`) })}
      footer={
        <Button variant="outline" onClick={onCancel}>
          {t("common:actions.cancel")}
        </Button>
      }
    >
      <div className="mb-3 flex items-center gap-2 rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
        <ScanBarcode aria-hidden className="size-4 shrink-0 text-primary" />
        <span>امسح باركود المالك للموافقة الفورية على هذه العملية فقط، أو اختر الحساب وأدخل الـ PIN.</span>
      </div>

      {barcodeError ? (
        <p role="alert" className="mb-3 rounded-control bg-danger-soft p-2.5 text-sm text-danger">
          {barcodeError}
        </p>
      ) : null}

      <Refusal error={refusal} />
      {approver === null ? (
        <div className="flex flex-col gap-3">
          <p className="font-semibold">{t("auth:approval.chooseApprover")}</p>
          {others.length === 0 && !tiles.isPending ? (
            <p className="text-ink-2">{t("auth:approval.noApprover")}</p>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {others.map((tile) => (
              <button
                key={tile.id}
                type="button"
                onClick={() => {
                  setBarcodeError(null);
                  setApprover(tile);
                }}
                className="flex min-h-16 items-center gap-3 rounded-card border border-line bg-surface p-3 text-start font-semibold hover:bg-surface-2"
              >
                <Avatar name={tile.displayName} />
                {tile.displayName}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <p className="flex items-center gap-2 font-semibold">
            <ShieldCheck aria-hidden className="size-5" />
            {t("auth:approval.pin", { name: approver.displayName })}
          </p>
          <PinPad
            value={pin}
            onChange={setPin}
            onSubmit={submit}
            onCancel={() => {
              setBarcodeError(null);
              setApprover(null);
            }}
            submitLabel={t("auth:approval.submit")}
            disabled={override.isPending}
          />
          {override.error ? (
            <p role="alert" className="text-danger">
              {errorText(override.error)}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

interface Pending {
  permission: Permission;
  refusal: unknown;
  resolve: () => void;
  reject: () => void;
}

export function useApproval(): {
  run: <T>(action: () => Promise<T>) => Promise<T>;
  dialog: ReactNode;
  pending: boolean;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        const permission = approvalPermission(error);
        if (permission === null || attempt >= 2) throw error;
        beep("error");
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timer = globalThis.setTimeout(() => {
            if (!settled) {
              settled = true;
              reject(new ApprovalCancelled());
            }
          }, APPROVAL_WINDOW_MS);

          setPending({
            permission,
            refusal: error,
            resolve: () => {
              if (!settled) {
                settled = true;
                globalThis.clearTimeout(timer);
                resolve();
              }
            },
            reject: () => {
              if (!settled) {
                settled = true;
                globalThis.clearTimeout(timer);
                reject(new ApprovalCancelled());
              }
            },
          });
        });
        setPending(null);
      }
    }
  }, []);
  const dialog = pending ? (
    <ManagerApprovalDialog
      permission={pending.permission}
      refusal={pending.refusal}
      onApproved={() => pending.resolve()}
      onCancel={() => {
        pending.reject();
        setPending(null);
      }}
    />
  ) : null;
  return { run, dialog, pending: pending !== null };
}
