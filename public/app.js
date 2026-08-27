(function () {
  "use strict";

  // ---- tiny helpers ----------------------------------------------------------
  var $ = function (id) {
    return document.getElementById(id);
  };

  function show(screenId) {
    var all = document.querySelectorAll(".screen");
    for (var i = 0; i < all.length; i++) all[i].classList.remove("on");
    $(screenId).classList.add("on");
    window.scrollTo(0, 0);
  }

  // Sessions live on this phone. No account, nothing sent anywhere on its own.
  var store = {
    read: function () {
      try {
        return JSON.parse(localStorage.getItem("outloud") || "{}") || {};
      } catch (e) {
        return {};
      }
    },
    write: function (obj) {
      try {
        localStorage.setItem("outloud", JSON.stringify(obj));
      } catch (e) {}
    },
  };

  // ---- speech out ------------------------------------------------------------
  // The question is spoken as well as shown. Shown matters more: a noisy room, a
  // silent phone or a failed voice must never leave the user stuck.
  function speak(text) {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      u.lang = "en-US";
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ---- recording -------------------------------------------------------------
  var FORMATS = [
    "audio/mp4",
    "audio/aac",
    "audio/ogg;codecs=opus",
    "audio/webm;codecs=opus",
    "audio/webm",
  ];

  function preferredFormat() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported)
      return "";
    for (var i = 0; i < FORMATS.length; i++) {
      if (MediaRecorder.isTypeSupported(FORMATS[i])) return FORMATS[i];
    }
    return "";
  }

  var recorder = null,
    chunks = [],
    stream = null,
    chosen = preferredFormat();

  function startRecording(onFail) {
    if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
      onFail("This browser cannot record. Try Chrome.");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (s) {
        stream = s;
        chunks = [];
        try {
          recorder = chosen
            ? new MediaRecorder(s, {
                mimeType: chosen,
                audioBitsPerSecond: 32000,
              })
            : new MediaRecorder(s);
        } catch (e) {
          recorder = new MediaRecorder(s);
        }
        recorder.ondataavailable = function (e) {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        recorder.start();
      })
      .catch(function (err) {
        var name = err && err.name;
        if (name === "NotAllowedError" || name === "SecurityError") {
          onFail(
            "The microphone is blocked. Allow it in your browser settings, then reload.",
          );
        } else if (name === "NotFoundError") {
          onFail("No microphone was found on this device.");
        } else {
          onFail("Could not start recording. Try again.");
        }
      });
  }

  function stopRecording(cb) {
    if (!recorder || recorder.state !== "recording") {
      cb(null);
      return;
    }
    recorder.onstop = function () {
      if (stream)
        stream.getTracks().forEach(function (t) {
          t.stop();
        });
      var type = recorder.mimeType || chosen || "audio/webm";
      var blob = new Blob(chunks, { type: type });
      var reader = new FileReader();
      reader.onload = function () {
        cb({
          base64: String(reader.result).split(",")[1] || "",
          mimeType: type,
          bytes: blob.size,
        });
      };
      reader.onerror = function () {
        cb(null);
      };
      reader.readAsDataURL(blob);
    };
    recorder.stop();
  }

  // ---- session state ---------------------------------------------------------
  var scenarios = [],
    TURNS = 4;
  var session = null;

  // Never open with the sentence this scenario used last time. Without this, the
  // fourth session feels like the first and there is no reason to come back.
  function chooseOpening(scenario) {
    var pool = scenario.openings || [];
    if (pool.length === 0) return "Tell me about yourself.";
    if (pool.length === 1) return pool[0];
    var s = store.read();
    var seen = s.lastOpening || {};
    var fresh = pool.filter(function (q) {
      return q !== seen[scenario.id];
    });
    var pick = fresh[Math.floor(Math.random() * fresh.length)];
    seen[scenario.id] = pick;
    s.lastOpening = seen;
    store.write(s);
    return pick;
  }

  function newSession(scenario) {
    return {
      scenario: scenario,
      turn: 1,
      question: chooseOpening(scenario),
      history: [],
      startedAt: Date.now(),
      retrying: false,
      extended: false,
      pendingQuestion: null,
    };
  }

  // ---- wiring ----------------------------------------------------------------
  function renderScenarioList(el, onPick) {
    renderList(el, scenarios, onPick);
  }

  function renderList(el, items, onPick) {
    el.innerHTML = "";
    items.forEach(function (s) {
      var li = document.createElement("li");
      var b = document.createElement("button");
      b.innerHTML = '<span class="t"></span><span class="b"></span>';
      b.querySelector(".t").textContent = s.title;
      b.querySelector(".b").textContent = s.blurb;
      b.addEventListener("click", function () {
        onPick(s);
      });
      li.appendChild(b);
      el.appendChild(li);
    });
  }

  function beginSession(scenario) {
    session = newSession(scenario);
    $("sp-scenario").textContent = scenario.title;
    $("sp-error").classList.add("hidden");
    paintQuestion();
    show("s-speak");
    speak(session.question);
  }

  function paintQuestion() {
    $("sp-progress").textContent = session.retrying
      ? "One more try"
      : session.turn > TURNS
        ? "Question " + session.turn
        : "Question " + session.turn + " of " + TURNS;
    $("sp-question").textContent = session.question;
    // Shown on the first question of any session, not only a user's very first.
    // It states how the product works rather than correcting the person, so it
    // does not read as nagging, and it disappears from question two onward.
    var hint =
      session.turn === 1 && !session.retrying
        ? "There is no time limit. The more you say, the more it has to ask about."
        : "Take your time.";
    setMic("idle", "Tap to answer", hint);
  }

  function setMic(state, stateText, hintText) {
    var mic = $("sp-mic");
    mic.setAttribute("data-state", state);
    mic.disabled = state === "busy";
    $("sp-state").textContent = stateText;
    $("sp-hint").textContent = hintText || "";
  }

  function showError(msg) {
    var e = $("sp-error");
    e.textContent = msg;
    e.classList.remove("hidden");
  }

  $("sp-mic").addEventListener("click", function () {
    var mic = $("sp-mic");
    var state = mic.getAttribute("data-state");

    if (state === "idle") {
      $("sp-error").classList.add("hidden");
      try {
        window.speechSynthesis && window.speechSynthesis.cancel();
      } catch (e) {}
      startRecording(function (msg) {
        showError(msg);
        setMic("idle", "Tap to answer", "Take your time.");
      });
      setMic("recording", "Listening", "Tap again when you have finished.");
      return;
    }

    if (state === "recording") {
      setMic("busy", "Thinking about your answer", "This takes a few seconds.");
      stopRecording(function (audio) {
        if (!audio || audio.base64.length < 100) {
          showError(
            "Nothing was recorded. Check the microphone and try again.",
          );
          setMic("idle", "Tap to answer", "Take your time.");
          return;
        }
        sendTurn(audio);
      });
    }
  });

  function sendTurn(audio) {
    var askedQuestion = session.question;

    fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId: session.scenario.id,
        turn: session.turn,
        question: askedQuestion,
        audioBase64: audio.base64,
        mimeType: audio.mimeType,
        history: session.history,
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok) {
          showError(
            "Something went wrong. Tap the microphone to try that answer again.",
          );
          setMic("idle", "Tap to answer", "Take your time.");
          return;
        }

        session.history.push({
          question: askedQuestion,
          transcript: data.transcript || "",
        });

        if (session.retrying) {
          finishSession();
          return;
        }

        // Two thirds of surveyed users said a realistic session is five minutes or
        // more, and four turns runs shorter than that. Rather than making the length
        // adaptive, which would remove the visible end a nervous user needs, the
        // session offers to continue once the planned questions are done.
        if (session.turn >= TURNS) {
          session.pendingQuestion = data.question;
          offerMore();
          return;
        }

        session.turn += 1;
        session.question = data.question;
        paintQuestion();
        speak(session.question);
      })
      .catch(function () {
        showError(
          "The connection dropped. Tap the microphone to try that answer again.",
        );
        setMic("idle", "Tap to answer", "Take your time.");
      });
  }

  // Bounded so the offer cannot repeat forever.
  var MAX_TURNS = 8;

  function offerMore() {
    if (session.history.length >= MAX_TURNS || !session.pendingQuestion) {
      finishSession();
      return;
    }
    try {
      window.speechSynthesis && window.speechSynthesis.cancel();
    } catch (e) {}
    var n = session.history.length;
    var words = [
      "",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
    ];
    $("more-title").textContent =
      "You have answered " +
      (words[n] || n) +
      (n === 1 ? " question." : " questions.");
    $("more-scenario").textContent = session.scenario.title;
    $("more-count").textContent = n + (n === 1 ? " answer" : " answers");
    show("s-more");
  }

  $("more-continue").addEventListener("click", function () {
    session.turn += 1;
    session.extended = true;
    session.question = session.pendingQuestion;
    session.pendingQuestion = null;
    $("sp-error").classList.add("hidden");
    paintQuestion();
    show("s-speak");
    speak(session.question);
  });

  $("more-finish").addEventListener("click", function () {
    finishSession();
  });

  // ---- feedback --------------------------------------------------------------
  function finishSession() {
    var mins = Math.max(
      1,
      Math.round((Date.now() - session.startedAt) / 60000),
    );
    $("fb-scenario").textContent = session.scenario.title;
    $("fb-meta").textContent =
      session.history.length + " answers · about " + mins + " min";
    setFeedbackLoading(true);
    show("s-feedback");

    // A completed session is 3 or more spoken turns plus reaching this screen.
    if (session.history.length >= 3) recordCompletion();

    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarioId: session.scenario.id,
        history: session.history,
        avoid: (store.read().saidBefore || []).slice(-6),
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        paintFeedback(d && d.ok ? d : null);
      })
      .catch(function () {
        paintFeedback(null);
      });
  }

  var SAFE_FEEDBACK = {
    strength:
      "You kept speaking through the whole session. That is the part most people avoid, and you did it.",
    improvement:
      "Next time, try adding one more sentence of detail to your first answer.",
    retry_question: "Try your first answer again, in about thirty seconds.",
  };

  function setFeedbackLoading(on) {
    $("fb-loading").classList.toggle("hidden", !on);
    $("fb-cards").classList.toggle("hidden", on);
    $("fb-retry").disabled = on;
    $("fb-retry").classList.toggle("hidden", on);
    $("fb-done").classList.toggle("hidden", on);
  }

  function rememberFeedback(f) {
    if (!f) return;
    var st = store.read();
    var said = st.saidBefore || [];
    if (f.strength) said.push(f.strength);
    if (f.improvement) said.push(f.improvement);
    st.saidBefore = said.slice(-6);
    store.write(st);
  }

  function paintFeedback(d) {
    var f = d || SAFE_FEEDBACK;
    setFeedbackLoading(false);
    if (d && !d.fallback) rememberFeedback(d);
    $("fb-strength").textContent = f.strength || SAFE_FEEDBACK.strength;
    $("fb-improvement").textContent =
      f.improvement || SAFE_FEEDBACK.improvement;
    $("fb-retry").disabled = false;
    $("fb-retry").setAttribute(
      "data-q",
      f.retry_question || SAFE_FEEDBACK.retry_question,
    );
  }

  function recordCompletion() {
    var s = store.read();
    s.completed = (s.completed || 0) + 1;
    s.lastScenario = session.scenario.id;
    s.lastAt = Date.now();
    store.write(s);
  }

  $("fb-retry").addEventListener("click", function () {
    var q =
      $("fb-retry").getAttribute("data-q") || SAFE_FEEDBACK.retry_question;
    session.retrying = true;
    session.question = q;
    $("sp-error").classList.add("hidden");
    paintQuestion();
    show("s-speak");
    speak(q);
  });

  $("fb-done").addEventListener("click", goHome);
  $("sp-quit").addEventListener("click", function () {
    try {
      window.speechSynthesis && window.speechSynthesis.cancel();
    } catch (e) {}
    if (recorder && recorder.state === "recording")
      stopRecording(function () {});
    goHome();
  });

  // ---- home ------------------------------------------------------------------
  function goHome() {
    var s = store.read();
    $("home-count").textContent = s.completed || 0;
    $("home-greet").textContent =
      (s.completed || 0) > 0 ? "Welcome back" : "Ready when you are";

    var last = null;
    for (var i = 0; i < scenarios.length; i++) {
      if (scenarios[i].id === s.lastScenario) last = scenarios[i];
    }
    $("home-last").textContent = last ? "Last time: " + last.title : "";

    // The "Practice again" button already covers the last scenario, so list the rest.
    var others = scenarios.filter(function (x) {
      return !last || x.id !== last.id;
    });
    renderList($("home-list"), others, beginSession);

    $("home-again").onclick = function () {
      beginSession(last || scenarios[0]);
    };
    show("s-home");
  }

  // ---- navigation ------------------------------------------------------------
  $("go-privacy").addEventListener("click", function () {
    show("s-privacy");
  });
  $("back-welcome").addEventListener("click", function () {
    show("s-welcome");
  });
  $("go-scenarios").addEventListener("click", function () {
    show("s-choose");
  });

  // ---- boot ------------------------------------------------------------------
  // Open with ?reset=1 to clear this phone's saved sessions and start fresh.
  if (window.location.search.indexOf("reset=1") !== -1) {
    try {
      localStorage.removeItem("outloud");
    } catch (e) {}
    try {
      history.replaceState(null, "", window.location.pathname);
    } catch (e) {}
  }

  fetch("/api/scenarios")
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      scenarios = (d && d.scenarios) || [];
      TURNS = (d && d.turns) || 4;
      renderScenarioList($("scenario-list"), beginSession);

      var s = store.read();
      if (s.completed) goHome();
    })
    .catch(function () {
      $("go-scenarios").disabled = true;
      $("go-scenarios").textContent = "Could not reach the server";
    });
})();
