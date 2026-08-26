const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

const MINING_RATE = 0.25; // ADT per hour
const DAILY_LIMIT = 6.0;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function query(text, params = []) {
  if (!pool) {
    throw new Error("DATABASE_URL is not configured.");
  }

  return pool.query(text, params);
}

async function initializeDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      pi_username TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS balances (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      available_adt NUMERIC(30,8) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mining_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stopped_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      rate_adt_per_hour NUMERIC(20,8) NOT NULL,
      earned_adt NUMERIC(30,8) NOT NULL DEFAULT 0
    );
  `);
}

app.get("/", (req, res) => {
  res.json({
    service: "Alberto Digital Token",
    status: "online",
    version: "1.0.0"
  });
});

app.get("/health", async (req, res) => {
  try {
    if (pool) {
      await query("SELECT 1");
    }

    res.json({
      ok: true,
      database: Boolean(pool),
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      database: false
    });
  }
});

app.post("/api/users", async (req, res) => {
  try {
    const { piUsername } = req.body;

    if (
      typeof piUsername !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(piUsername)
    ) {
      return res.status(400).json({
        error: "Invalid Pi username."
      });
    }

    const result = await query(
      `
      INSERT INTO users (pi_username)
      VALUES ($1)
      ON CONFLICT (pi_username)
      DO UPDATE SET pi_username = EXCLUDED.pi_username
      RETURNING id, pi_username, created_at
      `,
      [piUsername]
    );

    await query(
      `
      INSERT INTO balances (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [result.rows[0].id]
    );

    res.status(201).json({
      user: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to create user."
    });
  }
});

app.post("/api/mining/start", async (req, res) => {
  try {
    const { piUsername } = req.body;

    const user = await query(
      `
      SELECT id
      FROM users
      WHERE pi_username = $1
      `,
      [piUsername]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    const userId = user.rows[0].id;

    const active = await query(
      `
      SELECT id, started_at
      FROM mining_sessions
      WHERE user_id = $1
      AND status = 'active'
      LIMIT 1
      `,
      [userId]
    );

    if (active.rows.length > 0) {
      return res.status(409).json({
        error: "Mining is already active.",
        session: active.rows[0]
      });
    }

    const session = await query(
      `
      INSERT INTO mining_sessions
      (user_id, rate_adt_per_hour, status)
      VALUES ($1, $2, 'active')
      RETURNING id, started_at, rate_adt_per_hour, status
      `,
      [userId, MINING_RATE]
    );

    res.status(201).json({
      message: "ADT mining started.",
      session: session.rows[0],
      miningRate: MINING_RATE,
      dailyLimit: DAILY_LIMIT
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to start mining."
    });
  }
});

app.get("/api/mining/status", async (req, res) => {
  try {
    const { piUsername } = req.query;

    const result = await query(
      `
      SELECT
        ms.id,
        ms.started_at,
        ms.rate_adt_per_hour
      FROM mining_sessions ms
      JOIN users u ON u.id = ms.user_id
      WHERE u.pi_username = $1
      AND ms.status = 'active'
      LIMIT 1
      `,
      [piUsername]
    );

    if (result.rows.length === 0) {
      return res.json({
        active: false,
        earnedADT: 0
      });
    }

    const session = result.rows[0];

    const elapsed =
      Date.now() - new Date(session.started_at).getTime();

    const hours = Math.max(0, elapsed / 3600000);

    const earned = Number(
      (hours * Number(session.rate_adt_per_hour)).toFixed(8)
    );

    res.json({
      active: true,
      sessionId: session.id,
      startedAt: session.started_at,
      rateADTPerHour: Number(session.rate_adt_per_hour),
      earnedADT: earned
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to read mining status."
    });
  }
});

app.post("/api/mining/stop", async (req, res) => {
  try {
    const { piUsername } = req.body;

    const result = await query(
      `
      SELECT
        ms.id,
        ms.user_id,
        ms.started_at,
        ms.rate_adt_per_hour
      FROM mining_sessions ms
      JOIN users u ON u.id = ms.user_id
      WHERE u.pi_username = $1
      AND ms.status = 'active'
      LIMIT 1
      `,
      [piUsername]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "No active mining session."
      });
    }

    const session = result.rows[0];

    const elapsed =
      Date.now() - new Date(session.started_at).getTime();

    const hours = Math.max(0, elapsed / 3600000);

    const earned = Number(
      (hours * Number(session.rate_adt_per_hour)).toFixed(8)
    );

    await query(
      `
      UPDATE mining_sessions
      SET
        stopped_at = NOW(),
        status = 'completed',
        earned_adt = $1
      WHERE id = $2
      `,
      [earned, session.id]
    );

    await query(
      `
      INSERT INTO balances (user_id, available_adt)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET
        available_adt =
          balances.available_adt + EXCLUDED.available_adt,
        updated_at = NOW()
      `,
      [session.user_id, earned]
    );

    const balance = await query(
      `
      SELECT available_adt
      FROM balances
      WHERE user_id = $1
      `,
      [session.user_id]
    );

    res.json({
      message: "Mining completed.",
      sessionId: session.id,
      earnedADT: earned,
      balanceADT: Number(balance.rows[0].available_adt)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to stop mining."
    });
  }
});

app.get("/api/balance", async (req, res) => {
  try {
    const { piUsername } = req.query;

    const result = await query(
      `
      SELECT
        u.pi_username,
        b.available_adt
      FROM users u
      JOIN balances b ON b.user_id = u.id
      WHERE u.pi_username = $1
      `,
      [piUsername]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    res.json({
      piUsername: result.rows[0].pi_username,
      balanceADT: Number(result.rows[0].available_adt)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to read balance."
    });
  }
});

app.get("/api/mining/history", async (req, res) => {
  try {
    const { piUsername } = req.query;

    const result = await query(
      `
      SELECT
        ms.id,
        ms.started_at,
        ms.stopped_at,
        ms.status,
        ms.rate_adt_per_hour,
        ms.earned_adt
      FROM mining_sessions ms
      JOIN users u ON u.id = ms.user_id
      WHERE u.pi_username = $1
      ORDER BY ms.started_at DESC
      LIMIT 50
      `,
      [piUsername]
    );

    res.json({
      history: result.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to read mining history."
    });
  }
});

async function startServer() {
  try {
    if (pool) {
      await initializeDatabase();
      console.log("Database initialized.");
    } else {
      console.log("DATABASE_URL is not configured yet.");
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`ADT backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Startup failed:", error);
    process.exit(1);
  }
}

startServer();