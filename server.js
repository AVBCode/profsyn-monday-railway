const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// --------------------------------------------------
// OPSAMLING AF SYN
// --------------------------------------------------
// Key = itemId
// Value = syn-data
const collectedSyn = new Map();

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
// TEST / STATUS
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "ProfSyn Monday → Railway",
    status: "online",
    collectedSyn: collectedSyn.size
  });
});

// --------------------------------------------------
// HENT ALLE OPSAMLEDE SYN
// --------------------------------------------------

app.get("/api/syn", (req, res) => {
  const syn = Array.from(collectedSyn.values());

  res.json({
    success: true,
    count: syn.length,
    syn
  });
});

// --------------------------------------------------
// RYD ALLE OPSAMLEDE SYN
// KUN TIL TEST
// --------------------------------------------------

app.delete("/api/syn", (req, res) => {
  const count = collectedSyn.size;

  collectedSyn.clear();

  res.json({
    success: true,
    deleted: count
  });
});

// --------------------------------------------------
// MONDAY WEBHOOK
// --------------------------------------------------

app.post("/monday/webhook", async (req, res) => {

  // ------------------------------------------------
  // MONDAY CHALLENGE
  // ------------------------------------------------

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

    const boardId = event.boardId;
    const itemId = event.pulseId;

    // ------------------------------------------------
    // KUN:
    // Send til E-conomics = Sendt
    // ------------------------------------------------

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
    // UNDGÅ DUBLETTER
    // ------------------------------------------------

    const itemKey = String(itemId);

    if (collectedSyn.has(itemKey)) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        itemId: itemKey
      });
    }

    // ------------------------------------------------
    // HENT RELEVANTE DATA FRA MONDAY
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
    // OPRET SYN
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
    // GEM SYN
    // ------------------------------------------------

    collectedSyn.set(syn.itemId, syn);

    // ------------------------------------------------
    // KORT LOGGING
    // ------------------------------------------------

    console.log(
      `Syn gemt | item: ${syn.itemId} | lejemål: ${syn.lejemålsnr} | type: ${syn.typeSyn} | samlet: ${collectedSyn.size}`
    );

    // ------------------------------------------------
    // SVAR TIL MONDAY
    // ------------------------------------------------

    return res.status(200).json({
      success: true,
      collected: true,
      count: collectedSyn.size,
      syn
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});