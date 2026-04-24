const POLL_INTERVAL_MS = 3000;

// Read target from URL hash
const target = (location.hash || "").replace(/^#/, "") || new URLSearchParams(location.search).get("target") || "";
const inner = document.getElementById("inner") as HTMLIFrameElement;
const status = document.getElementById("status")!;

function loadTarget() {
  status.style.display = "none";
  inner.style.display = "block";
  inner.src = target;
  try { parent.postMessage({ type: "sidepanel-probe", ok: true }, "*"); } catch (_) {}
}

function showInitial() {
  status.innerHTML = `
    <svg class="icon-empty" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="9" y1="3" x2="9" y2="21"/>
    </svg>
    <span>Enter a URL above and press Go</span>
  `;
}

function showError() {
  let portInfo = "";
  try {
    const url = new URL(target);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    portInfo = `<span style="color:#999;font-size:11px">Target: ${url.hostname}:${port}</span>`;
  } catch (_) {
    portInfo = `<span style="color:#999;font-size:11px">Target: ${target}</span>`;
  }
  status.innerHTML = `
    <svg class="icon-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="12" cy="12" r="10"/>
      <line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
    <span class="error-text">Failed to load page.<br>Service may not be running.</span>
    ${portInfo}
    <div style="display:flex;align-items:center;gap:6px;color:#999;font-size:12px">
      <span class="spinner"></span>
      <span>Waiting for service...</span>
    </div>
    <button class="btn-start" id="btnStart">Start Local Service</button>
  `;
  document.getElementById("btnStart")!.addEventListener("click", () => {
    try { parent.postMessage({ type: "sidepanel-action", action: "open-opencode" }, "*"); } catch (_) {}
  });
  try { parent.postMessage({ type: "sidepanel-probe", ok: false }, "*"); } catch (_) {}
}

function probe() {
  fetch(target, { method: "HEAD", cache: "no-store" })
    .then(() => loadTarget())
    .catch(() => {
      showError();
      setTimeout(probe, POLL_INTERVAL_MS);
    });
}

// Init
if (!target) {
  showInitial();
} else {
  status.innerHTML = '<span class="spinner"></span><span>Loading...</span>';
  setTimeout(probe, 500);
}
