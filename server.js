"use strict";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;
const PI_API_KEY = process.env.PI_API_KEY;

const ADT_TEST_PI_USERNAME =
  (process.env.ADT_TEST_PI_USERNAME || "")
    .replace(/^@/, "")
    .trim();

const ADT_TEST_WALLET_ADDRESS =
  (process.env.ADT_TEST_WALLET_ADDRESS || "").trim();

/*
 * ============================================================
 * ADT MINING SETTINGS
 * ============================================================
 */

const MINING_RATE = 0.25;
const MINING_HOURS = 24;
const DAILY_LIMIT =
  MINING_RATE * MINING_HOURS;


/*
 * ============================================================
 * TEST PET
 * ============================================================
 *
 * Testing only.
 */

const TEST_PET_PRODUCT = "adt-digital-pet";
const TEST_PET_AMOUNT = 0.1;


/*
 * ============================================================
 * PI PLATFORM API
 * ============================================================
 */

const PI_PLATFORM_API =
  "https://api.minepi.com/v2";


/*
 * ============================================================
 * DATABASE
 * ============================================================
 */

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;


async function query(text, params = []) {

  if (!pool) {
    throw new Error(
      "DATABASE_URL is not configured."
    );
  }

  return pool.query(text, params);
}


/*
 * ============================================================
 * PI SERVER API REQUEST
 *
 * Used for server-authorized endpoints such as:
 * - payment information
 * - payment approval
 * - payment completion
 * ============================================================
 */

async function piApiRequest(
  path,
  method = "GET",
  body = null
) {

  if (!PI_API_KEY) {
    const error = new Error(
      "PI_API_KEY is not configured."
    );

    error.status = 500;

    throw error;
  }


  const options = {
    method,
    headers: {
      "Authorization":
        `Key ${PI_API_KEY}`,
      "Content-Type":
        "application/json"
    }
  };


  if (body !== null) {
    options.body =
      JSON.stringify(body);
  }


  const response =
    await fetch(
      PI_PLATFORM_API + path,
      options
    );


  const text =
    await response.text();


  let data = {};

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text
    };

  }


  if (!response.ok) {

    const error =
      new Error(
        data.error_message ||
        data.error ||
        `Pi API request failed (${response.status}).`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }


  return data;
}


/*
 * ============================================================
 * PI USER ACCESS TOKEN VERIFICATION
 *
 * IMPORTANT:
 * The frontend access token is verified directly
 * against Pi's /me endpoint.
 * ============================================================
 */

async function verifyPiAccessToken(
  accessToken
) {

  if (
    typeof accessToken !== "string" ||
    accessToken.trim().length < 1
  ) {

    const error =
      new Error(
        "Pi access token is required."
      );

    error.status = 401;

    throw error;
  }


  const response =
    await fetch(
      PI_PLATFORM_API + "/me",
      {
        method: "GET",

        headers: {
          "Authorization":
            `Bearer ${accessToken.trim()}`
        }
      }
    );


  const text =
    await response.text();


  let data = {};

  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      raw: text
    };

  }


  if (!response.ok) {

    const error =
      new Error(
        data.error_message ||
        data.error ||
        "Invalid or expired Pi access token."
      );

    error.status =
      response.status === 401
        ? 401
        : 502;

    error.data =
      data;

    throw error;
  }


  /*
   * Pi UserDTO is expected to contain:
   *
   * {
   *   uid,
   *   username
   * }
   */

  const uid =
    data.uid ||
    (data.user && data.user.uid);

  const username =
    data.username ||
    (data.user && data.user.username);


  if (
    typeof uid !== "string" ||
    typeof username !== "string"
  ) {

    const error =
      new Error(
        "Pi identity response is incomplete."
      );

    error.status = 502;

    throw error;
  }


  return {
    uid,
    username
  };
}


/*
 * ============================================================
 * REQUIRE VERIFIED PI USER
 * ============================================================
 */

async function requirePiUser(
  req,
  res,
  next
) {

  try {

    const accessToken =
      req.headers.authorization
        ?.replace(/^Bearer\s+/i, "")
        .trim();


    if (!accessToken) {

      return res.status(401).json({
        error:
          "Pi authentication required."
      });

    }


    const piUser =
      await verifyPiAccessToken(
        accessToken
      );


    req.piUser =
      piUser;


    next();

  } catch (error) {

    console.error(
      "Pi authentication error:",
      error.message
    );


    return res.status(
      error.status || 401
    ).json({

      error:
        error.message ||
        "Pi authentication failed."

    });

  }

}


/*
 * ============================================================
 * REQUIRE TEST ADMIN
 *
 * IMPORTANT:
 * The username is obtained from the
 * verified Pi /me response.
 * ============================================================
 */

function requireTestAdmin(
  req,
  res,
  next
) {

  if (
    !ADT_TEST_PI_USERNAME
  ) {

    return res.status(503).json({

      error:
        "ADT test administrator is not configured."

    });

  }


  if (
    !req.piUser ||
    req.piUser.username !==
      ADT_TEST_PI_USERNAME
  ) {

    return res.status(403).json({

      error:
        "This testing feature is restricted."

    });

  }


  next();
}


/*
 * ============================================================
 * INITIALIZE DATABASE
 * ============================================================
 */

async function initializeDatabase() {

  await query(`
    CREATE TABLE IF NOT EXISTS users (

      id BIGSERIAL PRIMARY KEY,

      pi_uid TEXT UNIQUE,

      pi_username TEXT UNIQUE NOT NULL,

      wallet_address TEXT,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()

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

      pi_uid TEXT,

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


    CREATE TABLE IF NOT EXISTS wallet_reputation (

      user_id BIGINT PRIMARY KEY
        REFERENCES users(id)
        ON DELETE CASCADE,

      wallet_address TEXT UNIQUE,

      trust_level TEXT
        NOT NULL DEFAULT 'Limited',

      trust_score INTEGER
        NOT NULL DEFAULT 0,

      verification_status TEXT
        NOT NULL DEFAULT 'unverified',

      successful_purchases INTEGER
        NOT NULL DEFAULT 0,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()

    );
  `);


  /*
   * Migration support for older databases.
   */

  try {

    await query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS pi_uid TEXT UNIQUE
    `);

  } catch (error) {

    console.warn(
      "pi_uid migration warning:",
      error.message
    );

  }


  try {

    await query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS wallet_address TEXT
    `);

  } catch (error) {

    console.warn(
      "wallet_address migration warning:",
      error.message
    );

  }


  try {

    await query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
      NOT NULL DEFAULT NOW()
    `);

  } catch (error) {

    console.warn(
      "updated_at migration warning:",
      error.message
    );

  }


  console.log(
    "Database initialized."
  );
}


/*
 * ============================================================
 * ROOT
 * ============================================================
 */

app.get("/", (req, res) => {

  res.json({

    service:
      "Alberto Digital Token",

    status:
      "online",

    version:
      "2.0.0",

    environment:
      "testing",

    miningRate:
      MINING_RATE,

    miningHours:
      MINING_HOURS,

    testPet:
      TEST_PET_PRODUCT

  });

});


/*
 * ============================================================
 * HEALTH
 * ============================================================
 */

app.get(
  "/health",
  async (req, res) => {

    try {

      if (pool) {

        await query(
          "SELECT 1"
        );

      }


      res.json({

        ok: true,

        database:
          Boolean(pool),

        piApiKeyConfigured:
          Boolean(PI_API_KEY),

        testAdminConfigured:
          Boolean(
            ADT_TEST_PI_USERNAME
          ),

        testWalletConfigured:
          Boolean(
            ADT_TEST_WALLET_ADDRESS
          ),

        time:
          new Date().toISOString()

      });

    } catch (error) {

      console.error(
        "Health check error:",
        error
      );


      res.status(503).json({

        ok: false,

        database: false

      });

    }

  }
);


/*
 * ============================================================
 * VERIFIED USER REGISTRATION
 *
 * IMPORTANT:
 * Username comes from Pi /me.
 * Frontend cannot choose the username.
 * ============================================================
 */

app.post(
  "/api/users",
  requirePiUser,
  async (req, res) => {

    try {

      const {
        uid,
        username
      } = req.piUser;


      const walletAddress =
        typeof req.body.walletAddress === "string"
          ? req.body.walletAddress.trim()
          : null;


      const result =
        await query(
          `
          INSERT INTO users
          (
            pi_uid,
            pi_username,
            wallet_address
          )

          VALUES
          ($1, $2, $3)

          ON CONFLICT (pi_username)

          DO UPDATE SET

            pi_uid =
              EXCLUDED.pi_uid,

            wallet_address =
              COALESCE(
                EXCLUDED.wallet_address,
                users.wallet_address
              ),

            updated_at =
              NOW()

          RETURNING
            id,
            pi_uid,
            pi_username,
            wallet_address,
            created_at,
            updated_at
          `,
          [
            uid,
            username,
            walletAddress
          ]
        );


      const user =
        result.rows[0];


      await query(
        `
        INSERT INTO balances
        (user_id)

        VALUES ($1)

        ON CONFLICT (user_id)
        DO NOTHING
        `,
        [user.id]
      );


      await query(
        `
        INSERT INTO wallet_reputation
        (
          user_id,
          wallet_address
        )

        VALUES
        ($1, $2)

        ON CONFLICT (user_id)

        DO UPDATE SET

          wallet_address =
            COALESCE(
              EXCLUDED.wallet_address,
              wallet_reputation.wallet_address
            ),

          updated_at =
            NOW()
        `,
        [
          user.id,
          walletAddress
        ]
      );


      res.status(200).json({

        ok: true,

        user

      });

    } catch (error) {

      console.error(
        "User registration error:",
        error
      );


      res.status(500).json({

        error:
          "Unable to create or update user."

      });

    }

  }
);


/*
 * ============================================================
 * CURRENT VERIFIED USER
 * ============================================================
 */

app.get(
  "/api/me",
  requirePiUser,
  async (req, res) => {

    try {

      const result =
        await query(
          `
          SELECT

            u.id,
            u.pi_uid,
            u.pi_username,
            u.wallet_address,

            b.available_adt

          FROM users u

          LEFT JOIN balances b
            ON b.user_id = u.id

          WHERE
            u.pi_uid = $1

          LIMIT 1
          `,
          [req.piUser.uid]
        );


      res.json({

        piUser:
          req.piUser,

        registered:
          result.rows.length > 0,

        account:
          result.rows[0] || null

      });

    } catch (error) {

      console.error(
        "Current user error:",
        error
      );


      res.status(500).json({

        error:
          "Unable to read current user."

      });

    }

  }
);


/*
 * ============================================================
 * SAVE / UPDATE PUBLIC WALLET ADDRESS
 * ============================================================
 */

app.post(
  "/api/wallet",
  requirePiUser,
  async (req, res) => {

    try {

      const {
        walletAddress
      } = req.body;


      if (
        typeof walletAddress !== "string" ||
        walletAddress.trim().length < 20 ||
        walletAddress.trim().length > 150
      ) {

        return res.status(400).json({

          error:
            "Invalid wallet address."

        });

      }


      const result =
        await query(
          `
          UPDATE users

          SET

            wallet_address = $1,

            updated_at = NOW()

          WHERE
            pi_uid = $2

          RETURNING
            id,
            pi_uid,
            pi_username,
            wallet_address
          `,
          [
            walletAddress.trim(),
            req.piUser.uid
          ]
        );


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not registered."

        });

      }


      await query(
        `
        INSERT INTO wallet_reputation
        (
          user_id,
          wallet_address
        )

        VALUES
        ($1, $2)

        ON CONFLICT (user_id)

        DO UPDATE SET

          wallet_address =
            EXCLUDED.wallet_address,

          updated_at =
            NOW()
        `,
        [
          result.rows[0].id,
          walletAddress.trim()
        ]
      );


      res.json({

        ok: true,

        walletAddress:
          walletAddress.trim(),

        verificationStatus:
          "unverified"

      });

    } catch (error) {

      console.error(
        "Wallet update error:",
        error
      );


      res.status(500).json({

        error:
          "Unable to save wallet address."

      });

    }

  }
);


/*
 * ============================================================
 * START MINING
 * ============================================================
 */

app.post(
  "/api/mining/start",
  requirePiUser,
  async (req, res) => {

    try {

      const user =
        await query(
          `
          SELECT id

          FROM users

          WHERE pi_uid = $1

          LIMIT 1
          `,
          [req.piUser.uid]
        );


      if (
        user.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not found. Please sign in again."

        });

      }


      const userId =
        user.rows[0].id;


      const active =
        await query(
          `
          SELECT

            id,
            started_at

          FROM mining_sessions

          WHERE
            user_id = $1

          AND
            status = 'active'

          LIMIT 1
          `,
          [userId]
        );


      if (
        active.rows.length > 0
      ) {

        return res.status(409).json({

          error:
            "Mining is already active.",

          session:
            active.rows[0]

        });

      }


      const session =
        await query(
          `
          INSERT INTO mining_sessions
          (
            user_id,
            rate_adt_per_hour,
            status
          )

          VALUES
          ($1, $2, 'active')

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


      res.status(500).json({

        error:
          "Unable to start mining."

      });

    }

  }
);


/*
 * ============================================================
 * MINING STATUS
 * ============================================================
 */

app.get(
  "/api/mining/status",
  requirePiUser,
  async (req, res) => {

    try {

      const result =
        await query(
          `
          SELECT

            ms.id,

            ms.started_at,

            ms.rate_adt_per_hour

          FROM mining_sessions ms

          JOIN users u
            ON u.id = ms.user_id

          WHERE
            u.pi_uid = $1

          AND
            ms.status = 'active'

          LIMIT 1
          `,
          [req.piUser.uid]
        );


      if (
        result.rows.length === 0
      ) {

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


      res.status(500).json({

        error:
          "Unable to read mining status."

      });

    }

  }
);


/*
 * ============================================================
 * CLAIM ADT AFTER 24 HOURS
 * ============================================================
 */

app.post(
  "/api/mining/stop",
  requirePiUser,
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

      await client.query(
        "BEGIN"
      );


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

          WHERE
            u.pi_uid = $1

          AND
            ms.status = 'active'

          FOR UPDATE
          `,
          [req.piUser.uid]
        );


      if (
        result.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );


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


      if (
        elapsedMs < totalMs
      ) {

        const remainingSeconds =
          Math.ceil(
            (
              totalMs -
              elapsedMs
            ) / 1000
          );


        await client.query(
          "ROLLBACK"
        );


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

        WHERE
          id = $2
        `,
        [
          earned,
          session.id
        ]
      );


      await client.query(
        `
        INSERT INTO balances
        (
          user_id,
          available_adt
        )

        VALUES
        ($1, $2)

        ON CONFLICT (user_id)

        DO UPDATE SET

          available_adt =
            balances.available_adt +
            EXCLUDED.available_adt,

          updated_at =
            NOW()
        `,
        [
          session.user_id,
          earned
        ]
      );


      const balance =
        await client.query(
          `
          SELECT
            available_adt

          FROM balances

          WHERE user_id = $1
          `,
          [session.user_id]
        );


      await client.query(
        "COMMIT"
      );


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

        await client.query(
          "ROLLBACK"
        );

      } catch {}

      console.error(
        "Mining claim error:",
        error
      );


      res.status(500).json({

        error:
          "Unable to claim ADT."

      });

    } finally {

      client.release();

    }

  }
);


/*
 * ============================================================
 * BALANCE
 * ============================================================
 */

app.get(
  "/api/balance",
  requirePiUser,
  async (req, res) => {

    try {

      const result =
        await query(
          `
          SELECT

            u.pi_username,

            b.available_adt

          FROM users u

          JOIN balances b
            ON b.user_id = u.id

          WHERE
            u.pi_uid = $1

          LIMIT 1
          `,
          [req.piUser.uid]
        );


      if (
        result.rows.length === 0
      ) {

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


      res.status(500).json({

        error:
          "Unable to read balance."

      });

    }

  }
);


/*
 * ============================================================
 * MINING HISTORY
 * ============================================================
 */

app.get(
  "/api/mining/history",
  requirePiUser,
  async (req, res) => {

    try {

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

          WHERE
            u.pi_uid = $1

          ORDER BY
            ms.started_at DESC

          LIMIT 50
          `,
          [req.piUser.uid]
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


      res.status(500).json({

        error:
          "Unable to read mining history."

      });

    }

  }
);


/*
 * ============================================================
 * TEST PET ACCESS
 *
 * ONLY the configured test admin can see this.
 * ============================================================
 */

app.get(
  "/api/test-pet",
  requirePiUser,
  requireTestAdmin,
  async (req, res) => {

    res.json({

      available: true,

      testingOnly: true,

      product:
        TEST_PET_PRODUCT,

      amount:
        TEST_PET_AMOUNT,

      currency:
        "Test-Pi",

      walletReference:
        ADT_TEST_WALLET_ADDRESS
          ? ADT_TEST_WALLET_ADDRESS
          : null,

      message:
        "Authorized ADT Test-Pi tester."

    });

  }
);


/*
 * ============================================================
 * PI PAYMENT APPROVAL
 *
 * Only authenticated Pi users may attempt approval.
 * Test Pet approval is restricted to admin.
 * ============================================================
 */

app.post(
  "/api/payments/approve",
  requirePiUser,
  async (req, res) => {

    try {

      const {
        paymentId
      } = req.body;


      if (
        typeof paymentId !== "string" ||
        paymentId.length < 1
      ) {

        return res.status(400).json({

          error:
            "Invalid payment ID."

        });

      }


      /*
       * Ask Pi Server for the actual payment.
       */

      const payment =
        await piApiRequest(
          `/payments/${encodeURIComponent(
            paymentId
          )}`,
          "GET"
        );


      /*
       * Payment must belong to the
       * currently authenticated Pi user.
       */

      if (
        payment.Pioneer_uid &&
        payment.Pioneer_uid !==
          req.piUser.uid
      ) {

        return res.status(403).json({

          error:
            "Payment does not belong to the authenticated Pi user."

        });

      }


      /*
       * For our test pet, only the
       * configured test account may proceed.
       */

      const product =
        payment.metadata?.product;


      if (
        product === TEST_PET_PRODUCT
      ) {

        if (
          req.piUser.username !==
            ADT_TEST_PI_USERNAME
        ) {

          return res.status(403).json({

            error:
              "Test Pet is restricted to the authorized tester."

          });

        }


        if (
          Number(payment.amount) !==
            TEST_PET_AMOUNT
        ) {

          return res.status(400).json({

            error:
              "Invalid Test Pet amount."

          });

        }

      }


      /*
       * Approve with Pi servers.
       */

      const approved =
        await piApiRequest(

          `/payments/${encodeURIComponent(
            paymentId
          )}/approve`,

          "POST",

          {}

        );


      await query(
        `
        INSERT INTO payments
        (
          payment_id,
          pi_uid,
          pi_username,
          product,
          amount,
          status
        )

        VALUES
        ($1, $2, $3, $4, $5, 'approved')

        ON CONFLICT (payment_id)

        DO UPDATE SET

          pi_uid =
            EXCLUDED.pi_uid,

          pi_username =
            EXCLUDED.pi_username,

          product =
            EXCLUDED.product,

          amount =
            EXCLUDED.amount,

          status =
            'approved'
        `,
        [
          paymentId,
          req.piUser.uid,
          req.piUser.username,
          product || null,
          Number(payment.amount || 0)
        ]
      );


      res.json({

        ok: true,

        message:
          "Payment approved.",

        payment:
          approved

      });

    } catch (error) {

      console.error(
        "Payment approval error:",
        error
      );


      res.status(
        error.status || 500
      ).json({

        error:
          error.message ||
          "Payment approval failed."

      });

    }

  }
);


/*
 * ============================================================
 * PI PAYMENT COMPLETION
 * ============================================================
 */

app.post(
  "/api/payments/complete",
  requirePiUser,
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
        product
      } = req.body;


      if (
        typeof paymentId !== "string" ||
        typeof txid !== "string"
      ) {

        return res.status(400).json({

          error:
            "Invalid payment data."

        });

      }


      /*
       * Read the verified payment
       * directly from Pi.
       */

      const payment =
        await piApiRequest(
          `/payments/${encodeURIComponent(
            paymentId
          )}`,
          "GET"
        );


      /*
       * Verify payment ownership.
       */

      if (
        payment.Pioneer_uid &&
        payment.Pioneer_uid !==
          req.piUser.uid
      ) {

        return res.status(403).json({

          error:
            "Payment belongs to another Pi user."

        });

      }


      /*
       * Verify product.
       */

      const verifiedProduct =
        payment.metadata?.product ||
        product;


      if (
        verifiedProduct !==
          TEST_PET_PRODUCT
      ) {

        return res.status(400).json({

          error:
            "Unknown or unauthorized product."

        });

      }


      /*
       * Test Pet is ADMIN ONLY.
       */

      if (
        req.piUser.username !==
          ADT_TEST_PI_USERNAME
      ) {

        return res.status(403).json({

          error:
            "Test Pet purchase is restricted."

        });

      }


      /*
       * Verify exact test amount.
       */

      const verifiedAmount =
        Number(
          payment.amount || 0
        );


      if (
        verifiedAmount !==
          TEST_PET_AMOUNT
      ) {

        return res.status(400).json({

          error:
            "Invalid Test Pet payment amount."

        });

      }


      /*
       * Verify transaction returned
       * by Pi matches submitted txid.
       */

      const verifiedTxid =
        payment.transaction?.txid;


      if (
        verifiedTxid &&
        verifiedTxid !== txid
      ) {

        return res.status(400).json({

          error:
            "Transaction ID does not match Pi payment."

        });

      }


      /*
       * Complete payment with Pi.
       */

      const completed =
        await piApiRequest(

          `/payments/${encodeURIComponent(
            paymentId
          )}/complete`,

          "POST",

          {
            txid
          }

        );


      /*
       * Get our verified user.
       */

      const userResult =
        await client.query(
          `
          SELECT id

          FROM users

          WHERE pi_uid = $1

          LIMIT 1
          `,
          [req.piUser.uid]
        );


      if (
        userResult.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not registered."

        });

      }


      const userId =
        userResult.rows[0].id;


      await client.query(
        "BEGIN"
      );


      /*
       * Check for duplicate purchase
       * before delivering again.
       */

      const existingPurchase =
        await client.query(
          `
          SELECT id

          FROM purchases

          WHERE payment_id = $1

          LIMIT 1
          `,
          [paymentId]
        );


      if (
        existingPurchase.rows.length > 0
      ) {

        await client.query(
          "ROLLBACK"
        );


        return res.json({

          ok: true,

          alreadyRecorded: true,

          message:
            "Purchase was already recorded.",

          paymentId,

          product:
            TEST_PET_PRODUCT

        });

      }


      /*
       * Save completed payment.
       */

      await client.query(
        `
        INSERT INTO payments
        (
          payment_id,
          pi_uid,
          pi_username,
          product,
          amount,
          txid,
          status,
          completed_at
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'completed',
          NOW()
        )

        ON CONFLICT (payment_id)

        DO UPDATE SET

          pi_uid =
            EXCLUDED.pi_uid,

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
          req.piUser.uid,
          req.piUser.username,
          TEST_PET_PRODUCT,
          verifiedAmount,
          txid
        ]
      );


      /*
       * Deliver the test pet once.
       */

      await client.query(
        `
        INSERT INTO purchases
        (
          user_id,
          payment_id,
          product,
          amount,
          txid
        )

        VALUES
        ($1, $2, $3, $4, $5)

        ON CONFLICT (payment_id)
        DO NOTHING
        `,
        [
          userId,
          paymentId,
          TEST_PET_PRODUCT,
          verifiedAmount,
          txid
        ]
      );


      /*
       * Update our ADT Trust foundation.
       */

      await client.query(
        `
        INSERT INTO wallet_reputation
        (
          user_id,
          trust_level,
          trust_score,
          verification_status,
          successful_purchases
        )

        VALUES
        (
          $1,
          'Established',
          50,
          'verified_pi_payment',
          1
        )

        ON CONFLICT (user_id)

        DO UPDATE SET

          successful_purchases =
            wallet_reputation.successful_purchases + 1,

          trust_score =
            LEAST(
              100,
              wallet_reputation.trust_score + 5
            ),

          trust_level =
            CASE
              WHEN LEAST(
                100,
                wallet_reputation.trust_score + 5
              ) >= 80
                THEN 'Trusted'

              WHEN LEAST(
                100,
                wallet_reputation.trust_score + 5
              ) >= 60
                THEN 'Established'

              WHEN LEAST(
                100,
                wallet_reputation.trust_score + 5
              ) >= 40
                THEN 'Limited'

              ELSE 'Caution'
            END,

          verification_status =
            'verified_pi_payment',

          updated_at =
            NOW()
        `,
        [userId]
      );


      await client.query(
        "COMMIT"
      );


      res.json({

        ok: true,

        message:
          "Test-Pi payment completed and Test Pet recorded.",

        paymentId,

        txid,

        product:
          TEST_PET_PRODUCT,

        amount:
          verifiedAmount,

        piUsername:
          req.piUser.username,

        payment:
          completed

      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {}

      console.error(
        "Payment completion error:",
        error
      );


      res.status(
        error.status || 500
      ).json({

        error:
          error.message ||
          "Payment completion failed."

      });

    } finally {

      client.release();

    }

  }
);


/*
 * ============================================================
 * PURCHASE HISTORY
 * ============================================================
 */

app.get(
  "/api/purchases",
  requirePiUser,
  async (req, res) => {

    try {

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

          WHERE
            u.pi_uid = $1

          ORDER BY
            p.purchased_at DESC
          `,
          [req.piUser.uid]
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


      res.status(500).json({

        error:
          "Unable to read purchases."

      });

    }

  }
);


/*
 * ============================================================
 * ADT TRUST / WALLET REPUTATION
 *
 * This is our own ADT system.
 * It is NOT Pi KYC.
 * ============================================================
 */

app.get(
  "/api/trust",
  requirePiUser,
  async (req, res) => {

    try {

      const result =
        await query(
          `
          SELECT

            u.pi_username,
            u.wallet_address,

            wr.trust_level,
            wr.trust_score,
            wr.verification_status,
            wr.successful_purchases

          FROM users u

          LEFT JOIN wallet_reputation wr
            ON wr.user_id = u.id

          WHERE
            u.pi_uid = $1

          LIMIT 1
          `,
          [req.piUser.uid]
        );


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not found."

        });

      }


      const row =
        result.rows[0];


      res.json({

        piUsername:
          row.pi_username,

        walletAddress:
          row.wallet_address,

        trustLevel:
          row.trust_level ||
          "Limited",

        trustScore:
          Number(
            row.trust_score || 0
          ),

        verificationStatus:
          row.verification_status ||
          "unverified",

        successfulPurchases:
          Number(
            row.successful_purchases || 0
          )

      });

    } catch (error) {

      console.error(
        "Trust error:",
        error
      );


      res.status(500).json({

        error:
          "Unable to read ADT Trust information."

      });

    }

  }
);


/*
 * ============================================================
 * START SERVER
 * ============================================================
 */

async function startServer() {

  try {

    if (pool) {

      await initializeDatabase();

    } else {

      console.warn(
        "DATABASE_URL is not configured yet."
      );

    }


    if (!PI_API_KEY) {

      console.warn(
        "WARNING: PI_API_KEY is not configured. " +
        "Pi payment approval/completion will fail."
      );

    }


    if (!ADT_TEST_PI_USERNAME) {

      console.warn(
        "WARNING: ADT_TEST_PI_USERNAME is not configured."
      );

    }


    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `ADT backend v2 running on port ${PORT}`
        );

        console.log(
          `Mining rate: ${MINING_RATE} ADT/hour`
        );

        console.log(
          `Mining cycle: ${MINING_HOURS} hours`
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