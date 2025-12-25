document.addEventListener("DOMContentLoaded", () => {
  // --- Core UI ---
  const fabBtn      = document.getElementById("fab-button");
  const fabPanel    = document.getElementById("fab-panel");
  const closePanel  = document.getElementById("close-panel");
  const overlay     = document.getElementById("call-overlay");
  const callerName  = document.getElementById("caller-name");
  const overlayName = document.getElementById("overlay-name");

  // Controls
  const startSimBtn = document.getElementById("start-sim-call");
  const endCallBtn  = document.getElementById("end-call");
  const acceptBtn   = document.getElementById("accept-call");

  // Media/UX
  const callAudio = document.getElementById("call-audio");
  const recBadge  = document.getElementById("rec-badge");
  const dontRecordCb = document.getElementById("no-record");

  // Discreet feedback
  const recAria  = document.getElementById("rec-aria");
  const recToast = document.getElementById("rec-toast");
  const recChime = document.getElementById("rec-chime"); // optional

  // Robust status handle: prefer #call-status, else first <p> in the call box
  const callStatus =
    document.getElementById("call-status") ||
    document.querySelector("#call-overlay .call-box p");

  // State
  let currentName = "Emergency Contact";
  let collapseTimeout, activeTimeout;
  let callState = "idle"; // "idle" | "incoming" | "active"

  // Recording state
  let mediaStream = null;
  let mediaRecorder = null;
  let recChunks = [];
  let isRecording = false;
  let callStartAt = null;

  // Namespaced emergency-call End class (avoid collisions)
  const EC_END_CLASS = "ec-end";

  // --- UI state helper ---
  function updateCallUI(state) {
    // state: "incoming" | "active" | "ended"
    if (state === "incoming") {
      // show Accept + Decline; hide rec pill; set status
      acceptBtn?.classList.remove("hidden");
      endCallBtn?.classList.remove("hidden");

      // reset End styling/text to Decline
      endCallBtn?.classList.remove(EC_END_CLASS);
      endCallBtn?.setAttribute("aria-label", "Decline");
      const endTxt = endCallBtn?.querySelector(".txt");
      if (endTxt) endTxt.textContent = "Decline";

      recBadge?.classList.add("hidden");
      if (callStatus) callStatus.textContent = "Incoming call...";
    } else if (state === "active") {
      // hide Accept; style button as End; show rec pill; set status
      acceptBtn?.classList.add("hidden");

      endCallBtn?.classList.add(EC_END_CLASS);
      endCallBtn?.setAttribute("aria-label", "End");
      const endTxt = endCallBtn?.querySelector(".txt");
      if (endTxt) endTxt.textContent = "End";

      recBadge?.classList.remove("hidden");
      if (callStatus) callStatus.textContent = "In call";
    } else {
      // ended / reset to initial state
      acceptBtn?.classList.remove("hidden");
      recBadge?.classList.add("hidden");

      endCallBtn?.classList.remove(EC_END_CLASS);
      endCallBtn?.setAttribute("aria-label", "Decline");
      const endTxt = endCallBtn?.querySelector(".txt");
      if (endTxt) endTxt.textContent = "Decline";
    }
  }

  // --- Helpers ---
  const showToast = (msg, ms = 1600) => {
    if (!recToast) return;
    recToast.textContent = msg;
    recToast.setAttribute("aria-hidden", "false");
    recToast.classList.add("is-show");
    setTimeout(() => {
      recToast.classList.remove("is-show");
      recToast.setAttribute("aria-hidden", "true");
    }, ms);
  };

  const announce = (msg) => { if (recAria) recAria.textContent = msg; };

  const playChime = () => {
    if (!recChime) return;
    try { recChime.currentTime = 0; recChime.play(); } catch {}
  };

  const fileNameForNow = (prefix = "emergency-recording") => {
    const t = new Date().toISOString().replace(/[:.]/g, "-");
    const who = (overlayName?.textContent || "contact").trim() || "contact";
    return `${prefix}_${who}_${t}.webm`;
  };

  const pickAudioMime = () => {
    const prefs = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
    for (const t of prefs) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(t)) return t;
    }
    return "";
  };

  // --- Panel behavior ---
  fabBtn?.addEventListener("click", () => {
    fabPanel?.classList.remove("hidden");
    clearTimeout(collapseTimeout);
    collapseTimeout = setTimeout(() => fabPanel?.classList.add("hidden"), 10000);
  });
  closePanel?.addEventListener("click", () => fabPanel?.classList.add("hidden"));
  callerName?.addEventListener("input", (e) => { currentName = e.target.value; });

  // --- Recording ---
  async function startRecording() {
    if (isRecording) return;
    try {
      if (!mediaStream) {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      }
      recChunks = [];
      const mime = pickAudioMime();
      mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const type = mediaRecorder?.mimeType || "audio/webm";
        const blob = new Blob(recChunks, { type });
        const url  = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = fileNameForNow();
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);

        const durSec = callStartAt ? Math.round((Date.now() - callStartAt) / 1000) : null;
        showToast(durSec ? `Recording saved (${durSec}s)` : "Recording saved");
      };

      mediaRecorder.start(1000);
      isRecording = true;
      // visual pill handled by updateCallUI('active')
      playChime();
      announce("Recording started");
      showToast("Recording started");
    } catch (err) {
      console.warn("Recording error:", err);
      announce("Recording unavailable");
      showToast("Recording unavailable");
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    try { mediaRecorder?.stop(); } catch {}
    isRecording = false;
    recBadge?.classList.add("hidden");
  }

  // --- Call flow ---
  function startCall() {
    fabPanel?.classList.add("hidden");
    overlay?.classList.remove("hidden");
    if (overlayName) overlayName.textContent = currentName;

    callState = "incoming";
    updateCallUI("incoming");

    if (callAudio) {
      callAudio.currentTime = 0;
      callAudio.loop = true;
      callAudio.play().catch(() => {});
    }

    clearTimeout(activeTimeout);
    activeTimeout = setTimeout(() => {
      if (callState === "incoming") endCall(); // missed call
    }, 30000);
  }

  function acceptCall() {
    if (callState !== "incoming") return;

    if (callAudio) { callAudio.pause(); callAudio.currentTime = 0; }

    callState = "active";
    callStartAt = Date.now();
    updateCallUI("active");
    announce("Call accepted");

    if (!dontRecordCb?.checked) startRecording();
  }

  function endCall() {
    overlay?.classList.add("hidden");
    if (callAudio) { callAudio.pause(); callAudio.currentTime = 0; }
    stopRecording();
    clearTimeout(activeTimeout);
    callState = "idle";
    callStartAt = null;
    updateCallUI("ended");
  }

  // --- Listeners ---
  startSimBtn?.addEventListener("click", startCall);
  endCallBtn?.addEventListener("click", endCall);
  acceptBtn?.addEventListener("click", acceptCall);

  overlay?.addEventListener("click", (e) => {
    if (!e.target.closest(".call-box")) endCall();
  });

  window.addEventListener("beforeunload", () => {
    try { stopRecording(); } catch {}
    try { mediaStream?.getTracks?.().forEach(t => t.stop()); } catch {}
    clearTimeout(collapseTimeout);
    clearTimeout(activeTimeout);
  });
});
