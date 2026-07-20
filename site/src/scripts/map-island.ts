// Map island. The only client JavaScript on the site. It enhances the server
// rendered SVG choropleth: keyboard navigation, flame toggle, carrier and time
// filters, a drill down side panel, and all view state kept in the URL.
//
// Hard rule honored here: the choropleth is the FCC layer, wireless billing
// complaint concentration for all carriers. The carrier filter never recolors
// it. Carrier only filters the records shown in the drill down panel, which are
// the carrier tagged layer.

interface PanelRecord {
  slug: string;
  title: string;
  carrier: string | null;
  claimType: string;
  state: string | null;
  eventDate: string;
  vetting: string;
}

interface MapData {
  records: PanelRecord[];
  stateNames: Record<string, string>;
  stateCounts: Record<string, number>;
}

const root = document.getElementById("map-root");
const dataEl = document.getElementById("map-data");
if (root && dataEl) {
  const data = JSON.parse(dataEl.textContent || "{}") as MapData;
  init(root, data);
}

function init(root: HTMLElement, data: MapData) {
  const svg = root.querySelector<SVGSVGElement>("svg.us-map");
  const paths = Array.from(
    root.querySelectorAll<SVGPathElement>("path.state")
  );
  const flameLayer = root.querySelector<SVGGElement>("#flame-layer");
  const flames = Array.from(
    root.querySelectorAll<SVGGElement>(".flame")
  );
  const flameToggle = root.querySelector<HTMLInputElement>("#flame-toggle");
  const carrierSel = root.querySelector<HTMLSelectElement>("#carrier-filter");
  const timeSel = root.querySelector<HTMLSelectElement>("#time-filter");
  const resetBtn = root.querySelector<HTMLButtonElement>("#reset-view");
  const panel = root.querySelector<HTMLElement>("#drill-panel");
  const panelBody = root.querySelector<HTMLElement>("#drill-body");
  const panelClose = root.querySelector<HTMLButtonElement>("#drill-close");

  const params = new URLSearchParams(window.location.search);

  function writeUrl() {
    const qs = params.toString();
    const url = qs ? `?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }

  // Flame toggle. Default on. Persisted in the URL like every other map state.
  function applyFlames() {
    const on = params.get("flames") !== "off";
    if (flameToggle) flameToggle.checked = on;
    if (flameLayer) flameLayer.style.display = on ? "" : "none";
  }
  flameToggle?.addEventListener("change", () => {
    if (flameToggle.checked) params.delete("flames");
    else params.set("flames", "off");
    applyFlames();
    writeUrl();
  });

  // Filters. Carrier and time change only the records listed in the panel.
  function syncFilterControls() {
    if (carrierSel) carrierSel.value = params.get("carrier") || "";
    if (timeSel) timeSel.value = params.get("time") || "";
  }
  carrierSel?.addEventListener("change", () => {
    if (carrierSel.value) params.set("carrier", carrierSel.value);
    else params.delete("carrier");
    writeUrl();
    refreshPanel();
  });
  timeSel?.addEventListener("change", () => {
    if (timeSel.value) params.set("time", timeSel.value);
    else params.delete("time");
    writeUrl();
    refreshPanel();
  });

  function matchTime(eventDate: string): boolean {
    const time = params.get("time");
    if (!time) return true;
    // time is a year like 2014 or 2026. Match the leading year of eventDate.
    return eventDate.slice(0, 4) === time;
  }

  function recordsFor(abbr: string): PanelRecord[] {
    const carrier = params.get("carrier");
    return data.records.filter((r) => {
      if (r.state && r.state !== abbr) return false;
      // National scope records (state null) show on any selection as context.
      if (carrier && r.carrier !== carrier) return false;
      if (!matchTime(r.eventDate)) return false;
      return true;
    });
  }

  function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
    );
  }

  function openPanel(abbr: string) {
    if (!panel || !panelBody) return;
    params.set("state", abbr);
    writeUrl();
    paths.forEach((p) =>
      p.setAttribute(
        "aria-pressed",
        p.dataset.abbr === abbr ? "true" : "false"
      )
    );
    renderPanel(abbr);
    panel.hidden = false;
    panelClose?.focus();
  }

  function refreshPanel() {
    const abbr = params.get("state");
    if (abbr && panel && !panel.hidden) renderPanel(abbr);
  }

  function renderPanel(abbr: string) {
    if (!panelBody) return;
    const name = data.stateNames[abbr] || abbr;
    const count = data.stateCounts[abbr] || 0;
    const recs = recordsFor(abbr);
    const carrier = params.get("carrier");
    const carrierNote = carrier
      ? ` Filtered to carrier: ${esc(carrier)}.`
      : "";
    let html = `<h3>${esc(name)} <span class="sample-badge">SAMPLE</span></h3>`;
    html += `<p><strong>${count}</strong> wireless billing complaints in the FCC layer for ${esc(
      name
    )}. This is complaint concentration for all carriers. The FCC dataset has no carrier name field.</p>`;
    html += `<h4>Sourced records${carrierNote ? "" : ""}</h4>`;
    if (recs.length === 0) {
      html += `<p>No sample records match the current filters for this area.${carrierNote}</p>`;
    } else {
      html += `<ul class="panel-records">`;
      for (const r of recs) {
        const car = r.carrier ? esc(r.carrier) : "no carrier on source";
        html += `<li><a href="/library/${esc(
          r.slug
        )}">${esc(r.title)}</a><br><span class="hint">${esc(
          r.claimType
        )} | ${car} | ${esc(r.vetting.replace("_", " "))} | ${esc(
          r.eventDate
        )}</span></li>`;
      }
      html += `</ul>`;
    }
    html += `<p class="hint">Every row links to its evidence record and citation. No dead ends.</p>`;
    panelBody.innerHTML = html;
  }

  function closePanel() {
    if (!panel) return;
    panel.hidden = true;
    params.delete("state");
    writeUrl();
    paths.forEach((p) => p.setAttribute("aria-pressed", "false"));
  }
  panelClose?.addEventListener("click", closePanel);

  // Click and keyboard on states.
  function wireGeo(el: Element) {
    const abbr = (el as HTMLElement).dataset.abbr;
    if (!abbr) return;
    el.addEventListener("click", () => openPanel(abbr));
    el.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPanel(abbr);
      }
    });
  }
  paths.forEach(wireGeo);
  flames.forEach(wireGeo);

  // Arrow keys move focus between states in document order.
  function moveFocus(current: Element, dir: number) {
    const idx = paths.indexOf(current as SVGPathElement);
    if (idx < 0) return;
    const next = paths[(idx + dir + paths.length) % paths.length];
    next.focus();
  }
  paths.forEach((p) => {
    p.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        moveFocus(p, 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(p, -1);
      }
    });
  });

  // Escape closes the panel from anywhere in the map.
  root.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Escape" && panel && !panel.hidden) {
      closePanel();
    }
  });

  resetBtn?.addEventListener("click", () => {
    for (const k of ["carrier", "time", "state", "flames"]) params.delete(k);
    writeUrl();
    syncFilterControls();
    applyFlames();
    closePanel();
  });

  // Restore full view state from the URL on load.
  applyFlames();
  syncFilterControls();
  const restoreState = params.get("state");
  if (restoreState && data.stateNames[restoreState]) {
    renderPanel(restoreState);
    if (panel) panel.hidden = false;
    paths.forEach((p) =>
      p.setAttribute(
        "aria-pressed",
        p.dataset.abbr === restoreState ? "true" : "false"
      )
    );
  }

  void svg;
}
