import pg from "pg";

const { Pool } = pg;
let pool: InstanceType<typeof Pool> | undefined;

export default async function hello(): Promise<Response> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return Response.json({ status: "unavailable", error: "Database is not configured." }, { status: 503 });
  }

  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    keepAlive: true,
  });

  try {
    await pool.query("SELECT 1");
    return Response.json({ status: "ok", postgres: "connected" });
  } catch {
    return Response.json({ status: "unavailable", error: "Database health check failed." }, { status: 503 });
  }
}
