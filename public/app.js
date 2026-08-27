(function () {
  "use strict";

  // ---- tiny helpers ----------------------------------------------------------
  // A missing element used to throw and kill everything after it, which left the
  // home screen rendered but its buttons dead. Never again: an unknown id returns
  // a harmless stand-in and the rest of the screen still works.
  var MISSING = [];
  function $(id) {
    var el = document.getElementById(id);
    if (el) return el;
    if (MISSING.indexOf(id) === -1) MISSING.push(id);
    return {
      textContent: "",
      innerHTML: "",
      value: "",
      disabled: false,
      style: {},
      classList: {
        add: function () {},
        remove: function () {},
        toggle: function () {},
        contains: function () {
          return false;
        },
      },
      addEventListener: function () {},
      setAttribute: function () {},
      getAttribute: function () {
        return null;
      },
      appendChild: function () {},
      focus: function () {},
      querySelector: function () {
        return null;
      },
    };
  }

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

  // A per-browser id so sessions can be counted without an account. Replaced by a
  // real identity only if the user chooses to give one.
  function deviceId() {
    var st = store.read();
    if (!st.deviceId) {
      st.deviceId =
        "d-" +
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 10);
      store.write(st);
    }
    return st.deviceId;
  }

  function recordSession(answersCount, durationMs, extended) {
    // Fire and forget. A storage failure must never affect the user's session.
    try {
      fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: deviceId(),
          scenarioId: session.scenario.id,
          answers: answersCount,
          durationMs: durationMs,
          extended: Boolean(extended),
        }),
      }).catch(function () {});
    } catch (e) {}
  }

  // ---- speech out ------------------------------------------------------------
  // The question is spoken as well as shown. Shown matters more: a noisy room, a
  // silent phone or a failed voice must never leave the user stuck.
  // Browsers load the voice list asynchronously. The very first utterance of a
  // page load was being dropped because no voices existed yet, which is why the
  // first question of a first session was silent while later ones spoke.
  var voicesReady = false;

  function primeSpeech() {
    try {
      if (!window.speechSynthesis) return;
      var list = window.speechSynthesis.getVoices();
      if (list && list.length) {
        voicesReady = true;
        return;
      }
      window.speechSynthesis.onvoiceschanged = function () {
        voicesReady = true;
      };
      // Some browsers only populate the list after a call made during a gesture.
      var warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      window.speechSynthesis.speak(warm);
    } catch (e) {}
  }

  function utter(text) {
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.lang = "en-US";
    window.speechSynthesis.speak(u);
  }

  function speak(text) {
    try {
      if (!window.speechSynthesis || !text) return;
      window.speechSynthesis.cancel();
      var list = window.speechSynthesis.getVoices();
      if (voicesReady || (list && list.length)) {
        utter(text);
        return;
      }
      // Wait for the list, but never wait forever.
      var spoken = false;
      var go = function () {
        if (spoken) return;
        spoken = true;
        voicesReady = true;
        utter(text);
      };
      window.speechSynthesis.onvoiceschanged = go;
      setTimeout(go, 350);
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
      recorded: false,
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

    // Count each session exactly once. Reaching this screen again after a retry is
    // the same session, and counting it twice would inflate the North Star both
    // locally and in the database.
    if (!session.recorded) {
      session.recorded = true;
      recordSession(
        session.history.length,
        Date.now() - session.startedAt,
        session.extended,
      );
      if (session.history.length >= 3) recordCompletion();
    }

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

  // Last resort, used only if the server itself cannot be reached. Says only what
  // is certainly true: that they spoke. Never claims effort or persistence the
  // app has no way to observe.
  var SAFE_FEEDBACK = {
    strength:
      "You spoke out loud in English for a whole session. That is the practice that actually builds the skill.",
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
    if (d && !d.fallback && !session.feedbackRemembered) {
      session.feedbackRemembered = true;
      rememberFeedback(d);
    }
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

  $("fb-done").addEventListener("click", function () {
    var st = store.read();
    // Asked once, after a win, and never again if answered or declined.
    if ((st.completed || 0) >= 1 && !st.identified && !st.declinedIdentity) {
      $("save-error").classList.add("hidden");
      show("s-save");
      return;
    }
    goHome();
  });

  $("save-skip").addEventListener("click", function () {
    var st = store.read();
    st.declinedIdentity = true;
    store.write(st);
    goHome();
  });

  $("save-submit").addEventListener("click", function () {
    var name = $("save-name").value.trim();
    var phone = $("save-phone").value.trim();
    var digits = phone.replace(/[^0-9]/g, "");

    if (digits.length < 10 || digits.length > 13) {
      var e = $("save-error");
      e.textContent =
        "Please check the number. It should be at least 10 digits.";
      e.classList.remove("hidden");
      return;
    }

    $("save-submit").disabled = true;
    $("save-submit").textContent = "Saving…";

    fetch("/api/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: deviceId(), name: name, phone: digits }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        $("save-submit").disabled = false;
        $("save-submit").textContent = "Save my progress";
        if (!d || !d.ok) {
          var e2 = $("save-error");
          e2.textContent =
            (d && d.error) ||
            "Could not save that. You can carry on without it.";
          e2.classList.remove("hidden");
          return;
        }
        var st = store.read();
        st.identified = true;
        st.name = name;
        store.write(st);
        goHome();
      })
      .catch(function () {
        $("save-submit").disabled = false;
        $("save-submit").textContent = "Save my progress";
        var e3 = $("save-error");
        e3.textContent =
          "The connection dropped. You can carry on without saving.";
        e3.classList.remove("hidden");
      });
  });
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
    // Wire the buttons before painting anything. If painting fails, the user can
    // still move; if wiring came second, a paint error would trap them here.
    $("home-again").onclick = function () {
      primeSpeech();
      var st = store.read();
      var pick = null;
      for (var j = 0; j < scenarios.length; j++) {
        if (scenarios[j].id === st.lastScenario) pick = scenarios[j];
      }
      beginSession(pick || scenarios[0]);
    };
    show("s-home");

    try {
      paintHome();
    } catch (err) {
      // Painting is cosmetic. Never let it block the person from practicing.
    }
  }

  function paintHome() {
    var s = store.read();
    var n = s.completed || 0;
    $("home-count").textContent = n;
    $("home-count-label").textContent =
      n === 1 ? "session completed" : "sessions completed";
    $("home-note").textContent =
      n === 0
        ? ""
        : n === 1
          ? "You have spoken out loud once. The next one is easier."
          : "You have spoken out loud " + n + " times.";
    $("home-greet").textContent =
      (s.completed || 0) > 0
        ? s.name
          ? "Welcome back, " + s.name
          : "Welcome back"
        : "Ready when you are";

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
  }

  // ---- navigation ------------------------------------------------------------
  $("go-privacy").addEventListener("click", function () {
    show("s-privacy");
  });
  $("back-welcome").addEventListener("click", function () {
    show("s-welcome");
  });
  $("go-scenarios").addEventListener("click", function () {
    primeSpeech();
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

  // Surfaced deliberately: a mismatched index.html should be obvious in the console
  // rather than showing up as buttons that quietly do nothing.
  setTimeout(function () {
    if (MISSING.length)
      console.warn(
        "OutLoud: missing elements in the page:",
        MISSING.join(", "),
      );
  }, 400);

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
