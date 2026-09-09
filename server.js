const express = require("express");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const DATABASE_URL = process.env.DATABASE_URL;

// --------------------------------------------------
// POSTGRESQL
// --------------------------------------------------

if (!DATABASE_URL) {
  console.error("DATABASE_URL mangler i Railway Variables");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --------------------------------------------------
// INITIALISER DATABASE
// --------------------------------------------------

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS syn (
      item_id TEXT PRIMARY KEY,
      lejemalsnr TEXT,
      adresse TEXT,
      vaerelser TEXT,
      type_syn TEXT,
      dato DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sent_to_zapier BOOLEAN DEFAULT FALSE,
      sent_at TIMESTAMP NULL
    )
  `);

  console.log("Database klar");
}

// --------------------------------------------------
// MONDAY GRAPHQL
// --------------------------------------------------

async function mondayGraphQL(query, variables = {}) {
  if (!MONDAY_API_TOKEN) {
    throw new Error("MONDAY_API_TOKEN mangler i Railway Variables");
  }

  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: MONDAY_API_TOKEN
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Monday HTTP ${response.status}: ${JSON.stringify(data)}`
    );
  }

  if (data.errors) {
    throw new Error(
      `Monday GraphQL error: ${JSON.stringify(data.errors)}`
    );
  }

  return data.data;
}

// --------------------------------------------------
// STATUS
// --------------------------------------------------

app.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM syn"
    );

    res.json({
      success: true,
      service: "ProfSyn Monday → Railway",
      status: "online",
      collectedSyn: result.rows[0].count
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --------------------------------------------------
// HENT ALLE SYN
// --------------------------------------------------

app.get("/api/syn", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        item_id AS "itemId",
        lejemalsnr AS "lejemålsnr",
        adresse,
        vaerelser AS "værelser",
        type_syn AS "typeSyn",
        TO_CHAR(dato, 'YYYY-MM-DD') AS dato,
        sent_to_zapier AS "sentToZapier"
      FROM syn
      ORDER BY created_at ASC
    `);

    res.json({
      success: true,
      count: result.rows.length,
      syn: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --------------------------------------------------
// RYD ALLE SYN
// KUN TIL TEST
// --------------------------------------------------

app.delete("/api/syn", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM syn");

    res.json({
      success: true,
      deleted: result.rowCount
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --------------------------------------------------
// SEND ALLE IKKE-SENDTE SYN TIL ZAPIER
// --------------------------------------------------

app.get("/api/send-to-zapier", async (req, res) => {
  try {
    if (!ZAPIER_WEBHOOK_URL) {
      throw new Error(
        "ZAPIER_WEBHOOK_URL mangler i Railway Variables"
      );
    }

    const result = await pool.query(`
      SELECT
        item_id AS "itemId",
        lejemalsnr AS "lejemålsnr",
        adresse,
        vaerelser AS "værelser",
        type_syn AS "typeSyn",
        TO_CHAR(dato, 'YYYY-MM-DD') AS dato
      FROM syn
      WHERE sent_to_zapier = FALSE
      ORDER BY created_at ASC
    `);

    const syn = result.rows;

    if (syn.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Ingen ikke-sendte syn er opsamlet"
      });
    }

    const payload = {
      success: true,
      count: syn.length,
      syn
    };

    const response = await fetch(ZAPIER_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Zapier HTTP ${response.status}: ${responseText}`
      );
    }

    await pool.query(`
      UPDATE syn
      SET
        sent_to_zapier = TRUE,
        sent_at = CURRENT_TIMESTAMP
      WHERE sent_to_zapier = FALSE
    `);

    console.log(`Sendt til Zapier: ${syn.length} syn`);

    return res.json({
      success: true,
      sentToZapier: syn.length,
      zapierResponse: responseText
    });

  } catch (error) {
    console.error("Send til Zapier fejl:", error.message);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --------------------------------------------------
// MONDAY WEBHOOK
// --------------------------------------------------

app.post("/monday/webhook", async (req, res) => {

  // Monday challenge
  if (req.body?.challenge) {
    console.log("Monday webhook challenge received");

    return res.json({
      challenge: req.body.challenge
    });
  }

  try {
    const event = req.body?.event;

    if (!event) {
      return res.status(400).json({
        success: false,
        error: "Webhook indeholder ikke event"
      });
    }

    const itemId = String(event.pulseId);

    // Kun:
    // Send til E-conomics = Sendt
    if (
      event.columnTitle !== "Send til E-conomics" ||
      event.value?.label?.text !== "Sendt"
    ) {
      return res.status(200).json({
        success: true,
        ignored: true
      });
    }

    // ------------------------------------------------
    // HENT DATA FRA MONDAY
    // ------------------------------------------------

    const query = `
      query GetItem($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          column_values(ids: [
            "text71",
            "text4",
            "text",
            "text7",
            "date5"
          ]) {
            id
            text
            value
          }
        }
      }
    `;

    const data = await mondayGraphQL(query, {
      itemId: itemId
    });

    const item = data.items?.[0];

    if (!item) {
      throw new Error(
        `Kunne ikke finde item ${itemId} på Monday`
      );
    }

    // ------------------------------------------------
    // MAP MONDAY COLUMNS
    // ------------------------------------------------

    const columns = {};

    for (const column of item.column_values || []) {
      columns[column.id] = {
        text: column.text,
        value: column.value
      };
    }

    // ------------------------------------------------
    // SYN
    // ------------------------------------------------

    const syn = {
      itemId: String(item.id),
      lejemålsnr: columns.text71?.text || "",
      adresse: columns.text4?.text || "",
      værelser: columns.text?.text || "",
      typeSyn: columns.text7?.text || "",
      dato: columns.date5?.text || ""
    };

    // ------------------------------------------------
    // GEM I POSTGRES
    // ------------------------------------------------

    await pool.query(
      `
      INSERT INTO syn (
        item_id,
        lejemalsnr,
        adresse,
        vaerelser,
        type_syn,
        dato
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (item_id)
      DO UPDATE SET
        lejemalsnr = EXCLUDED.lejemalsnr,
        adresse = EXCLUDED.adresse,
        vaerelser = EXCLUDED.vaerelser,
        type_syn = EXCLUDED.type_syn,
        dato = EXCLUDED.dato
      `,
      [
        syn.itemId,
        syn.lejemålsnr,
        syn.adresse,
        syn.værelser,
        syn.typeSyn,
        syn.dato || null
      ]
    );

    const countResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM syn"
    );

    console.log(
      `Syn gemt | item: ${syn.itemId} | lejemål: ${syn.lejemålsnr} | type: ${syn.typeSyn} | samlet: ${countResult.rows[0].count}`
    );

    return res.status(200).json({
      success: true,
      collected: true,
      count: countResult.rows[0].count
    });

  } catch (error) {
    console.error("Webhook error:", error.message);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Database startup error:", error);
    process.exit(1);
  }
}

startServer();