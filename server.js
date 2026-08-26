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

/*
 * ============================================================
 * ADT MINING SETTINGS
 * ============================================================
 */

const MINING_RATE = 0.25; // ADT per hour
const MINING_HOURS = 24;
const DAILY_LIMIT = MINING_RATE * MINING_HOURS; // 6 ADT

/*
 * ============================================================
 * PI PLATFORM API
 *
 * Server-side payment approval/completion.
 * PI_API_KEY NEVER goes to the frontend.
 * ============================================================
 */

const PI_PLATFORM_API = "https://api.minepi.com/v2";


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
      "Authorization":
        `Key ${PI_API_KEY}`,
      "Content-Type":
        "application/json"
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

  let data = null;

  try {

    data = text
      ? JSON.parse(text)
      : {};

  } catch (error) {

    data = {
      raw: text
    };

  }


  if (!response.ok) {

    const message =
      data.error_message ||
      data.error ||
      `Pi API request failed (${response.status}).`;

    const err =
      new Error(message);

    err.status =
      response.status;

    err.data =
      data;

    throw err;

  }


  return data;

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

      pi_username TEXT UNIQUE NOT NULL,

      created_at TIMESTAMPTZ
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
  `);

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
      "1.1.0"

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
 * REGISTER PI USER
 * ============================================================
 */

app.post(
  "/api/users",
  async (req, res) => {

    try {

      const {
        piUsername
      } = req.body;


      if (

        typeof piUsername !== "string" ||

        !/^[A-Za-z0-9._-]{1,64}$/
          .test(piUsername)

      ) {

        return res.status(400).json({

          error:
            "Invalid Pi username."

        });

      }


      const result =
        await query(
          `
          INSERT INTO users
          (pi_username)

          VALUES ($1)

          ON CONFLICT (pi_username)

          DO UPDATE SET
            pi_username =
              EXCLUDED.pi_username

          RETURNING
            id,
            pi_username,
            created_at
          `,
          [piUsername]
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


      res.status(201).json({

        user

      });

    } catch (error) {

      console.error(
        "User registration error:",
        error
      );


      res.status(500).json({

        error:
          "Unable to create user."

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

      const {
        piUsername
      } = req.body;


      if (
        typeof piUsername !== "string"
      ) {

        return res.status(400).json({

          error:
            "Invalid Pi username."

        });

      }


      const user =
        await query(
          `
          SELECT id

          FROM users

          WHERE pi_username = $1
          `,
          [piUsername]
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

          WHERE user_id = $1

          AND status = 'active'

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

      const {
        piUsername
      } = req.query;


      if (
        typeof piUsername !== "string"
      ) {

        return res.status(400).json({

          error:
            "Invalid Pi username."

        });

      }


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
            u.pi_username = $1

          AND
            ms.status = 'active'

          LIMIT 1
          `,
          [piUsername]
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
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const {
        piUsername
      } = req.body;


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
            u.pi_username = $1

          AND
            ms.status = 'active'

          FOR UPDATE
          `,
          [piUsername]
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


      /*
       * Fixed maximum reward for
       * one completed 24-hour cycle.
       */

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
          [
            session.user_id
          ]
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

      await client.query(
        "ROLLBACK"
      );


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

      const {
        piUsername
      } = req.query;


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
            u.pi_username = $1
          `,
          [piUsername]
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
  async (req, res) => {

    try {

      const {
        piUsername
      } = req.query;


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
            u.pi_username = $1

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


      res.status(500).json({

        error:
          "Unable to read mining history."

      });

    }

  }
);


/*
 * ============================================================
 * PI PAYMENT APPROVAL
 *
 * User -> App payment
 * ============================================================
 */

app.post(
  "/api/payments/approve",
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
       * Tell Pi Servers that our app
       * approves this U2A payment.
       */

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
          status

        )

        VALUES (

          $1,
          'approved'

        )

        ON CONFLICT (payment_id)

        DO UPDATE SET

          status = 'approved'
        `,
        [paymentId]
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

    const client =
      await pool.connect();

    try {

      const {

        paymentId,

        txid,

        piUsername,

        product

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


      /*
       * Complete payment with Pi Servers first.
       *
       * Do not deliver the product if this fails.
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


      /*
       * Get user.
       */

      const userResult =
        await client.query(
          `
          SELECT id

          FROM users

          WHERE pi_username = $1
          `,
          [piUsername]
        );


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
       * Read amount from Pi's verified
       * payment response.
       */

      const amount =
        Number(
          payment.amount || 0
        );


      await client.query(
        "BEGIN"
      );


      /*
       * Save completed payment.
       */

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


      /*
       * Deliver the product once.
       */

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
        `,
        [

          userId,

          paymentId,

          product,

          amount,

          txid

        ]
      );


      await client.query(
        "COMMIT"
      );


      res.json({

        ok: true,

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

      } catch (rollbackError) {

        console.error(
          "Rollback error:",
          rollbackError
        );

      }


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
 * PAYMENT / PURCHASE HISTORY
 * ============================================================
 */

app.get(
  "/api/purchases",
  async (req, res) => {

    try {

      const {
        piUsername
      } = req.query;


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
            u.pi_username = $1

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
        "Database initialized."
      );

    } else {

      console.log(
        "DATABASE_URL is not configured yet."
      );

    }


    if (!PI_API_KEY) {

      console.warn(
        "WARNING: PI_API_KEY is not configured. " +
        "Mining can work, but Pi payment approval " +
        "and completion will fail."
      );

    }


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