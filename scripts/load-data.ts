import "dotenv/config";
import { Pool } from "pg";

// Bulk data for load tests: adds N work orders (default 150,000) spread over two years to the demo organization.
//   LOAD_ROWS=150000 tsx scripts/load-data.ts
// Safety: only runs against a database whose name contains "load" (create one, migrate and seed it first; see
// docs/operations.md). It never touches a database you use for anything else.
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("Set MIGRATION_DATABASE_URL");
  const name = new URL(url).pathname.slice(1);
  if (!name.includes("load")) throw new Error(`Refusing to load test data into "${name}": the database name must contain "load".`);
  const n = Number(process.env.LOAD_ROWS) || 150_000;
  const pool = new Pool({ connectionString: url, max: 2 });
  const org = (await pool.query("select id from organizations where slug = 'pacific-properties'")).rows[0]?.id;
  if (!org) throw new Error("Seed the database first (npm run db:seed)");
  const start = (await pool.query("select coalesce(max(number), 0)::int as n from work_orders where org_id = $1", [org])).rows[0].n;
  const t0 = Date.now();
  await pool.query(`
    with u as (select id, building_id, property_id, row_number() over () as rn, count(*) over () as total from (
                 select un.id, un.building_id, b.property_id from units un join buildings b on b.id = un.building_id where un.org_id = $1) x),
         s as (select g, random() as r, random() as r2, now() - (random() * interval '730 days') as created from generate_series(1, $2::int) g)
    insert into work_orders (org_id, number, property_id, building_id, unit_id, category, priority, title, description, status, source, created_at, updated_at, completed_at, closed_at, resolve_due_at, cost)
    select $1, $3::int + s.g, u.property_id, u.building_id, u.id,
      (array['plumbing','electrical','hvac','appliance','elevator','cleaning','pest','general'])[1 + (s.g % 8)],
      (array['low','normal','normal','high','urgent'])[1 + (s.g % 5)],
      (array['Leaking tap','Light out in hallway','Heating not working','Dishwasher fault','Elevator noise','Stain on carpet','Ants in kitchen','Door will not latch'])[1 + (s.g % 8)] || ' #' || s.g,
      'Load test request ' || s.g,
      case when s.r < 0.86 then 'closed' when s.r < 0.92 then 'completed' when s.r < 0.95 then 'in_progress' when s.r < 0.98 then 'assigned' else 'new' end,
      'staff', s.created, s.created + interval '2 days',
      case when s.r < 0.92 then s.created + (s.r2 * interval '6 days') end,
      case when s.r < 0.86 then s.created + (s.r2 * interval '6 days') + interval '1 day' end,
      s.created + interval '5 days',
      case when s.r < 0.92 then round((40 + s.r2 * 900)::numeric, 2) end
    from s join u on u.rn = 1 + (s.g % u.total)`, [org, n, start]);
  await pool.query("analyze work_orders");
  const total = (await pool.query("select count(*)::int as n from work_orders where org_id = $1", [org])).rows[0].n;
  console.log(`✓ added ${n} work orders in ${((Date.now() - t0) / 1000).toFixed(1)}s (the organization now has ${total})`);
  await pool.end();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
