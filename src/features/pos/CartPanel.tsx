import { LogOut } from "lucide-react";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Amount } from "@/components/amount";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { approvalPermission } from "@/lib/approval";
import { formatDZD } from "@/lib/format";
import { useLogout, useSession } from "@/lib/ipc/auth";
import type { PaymentPreview } from "@/lib/ipc/types";
import { localizedName } from "@/lib/names";
import { formatQty } from "@/lib/numeric";
import { useErrorText } from "@/lib/use-error-text";
import { useLang } from "@/lib/use-language";
import { cn } from "@/lib/utils";
import { type DraftLine } from "./cart-store";
import type { PricedCartLine } from "./use-cart-preview";

export interface CashierUserBadgeInfo {
  id?: string | null;
  displayName?: string | null;
  roleName?: string | null;
}

/** End column (spec §10.5): lines, totals, the amount-due band, the pay button and the vertical
 * POS action strip. Every figure comes from the backend's preview; before it answers, a line shows "…". */
export function CartPanel({
  lines,
  selected,
  preview,
  priced,
  stale = false,
  error,
  onSelect,
  onEdit,
  onApproval,
  payButton,
  actions,
  actionsCollapsed = false,
  banner,
  customer,
  notices,
  user,
  onLogout,
  className,
}: {
  lines: DraftLine[];
  selected: number | null;
  preview: PaymentPreview | undefined;
  /** The backend's figures of each of `lines` (`usePricedLines`), none for a line not priced yet. */
  priced: readonly (PricedCartLine | undefined)[];
  /** `preview` is the previous cart's while this one is priced: its totals are about to change. */
  stale?: boolean;
  error: unknown;
  onSelect: (index: number) => void;
  onEdit: (index: number) => void;
  onApproval: () => void;
  payButton?: ReactNode;
  actions: ReactNode;
  /** When true, narrows the vertical action rail to compact icon-only width. */
  actionsCollapsed?: boolean;
  banner?: ReactNode;
  /** The ticket's customer (F3), under the title. */
  customer?: ReactNode;
  /** M8 pharmacy: what is said under a product's line (a cheaper generic, the Chifa price). */
  notices?: (index: number, productId: string) => ReactNode;
  /** Optional explicit user info; falls back to the active session when omitted. */
  user?: CashierUserBadgeInfo | null;
  /** Optional logout handler; falls back to `useLogout()` mutation when omitted. */
  onLogout?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const lang = useLang();
  const errorText = useErrorText();
  const session = useSession().data;
  const logoutMutation = useLogout();

  const resolvedUserId = user?.id !== undefined ? user.id : (session?.userId ?? null);
  const resolvedUserName =
    user?.displayName !== undefined
      ? user.displayName
      : (session?.displayName ?? session?.username ?? "");
  const resolvedRoleName =
    user?.roleName !== undefined
      ? user.roleName
      : session
        ? localizedName(
            {
              nameAr: session.roleNameAr,
              nameFr: session.roleNameFr,
              nameEn: session.roleNameEn,
            },
            lang,
          ) || (session.isOwner ? "المالك" : null)
        : null;

  const handleLogoutClick = () => {
    if (onLogout) {
      onLogout();
      return;
    }
    if (!logoutMutation.isPending) {
      logoutMutation.mutate();
    }
  };

  const totals = preview?.cart.totals;
  const ht = preview?.cart.priceMode === "ht";
  const settlement = preview?.settlement;
  // a slow answer dims the figures about to change; a quick one never shows the dimming
  const pending = stale ? "opacity-60 transition-opacity delay-300" : "transition-opacity";

  return (
    <aside
      className={cn(
        "flex min-h-0 min-w-0 flex-1 overflow-hidden bg-surface",
        className,
      )}
    >
      {/* Receipt + totals + due band + pay button */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="shrink-0 text-lg font-bold">{t("pos:cart.title")}</h2>

            {resolvedUserName || resolvedUserId ? (
              <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 py-0.5 ps-1 pe-2">
                <Avatar name={resolvedUserName || "?"} userId={resolvedUserId} />
                <div className="flex min-w-0 flex-col leading-tight">
                  {resolvedUserName ? (
                    <span className="truncate text-xs font-bold text-ink">{resolvedUserName}</span>
                  ) : null}
                  {resolvedRoleName ? (
                    <span className="truncate text-[10px] text-ink-2">{resolvedRoleName}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={handleLogoutClick}
                  disabled={logoutMutation.isPending}
                  aria-label={t("auth:logout", { defaultValue: "تسجيل الخروج" })}
                  title={t("auth:logout", { defaultValue: "تسجيل الخروج" })}
                  className="ms-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                >
                  <LogOut aria-hidden className="size-3.5 rtl:rotate-180" />
                </button>
              </div>
            ) : null}
          </div>

          {banner ? <div className="flex min-w-0 shrink-0 items-center">{banner}</div> : null}
        </div>

        {customer}

        <ul aria-label={t("pos:cart.title")} className="min-h-0 flex-1 overflow-y-auto">
          {lines.length === 0 ? <li className="p-6 text-ink-2">{t("pos:cart.empty")}</li> : null}
          {lines.map((draft, index) => {
            const figures = priced[index];
            return (
              <li key={draft.key}>
                <button
                  type="button"
                  aria-current={index === selected ? "true" : undefined}
                  // Spec §10.5 "tap to edit": a first tap selects the line, a tap on the selected
                  // line opens it (double-click still does, for the mouse)
                  onClick={() => (index === selected ? onEdit(index) : onSelect(index))}
                  onDoubleClick={() => onEdit(index)}
                  className={cn(
                    "flex w-full items-start justify-between gap-3 border-b border-line px-4 py-3 text-start",
                    index === selected ? "bg-brand-soft" : "hover:bg-surface-2",
                  )}
                >
                  <span className="flex flex-col">
                    <span className="font-semibold">
                      {t("pos:cart.line", {
                        qty: formatQty(draft.line.qty, lang),
                        name: figures?.description ?? draft.display.name,
                      })}
                    </span>
                    {figures && figures.amounts.discountAmount !== 0 ? (
                      <span className="text-sm text-ok">
                        {/* PRM-005/006, PRC-003: an automatic discount says where it comes from */}
                        <span>
                          {figures.autoDiscount
                            ? (figures.autoDiscount.label ?? t("pos:cart.customerDiscount"))
                            : t("pos:cart.discount")}
                        </span>{" "}
                        <Amount value={-figures.amounts.discountAmount} />
                      </span>
                    ) : null}
                    {figures?.priceChanged ? (
                      <span className="text-sm text-warn">{t("pos:cart.priceChanged")}</span>
                    ) : null}
                    {/* M8: a regulated staple's ceiling (SAL-030), the customer's agreed price, a
                        wholesale minimum not reached */}
                    {figures?.regulated ? (
                      <span
                        className={cn(
                          "w-fit rounded-sm px-1 text-sm",
                          figures.regulated.above ? "bg-danger-soft text-danger" : "text-ink-2",
                        )}
                      >
                        {t("pos:cart.regulated", { ceiling: formatDZD(figures.regulated.ceiling, lang) })}{" "}
                        {figures.regulated.above ? <span>{t("pos:cart.above")}</span> : null}
                      </span>
                    ) : null}
                    {figures?.customerPrice ? (
                      <span className="text-sm text-info">{t("pos:cart.customerPrice")}</span>
                    ) : null}
                    {figures?.minOrder ? (
                      <span className="w-fit rounded-sm bg-warn-soft px-1 text-sm text-warn">
                        {t("pos:cart.minOrder", { qty: formatQty(figures.minOrder, lang) })}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-2xl font-bold">
                    {figures ? (
                      <Amount value={figures.amounts.totalTtc} />
                    ) : (
                      <span aria-label={t("pos:cart.pricing")}>…</span>
                    )}
                  </span>
                </button>
                {notices && draft.line.productId ? notices(index, draft.line.productId) : null}
              </li>
            );
          })}
        </ul>

        {error ? (
          <div
            role="alert"
            className="flex flex-col gap-2 border-t border-danger bg-danger-soft px-4 py-2 text-danger"
          >
            <p className="text-sm">{errorText(error)}</p>
            {approvalPermission(error) ? (
              <Button variant="danger" onClick={onApproval}>
                {t("pos:cart.askApproval")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Spec §10.5: subtotal, discount, TVA, stamp duty */}
        <dl
          role="group"
          aria-label={t("pos:cart.totals")}
          aria-busy={stale || undefined}
          className={cn("grid gap-0.5 border-t border-line px-4 py-2 text-sm", pending)}
        >
          <div className="flex justify-between">
            <dt>{t("pos:cart.items")}</dt>
            <dd>
              <bdi dir="ltr">{preview ? formatQty(preview.cart.itemCount, lang) : "0"}</bdi>
            </dd>
          </div>
          {totals ? (
            <div className="flex justify-between">
              <dt>{t(ht ? "pos:cart.subtotalHt" : "pos:cart.subtotal")}</dt>
              <dd>
                <Amount value={totals.grossTotal} />
              </dd>
            </div>
          ) : null}
          {totals && totals.discountTotal !== 0 ? (
            <div className="flex justify-between text-ok">
              <dt>{t("pos:cart.discount")}</dt>
              <dd>
                <Amount value={-totals.discountTotal} />
              </dd>
            </div>
          ) : null}
          {totals && preview?.cart.taxRegime === "reel" ? (
            <div className="flex justify-between">
              <dt>{t(ht ? "pos:cart.vatAdded" : "pos:cart.vat")}</dt>
              <dd>
                <Amount value={totals.taxTotal} />
              </dd>
            </div>
          ) : null}
          {settlement && settlement.stampCharged !== 0 ? (
            <div className="flex justify-between">
              <dt>{t("pos:cart.stampDuty")}</dt>
              <dd>
                <Amount value={settlement.stampCharged} />
              </dd>
            </div>
          ) : null}
        </dl>

        {/* Bottom-left yellow total + pay button */}
        <div
          role="status"
          aria-label={t("pos:cart.due")}
          aria-busy={stale || undefined}
          className="flex items-baseline justify-between bg-brand px-4 py-3 text-brand-ink"
        >
          <span className="text-lg font-semibold">{t("pos:cart.due")}</span>
          <Amount
            value={settlement?.totalDue ?? 0}
            className={cn("text-5xl leading-none font-bold", pending)}
          />
        </div>
        {payButton ? <div className="border-t border-line bg-surface p-2.5">{payButton}</div> : null}
      </div>

      {/* Collapsible vertical column of POS action buttons */}
      <div
        aria-label={t("pos:cart.actions", { defaultValue: "إجراءات الكاشير" })}
        className={cn(
          "flex shrink-0 flex-col gap-1.5 overflow-y-auto border-s border-line bg-surface-2/60 transition-[width,padding] duration-200",
          actionsCollapsed ? "w-[58px] p-1.5" : "w-[112px] p-2",
        )}
      >
        {actions}
      </div>
    </aside>
  );
}
