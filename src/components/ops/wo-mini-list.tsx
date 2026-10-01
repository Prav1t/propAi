import Link from "next/link";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { WO_STATUS } from "@/lib/ops-labels";
import { relative } from "@/lib/time";
import type { WoListRow } from "@/server/modules/maintenance/service";

// compact work order list for dashboards
export function WoMiniList({ rows, base, empty, showLocation = true }: { rows: WoListRow[]; base: string; empty: string; showLocation?: boolean }) {
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <ul className="divide-y divide-border">
      {rows.map((w) => (
        <li key={w.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <Link href={`${base}/maintenance/${w.id}`} className="block truncate text-sm font-medium hover:underline">
              <span className="font-normal text-faint">#{w.number}</span> {w.title}
            </Link>
            {showLocation ? <p className="truncate text-xs text-faint">{[w.propertyName, w.buildingName, w.unitNumber ? `Unit ${w.unitNumber}` : w.area].filter(Boolean).join(" · ")}</p> : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <Badge tone={w.isEmergency ? "danger" : WO_STATUS[w.status]?.tone}>{w.isEmergency ? "Emergency" : WO_STATUS[w.status]?.label}</Badge>
            {w.resolveDueAt && !["completed", "closed", "cancelled"].includes(w.status) ? <span className={`text-[11px] ${w.overdue ? "text-danger" : "text-faint"}`}>{w.overdue ? "overdue" : `due ${relative(w.resolveDueAt)}`}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
