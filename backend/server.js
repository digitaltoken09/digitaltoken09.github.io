const http = require("http");

const PORT = process.env.PORT || 3000;

const MAX_SUPPLY = 30_000_000;
const MINING_ALLOCATION = 15_000_000;
const MINING_CYCLE_MS = 24 * 60 * 60 * 1000;
const REWARD_PER_CYCLE = 1.20;

const users = new Map();
const miningSessions = new Map();

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  });

  res.end(JSON.stringify(data));
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.substring(7);
}

/*
 * IMPORTANT:
 * This endpoint must be connected to Pi's official API
 * before production.
 *
 * Never trust a username or UID sent directly by the browser.
 */
async function verifyPiUser(req) {
  const accessToken = getBearerToken(req);

  if (!accessToken) {
    throw new Error("Pi authentication required.");
  }

  /*
   * TODO:
   * Verify accessToken against the current official
   * Pi API endpoint before trusting the user identity.
   *
   * We intentionally do NOT accept:
   * - client-provided UID
   * - client-provided username
   * - demo accounts
   */

  throw new Error(
    "Pi API verification is not configured yet."
  );
}

function getUser(uid, username) {
  if (!users.has(uid)) {
    users.set(uid, {
      uid,
      username,
      available: 0,
      pending: 0,
      minedLifetime: 0
    });
  }

  return users.get(uid);
}

function totalMined() {
  let total = 0;

  for (const user of users.values()) {
    total += user.minedLifetime;
  }

  return total;
}

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization"
    });

    return res.end();
  }

  try {

    if (
      req.url === "/api/health" &&
      req.method === "GET"
    ) {
      return sendJSON(res, 200, {
        ok: true,
        app: "ADT Mining",
        network: "Pi Testnet",
        maxSupply: MAX_SUPPLY,
        miningAllocation: MINING_ALLOCATION
      });
    }

    /*
     * Every user endpoint requires real Pi authentication.
     */

    const piUser = await verifyPiUser(req);

    const user = getUser(
      piUser.uid,
      piUser.username
    );


    /*
     * Current user
     */

    if (
      req.url === "/api/me" &&
      req.method === "GET"
    ) {
      return sendJSON(res, 200, {
        user
      });
    }


    /*
     * ADT wallet
     */

    if (
      req.url === "/api/wallet" &&
      req.method === "GET"
    ) {
      return sendJSON(res, 200, {
        available: user.available,
        pending: user.pending,
        minedLifetime: user.minedLifetime,
        maxSupply: MAX_SUPPLY,
        miningAllocation: MINING_ALLOCATION
      });
    }


    /*
     * START 24-HOUR MINING
     */

    if (
      req.url === "/api/mining/start" &&
      req.method === "POST"
    ) {

      for (const session of miningSessions.values()) {

        if (
          session.uid === user.uid &&
          !session.claimed &&
          Date.now() < session.endsAt
        ) {
          return sendJSON(res, 409, {
            error: "Mining is already active.",
            session
          });
        }
      }


      /*
       * Supply protection
       */

      if (
        totalMined() + REWARD_PER_CYCLE >
        MINING_ALLOCATION
      ) {
        return sendJSON(res, 409, {
          error: "ADT mining allocation exhausted."
        });
      }


      const sessionId =
        require("crypto").randomUUID();

      const session = {
        id: sessionId,
        uid: user.uid,
        startedAt: Date.now(),
        endsAt:
          Date.now() +
          MINING_CYCLE_MS,
        reward: REWARD_PER_CYCLE,
        claimed: false
      };

      miningSessions.set(
        sessionId,
        session
      );


      return sendJSON(res, 201, {
        session
      });
    }


    /*
     * CLAIM ADT
     */

    if (
      req.url.startsWith(
        "/api/mining/claim/"
      ) &&
      req.method === "POST"
    ) {

      const sessionId =
        req.url.split("/").pop();

      const session =
        miningSessions.get(sessionId);


      if (
        !session ||
        session.uid !== user.uid
      ) {
        return sendJSON(res, 404, {
          error: "Mining session not found."
        });
      }


      if (session.claimed) {
        return sendJSON(res, 409, {
          error: "Reward already claimed."
        });
      }


      /*
       * Server—not browser—checks 24 hours.
       */

      if (
        Date.now() <
        session.endsAt
      ) {
        return sendJSON(res, 409, {
          error:
            "The 24-hour mining cycle is not complete."
        });
      }


      session.claimed = true;

      user.pending +=
        session.reward;


      return sendJSON(res, 200, {
        reward: session.reward,
        user
      });
    }


    return sendJSON(res, 404, {
      error: "Endpoint not found."
    });

  } catch (error) {

    return sendJSON(res, 401, {
      error: error.message
    });

  }

});


server.listen(
  PORT,
  () => {
    console.log(
      `ADT Mining backend running on port ${PORT}`
    );
  }
);