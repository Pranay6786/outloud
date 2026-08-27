// OutLoud — practice server.
// One AI call per spoken turn, one at the end for feedback.
// Every AI response is treated as untrusted: validated, retried once, then a
// static fallback so a bad API moment never ends a user's session.

const express = require("express");
const path = require("path");

// --- storage -----------------------------------------------------------------
// Optional by design. If DATABASE_URL is absent the app still runs and simply
// records nothing, because a database problem must never stop someone practicing.
let pool = null;
let dbReady = false;
let dbError = null;

try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
} catch (err) {
  dbError = "pg module not installed: " + String(err.message || err);
}

async function initDb() {
  if (!pool) {
    dbError = dbError || "DATABASE_URL is not set";
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         SERIAL PRIMARY KEY,
        device_id  TEXT UNIQUE NOT NULL,
        name       TEXT,
        phone      TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          SERIAL PRIMARY KEY,
        device_id   TEXT NOT NULL,
        scenario    TEXT,
        answers     INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        completed   BOOLEAN NOT NULL DEFAULT false,
        extended    BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS sessions_device_idx ON sessions (device_id);`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS sessions_created_idx ON sessions (created_at);`,
    );
    dbReady = true;
  } catch (err) {
    dbError = String(err.message || err);
  }
}

// Kept in memory so a live session can be inspected afterwards. No transcripts,
// no audio, no personal data: only what happened to each AI call.
const DIAG = [];
function diag(entry) {
  DIAG.push(Object.assign({ at: new Date().toISOString() }, entry));
  if (DIAG.length > 80) DIAG.shift();
}

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const BASE = "https://generativelanguage.googleapis.com/v1beta";

// Pinned deliberately. Measured 26 Aug 2026: flash-lite 2.8s, 3.6-flash 4.8-9.9s,
// 3.5-flash 16s and truncated JSON, 3.7-flash 74s and a 503. Newest is not best,
// and an unpinned model means latency can change without a code change.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// Each model has its own free-tier quota. On 27 Aug 2026 the daily quota for one
// model ran out mid-testing and every call returned HTTP 429, so the app served
// static fallbacks for a whole session and looked as though the AI had simply
// become worse. Quota exhaustion is now treated as a reason to move to the next
// model rather than as a dead end.
// Ordered by measured quality and latency, not by version number. gemini-3.5-flash
// is last because it took 16 seconds and returned truncated JSON during testing,
// and gemini-3.7-flash is excluded entirely: 74 seconds on one request and a 503
// on another. Falling into a bad model silently is worse than the quota problem
// this chain exists to solve.
const PREFERRED = "gemini-3.5-flash-lite";
const MODEL_CHAIN = [MODEL].concat(
  [
    PREFERRED,
    "gemini-3.6-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
  ].filter((m) => m !== MODEL),
);

let activeModel = MODEL;
let switchedAt = 0;

// A model is only demoted for a while. Without this, one transient 503 pins the
// app to a fallback model for the rest of its life, long after the preferred one
// has recovered.
const RETRY_PREFERRED_AFTER_MS = Number(
  process.env.MODEL_RETRY_MS || 15 * 60 * 1000,
);

function currentModel() {
  const first = MODEL_CHAIN[0];
  if (
    activeModel !== first &&
    switchedAt &&
    Date.now() - switchedAt > RETRY_PREFERRED_AFTER_MS
  ) {
    diag({
      kind: "model",
      outcome: "returning to preferred",
      reason: "cooldown elapsed",
      now: first,
    });
    activeModel = first;
    switchedAt = 0;
  }
  return activeModel;
}
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
      "What are you hoping to do next?",
      "What is something you are good at that people do not notice?",
      "How would a colleague describe working with you?",
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
      "What kind of team do you work well in?",
      "Tell me about a time something did not go to plan.",
      "What questions would you want to ask us?",
    ],
  },
  // Replaced "Something you built" on 26 Aug 2026. Work calls and meetings was the
  // most requested practice situation in the survey at 57.14%, ahead of interview
  // answers at 50%. The sample skews employed, so this covers the top request
  // without giving up the interview focus the brief asks for.
  {
    id: "workcall",
    title: "A work call or meeting",
    blurb: "Speaking up when it is not an interview.",
    openings: [
      "You are in a team meeting. Give a quick update on what you worked on this week.",
      "A client asks how the work is going. What do you tell them?",
      "Your manager asks you to explain a problem you ran into. Explain it to me.",
      "Someone on the call asks you to walk them through what you do. Go ahead.",
    ],
    fallbacks: [
      "How would you explain that to someone outside your team?",
      "What would you say if they asked you to repeat that more simply?",
      "What is the one thing you would want them to remember?",
      "How would you tell them about a delay?",
      "How would you disagree with something said on that call?",
      "What would you say if you did not know the answer?",
    ],
  },
];

// Used only when a scenario's own fallbacks have all been asked, which is possible
// once a session can be extended to eight answers.
const GENERIC_FALLBACKS = [
  "What else would you want them to know?",
  "Can you say a bit more about that?",
  "What would you add if you had more time?",
  "What is the most important part of what you just said?",
];

// A pool rather than one message. Validation now rejects feedback that repeats an
// earlier session, which means the fallback runs more often — and a single fixed
// fallback would reintroduce the repetition it exists to prevent.
const FALLBACK_FEEDBACK_POOL = [
  {
    strength:
      "You spoke out loud in English for a whole session. That is the practice that actually builds the skill.",
    improvement:
      "Next time, try adding one more sentence of detail to your first answer.",
    retry_question: "Try your first answer again, in about thirty seconds.",
  },
  {
    strength:
      "You answered the questions in your own words instead of avoiding them.",
    improvement:
      "Next time, try giving one real example instead of a general answer.",
    retry_question:
      "Pick any question from this session and answer it once more.",
  },
  {
    strength:
      "You put your thoughts into spoken English, which is harder than writing them.",
    improvement:
      "Next time, try finishing an answer by saying what the result was.",
    retry_question:
      "Try your last answer again, and add what happened in the end.",
  },
  {
    strength:
      "You kept talking through a real conversation rather than a script.",
    improvement:
      "Next time, try slowing down slightly and saying a little more in each answer.",
    retry_question:
      "Answer one of these questions again, taking a bit longer over it.",
  },
];

const FALLBACK_FEEDBACK = FALLBACK_FEEDBACK_POOL[0];

function pickFallbackFeedback(previous) {
  const seen = (previous || []).map((t) =>
    normaliseText(t).split(" ").slice(0, 8).join(" "),
  );
  const fresh = FALLBACK_FEEDBACK_POOL.filter(function (f) {
    const key = normaliseText(f.strength).split(" ").slice(0, 8).join(" ");
    const key2 = normaliseText(f.improvement).split(" ").slice(0, 8).join(" ");
    return seen.indexOf(key) === -1 && seen.indexOf(key2) === -1;
  });
  const pool = fresh.length ? fresh : FALLBACK_FEEDBACK_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

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
  res.json({
    ok: Boolean(API_KEY),
    model: currentModel(),
    configured: MODEL,
    chain: MODEL_CHAIN,
    switchedAgo: switchedAt
      ? Math.round((Date.now() - switchedAt) / 1000) + "s"
      : null,
    turns: TURNS,
    database: dbReady,
  });
});

// --- Gemini plumbing ----------------------------------------------------------

async function callGemini(systemText, parts, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${BASE}/models/${model || currentModel()}:generateContent`,
      {
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
      },
    );
    const raw = await res.text();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
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

function normaliseText(t) {
  return String(t)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Two attempts, then the caller falls back to static content.
// Two attempts, then the caller falls back to static content. The second attempt
// is told what went wrong, otherwise it simply reproduces the rejected answer.
async function askGemini(systemText, parts, validate, kind) {
  let lastReason = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptParts =
      attempt === 0
        ? parts
        : parts.concat([
            {
              text:
                "Your previous reply was rejected because: " +
                lastReason +
                ". Give a different reply that fixes exactly that.",
            },
          ]);

    let res = await callGemini(systemText, attemptParts);

    // 429 quota, 404 retired, 503 overloaded: the model is the problem, not the
    // request. Move down the chain and remember the one that worked.
    if (!res.ok && [429, 404, 503].indexOf(res.status) !== -1) {
      for (let i = 0; i < MODEL_CHAIN.length; i++) {
        const candidate = MODEL_CHAIN[i];
        if (candidate === activeModel) continue;
        const alt = await callGemini(systemText, attemptParts, candidate);
        if (alt.ok) {
          diag({
            kind: kind,
            outcome: "switched model",
            reason: `${activeModel} returned ${res.status}`,
            now: candidate,
          });
          activeModel = candidate;
          switchedAt = Date.now();
          res = alt;
          break;
        }
      }
    }

    if (!res.ok) {
      lastReason = res.reason;
      diag({
        kind: kind,
        attempt: attempt,
        outcome: "call failed",
        reason: res.reason,
        detail: String(res.raw || "").slice(0, 200),
      });
      continue;
    }
    const parsed = extractJson(res.raw);
    if (parsed && validate(parsed)) {
      diag({ kind: kind, attempt: attempt, outcome: "accepted" });
      return { ok: true, data: parsed };
    }
    lastReason = parsed
      ? "the reply repeated something already used, or was missing a field"
      : "the reply was not valid JSON";
    diag({
      kind: kind,
      attempt: attempt,
      outcome: "rejected",
      reason: lastReason,
      got: parsed
        ? Object.keys(parsed).join(",")
        : String(res.raw || "").slice(0, 200),
    });
  }
  diag({
    kind: kind,
    outcome: "fell back to static content",
    reason: lastReason,
  });
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
  "The follow-up must name a concrete detail from their answer: a project, a company,",
  "a task, a person, a number, a decision, a problem. If your question would still make",
  "sense after somebody else's answer, it is too general and you must ask a different one.",
  "",
  "Weak, do not do this:",
  "  They said: I built an attendance dashboard for my college using React.",
  "  Bad question: What did you enjoy about that?",
  "  Bad question: Can you tell me more about your experience?",
  "",
  "Strong, do this:",
  "  They said: I built an attendance dashboard for my college using React.",
  "  Good question: Who was using that dashboard, and what did they do before it existed?",
  "",
  "  They said: I worked as a business analyst for eight months at a small tech firm.",
  "  Good question: What was the first thing you were asked to figure out there?",
  "",
  "  They said: We had a delay and the client was not happy about it.",
  "  Good question: What did you actually say to the client about the delay?",
  "",
  "Push gently for detail rather than opinion. Ask what happened, what they did, what",
  "they said, who else was involved, what changed. Avoid asking how they felt about it.",
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
  "If they answer in a language other than English, do not comment on it and do not",
  "translate. Ask a simpler, shorter question in English so they can try again.",
  "",
  "If they swear, insult you, or say something rude, do not repeat the words, do not",
  "react to them, and do not lecture them. Ask the next question calmly as if it did",
  "not happen. Never use offensive language yourself.",
  "",
  "If they say something off-topic, treat it as nerves and ask a simple question that",
  "brings them back to the practice.",
  "",
  "If they say something that suggests real distress or that they may be in danger,",
  "stop the practice line of questioning. Say one short kind sentence and suggest they",
  "talk to someone they trust. Do not counsel them and do not continue interviewing.",
  "",
  "Never repeat a question that has already been asked in this session, and never ask",
  "a question that is only a small rewording of one already asked.",
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

  // Everything already asked this session, so nothing gets asked twice. Extended
  // sessions ran past the end of the fallback list and repeated the same question
  // until the cap; both the model and the fallback are now checked against this.
  const askedList = (Array.isArray(history) ? history : [])
    .map((h) => (h && h.question) || "")
    .concat([question || ""])
    .filter(nonEmpty);

  const askedSet = askedList.map(normaliseText);
  const alreadyAsked = (q) => askedSet.indexOf(normaliseText(q)) !== -1;

  const unusedFallbacks = scenario.fallbacks.filter((q) => !alreadyAsked(q));
  const fallbackQuestion =
    unusedFallbacks.length > 0
      ? unusedFallbacks[turnIndex % unusedFallbacks.length]
      : GENERIC_FALLBACKS[turnIndex % GENERIC_FALLBACKS.length];

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
    (d) =>
      typeof d.transcript === "string" &&
      nonEmpty(d.question) &&
      !alreadyAsked(d.question),
    "turn " + turnIndex,
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

// Consecutive sessions were producing similar feedback because every call was
// asked the same open question. The server picks an angle and requires it, which
// forces variety without needing the model to remember anything.
const FEEDBACK_ANGLES = [
  "the specific example or detail they gave",
  "how they structured the answer from start to finish",
  "how they handled a question they clearly had not prepared for",
  "the amount of detail they gave about their own role",
  "how they explained something technical in plain words",
  "how they kept going when an answer was hard to start",
  "the way they described a result or an outcome",
];

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
  "If the answers contain swearing, insults or nonsense, do not repeat any of it and",
  "do not scold them. Give neutral, encouraging feedback about having spoken, and make",
  "the improvement about answering the question that was asked.",
  "",
  "If any answer was in another language, do not comment on it. Make the improvement",
  "about trying the next answer in English.",
  "",
  "Vary your feedback. Pick a different strength and a different improvement from the",
  "ones listed as already given, even if the session looks similar to an earlier one.",
  "There is always something specific in what they said that has not been mentioned yet.",
  "",
  "Quote nothing, but be concrete. Name what they talked about.",
  "",
  "Weak, do not do this:",
  "  You spoke clearly and answered the questions well.",
  "  Try to give more detail next time.",
  "",
  "Strong, do this:",
  "  You explained who the dashboard was actually for, which is what makes an example land.",
  "  Next time, finish that story by saying how much time it saved them.",
  "",
  "If the transcript is too short or unclear to judge, still give an encouraging",
  "strength about having spoken, and make the improvement about giving one more",
  "sentence of detail next time.",
  "",
  'Return only JSON: {"strength": string, "improvement": string, "retry_question": string}',
].join("\n");

app.post("/api/feedback", async (req, res) => {
  const { scenarioId, history, avoid } = req.body || {};
  const scenario = scenarioById(scenarioId);

  if (!scenario)
    return res.status(400).json({ ok: false, error: "Unknown scenario." });
  if (!API_KEY)
    return res.json({ ok: true, fallback: true, ...pickFallbackFeedback([]) });

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
    return res.json({
      ok: true,
      fallback: true,
      ...pickFallbackFeedback(Array.isArray(avoid) ? avoid : []),
    });
  }

  // Feedback repeated itself across short sessions because each call knew nothing
  // about the last. The client sends what was said before so it can be avoided,
  // and a response that repeats it is rejected and retried.
  const previous = Array.isArray(avoid) ? avoid.filter(nonEmpty).slice(-6) : [];
  const shorthand = (t) => normaliseText(t).split(" ").slice(0, 8).join(" ");
  const previousShort = previous.map(shorthand);
  const repeatsPrevious = (t) => previousShort.indexOf(shorthand(t)) !== -1;

  const answers = (Array.isArray(history) ? history : []).map(
    (h) => (h && h.transcript) || "",
  );
  const words = answers.join(" ").trim().split(/\s+/).filter(Boolean).length;
  const avgWords = answers.length ? Math.round(words / answers.length) : 0;

  const angle =
    FEEDBACK_ANGLES[Math.floor(Math.random() * FEEDBACK_ANGLES.length)];

  const context =
    `Practice scenario: ${scenario.title}\n\n${lines}\n\n` +
    `For the strength, focus on ${angle}. If there is genuinely nothing there, pick ` +
    `a different specific thing they said, but do not fall back on general praise.\n\n` +
    `Their answers averaged about ${avgWords} words each.` +
    (avgWords > 0 && avgWords < 25
      ? " Their answers were short, so there was little to work with. Make the improvement" +
        " about saying more next time, and explain it as the way to get more interesting" +
        " questions, never as something they did wrong."
      : "") +
    (previous.length
      ? `\n\nIn earlier sessions they were already told the following. Do not repeat these` +
        ` points or say them in different words. Find something new:\n- ${previous.join("\n- ")}`
      : "");

  const result = await askGemini(
    FEEDBACK_SYSTEM,
    [{ text: context }],
    (d) =>
      nonEmpty(d.strength) &&
      nonEmpty(d.improvement) &&
      nonEmpty(d.retry_question) &&
      !repeatsPrevious(d.strength) &&
      !repeatsPrevious(d.improvement),
    "feedback",
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
    ...pickFallbackFeedback(previous),
  });
});

// --- session and identity -----------------------------------------------------

function cleanPhone(v) {
  const digits = String(v || "").replace(/[^0-9]/g, "");
  return digits.length >= 10 && digits.length <= 13 ? digits : null;
}

app.post("/api/session", async (req, res) => {
  const { deviceId, scenarioId, answers, durationMs, extended } =
    req.body || {};
  if (!nonEmpty(deviceId))
    return res.status(400).json({ ok: false, error: "No device id." });

  // A completed session is three or more spoken answers plus reaching feedback.
  const answerCount = Math.max(0, parseInt(answers, 10) || 0);
  const completed = answerCount >= 3;

  if (!dbReady)
    return res.json({
      ok: true,
      stored: false,
      reason: dbError || "no database",
    });

  try {
    await pool.query(
      `INSERT INTO sessions (device_id, scenario, answers, duration_ms, completed, extended)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(deviceId).slice(0, 64),
        String(scenarioId || "").slice(0, 40),
        answerCount,
        Math.max(0, parseInt(durationMs, 10) || 0),
        completed,
        Boolean(extended),
      ],
    );
    res.json({ ok: true, stored: true, completed });
  } catch (err) {
    // Never fail the user's session because a write failed.
    res.json({ ok: true, stored: false, reason: String(err.message || err) });
  }
});

app.post("/api/identify", async (req, res) => {
  const { deviceId, name, phone } = req.body || {};
  if (!nonEmpty(deviceId))
    return res.status(400).json({ ok: false, error: "No device id." });

  const phoneDigits = cleanPhone(phone);
  if (!phoneDigits)
    return res
      .status(400)
      .json({ ok: false, error: "That does not look like a phone number." });

  if (!dbReady)
    return res.json({
      ok: true,
      stored: false,
      reason: dbError || "no database",
    });

  try {
    await pool.query(
      `INSERT INTO users (device_id, name, phone) VALUES ($1, $2, $3)
       ON CONFLICT (device_id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone`,
      [
        String(deviceId).slice(0, 64),
        String(name || "").slice(0, 80),
        phoneDigits,
      ],
    );
    res.json({ ok: true, stored: true });
  } catch (err) {
    res.json({ ok: true, stored: false, reason: String(err.message || err) });
  }
});

app.get("/api/diag", (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key)
    return res.status(403).json({ ok: false, error: "Forbidden." });
  res.json({
    ok: true,
    model: currentModel(),
    chain: MODEL_CHAIN,
    callsPerSession:
      "about 5 for four questions, about 7 if extended or retried",
    summary: {
      accepted: DIAG.filter((d) => d.outcome === "accepted").length,
      rejected: DIAG.filter((d) => d.outcome === "rejected").length,
      callFailed: DIAG.filter((d) => d.outcome === "call failed").length,
      fellBack: DIAG.filter((d) => d.outcome === "fell back to static content")
        .length,
    },
    recent: DIAG.slice(-40).reverse(),
  });
});

// --- metrics, for the Step 6 dashboard ----------------------------------------
// Behind a key because it exposes counts, and it never returns phone numbers.
app.get("/api/stats", async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.query.key !== key)
    return res.status(403).json({ ok: false, error: "Forbidden." });
  if (!dbReady) return res.json({ ok: false, error: dbError || "no database" });

  try {
    const q = async (sql) => (await pool.query(sql)).rows;
    const [totals] = await q(`
      SELECT
        COUNT(*)::int                                   AS sessions_started,
        COUNT(*) FILTER (WHERE completed)::int          AS sessions_completed,
        COUNT(DISTINCT device_id)::int                  AS devices,
        COUNT(DISTINCT device_id) FILTER (WHERE completed)::int AS devices_completed,
        COALESCE(ROUND(AVG(answers) FILTER (WHERE completed))::int, 0) AS avg_answers,
        COUNT(*) FILTER (WHERE extended)::int           AS sessions_extended
      FROM sessions
    `);
    const [identified] = await q(
      `SELECT COUNT(*)::int AS identified_users FROM users WHERE phone IS NOT NULL`,
    );
    const [median] = await q(`
      SELECT COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) / 1000)::int, 0) AS median_seconds
      FROM sessions WHERE completed AND duration_ms > 0
    `);
    const byDay = await q(`
      SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS started,
             COUNT(*) FILTER (WHERE completed)::int AS completed
      FROM sessions GROUP BY 1 ORDER BY 1 DESC LIMIT 14
    `);
    const byScenario = await q(`
      SELECT scenario, COUNT(*)::int AS started, COUNT(*) FILTER (WHERE completed)::int AS completed
      FROM sessions GROUP BY 1 ORDER BY 2 DESC
    `);
    const repeat = await q(`
      SELECT sessions_per_device, COUNT(*)::int AS devices FROM (
        SELECT device_id, COUNT(*)::int AS sessions_per_device
        FROM sessions WHERE completed GROUP BY device_id
      ) t GROUP BY 1 ORDER BY 1
    `);

    res.json({
      ok: true,
      note: "Week 4 completion cannot be computed until four weeks after the first signup.",
      totals: { ...totals, ...identified, ...median },
      byDay,
      byScenario,
      repeatDistribution: repeat,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OutLoud on ${PORT}, model ${MODEL}`);
  if (!API_KEY) console.log("WARNING: GEMINI_API_KEY is not set.");
  initDb().then(() => {
    console.log(
      dbReady ? "Database ready." : "Database not in use: " + dbError,
    );
  });
});
