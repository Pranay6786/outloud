// OutLoud — audio spike server.
// Purpose: find out whether sending recorded audio to Gemini gives a better
// transcript than the browser recogniser, how long it takes on mobile data,
// and whether the free tier accepts it. Throwaway apart from the patterns.

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const BASE = "https://generativelanguage.googleapis.com/v1beta";

// Audio arrives base64-encoded, so the body is roughly a third larger than the file.
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Model names change. Rather than hardcode one that may not exist on this key,
// ask Google what the key can actually use and cache the answer.
let cachedModel = null;

async function pickModel() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (cachedModel) return cachedModel;

  const res = await fetch(`${BASE}/models`, {
    headers: { "x-goog-api-key": API_KEY },
  });
  if (!res.ok) {
    throw new Error(
      `Could not list models (HTTP ${res.status}). ${await res.text()}`,
    );
  }
  const data = await res.json();
  const usable = (data.models || []).filter(
    (m) =>
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.indexOf("generateContent") !== -1,
  );

  // Listed does not mean usable: Google keeps retired models in the list and
  // returns 404 for accounts that never used them. Prefer the newest version.
  function version(name) {
    const m = /gemini-(\d+)(?:\.(\d+))?/i.exec(name);
    if (!m) return -1;
    return parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0);
  }

  const flash = usable
    .filter((m) => /flash/i.test(m.name))
    .filter(
      (m) => !/thinking|image|tts|live|audio-native|embedding/i.test(m.name),
    )
    .sort((a, b) => {
      const v = version(b.name) - version(a.name);
      if (v !== 0) return v;
      // At equal version, plain beats lite and preview.
      const penalty = (n) =>
        (/lite/i.test(n) ? 2 : 0) + (/preview|exp/i.test(n) ? 1 : 0);
      return penalty(a.name) - penalty(b.name);
    });

  const chosen = flash[0] || usable[0];
  if (!chosen)
    throw new Error("No model on this key supports generateContent.");
  cachedModel = chosen.name.replace(/^models\//, "");
  return cachedModel;
}

app.get("/api/health", async (req, res) => {
  if (!API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "GEMINI_API_KEY is not set." });
  }
  try {
    const model = await pickModel();
    res.json({ ok: true, model });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

const SYSTEM = [
  "You are running a short practice job interview for a nervous Indian job seeker",
  "who reads and writes English well but is anxious about speaking it.",
  "",
  "You are given the question that was just asked and an audio recording of the answer.",
  "",
  "Do two things:",
  "1. Transcribe the answer exactly as spoken. Do not correct grammar, do not tidy it up.",
  "   Do your best with names of people, companies, colleges and technical terms.",
  "2. Ask one short follow-up question, under 25 spoken words, built on something specific",
  "   the person actually said.",
  "",
  "Never correct their English. Never evaluate the answer. Never ask more than one question.",
  "Refer to what they talked about, not their exact wording, because the recording may be unclear.",
  "If the audio is silent or unintelligible, set transcript to an empty string and ask a simpler",
  "version of the same question.",
  "",
  'Return only JSON: {"transcript": string, "question": string}',
].join("\n");

app.post("/api/answer", async (req, res) => {
  const started = Date.now();

  if (!API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "GEMINI_API_KEY is not set on the server." });
  }

  const { audioBase64, mimeType, question } = req.body || {};
  if (typeof audioBase64 !== "string" || audioBase64.length < 100) {
    return res.status(400).json({ ok: false, error: "No audio received." });
  }
  if (typeof mimeType !== "string" || !mimeType) {
    return res.status(400).json({ ok: false, error: "No mime type received." });
  }

  let model;
  try {
    model = await pickModel();
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: String(err.message || err) });
  }

  // MediaRecorder reports things like "audio/webm;codecs=opus". Gemini wants the
  // bare type. Whether it accepts webm at all is one of the things being tested.
  const cleanMime = mimeType.split(";")[0].trim();

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `The question asked was: "${question || "Tell me about yourself."}"`,
          },
          { inlineData: { mimeType: cleanMime, data: audioBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
      maxOutputTokens: 800,
    },
  };

  let apiRes, raw;
  try {
    apiRes = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
      },
      body: JSON.stringify(body),
    });
    raw = await apiRes.text();
  } catch (err) {
    return res
      .status(502)
      .json({
        ok: false,
        error: "Could not reach Gemini: " + String(err.message || err),
      });
  }

  if (!apiRes.ok) {
    return res.status(apiRes.status).json({
      ok: false,
      error: `Gemini returned HTTP ${apiRes.status}`,
      model,
      mimeSent: cleanMime,
      detail: raw.slice(0, 1200),
    });
  }

  // Everything below treats the response as untrusted, per the project's AI rules.
  let parsed = null,
    text = "",
    parseError = null;
  try {
    const envelope = JSON.parse(raw);
    const parts =
      envelope &&
      envelope.candidates &&
      envelope.candidates[0] &&
      envelope.candidates[0].content &&
      envelope.candidates[0].content.parts;
    text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
    const cleaned = text
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    parseError = String(err.message || err);
  }

  const valid =
    parsed &&
    typeof parsed.transcript === "string" &&
    typeof parsed.question === "string" &&
    parsed.question.trim().length > 0;

  res.json({
    ok: true,
    model,
    mimeSent: cleanMime,
    bytesSent: Math.round((audioBase64.length * 3) / 4),
    roundTripMs: Date.now() - started,
    valid: Boolean(valid),
    transcript: valid ? parsed.transcript : "",
    question: valid ? parsed.question : "",
    parseError,
    rawText: valid ? undefined : text.slice(0, 1200),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OutLoud spike listening on ${PORT}`);
  if (!API_KEY)
    console.log("WARNING: GEMINI_API_KEY is not set. Requests will fail.");
});
