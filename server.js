"use strict";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL = process.env.DATABASE_URL;
const PI_API_KEY = process.env.PI_API_KEY;

const MINING_RATE = 0.25;
const MINING_HOURS = 24;
const DAILY_LIMIT = MINING_RATE * MINING_HOURS;

const PI_SANDBOX =
  String(process.env.PI_SANDBOX || "true").toLowerCase() === "true";

const ADT_TEST_USERNAME =
  String(process.env.ADT_TEST_USERNAME || "").trim();

const PI_PLATFORM_API = "https://api.minepi.com/v2";

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;


/* ============================================================
   HELPERS
   ============================================================ */

async function query(text, params = []) {
  if (!pool) {
    throw new Error("DATABASE_URL is not configured.");
  }

  return pool.query(text, params);
}


function validUsername(username) {
  return (
    typeof username === "string" &&
    /^[A-Za-z0-9._-]{1,64}$/.test(username)
  );
}


function validWalletAddress(address) {
  if (typeof address !== "string") return false;

  return /^G[A-Z2-7]{20,60}$/.test(address.trim());
}


function isTestUser(username) {
  if (!ADT_TEST_USERNAME || !username) return false;

  return (
    String(username).toLowerCase() ===
    ADT_TEST_USERNAME.toLowerCase()
  );
}


function getReputationLevel(score) {
  if (score >= 900) return "Legend";
  if (score >= 750) return "Elite";
  if (score >= 500) return "Trusted";
  if (score >= 250) return "Established";
  if (score >= 100) return "Miner";
  return "Newcomer";
}


/* ============================================================
   PI API
   ============================================================ */

async function piApiRequest(path, method = "GET", body = null) {
  if (!PI_API_KEY) {
    throw new Error("PI_API_KEY is not configured.");
  }

  const options = {
    method,
    headers: {
      Authorization: `Key ${PI_API_KEY}`,
      "Content-Type": "application/json"
    }
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(
    PI_PLATFORM_API + path,
    options
  );

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      data.error_message ||
      data.error ||
      `Pi API request failed (${response.status}).`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}


/* ============================================================
   PI USER VERIFICATION
   ============================================================ */

async function verifyPiUser(accessToken) {
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 10
  ) {
    throw new Error("Invalid Pi access token.");
  }

  const response = await fetch(
    PI_PLATFORM_API + "/me",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      data.error_message ||
      data.error ||
      "Pi user verification failed."
    );

    error.status = response.status;
    throw error;
  }

  if (!data || !data.username) {
    throw new Error(
      "Pi did not return a valid username."
    );
  }

  return data;
}


/*
 * Require authenticated Pi account.
 *
 * Every protected endpoint should send:
 *
 * {
 *   piUsername,
 *   accessToken
 * }
 */

async function requirePiUser(piUsername, accessToken) {
  if (!validUsername(piUsername)) {
    const error = new Error("Invalid Pi username.");
    error.status = 400;
    throw error;
  }

  if (
    typeof accessToken !== "string" ||
    accessToken.length < 10
  ) {
    const error = new Error(
      "Pi access token is required."
    );
    error.status = 401;
    throw error;
  }

  const piUser = await verifyPiUser(accessToken);

  if (
    String(piUser.username).toLowerCase() !==
    String(piUsername).toLowerCase()
  ) {
    const error = new Error(
      "Pi account does not match the requested username."
    );
    error.status = 403;
    throw error;
  }

  return piUser;
}


async function getUserId(piUsername) {
  const result = await query(
    `
    SELECT id
    FROM users
    WHERE LOWER(pi_username) = LOWER($1)
    `,
    [piUsername]
  );

  if (result.rows.length === 0) {
    const error = new Error(
      "User not found. Please sign in with Pi first."
    );

    error.status = 404;
    throw error;
  }

  return result.rows[0].id;
}


/* ============================================================
   DATABASE INITIALIZATION
   ============================================================ */

async function initializeDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      pi_username TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS balances (
      user_id BIGINT PRIMARY KEY
        REFERENCES users(id)
        ON DELETE CASCADE,

      available_adt NUMERIC(30,8)
        NOT NULL DEFAULT 0,

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mining_sessions (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      started_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      stopped_at TIMESTAMPTZ,

      status TEXT
        NOT NULL DEFAULT 'active',

      rate_adt_per_hour NUMERIC(20,8)
        NOT NULL,

      earned_adt NUMERIC(30,8)
        NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,

      payment_id TEXT UNIQUE NOT NULL,

      pi_username TEXT,

      product TEXT,

      amount NUMERIC(20,8),

      txid TEXT UNIQUE,

      status TEXT
        NOT NULL DEFAULT 'created',

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      payment_id TEXT UNIQUE NOT NULL,

      product TEXT NOT NULL,

      amount NUMERIC(20,8) NOT NULL,

      txid TEXT UNIQUE NOT NULL,

      purchased_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id BIGSERIAL PRIMARY KEY,

      user_id BIGINT UNIQUE NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      wallet_address TEXT UNIQUE NOT NULL,

      verification_status TEXT
        NOT NULL DEFAULT 'pending',

      submitted_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      verified_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS reputation (
      user_id BIGINT PRIMARY KEY
        REFERENCES users(id)
        ON DELETE CASCADE,

      score INTEGER
        NOT NULL DEFAULT 100,

      mining_cycles INTEGER
        NOT NULL DEFAULT 0,

      completed_purchases INTEGER
        NOT NULL DEFAULT 0,

      wallet_verified BOOLEAN
        NOT NULL DEFAULT FALSE,

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mining_user_status
      ON mining_sessions(user_id, status);

    CREATE INDEX IF NOT EXISTS idx_purchases_user
      ON purchases(user_id);

    CREATE INDEX IF NOT EXISTS idx_payments_username
      ON payments(pi_username);
  `);
}


/* ============================================================
   ROOT
   ============================================================ */

app.get("/", (req, res) => {
  res.json({
    service: "Alberto Digital Token",
    status: "online",
    version: "2.1.0",
    network: PI_SANDBOX
      ? "Pi Testnet / Sandbox"
      : "Pi Production",
    miningRate: MINING_RATE,
    miningCycle: `${MINING_HOURS} hours`,
    dailyLimit: DAILY_LIMIT
  });
});


/* ============================================================
   HEALTH
   ============================================================ */

app.get("/health", async (req, res) => {
  try {
    let database = false;

    if (pool) {
      await query("SELECT 1");
      database = true;
    }

    res.json({
      ok: true,
      database,
      piApiKeyConfigured: Boolean(PI_API_KEY),
      piSandbox: PI_SANDBOX,
      developerTestUserConfigured:
        Boolean(ADT_TEST_USERNAME),
      time: new Date().toISOString()
    });

  } catch (error) {
    console.error("Health error:", error);

    res.status(503).json({
      ok: false,
      database: false,
      error: error.message
    });
  }
});


/* ============================================================
   REGISTER USER
   ============================================================ */

app.post("/api/users", async (req, res) => {
  try {
    const {
      piUsername,
      accessToken
    } = req.body;

    await requirePiUser(
      piUsername,
      accessToken
    );

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

    const user = result.rows[0];

    await query(
      `
      INSERT INTO balances (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [user.id]
    );

    await query(
      `
      INSERT INTO reputation (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [user.id]
    );

    res.status(201).json({
      user
    });

  } catch (error) {
    console.error(
      "User registration error:",
      error
    );

    res.status(error.status || 500).json({
      error:
        error.message ||
        "Unable to create user."
    });
  }
});


/* ============================================================
   PROFILE
   ============================================================ */

app.get("/api/profile", async (req, res) => {
  try {
    const {
      piUsername,
      accessToken
    } = req.query;

    await requirePiUser(
      piUsername,
      accessToken
    );

    const result = await query(
      `
      SELECT
        u.id,
        u.pi_username,
        b.available_adt,
        r.score,
        r.mining_cycles,
        r.completed_purchases,
        r.wallet_verified
      FROM users u

      LEFT JOIN balances b
        ON b.user_id = u.id

      LEFT JOIN reputation r
        ON r.user_id = u.id

      WHERE LOWER(u.pi_username) = LOWER($1)
      `,
      [piUsername]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    const user = result.rows[0];

    res.json({
      username: user.pi_username,

      balanceADT:
        Number(user.available_adt || 0),

      reputation: {
        score: Number(user.score || 100),

        level:
          getReputationLevel(
            Number(user.score || 100)
          ),

        miningCycles:
          Number(user.mining_cycles || 0),

        completedPurchases:
          Number(
            user.completed_purchases || 0
          ),

        walletVerified:
          Boolean(user.wallet_verified)
      }
    });

  } catch (error) {
    console.error(
      "Profile error:",
      error
    );

    res.status(error.status || 500).json({
      error:
        error.message ||
        "Unable to read profile."
    });
  }
});


/* ============================================================
   WALLET SUBMISSION
   ============================================================ */

app.post("/api/wallet", async (req, res) => {
  try {
    const {
      piUsername,
      walletAddress,
      accessToken
    } = req.body;

    await requirePiUser(
      piUsername,
      accessToken
    );

    if (!validWalletAddress(walletAddress)) {
      return res.status(400).json({
        error:
          "Invalid wallet address format."
      });
    }

    const userId =
      await getUserId(piUsername);

    const result = await query(
      `
      INSERT INTO wallets (
        user_id,
        wallet_address,
        verification_status
      )

      VALUES (
        $1,
        $2,
        'pending'
      )

      ON CONFLICT (user_id)

      DO UPDATE SET
        wallet_address =
          EXCLUDED.wallet_address,

        verification_status =
          'pending',

        submitted_at =
          NOW(),

        verified_at =
          NULL

      RETURNING
        wallet_address,
        verification_status,
        submitted_at
      `,
      [
        userId,
        walletAddress.trim()
      ]
    );

    await query(
      `
      UPDATE reputation

      SET
        wallet_verified = FALSE,
        updated_at = NOW()

      WHERE user_id = $1
      `,
      [userId]
    );

    res.json({
      ok: true,

      message:
        "Wallet submitted for verification.",

      wallet:
        result.rows[0]
    });

  } catch (error) {
    console.error(
      "Wallet submission error:",
      error
    );

    res.status(error.status || 500).json({
      error:
        error.message ||
        "Unable to submit wallet."
    });
  }
});


/* ============================================================
   WALLET STATUS
   ============================================================ */

app.get("/api/wallet", async (req, res) => {
  try {
    const {
      piUsername,
      accessToken
    } = req.query;

    await requirePiUser(
      piUsername,
      accessToken
    );

    const result = await query(
      `
      SELECT
        w.wallet_address,
        w.verification_status,
        w.submitted_at,
        w.verified_at

      FROM wallets w

      JOIN users u
        ON u.id = w.user_id

      WHERE LOWER(u.pi_username) =
        LOWER($1)
      `,
      [piUsername]
    );

    if (result.rows.length === 0) {
      return res.json({
        exists: false,
        verificationStatus:
          "not_submitted"
      });
    }

    res.json({
      exists: true,
      wallet: result.rows[0]
    });

  } catch (error) {
    console.error(
      "Wallet status error:",
      error
    );

    res.status(error.status || 500).json({
      error:
        error.message ||
        "Unable to read wallet status."
    });
  }
});


/* ============================================================
   START MINING
   ============================================================ */

app.post(
  "/api/mining/start",
  async (req, res) => {
    try {
      const {
        piUsername,
        accessToken
      } = req.body;

      await requirePiUser(
        piUsername,
        accessToken
      );

      const userId =
        await getUserId(piUsername);

      const active = await query(
        `
        SELECT
          id,
          started_at
        FROM mining_sessions
        WHERE user_id = $1
          AND status = 'active'
        LIMIT 1
        `,
        [userId]
      );

      if (active.rows.length > 0) {
        return res.status(409).json({
          error:
            "Mining is already active.",
          session:
            active.rows[0]
        });
      }

      const session = await query(
        `
        INSERT INTO mining_sessions (
          user_id,
          rate_adt_per_hour,
          status
        )

        VALUES (
          $1,
          $2,
          'active'
        )

        RETURNING
          id,
          started_at,
          rate_adt_per_hour,
          status
        `,
        [
          userId,
          MINING_RATE
        ]
      );

      res.status(201).json({
        message:
          "ADT mining started.",

        session:
          session.rows[0],

        miningRate:
          MINING_RATE,

        miningHours:
          MINING_HOURS,

        maximumEarnedADT:
          DAILY_LIMIT
      });

    } catch (error) {
      console.error(
        "Mining start error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Unable to start mining."
      });
    }
  }
);


/* ============================================================
   MINING STATUS
   ============================================================ */

app.get(
  "/api/mining/status",
  async (req, res) => {
    try {
      const {
        piUsername,
        accessToken
      } = req.query;

      await requirePiUser(
        piUsername,
        accessToken
      );

      const result = await query(
        `
        SELECT
          ms.id,
          ms.started_at,
          ms.rate_adt_per_hour

        FROM mining_sessions ms

        JOIN users u
          ON u.id = ms.user_id

        WHERE LOWER(u.pi_username) =
          LOWER($1)

        AND ms.status = 'active'

        LIMIT 1
        `,
        [piUsername]
      );

      if (result.rows.length === 0) {
        return res.json({
          active: false,
          canClaim: false,
          earnedADT: 0,
          remainingSeconds: 0
        });
      }

      const session =
        result.rows[0];

      const elapsedMs =
        Date.now() -
        new Date(
          session.started_at
        ).getTime();

      const totalMs =
        MINING_HOURS *
        60 *
        60 *
        1000;

      const remainingMs =
        Math.max(
          0,
          totalMs - elapsedMs
        );

      const canClaim =
        elapsedMs >= totalMs;

      const elapsedHours =
        Math.min(
          MINING_HOURS,
          Math.max(
            0,
            elapsedMs / 3600000
          )
        );

      const earned =
        Number(
          (
            elapsedHours *
            Number(
              session.rate_adt_per_hour
            )
          ).toFixed(8)
        );

      res.json({
        active: true,

        canClaim,

        sessionId:
          session.id,

        startedAt:
          session.started_at,

        rateADTPerHour:
          Number(
            session.rate_adt_per_hour
          ),

        earnedADT:
          earned,

        maximumEarnedADT:
          DAILY_LIMIT,

        remainingSeconds:
          Math.ceil(
            remainingMs / 1000
          )
      });

    } catch (error) {
      console.error(
        "Mining status error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Unable to read mining status."
      });
    }
  }
);


/* ============================================================
   CLAIM MINING
   ============================================================ */

app.post(
  "/api/mining/stop",
  async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        error:
          "Database is not configured."
      });
    }

    const client =
      await pool.connect();

    try {
      const {
        piUsername,
        accessToken
      } = req.body;

      await requirePiUser(
        piUsername,
        accessToken
      );

      await client.query("BEGIN");

      const result =
        await client.query(
          `
          SELECT
            ms.id,
            ms.user_id,
            ms.started_at,
            ms.rate_adt_per_hour

          FROM mining_sessions ms

          JOIN users u
            ON u.id = ms.user_id

          WHERE LOWER(u.pi_username) =
            LOWER($1)

          AND ms.status = 'active'

          FOR UPDATE
          `,
          [piUsername]
        );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error:
            "No active mining session."
        });
      }

      const session =
        result.rows[0];

      const elapsedMs =
        Date.now() -
        new Date(
          session.started_at
        ).getTime();

      const totalMs =
        MINING_HOURS *
        60 *
        60 *
        1000;

      if (elapsedMs < totalMs) {
        const remainingSeconds =
          Math.ceil(
            (totalMs - elapsedMs) /
            1000
          );

        await client.query("ROLLBACK");

        return res.status(409).json({
          error:
            "Mining cycle is not complete yet.",
          remainingSeconds
        });
      }

      const earned =
        DAILY_LIMIT;

      await client.query(
        `
        UPDATE mining_sessions

        SET
          stopped_at = NOW(),
          status = 'completed',
          earned_adt = $1

        WHERE id = $2
        `,
        [
          earned,
          session.id
        ]
      );

      await client.query(
        `
        INSERT INTO balances (
          user_id,
          available_adt
        )

        VALUES ($1, $2)

        ON CONFLICT (user_id)

        DO UPDATE SET

          available_adt =
            balances.available_adt +
            EXCLUDED.available_adt,

          updated_at = NOW()
        `,
        [
          session.user_id,
          earned
        ]
      );

      const balance =
        await client.query(
          `
          SELECT available_adt
          FROM balances
          WHERE user_id = $1
          `,
          [session.user_id]
        );

      await client.query(
        `
        UPDATE reputation

        SET
          mining_cycles =
            mining_cycles + 1,

          score =
            LEAST(
              1000,
              score + 1
            ),

          updated_at = NOW()

        WHERE user_id = $1
        `,
        [session.user_id]
      );

      await client.query("COMMIT");

      res.json({
        message:
          "24-hour mining completed.",

        sessionId:
          session.id,

        earnedADT:
          earned,

        balanceADT:
          Number(
            balance.rows[0]
              .available_adt
          )
      });

    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Mining claim error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Unable to claim ADT."
      });

    } finally {
      client.release();
    }
  }
);


/* ============================================================
   BALANCE
   ============================================================ */

app.get(
  "/api/balance",
  async (req, res) => {
    try {
      const {
        piUsername,
        accessToken
      } = req.query;

      await requirePiUser(
        piUsername,
        accessToken
      );

      const result =
        await query(
          `
          SELECT
            u.pi_username,
            b.available_adt

          FROM users u

          JOIN balances b
            ON b.user_id = u.id

          WHERE LOWER(u.pi_username) =
            LOWER($1)
          `,
          [piUsername]
        );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error:
            "User not found."
        });
      }

      res.json({
        piUsername:
          result.rows[0]
            .pi_username,

        balanceADT:
          Number(
            result.rows[0]
              .available_adt
          )
      });

    } catch (error) {
      console.error(
        "Balance error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Unable to read balance."
      });
    }
  }
);


/* ============================================================
   MINING HISTORY
   ============================================================ */

app.get(
  "/api/mining/history",
  async (req, res) => {
    try {
      const {
        piUsername,
        accessToken
      } = req.query;

      await requirePiUser(
        piUsername,
        accessToken
      );

      const result =
        await query(
          `
          SELECT
            ms.id,
            ms.started_at,
            ms.stopped_at,
            ms.status,
            ms.rate_adt_per_hour,
            ms.earned_adt

          FROM mining_sessions ms

          JOIN users u
            ON u.id = ms.user_id

          WHERE LOWER(u.pi_username) =
            LOWER($1)

          ORDER BY
            ms.started_at DESC

          LIMIT 50
          `,
          [piUsername]
        );

      res.json({
        history:
          result.rows
      });

    } catch (error) {
      console.error(
        "Mining history error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Unable to read mining history."
      });
    }
  }
);


/* ============================================================
   REPUTATION
   ============================================================ */

app.get(
  "/api/reputation",
  async (req, res) => {
    try {
      const {
        piUsername,
        accessToken
      } = req.query;

      await requirePiUser(
        piUsername,
        accessToken
      );

      const result =
        await query(
          `
          SELECT
            r.score,
            r.mining_cycles,
            r.completed_purchases,
            r.wallet_verified

          FROM reputation r

          JOIN users u
            ON u.id = r.user_id

          WHERE LOWER(u.pi_username) =
            LOWER($1)
          `,
          [piUsername]
        );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error:
            "Reputation profile not found."
        });
      }

      const reputation =
        result.rows[0];

      const score =
        Number(
          reputation.score
        );

      res.json({
        username: piUsername,

        reputation: {
          score,

          level:
            getReputationLevel(score),

          miningCycles:
            Number(
              reputation.mining_cycles
            ),

          completedPurchases:
            Number(
              reputation.completed_purchases
            ),

          walletVerified:
            Boolean(
              reputation.wallet_verified
            )
        }
      });

    } catch (error) {
      console.error(
        "Reputation error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Unable to read reputation."
      });
    }
  }
);


/* ============================================================
   MARKETPLACE
   ============================================================ */

app.get(
  "/api/marketplace",
  async (req, res) => {
    try {
      const {
        piUsername,
        accessToken
      } = req.query;

      /*
       * Marketplace can be viewed publicly,
       * but the developer test product requires
       * verified Pi identity.
       */

      const products = [];

      if (
        piUsername &&
        isTestUser(piUsername)
      ) {
        if (accessToken) {
          await requirePiUser(
            piUsername,
            accessToken
          );
        }

        products.push({
          id:
            "adt-digital-pet-test",

          name:
            "ADT Digital Pet",

          description:
            "Developer checklist test item.",

          price:
            0.1,

          currency:
            "Test-Pi",

          testOnly:
            true,

          available:
            true
        });
      }

      res.json({
        network:
          PI_SANDBOX
            ? "testnet"
            : "production",

        products
      });

    } catch (error) {
      console.error(
        "Marketplace error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Unable to load marketplace."
      });
    }
  }
);


/* ============================================================
   PAYMENT APPROVAL
   ============================================================ */

app.post(
  "/api/payments/approve",
  async (req, res) => {
    try {
      const {
        paymentId,
        piUsername,
        accessToken
      } = req.body;

      if (
        typeof paymentId !== "string" ||
        paymentId.length < 3
      ) {
        return res.status(400).json({
          error:
            "Invalid payment ID."
        });
      }

      await requirePiUser(
        piUsername,
        accessToken
      );

      if (!isTestUser(piUsername)) {
        return res.status(403).json({
          error:
            "Marketplace test payment is restricted to the developer test account."
        });
      }

      const payment =
        await piApiRequest(
          `/payments/${encodeURIComponent(
            paymentId
          )}/approve`,
          "POST",
          {}
        );

      await query(
        `
        INSERT INTO payments (
          payment_id,
          pi_username,
          product,
          status
        )

        VALUES (
          $1,
          $2,
          'adt-digital-pet-test',
          'approved'
        )

        ON CONFLICT (payment_id)

        DO UPDATE SET
          pi_username =
            EXCLUDED.pi_username,

          status =
            'approved'
        `,
        [
          paymentId,
          piUsername
        ]
      );

      res.json({
        ok: true,
        message:
          "Payment approved.",
        payment
      });

    } catch (error) {
      console.error(
        "Payment approval error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Payment approval failed."
      });
    }
  }
);


/* ============================================================
   PAYMENT COMPLETION
   ============================================================ */

app.post(
  "/api/payments/complete",
  async (req, res) => {
    if (!pool) {
      return res.status(503).json({
        error:
          "Database is not configured."
      });
    }

    const client =
      await pool.connect();

    try {
      const {
        paymentId,
        txid,
        piUsername,
        product,
        accessToken
      } = req.body;

      if (
        typeof paymentId !== "string" ||
        typeof txid !== "string" ||
        typeof piUsername !== "string" ||
        typeof product !== "string"
      ) {
        return res.status(400).json({
          error:
            "Missing or invalid payment data."
        });
      }

      await requirePiUser(
        piUsername,
        accessToken
      );

      if (
        product ===
          "adt-digital-pet-test" &&
        !isTestUser(piUsername)
      ) {
        return res.status(403).json({
          error:
            "This Test-Pi product is restricted to the developer test account."
        });
      }

      /*
       * Prevent completion of an already
       * completed payment.
       */

      const existing =
        await client.query(
          `
          SELECT
            payment_id,
            status,
            txid

          FROM payments

          WHERE payment_id = $1
          `,
          [paymentId]
        );

      if (
        existing.rows.length > 0 &&
        existing.rows[0].status ===
          "completed"
      ) {
        return res.status(409).json({
          error:
            "Payment has already been completed."
        });
      }

      /*
       * Ask Pi to complete the payment.
       */

      const payment =
        await piApiRequest(
          `/payments/${encodeURIComponent(
            paymentId
          )}/complete`,
          "POST",
          { txid }
        );

      const amount =
        Number(
          payment.amount || 0
        );

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(
          "Pi returned an invalid payment amount."
        );
      }

      /*
       * Verify payment user where Pi provides
       * the required information.
       */

      if (
        payment.user &&
        payment.user.username &&
        String(payment.user.username)
          .toLowerCase() !==
          String(piUsername).toLowerCase()
      ) {
        const error = new Error(
          "Payment user does not match the authenticated Pi account."
        );

        error.status = 403;

        throw error;
      }

      const userId =
        await getUserId(piUsername);

      await client.query("BEGIN");

      await client.query(
        `
        INSERT INTO payments (
          payment_id,
          pi_username,
          product,
          amount,
          txid,
          status,
          completed_at
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          'completed',
          NOW()
        )

        ON CONFLICT (payment_id)

        DO UPDATE SET

          pi_username =
            EXCLUDED.pi_username,

          product =
            EXCLUDED.product,

          amount =
            EXCLUDED.amount,

          txid =
            EXCLUDED.txid,

          status =
            'completed',

          completed_at =
            NOW()
        `,
        [
          paymentId,
          piUsername,
          product,
          amount,
          txid
        ]
      );

      const purchase =
        await client.query(
          `
          INSERT INTO purchases (
            user_id,
            payment_id,
            product,
            amount,
            txid
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5
          )

          ON CONFLICT (payment_id)
          DO NOTHING

          RETURNING id
          `,
          [
            userId,
            paymentId,
            product,
            amount,
            txid
          ]
        );

      if (purchase.rows.length > 0) {
        await client.query(
          `
          UPDATE reputation

          SET
            completed_purchases =
              completed_purchases + 1,

            score =
              LEAST(
                1000,
                score + 5
              ),

            updated_at = NOW()

          WHERE user_id = $1
          `,
          [userId]
        );
      }

      await client.query("COMMIT");

      res.json({
        ok: true,

        message:
          "Payment completed and purchase recorded.",

        paymentId,

        txid,

        product,

        amount,

        testnet:
          PI_SANDBOX
      });

    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Payment completion error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Payment completion failed."
      });

    } finally {
      client.release();
    }
  }
);


/* ============================================================
   PURCHASE HISTORY
   ============================================================ */

app.get(
  "/api/purchases",
  async (req, res) => {
    try {
      const {
        piUsername,
        accessToken
      } = req.query;

      await requirePiUser(
        piUsername,
        accessToken
      );

      const result =
        await query(
          `
          SELECT
            p.id,
            p.product,
            p.amount,
            p.txid,
            p.purchased_at

          FROM purchases p

          JOIN users u
            ON u.id = p.user_id

          WHERE LOWER(u.pi_username) =
            LOWER($1)

          ORDER BY
            p.purchased_at DESC
          `,
          [piUsername]
        );

      res.json({
        purchases:
          result.rows
      });

    } catch (error) {
      console.error(
        "Purchase history error:",
        error
      );

      res.status(error.status || 500).json({
        error:
          error.message ||
          "Unable to read purchases."
      });
    }
  }
);


/* ============================================================
   404
   ============================================================ */

app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found."
  });
});


/* ============================================================
   START SERVER
   ============================================================ */

async function startServer() {
  try {
    if (pool) {
      await initializeDatabase();

      console.log(
        "Database initialized."
      );
    } else {
      console.log(
        "DATABASE_URL is not configured."
      );
    }

    if (!PI_API_KEY) {
      console.warn(
        "WARNING: PI_API_KEY is not configured."
      );
    }

    if (!ADT_TEST_USERNAME) {
      console.warn(
        "WARNING: ADT_TEST_USERNAME is not configured."
      );
    }

    console.log(
      "Pi network:",
      PI_SANDBOX
        ? "TESTNET / SANDBOX"
        : "PRODUCTION"
    );

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `ADT backend running on port ${PORT}`
        );
      }
    );

  } catch (error) {
    console.error(
      "Startup failed:",
      error
    );

    process.exit(1);
  }
}


startServer();