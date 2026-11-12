"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import css from "./landing.module.css";

// The hero: a building you can click. Each spot is something that happens in a building every day; the card shows
// the plan the assistant would prepare for it. Everything here is sample data and says so: nothing is sent or saved.

type Step = { text: string; asks?: boolean };
type Scenario = {
  id: string; label: string; where: string; said: string; who: string; steps: Step[]; done: string;
  spot: { x: number; y: number; left?: boolean }; band: { y: number; h: number };
};

const FLOORS = 12, TOP = 78, FLOOR_H = 30, LEFT = 90, WIDTH = 180;
const floorY = (level: number) => TOP + (FLOORS - level) * FLOOR_H; // level 1 = lowest residential floor
const pct = (x: number, y: number) => ({ left: `${(x / 360) * 100}%`, top: `${(y / 540) * 100}%` });

const SCENARIOS: Scenario[] = [
  {
    id: "elevator", label: "Elevator", where: "Tower B, elevator 2", who: "Property manager",
    said: "The elevator in Tower B is down. Get someone out and tell the residents.",
    steps: [
      { text: "Create an emergency work order for elevator 2" },
      { text: "Assign the elevator contractor on this property’s vendor list" },
      { text: "Send a notice to the 96 households in Tower B", asks: true },
      { text: "Add a follow-up task for tomorrow’s inspection" },
    ],
    done: "Work order #1042 is with the contractor and the notice went to Tower B.",
    spot: { x: 180, y: floorY(7) + 15 }, band: { y: TOP, h: FLOORS * FLOOR_H },
  },
  {
    id: "leak", label: "Leak in 1204", where: "Unit 1204", who: "Resident, from her phone",
    said: "My kitchen sink is leaking badly and water is spreading across the floor.",
    steps: [
      { text: "File the request under plumbing, with her photo" },
      { text: "Mark it urgent: this property’s rules treat spreading water as urgent" },
      { text: "Check for an open request about the same leak (none found)" },
      { text: "Notify the on-call maintenance lead" },
    ],
    done: "Request #1043 is urgent and with the on-call lead. She can follow it from her phone.",
    spot: { x: 242, y: floorY(12) + 15 }, band: { y: floorY(12), h: FLOOR_H },
  },
  {
    id: "party", label: "Party room", where: "Amenity level", who: "Resident",
    said: "Book the party room this Saturday at 6 PM.",
    steps: [
      { text: "Check Saturday 6 to 10 PM is free" },
      { text: "Check the building’s rules: 4-hour limit, 14 days ahead, $100 deposit" },
      { text: "Book it and add the deposit to the booking", asks: true },
    ],
    done: "Booked for Saturday, 6 to 10 PM. The deposit and house rules are on the confirmation.",
    spot: { x: 118, y: floorY(3) + 15, left: true }, band: { y: floorY(3), h: FLOOR_H },
  },
  {
    id: "package", label: "Package", where: "Front desk", who: "Concierge",
    said: "A package arrived for unit 602.",
    steps: [
      { text: "Log the package with its courier and tracking number" },
      { text: "Match it to the resident of unit 602" },
      { text: "Tell them it’s ready for pickup, in the app and by email" },
    ],
    done: "Logged at 2:14 PM. The resident has been told, and gets a reminder after 3 days.",
    spot: { x: 150, y: 458, left: true }, band: { y: TOP + FLOORS * FLOOR_H, h: 40 },
  },
  {
    id: "parking", label: "Visitor parking", where: "Parkade P1", who: "Concierge",
    said: "Check in Maya’s guest. He’s driving.",
    steps: [
      { text: "Find the guest pass Maya registered this morning" },
      { text: "Check him in and note the plate" },
      { text: "Give him a free visitor space until the visit ends" },
    ],
    done: "Checked in, space V-07 until 9 PM. Maya got a notification that her guest arrived.",
    spot: { x: 225, y: 503 }, band: { y: 480, h: 44 },
  },
  {
    id: "hvac", label: "Rooftop unit", where: "Mechanical room", who: "The assistant, unprompted",
    said: "Rooftop unit 4 has had 6 service requests in 90 days. That is three times the other units.",
    steps: [
      { text: "Show the six requests, their cost and the downtime" },
      { text: "Suggest an inspection before the next failure" },
      { text: "Schedule it with the HVAC contractor for Tuesday", asks: true },
    ],
    done: "Inspection scheduled for Tuesday. The six requests are linked to it for the contractor.",
    spot: { x: 205, y: 62 }, band: { y: 44, h: 34 },
  },
];

const lit = (level: number, col: number) => (level * 7 + col * 3) % 5 < 2;
const flickers = (level: number, col: number) => (level * 5 + col) % 17 === 3;

export function BuildingDemo({ children }: { children: React.ReactNode }) {
  const [id, setId] = useState("elevator");
  const [run, setRun] = useState<{ id: string; at: number } | null>(null); // at = steps finished
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const s = SCENARIOS.find((x) => x.id === id)!;
  const progress = run?.id === id ? run.at : -1;
  const finished = progress >= s.steps.length;
  const needsApproval = s.steps.some((x) => x.asks);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const pick = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setRun(null);
    setId(next);
  };
  // a spot on the building can be picked while its plan is off-screen below: bring the plan into view
  const pickSpot = (next: string) => {
    pick(next);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => card.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }));
  };
  const approve = () => {
    const tick = (at: number) => {
      setRun({ id, at });
      if (at < s.steps.length) timer.current = setTimeout(() => tick(at + 1), 650);
    };
    tick(0);
  };

  return (
    <div>
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] lg:gap-12">
        <div>{children}</div>
        <div className={css.building}>
          <svg viewBox="0 0 360 540" role="img" aria-label="A residential tower at dusk with a parkade below it. Six marked spots can be selected.">
            {/* rooftop plant */}
            <rect x="160" y="50" width="90" height="28" rx="2" fill="var(--tower)" />
            <rect x="172" y="57" width="26" height="14" rx="1" className={css.pane} />
            <rect x="206" y="57" width="34" height="14" rx="1" className={css.pane} />
            {/* tower */}
            <rect x={LEFT} y={TOP} width={WIDTH} height={FLOORS * FLOOR_H + 40} fill="var(--tower)" />
            {Array.from({ length: FLOORS }, (_, i) => {
              const level = FLOORS - i;
              return Array.from({ length: 6 }, (_, col) => {
                const x = LEFT + 12 + col * 27 + (col > 2 ? 6 : 0); // the gap is the elevator shaft
                const on = lit(level, col);
                return <rect key={`${level}-${col}`} x={x} y={floorY(level) + 8} width="18" height="15" rx="1" className={cn(on ? css.lit : css.pane, on && flickers(level, col) && css.flick)} />;
              });
            })}
            {/* elevator shaft and car */}
            <rect x="177.5" y={TOP + 4} width="5" height={FLOORS * FLOOR_H - 4} fill="#182252" />
            <rect x="174" y={floorY(7) + 6} width="12" height="18" rx="1.5" fill="#8fa2e6" />
            {/* lobby */}
            <rect x={LEFT + 12} y={TOP + FLOORS * FLOOR_H + 8} width="66" height="24" rx="1" className={css.lit} opacity="0.9" />
            <rect x="174" y={TOP + FLOORS * FLOOR_H + 8} width="12" height="32" fill="#182252" />
            <rect x="192" y={TOP + FLOORS * FLOOR_H + 8} width="66" height="24" rx="1" className={css.pane} />
            {/* ground and parkade */}
            <line x1="0" y1="478" x2="360" y2="478" stroke="#3a4a8c" strokeWidth="1.5" strokeLinecap="round" />
            <rect x={LEFT - 30} y="486" width={WIDTH + 60} height="34" rx="3" fill="#0d1430" stroke="#2a3870" />
            {Array.from({ length: 7 }, (_, i) => <line key={i} x1={LEFT - 14 + i * 34} y1="490" x2={LEFT - 14 + i * 34} y2="516" stroke="#3a4a8c" strokeWidth="1" />)}
            <rect x="214" y="497" width="24" height="12" rx="3" fill="#8fa2e6" />
            {/* where the selected event is happening */}
            {SCENARIOS.map((x) => <rect key={x.id} x={x.id === "parking" ? LEFT - 30 : x.id === "hvac" ? 160 : LEFT} y={x.band.y} width={x.id === "parking" ? WIDTH + 60 : x.id === "hvac" ? 90 : WIDTH} height={x.band.h} rx="2" className={cn(css.band, x.id === id && css.bandOn)} />)}
          </svg>
          {SCENARIOS.map((x) => (
            <button key={x.id} type="button" onClick={() => pickSpot(x.id)} aria-pressed={x.id === id} aria-label={`${x.label}: ${x.where}`} style={pct(x.spot.x, x.spot.y)} className={cn(css.spot, x.id === id && css.spotOn)}>
              {x.id === id ? <span className={cn(css.spotLabel, x.spot.left && css.spotLabelLeft)}>{x.where}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div ref={card} className="mt-10 scroll-mb-6 scroll-mt-6 lg:mt-12">
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Pick something happening in the building">
          <span className="mr-1 text-[14px] font-medium text-[#cfd6f2]">Something happens in the building:</span>
          {SCENARIOS.map((x) => <button key={x.id} type="button" onClick={() => pick(x.id)} aria-pressed={x.id === id} className={cn(css.chip, x.id === id && css.chipOn)}>{x.label}</button>)}
        </div>
        <div className={cn(css.card, "grid gap-x-10 gap-y-4 p-5 sm:p-7 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]")} data-testid="demo-plan">
          <div>
            <p className="text-[13px] text-faint">{s.who}</p>
            <p className={cn(css.h3, "mt-2 text-xl leading-snug sm:text-2xl")}>“{s.said}”</p>
          </div>
          <div>
          <p className="mb-1 text-[13px] font-semibold text-muted">{s.id === "hvac" ? "What it found and suggests" : "The plan"}</p>
          <ol aria-live="polite">
            {s.steps.map((step, i) => {
              const state = progress > i ? "done" : progress === i ? "run" : "todo";
              return (
                <li key={step.text} className={css.step}>
                  <span className={cn(css.dot, state === "run" && css.dotRun, state === "done" && css.dotDone)} aria-hidden>{state === "done" ? "✓" : ""}</span>
                  <span className="text-[15px] leading-snug">{step.text}<span className="sr-only">{state === "done" ? " (done)" : state === "run" ? " (in progress)" : ""}</span></span>
                  <span className={cn("mt-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold", step.asks ? "bg-warning-soft text-warning" : "bg-subtle text-muted")}>{step.asks ? "Asks first" : "Automatic"}</span>
                </li>
              );
            })}
          </ol>
          <div className="mt-4 flex min-h-11 flex-wrap items-center gap-3 border-t border-border pt-4">
            {finished ? (
              <>
                <p className="flex-1 text-[14px] font-medium text-success" role="status">{s.done}</p>
                <button type="button" onClick={() => setRun(null)} className="rounded-[var(--radius-md)] border border-border-strong px-3 py-2 text-[13px] font-medium hover:bg-subtle">Run it again</button>
              </>
            ) : (
              <>
                <button type="button" onClick={approve} disabled={progress >= 0} className="rounded-[var(--radius-md)] bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg hover:opacity-90 disabled:opacity-60">
                  {progress >= 0 ? "Working…" : needsApproval ? "Approve the plan" : "Run the plan"}
                </button>
                <p className="flex-1 text-[13px] text-faint">{needsApproval ? "Steps marked “Asks first” wait for this click. You can also edit or cancel." : "Nothing here needs sign-off under the default rules."}</p>
              </>
            )}
          </div>
          </div>
        </div>
        <p className="mt-3 text-[13px] text-[#b9c2e6]">A preview with sample data. In the product the plan is built from your own buildings, vendors and rules, and every step lands in the audit log.</p>
      </div>
    </div>
  );
}
