const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Test
app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "ProfSyn Monday → Railway",
    status: "online"
  });
});

// Monday webhook
app.post("/monday/webhook", (req, res) => {
  console.log("Received from Monday:");
  console.log(JSON.stringify(req.body, null, 2));

  // Monday verification
  if (req.body && req.body.challenge) {
    return res.json({
      challenge: req.body.challenge
    });
  }

  return res.status(200).json({
    success: true,
    received: true,
    data: req.body
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});