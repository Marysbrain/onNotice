// Shared one tap copy handler for the distribution kit copy blocks and the
// citation strings. Delegated so any number of copy targets work with one
// listener. No tracking, no network, clipboard only.

function findText(btn: HTMLElement): string {
  const sel = btn.getAttribute("data-copy-target");
  if (sel) {
    const el = document.querySelector(sel);
    if (el) return (el as HTMLElement).innerText.trim();
  }
  return btn.getAttribute("data-copy") ?? "";
}

async function copy(text: string, status: HTMLElement | null) {
  try {
    await navigator.clipboard.writeText(text);
    if (status) status.textContent = "Copied.";
  } catch {
    if (status) status.textContent = "Copy failed. Select the text and copy it.";
  }
  if (status) {
    window.setTimeout(() => {
      status.textContent = "";
    }, 4000);
  }
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const btn = target.closest<HTMLElement>("[data-copy], [data-copy-target]");
  if (!btn) return;
  e.preventDefault();
  const statusSel = btn.getAttribute("data-copy-status");
  const status = statusSel
    ? document.querySelector<HTMLElement>(statusSel)
    : null;
  void copy(findText(btn), status);
});
