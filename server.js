// OutLoud — practice server.
// One AI call per spoken turn, one at the end for feedback.
// Every AI response is treated as untrusted: validated, retried once, then a
// static fallback so a bad API moment never ends a user's session.

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const BASE = "https://generativelanguage.googleapis.com/v1beta";

// Pinned deliberately. Measured 26 Aug 2026: flash-lite 2.8s, 3.6-flash 4.8-9.9s,
// 3.5-flash 16s and truncated JSON, 3.7-flash 74s and a 503. Newest is not best,
// and an unpinned model means latency can change without a code change.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 15000);
const TURNS = 4;

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Scenarios: one source of truth, served to the client ---------------------

// Each scenario has several openings. Practicing the same scenario twice must not
// start with the same sentence, or the fourth session feels like the first and the
// user stops coming back. The follow-ups are generated, so varying the opening
// varies the whole conversation.
const SCENARIOS = [
  {
    id: "intro",
    title: "Introduce yourself",
    blurb: "The question every interview starts with.",
    openings: [
      "To start, tell me a little about yourself.",
      "Walk me through your background in your own words.",
      "How would you describe what you do to someone who has never met you?",
      "Tell me about yourself, and where you are in your career right now.",
    ],
    fallbacks: [
      "What did you enjoy most about that?",
      "Can you tell me more about one thing you mentioned?",
      "What would you like an interviewer to remember about you?",
    ],
  },
  {
    id: "fresher",
    title: "Fresher job interview",
    blurb: "General questions for your first or second job.",
    openings: [
      "Why are you interested in this kind of role?",
      "What made you apply for this job?",
      "What kind of work are you hoping to do next?",
      "Why do you think this role would suit you?",
    ],
    fallbacks: [
      "What part of that work would suit you best?",
      "Tell me about a time you had to learn something quickly.",
      "What would you want to get better at in your first year?",
    ],
  },
  {
    id: "project",
    title: "Something you built",
    blurb: "Talk through your own work out loud.",
    openings: [
      "Tell me about something you built or worked on.",
      "Pick a project you are proud of and walk me through it.",
      "What is the most interesting thing you have worked on?",
      "Describe something you made, and why you made it.",
    ],
    fallbacks: [
      "What was the hardest part of it?",
      "What would you do differently if you started again?",
      "What did you learn from doing it?",
    ],
  },
];

const FALLBACK_FEEDBACK = {
  strength:
    "You kept speaking through the whole session. That is the part most people avoid, and you did it.",
  improvement:
    "Next time, try adding one more sentence of detail to your first answer.",
  retry_question: "Try your first answer again, in about thirty seconds.",
};

function scenarioById(id) {
  for (let i = 0; i < SCENARIOS.length; i++) {
    if (SCENARIOS[i].id === id) return SCENARIOS[i];
  }
  return null;
}

app.get("/api/scenarios", (req, res) => {
  res.json({
    turns: TURNS,
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      title: s.title,
      blurb: s.blurb,
      openings: s.openings,
    })),
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: Boolean(API_KEY), model: MODEL, turns: TURNS });
});

// --- Gemini plumbing ----------------------------------------------------------

async function callGemini(systemText, parts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
      },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: "user", parts: parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.8,
          maxOutputTokens: 1200,
        },
      }),
    });
    const raw = await res.text();
    if (!res.ok)
      return {
        ok: false,
        reason: `HTTP ${res.status}`,
        raw: raw.slice(0, 400),
      };
    return { ok: true, raw };
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return {
      ok: false,
      reason: aborted ? "timeout" : String(err.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Models sometimes wrap JSON in code fences, and truncate it when they run long.
// gemini-3.5-flash returned an unterminated string during testing, so nothing
// here assumes the response parses.
function extractJson(raw) {
  try {
    const envelope = JSON.parse(raw);
    const parts =
      envelope &&
      envelope.candidates &&
      envelope.candidates[0] &&
      envelope.candidates[0].content &&
      envelope.candidates[0].content.parts;
    const text = Array.isArray(parts)
      ? parts.map((p) => p.text || "").join("")
      : "";
    const cleaned = text
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Two attempts, then the caller falls back to static content.
async function askGemini(systemText, parts, validate) {
  let lastReason = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callGemini(systemText, parts);
    if (!res.ok) {
      lastReason = res.reason;
      continue;
    }
    const parsed = extractJson(res.raw);
    if (parsed && validate(parsed)) return { ok: true, data: parsed };
    lastReason = parsed ? "missing fields" : "unparseable";
  }
  return { ok: false, reason: lastReason };
}

// --- Turn: the user has spoken, ask the next question -------------------------

const TURN_SYSTEM = [
  "You are running a short practice job interview for a nervous Indian job seeker",
  "who reads and writes English well but is anxious about speaking it.",
  "Your job is to keep them speaking, not to teach English.",
  "",
  "You are given the question just asked and an audio recording of their answer.",
  "",
  "1. Transcribe the answer as spoken. Do not correct grammar or tidy it up.",
  "2. Ask one short follow-up question, under 25 spoken words, built on something",
  "   specific they actually said.",
  "",
  "Never correct grammar, pronunciation, accent or vocabulary. Never evaluate the",
  "answer. Never give advice. Never ask more than one question.",
  "",
  "Refer to what they talked about, not their exact wording. Speech recognition",
  "misheard names and technical terms in testing, and quoting a misheard word back",
  "would embarrass the person for a mistake they did not make.",
  "",
  "If the audio is silent or unintelligible, set transcript to an empty string and",
  "ask a simpler version of the same question without commenting on it.",
  "",
  'Return only JSON: {"transcript": string, "question": string}',
].join("\n");

app.post("/api/turn", async (req, res) => {
  const { scenarioId, turn, question, audioBase64, mimeType, history } =
    req.body || {};
  const scenario = scenarioById(scenarioId);

  if (!scenario)
    return res.status(400).json({ ok: false, error: "Unknown scenario." });
  if (!API_KEY)
    return res
      .status(500)
      .json({ ok: false, error: "Server is not configured." });

  const turnIndex = Number(turn) || 1;
  const fallbackQuestion =
    scenario.fallbacks[Math.min(turnIndex - 1, scenario.fallbacks.length - 1)];

  if (typeof audioBase64 !== "string" || audioBase64.length < 100) {
    return res.status(400).json({ ok: false, error: "No audio received." });
  }

  const priorLines = Array.isArray(history)
    ? history
        .filter((h) => h && nonEmpty(h.question))
        .map(
          (h) =>
            `Asked: ${h.question}\nThey said: ${h.transcript || "(unclear)"}`,
        )
        .join("\n\n")
    : "";

  const parts = [
    {
      text:
        (priorLines ? `Earlier in this session:\n${priorLines}\n\n` : "") +
        `The question just asked was: "${question || scenario.openings[0]}"`,
    },
    {
      inlineData: {
        mimeType: String(mimeType || "")
          .split(";")[0]
          .trim(),
        data: audioBase64,
      },
    },
  ];

  const result = await askGemini(
    TURN_SYSTEM,
    parts,
    (d) => typeof d.transcript === "string" && nonEmpty(d.question),
  );

  if (result.ok) {
    return res.json({
      ok: true,
      transcript: result.data.transcript,
      question: result.data.question,
      fallback: false,
    });
  }

  // The session continues on a pre-written question rather than ending.
  res.json({
    ok: true,
    transcript: "",
    question: fallbackQuestion,
    fallback: true,
    reason: result.reason,
  });
});

// --- Feedback: one strength, one improvement, one retry -----------------------

const FEEDBACK_SYSTEM = [
  "You are giving end-of-practice feedback to a nervous job seeker who has just",
  "finished a spoken interview practice session in English.",
  "Your goal is that they want to practice again today.",
  "",
  "Give exactly one specific strength, drawn from what they actually said, not",
  "generic praise. Give exactly one improvement, and only one, phrased as something",
  "to try rather than something they did wrong. Give one short retry instruction",
  "naming which question to answer again.",
  "",
  "Never mention grammar, accent, pronunciation, filler words or vocabulary.",
  "Never give a score, grade or rating. Never say they failed or would not get the",
  "job. Keep each field under 30 words. Write at a plain English reading level.",
  "",
  "The transcript comes from speech recognition and may contain mistakes. Never",
  "comment on odd wording, and never quote them word for word.",
  "",
  "If the transcript is too short or unclear to judge, still give an encouraging",
  "strength about having spoken, and make the improvement about giving one more",
  "sentence of detail next time.",
  "",
  'Return only JSON: {"strength": string, "improvement": string, "retry_question": string}',
].join("\n");

app.post("/api/feedback", async (req, res) => {
  const { scenarioId, history } = req.body || {};
  const scenario = scenarioById(scenarioId);

  if (!scenario)
    return res.status(400).json({ ok: false, error: "Unknown scenario." });
  if (!API_KEY)
    return res.json({ ok: true, fallback: true, ...FALLBACK_FEEDBACK });

  const lines = Array.isArray(history)
    ? history
        .filter((h) => h && nonEmpty(h.question))
        .map(
          (h) =>
            `Asked: ${h.question}\nThey said: ${h.transcript || "(unclear)"}`,
        )
        .join("\n\n")
    : "";

  if (!lines) {
    return res.json({ ok: true, fallback: true, ...FALLBACK_FEEDBACK });
  }

  const result = await askGemini(
    FEEDBACK_SYSTEM,
    [{ text: `Practice scenario: ${scenario.title}\n\n${lines}` }],
    (d) =>
      nonEmpty(d.strength) &&
      nonEmpty(d.improvement) &&
      nonEmpty(d.retry_question),
  );

  if (result.ok) {
    return res.json({
      ok: true,
      fallback: false,
      strength: result.data.strength,
      improvement: result.data.improvement,
      retry_question: result.data.retry_question,
    });
  }

  res.json({
    ok: true,
    fallback: true,
    reason: result.reason,
    ...FALLBACK_FEEDBACK,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OutLoud on ${PORT}, model ${MODEL}`);
  if (!API_KEY) console.log("WARNING: GEMINI_API_KEY is not set.");
});
