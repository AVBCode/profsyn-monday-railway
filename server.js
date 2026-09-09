const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// --------------------------------------------------
// Monday GraphQL helper
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
// Test endpoint
// --------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "ProfSyn Monday → Railway",
    status: "online"
  });
});

// --------------------------------------------------
// Monday webhook
// --------------------------------------------------
app.post("/monday/webhook", async (req, res) => {
  console.log("Received from Monday:");
  console.log(JSON.stringify(req.body, null, 2));

  // Monday verification challenge
  if (req.body?.challenge) {
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

    console.log("Board ID:", boardId);
    console.log("Item ID:", itemId);

    // --------------------------------------------------
    // Kun når:
    // Send til E-conomics = Sendt
    // --------------------------------------------------
    if (
      event.columnTitle !== "Send til E-conomics" ||
      event.value?.label?.text !== "Sendt"
    ) {
      console.log("Ignorerer event - status er ikke Sendt.");

      return res.status(200).json({
        success: true,
        ignored: true
      });
    }

    // --------------------------------------------------
    // Hent item fra Monday
    // --------------------------------------------------
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
      throw new Error(`Kunne ikke finde item ${itemId} på Monday`);
    }

    // --------------------------------------------------
    // Map Monday columns
    // --------------------------------------------------
    const columns = {};

    for (const column of item.column_values || []) {
      columns[column.id] = {
        text: column.text,
        value: column.value
      };
    }

    // --------------------------------------------------
    // Opret syn-objekt
    // --------------------------------------------------
    const syn = {
      itemId: String(item.id),
      lejemålsnr: columns.text71?.text || "",
      adresse: columns.text4?.text || "",
      værelser: columns.text?.text || "",
      typeSyn: columns.text7?.text || "",
      dato: columns.date5?.text || ""
    };

    console.log("====================================");
    console.log("NYT SYN MODTAGET");
    console.log(JSON.stringify(syn, null, 2));
    console.log("====================================");

    return res.status(200).json({
      success: true,
      received: true,
      syn
    });

  } catch (error) {
    console.error("ERROR:");
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --------------------------------------------------
// Start server
// --------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});