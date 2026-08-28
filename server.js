"use strict";

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL || "";
const PI_API_KEY = process.env.PI_API_KEY || "";

/*
 * ============================================================
 * ADT CONFIGURATION
 * ============================================================
 */

const APP_NAME = "Alberto Digital Token";

const MINING_RATE = 0.25;          // ADT / hour
const MINING_HOURS = 24;
const DAILY_REWARD = MINING_RATE * MINING_HOURS;

const PI_NETWORK = "sandbox";

/*
 * Developer test account.
 *
 * IMPORTANT:
 * This is only for controlling developer-only marketplace
 * test products. Normal miners cannot access these products.
 *
 * Set this in Render:
 *
 * DEV_PI_USERNAME=utoy0913
 */

const DEV_PI_USERNAME =
  String(process.env.DEV_PI_USERNAME || "")
    .trim()
    .toLowerCase();


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
 * BASIC HELPERS
 * ============================================================
 */

function normalizeUsername(username) {

  if (
    typeof username !== "string"
  ) {
    return "";
  }

  return username
    .trim()
    .toLowerCase();
}


function validUsername(username) {

  return /^[a-z0-9._-]{1,64}$/
    .test(username);
}


function isDeveloper(username) {

  return (
    DEV_PI_USERNAME &&
    normalizeUsername(username) ===
      DEV_PI_USERNAME
  );
}


function validWalletAddress(address) {

  if (
    typeof address !== "string"
  ) {
    return false;
  }

  /*
   * Pi wallet addresses are Stellar-style
   * public addresses beginning with G.
   *
   * We intentionally do NOT accept private
   * keys or secret phrases.
   */

  return /^G[A-Z2-7]{55}$/.test(
    address.trim()
  );
}


function reputationLevel(score) {

  if (score >= 900) {
    return "LEGEND";
  }

  if (score >= 750) {
    return "TRUSTED";
  }

  if (score >= 500) {
    return "ESTABLISHED";
  }

  if (score >= 250) {
    return "RISING";
  }

  return "NEW";
}


/*
 * ============================================================
 * PI API HELPER
 * ============================================================
 */

async function piApiRequest(
  path,
  method = "GET",
  body = null
) {

  if (!PI_API_KEY) {

    throw new Error(
      "PI_API_KEY is not configured."
    );

  }

  const options = {

    method,

    headers: {

      Authorization:
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
 * DATABASE INITIALIZATION
 * ============================================================
 */

async function initializeDatabase() {

  await query(`

    CREATE TABLE IF NOT EXISTS users (

      id BIGSERIAL PRIMARY KEY,

      pi_username TEXT UNIQUE NOT NULL,

      wallet_address TEXT,

      wallet_verified BOOLEAN
        NOT NULL DEFAULT FALSE,

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

      wallet_verified_count INTEGER
        NOT NULL DEFAULT 0,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()

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

      amount NUMERIC(20,8)
        NOT NULL,

      txid TEXT UNIQUE NOT NULL,

      purchased_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()

    );


    CREATE TABLE IF NOT EXISTS marketplace_products (

      id BIGSERIAL PRIMARY KEY,

      product_code TEXT UNIQUE NOT NULL,

      name TEXT NOT NULL,

      description TEXT,

      price_pi NUMERIC(20,8)
        NOT NULL,

      test_only BOOLEAN
        NOT NULL DEFAULT TRUE,

      active BOOLEAN
        NOT NULL DEFAULT TRUE,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()

    );

  `);


  /*
   * Developer-only Test Pet.
   *
   * This product exists in the database but is
   * intentionally protected by the API.
   */

  await query(`

    INSERT INTO marketplace_products (

      product_code,
      name,
      description,
      price_pi,
      test_only,
      active

    )

    VALUES (

      'adt-test-pet',

      'ADT Test Digital Pet',

      'Developer checklist test item.',

      0.1,

      TRUE,

      TRUE

    )

    ON CONFLICT (product_code)
    DO NOTHING

  `);

}


/*
 * ============================================================
 * ROOT
 * ============================================================
 */

app.get("/", (req, res) => {

  res.json({

    app:
      APP_NAME,

    status:
      "online",

    version:
      "2.0.0",

    network:
      PI_NETWORK,

    miningRate:
      MINING_RATE,

    miningCycleHours:
      MINING_HOURS

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

        network:
          PI_NETWORK,

        time:
          new Date().toISOString()

      });

    } catch (error) {

      console.error(
        "Health error:",
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
 * REGISTER / SYNC USER
 * ============================================================
 */

app.post(
  "/api/users",
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.body.piUsername
        );


      if (!validUsername(username)) {

        return res.status(400).json({

          error:
            "Invalid Pi username."

        });

      }


      const result =
        await query(`

          INSERT INTO users (
            pi_username
          )

          VALUES ($1)

          ON CONFLICT (pi_username)

          DO UPDATE SET
            updated_at = NOW()

          RETURNING
            id,
            pi_username,
            wallet_address,
            wallet_verified,
            created_at

        `, [username]);


      const user =
        result.rows[0];


      await query(`

        INSERT INTO balances (
          user_id
        )

        VALUES ($1)

        ON CONFLICT (user_id)
        DO NOTHING

      `, [user.id]);


      await query(`

        INSERT INTO reputation (
          user_id
        )

        VALUES ($1)

        ON CONFLICT (user_id)
        DO NOTHING

      `, [user.id]);


      res.status(201).json({

        user,

        developer:
          isDeveloper(username),

        network:
          PI_NETWORK

      });

    } catch (error) {

      console.error(
        "User registration error:",
        error
      );

      res.status(500).json({

        error:
          "Unable to register user."

      });

    }

  }
);


/*
 * ============================================================
 * WALLET VERIFICATION
 * ============================================================
 */

app.post(
  "/api/wallet/verify",
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.body.piUsername
        );

      const walletAddress =
        String(
          req.body.walletAddress || ""
        ).trim();


      if (!validUsername(username)) {

        return res.status(400).json({

          error:
            "Invalid Pi username."

        });

      }


      if (
        !validWalletAddress(
          walletAddress
        )
      ) {

        return res.status(400).json({

          error:
            "Invalid public wallet address."

        });

      }


      const user =
        await query(`

          SELECT id

          FROM users

          WHERE pi_username = $1

        `, [username]);


      if (
        user.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not found."

        });

      }


      const userId =
        user.rows[0].id;


      await query(`

        UPDATE users

        SET

          wallet_address = $1,

          wallet_verified = TRUE,

          updated_at = NOW()

        WHERE id = $2

      `, [
        walletAddress,
        userId
      ]);


      await query(`

        UPDATE reputation

        SET

          wallet_verified_count =
            wallet_verified_count + 1,

          score =
            LEAST(
              1000,
              score + 50
            ),

          updated_at = NOW()

        WHERE user_id = $1

      `, [userId]);


      res.json({

        ok: true,

        verified: true,

        message:
          "Wallet address registered successfully.",

        network:
          PI_NETWORK

      });

    } catch (error) {

      console.error(
        "Wallet verification error:",
        error
      );

      res.status(500).json({

        error:
          "Unable to verify wallet."

      });

    }

  }
);


/*
 * ============================================================
 * WALLET STATUS
 * ============================================================
 */

app.get(
  "/api/wallet/status",
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.query.piUsername
        );


      const result =
        await query(`

          SELECT

            pi_username,

            wallet_address,

            wallet_verified

          FROM users

          WHERE pi_username = $1

        `, [username]);


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not found."

        });

      }


      const user =
        result.rows[0];


      res.json({

        username:
          user.pi_username,

        walletAddress:
          user.wallet_address,

        verified:
          user.wallet_verified,

        network:
          PI_NETWORK

      });

    } catch (error) {

      console.error(
        "Wallet status error:",
        error
      );

      res.status(500).json({

        error:
          "Unable to read wallet status."

      });

    }

  }
);


/*
 * ============================================================
 * REPUTATION
 * ============================================================
 */

app.get(
  "/api/reputation",
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.query.piUsername
        );


      const result =
        await query(`

          SELECT

            u.pi_username,

            u.wallet_verified,

            r.score,

            r.mining_cycles,

            r.completed_purchases,

            r.wallet_verified_count

          FROM users u

          JOIN reputation r
            ON r.user_id = u.id

          WHERE
            u.pi_username = $1

        `, [username]);


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not found."

        });

      }


      const data =
        result.rows[0];


      res.json({

        username:
          data.pi_username,

        score:
          data.score,

        level:
          reputationLevel(
            Number(data.score)
          ),

        walletVerified:
          data.wallet_verified,

        miningCycles:
          data.mining_cycles,

        purchases:
          data.completed_purchases,

        walletVerifications:
          data.wallet_verified_count

      });

    } catch (error) {

      console.error(
        "Reputation error:",
        error
      );

      res.status(500).json({

        error:
          "Unable to read reputation."

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
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.body.piUsername
        );


      if (!validUsername(username)) {

        return res.status(400).json({

          error:
            "Invalid Pi username."

        });

      }


      const user =
        await query(`

          SELECT id

          FROM users

          WHERE pi_username = $1

        `, [username]);


      if (
        user.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not found. Sign in again."

        });

      }


      const userId =
        user.rows[0].id;


      const active =
        await query(`

          SELECT

            id,
            started_at,
            rate_adt_per_hour

          FROM mining_sessions

          WHERE user_id = $1

          AND status = 'active'

          LIMIT 1

        `, [userId]);


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
        await query(`

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

        `, [
          userId,
          MINING_RATE
        ]);


      res.status(201).json({

        message:
          "ADT mining started.",

        network:
          PI_NETWORK,

        session:
          session.rows[0],

        miningRate:
          MINING_RATE,

        miningHours:
          MINING_HOURS,

        maximumEarnedADT:
          DAILY_REWARD

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
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.query.piUsername
        );


      const result =
        await query(`

          SELECT

            ms.id,

            ms.started_at,

            ms.rate_adt_per_hour

          FROM mining_sessions ms

          JOIN users u
            ON u.id = ms.user_id

          WHERE

            u.pi_username = $1

          AND

            ms.status = 'active'

          LIMIT 1

        `, [username]);


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
          DAILY_REWARD,

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
 * CLAIM MINING
 * ============================================================
 */

app.post(
  "/api/mining/stop",
  async (req, res) => {

    if (!pool) {

      return res.status(500).json({

        error:
          "DATABASE_URL is not configured."

      });

    }


    const client =
      await pool.connect();


    try {

      const username =
        normalizeUsername(
          req.body.piUsername
        );


      await client.query(
        "BEGIN"
      );


      const result =
        await client.query(`

          SELECT

            ms.id,

            ms.user_id,

            ms.started_at,

            ms.rate_adt_per_hour

          FROM mining_sessions ms

          JOIN users u
            ON u.id = ms.user_id

          WHERE

            u.pi_username = $1

          AND

            ms.status = 'active'

          FOR UPDATE

        `, [username]);


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
        DAILY_REWARD;


      await client.query(`

        UPDATE mining_sessions

        SET

          stopped_at = NOW(),

          status = 'completed',

          earned_adt = $1

        WHERE id = $2

      `, [
        earned,
        session.id
      ]);


      await client.query(`

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

      `, [
        session.user_id,
        earned
      ]);


      /*
       * Increase our own ADT reputation.
       */

      await client.query(`

        UPDATE reputation

        SET

          mining_cycles =
            mining_cycles + 1,

          score =
            LEAST(
              1000,
              score + 10
            ),

          updated_at = NOW()

        WHERE user_id = $1

      `, [
        session.user_id
      ]);


      const balance =
        await client.query(`

          SELECT available_adt

          FROM balances

          WHERE user_id = $1

        `, [
          session.user_id
        ]);


      await client.query(
        "COMMIT"
      );


      res.json({

        ok: true,

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
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.query.piUsername
        );


      const result =
        await query(`

          SELECT

            u.pi_username,

            b.available_adt

          FROM users u

          JOIN balances b
            ON b.user_id = u.id

          WHERE
            u.pi_username = $1

        `, [username]);


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
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.query.piUsername
        );


      const result =
        await query(`

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
            u.pi_username = $1

          ORDER BY
            ms.started_at DESC

          LIMIT 50

        `, [username]);


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
 * MARKETPLACE
 * ============================================================
 *
 * Normal miners will NOT receive developer-only products.
 * ============================================================
 */

app.get(
  "/api/marketplace",
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.query.piUsername
        );


      let result;


      if (isDeveloper(username)) {

        /*
         * Developer can see test products.
         */

        result =
          await query(`

            SELECT

              product_code,
              name,
              description,
              price_pi,
              test_only,
              active

            FROM marketplace_products

            WHERE active = TRUE

            ORDER BY id ASC

          `);

      } else {

        /*
         * Normal miners cannot see
         * developer test products.
         */

        result =
          await query(`

            SELECT

              product_code,
              name,
              description,
              price_pi,
              test_only,
              active

            FROM marketplace_products

            WHERE active = TRUE

            AND test_only = FALSE

            ORDER BY id ASC

          `);

      }


      res.json({

        network:
          PI_NETWORK,

        developer:
          isDeveloper(username),

        products:
          result.rows

      });

    } catch (error) {

      console.error(
        "Marketplace error:",
        error
      );

      res.status(500).json({

        error:
          "Unable to load marketplace."

      });

    }

  }
);


/*
 * ============================================================
 * PI PAYMENT APPROVAL
 * ============================================================
 */

app.post(
  "/api/payments/approve",
  async (req, res) => {

    try {

      const paymentId =
        String(
          req.body.paymentId || ""
        ).trim();


      if (!paymentId) {

        return res.status(400).json({

          error:
            "Invalid payment ID."

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


      await query(`

        INSERT INTO payments (

          payment_id,

          status

        )

        VALUES (

          $1,

          'approved'

        )

        ON CONFLICT (payment_id)

        DO UPDATE SET

          status = 'approved'

      `, [
        paymentId
      ]);


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
  async (req, res) => {

    if (!pool) {

      return res.status(500).json({

        error:
          "DATABASE_URL is not configured."

      });

    }


    const client =
      await pool.connect();


    try {

      const paymentId =
        String(
          req.body.paymentId || ""
        ).trim();

      const txid =
        String(
          req.body.txid || ""
        ).trim();

      const username =
        normalizeUsername(
          req.body.piUsername
        );

      const product =
        String(
          req.body.product || ""
        ).trim();


      if (
        !paymentId ||
        !txid ||
        !validUsername(username) ||
        !product
      ) {

        return res.status(400).json({

          error:
            "Missing or invalid payment data."

        });

      }


      /*
       * Test product protection.
       *
       * Only the developer account may
       * complete the developer-only test pet.
       */

      if (
        product === "adt-test-pet" &&
        !isDeveloper(username)
      ) {

        return res.status(403).json({

          error:
            "This test marketplace product is restricted."

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

          {
            txid
          }

        );


      const userResult =
        await client.query(`

          SELECT id

          FROM users

          WHERE pi_username = $1

        `, [
          username
        ]);


      if (
        userResult.rows.length === 0
      ) {

        return res.status(404).json({

          error:
            "User not found."

        });

      }


      const userId =
        userResult.rows[0].id;


      /*
       * Use amount returned by Pi.
       */

      const amount =
        Number(
          payment.amount || 0
        );


      await client.query(
        "BEGIN"
      );


      /*
       * Save payment.
       */

      await client.query(`

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

      `, [

        paymentId,

        username,

        product,

        amount,

        txid

      ]);


      /*
       * Deliver product exactly once.
       */

      const purchase =
        await client.query(`

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

        `, [

          userId,

          paymentId,

          product,

          amount,

          txid

      ]);


      /*
       * Increase reputation only for
       * a newly recorded purchase.
       */

      if (
        purchase.rows.length > 0
      ) {

        await client.query(`

          UPDATE reputation

          SET

            completed_purchases =
              completed_purchases + 1,

            score =
              LEAST(
                1000,
                score + 25
              ),

            updated_at = NOW()

          WHERE user_id = $1

        `, [
          userId
        ]);

      }


      await client.query(
        "COMMIT"
      );


      res.json({

        ok: true,

        network:
          PI_NETWORK,

        message:
          "Payment completed and purchase recorded.",

        paymentId,

        txid,

        product,

        amount

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
  async (req, res) => {

    try {

      const username =
        normalizeUsername(
          req.query.piUsername
        );


      const result =
        await query(`

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
            u.pi_username = $1

          ORDER BY
            p.purchased_at DESC

        `, [
          username
        ]);


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
 * START SERVER
 * ============================================================
 */

async function startServer() {

  try {

    if (pool) {

      await initializeDatabase();

      console.log(
        "ADT database initialized."
      );

    } else {

      console.warn(
        "DATABASE_URL is not configured."
      );

    }


    if (!PI_API_KEY) {

      console.warn(
        "WARNING: PI_API_KEY is not configured."
      );

    }


    if (!DEV_PI_USERNAME) {

      console.warn(
        "WARNING: DEV_PI_USERNAME is not configured."
      );

    }


    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `${APP_NAME} backend running on port ${PORT}`
        );

        console.log(
          `Network: ${PI_NETWORK}`
        );

      }
    );

  } catch (error) {

    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);

  }

}


startServer();