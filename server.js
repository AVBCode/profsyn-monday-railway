const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// --------------------------------------------------
// Hjælpefunktion: kald Monday GraphQL API
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

    // Vi reagerer kun på:
    // Send til E-conomics = Sendt
    if (
      event.columnTitle !== "Send til E-conomics" ||
      event.value?.label?.text !== "Sendt"
    ) {
      console.log("Ignorerer event - ikke Sendt.");
      
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
          column_values {
            id
            text
            value
          }
        }
      }
    `;

    const data = await mondayGraphQL(query, {
      itemId: Number(itemId)
    });

    const item = data.items?.[0];

    if (!item) {
      throw new Error(`Kunne ikke finde item ${itemId} på Monday`);
    }

    console.log("Monday item:");
    console.log(JSON.stringify(item, null, 2));

    // --------------------------------------------------
    // Her finder vi de ønskede felter
    // --------------------------------------------------

    const columns = {};

    for (const column of item.column_values || []) {
      columns[column.id] = {
        text: column.text,
        value: column.value
      };
    }

    console.log("Columns:");
    console.log(JSON.stringify(columns, null, 2));

    // --------------------------------------------------
    // MIDLERLERTIDIGT OUTPUT
    // --------------------------------------------------
    // Vi identificerer først præcis hvilke column IDs
    // der svarer til:
    //
    // kunde
    // adresse
    // lejemålsnr.
    // syn
    // værelser
    // dato
    //
    // så vi ikke gætter forkert.
    // --------------------------------------------------

    return res.status(200).json({
      success: true,
      received: true,
      boardId,
      itemId,
      itemName: item.name,
      columns
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