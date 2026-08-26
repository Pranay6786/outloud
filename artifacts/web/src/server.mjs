import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(publicDirectory));

app.post("/submit", (request, response) => {
  const message =
    typeof request.body?.message === "string"
      ? request.body.message.trim()
      : "";

  if (!message) {
    return response.status(400).json({ error: "A message is required." });
  }

  return response.json({
    ok: true,
    message: `Received: ${message}`,
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Express server listening on port ${port}`);
});