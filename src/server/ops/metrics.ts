// In-process metrics in the Prometheus text format (Iteration 13). Counters and histograms live in this process;
// each instance is scraped on its own. Queue depths and worker health are read from the database at scrape time, so
// they are the same whichever instance answers.

type Labels = Record<string, string>;
const key = (name: string, labels: Labels) => `${name}{${Object.entries(labels).sort().map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, "_")}"`).join(",")}}`;

const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]; // seconds
type Hist = { buckets: number[]; sum: number; count: number; labels: Labels; name: string };

const g = globalThis as unknown as { __metrics?: { counters: Map<string, { name: string; labels: Labels; value: number }>; hists: Map<string, Hist>; started: number } };
const store = () => (g.__metrics ??= { counters: new Map(), hists: new Map(), started: Date.now() });

export const HELP: Record<string, [type: "counter" | "histogram" | "gauge", help: string]> = {
  app_api_requests_total: ["counter", "REST API requests by method and status class."],
  app_api_request_duration_seconds: ["histogram", "REST API request duration."],
  app_request_errors_total: ["counter", "Unhandled server errors by kind of route."],
  app_worker_ticks_total: ["counter", "Background worker ticks in this process by outcome (ok, failed, skipped)."],
  app_worker_tick_duration_seconds: ["histogram", "Duration of worker ticks in this process."],
  app_assistant_requests_total: ["counter", "Assistant requests handled by this process by outcome."],
  app_process_uptime_seconds: ["gauge", "Seconds since this process started."],
  app_process_resident_memory_bytes: ["gauge", "Resident memory of this process."],
  app_queue_depth: ["gauge", "Items waiting in each background queue."],
  app_queue_oldest_seconds: ["gauge", "Age of the oldest waiting item in each queue."],
  app_worker_last_tick_age_seconds: ["gauge", "Seconds since any worker last completed a tick."],
  app_ai_requests_last_hour: ["gauge", "Assistant requests recorded in the last hour, all organizations."],
  app_db_up: ["gauge", "1 when the database answered this scrape."],
};

export function count(name: keyof typeof HELP & string, labels: Labels = {}, by = 1) {
  const k = key(name, labels);
  const c = store().counters.get(k);
  if (c) c.value += by;
  else store().counters.set(k, { name, labels, value: by });
}

export function observe(name: keyof typeof HELP & string, seconds: number, labels: Labels = {}) {
  const k = key(name, labels);
  let h = store().hists.get(k);
  if (!h) store().hists.set(k, (h = { name, labels, buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
  BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
  h.sum += seconds;
  h.count++;
}

export type Gauge = { name: keyof typeof HELP & string; labels?: Labels; value: number };

const line = (name: string, labels: Labels, value: number) => `${key(name, labels).replace(/\{\}$/, "")} ${Number.isFinite(value) ? value : 0}`;

// text exposition: process metrics + whatever gauges the caller read from the database
export function renderMetrics(gauges: Gauge[] = []): string {
  const s = store();
  const all: Gauge[] = [
    { name: "app_process_uptime_seconds", value: Math.round(process.uptime()) },
    { name: "app_process_resident_memory_bytes", value: process.memoryUsage().rss },
    ...gauges,
  ];
  const out: string[] = [];
  const head = (name: string) => { const [type, help] = HELP[name]; out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); };
  const names = new Set<string>();
  for (const c of s.counters.values()) names.add(c.name);
  for (const name of names) {
    head(name);
    for (const c of s.counters.values()) if (c.name === name) out.push(line(name, c.labels, c.value));
  }
  const hnames = new Set<string>();
  for (const h of s.hists.values()) hnames.add(h.name);
  for (const name of hnames) {
    head(name);
    for (const h of s.hists.values()) {
      if (h.name !== name) continue;
      BUCKETS.forEach((b, i) => out.push(line(`${name}_bucket`, { ...h.labels, le: String(b) }, h.buckets[i])));
      out.push(line(`${name}_bucket`, { ...h.labels, le: "+Inf" }, h.count), line(`${name}_sum`, h.labels, Number(h.sum.toFixed(6))), line(`${name}_count`, h.labels, h.count));
    }
  }
  const gnames = new Set(all.map((x) => x.name));
  for (const name of gnames) {
    head(name);
    for (const x of all) if (x.name === name) out.push(line(name, x.labels ?? {}, x.value));
  }
  return out.join("\n") + "\n";
}

export function resetMetricsForTests() { g.__metrics = undefined; }
