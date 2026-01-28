import { MarkdownView, Plugin, TFile } from "obsidian";

type CleanupFn = () => void;

// Breakpoints for sidenote behavior (in pixels of EDITOR width)
const SIDENOTE_HIDE_BELOW = 900; // Hide sidenotes entirely
const SIDENOTE_COMPACT_BELOW = 1100; // Use compact/narrow sidenotes
const SIDENOTE_FULL_ABOVE = 1400; // Full-width sidenotes

export default class SidenoteCollisionAvoider extends Plugin {
	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];
	private cmRoot: HTMLElement | null = null;
	private isMutating = false;
	private resizeObserver: ResizeObserver | null = null;

	async onload() {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.rebindAndSchedule(),
			),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () =>
				this.rebindAndSchedule(),
			),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (_file: TFile | null) =>
				this.rebindAndSchedule(),
			),
		);
		// Window resize still useful for edge cases
		this.registerDomEvent(window, "resize", () => this.scheduleLayout());

		this.rebindAndSchedule();
	}

	onunload() {
		this.cancelScheduled();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cmRoot = view?.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			cmRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((n) => n.remove());
			cmRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			cmRoot.style.removeProperty("--editor-width");
			cmRoot.style.removeProperty("--sidenote-mode");
			cmRoot.dataset.sidenoteMode = "";
		}
	}

	private cancelScheduled() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	private scheduleLayout() {
		this.cancelScheduled();
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.layout();
		});
	}

	private rebindAndSchedule() {
		this.rebind();
		this.scheduleLayout();
	}

	private rebind() {
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const root = view.containerEl;
		const cmRoot = root.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (!cmRoot) return;

		this.cmRoot = cmRoot;

		// Use ResizeObserver on the editor container for instant response
		this.resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target === cmRoot) {
					this.scheduleLayout();
				}
			}
		});
		this.resizeObserver.observe(cmRoot);

		const scroller = cmRoot.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return;

		const onScroll = () => this.scheduleLayout();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		this.cleanups.push(() =>
			scroller.removeEventListener("scroll", onScroll),
		);

		const content = cmRoot.querySelector<HTMLElement>(".cm-content");
		if (content) {
			const mo = new MutationObserver(() => {
				if (this.isMutating) return;
				this.scheduleLayout();
			});
			mo.observe(content, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			this.cleanups.push(() => mo.disconnect());
		}
	}

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) return;

		const cmRootRect = cmRoot.getBoundingClientRect();
		const editorWidth = cmRootRect.width;

		// Set CSS variables for width-based calculations
		cmRoot.style.setProperty("--editor-width", `${editorWidth}px`);

		// Determine sidenote mode based on editor width
		let mode: "hidden" | "compact" | "normal" | "full";
		if (editorWidth < SIDENOTE_HIDE_BELOW) {
			mode = "hidden";
		} else if (editorWidth < SIDENOTE_COMPACT_BELOW) {
			mode = "compact";
		} else if (editorWidth < SIDENOTE_FULL_ABOVE) {
			mode = "normal";
		} else {
			mode = "full";
		}

		// Set mode as data attribute for CSS to use
		cmRoot.dataset.sidenoteMode = mode;

		// Calculate a scale factor (0-1) for smooth interpolation
		// This allows CSS to smoothly scale between breakpoints
		let scaleFactor = 0;
		if (editorWidth >= SIDENOTE_HIDE_BELOW) {
			scaleFactor = Math.min(
				1,
				(editorWidth - SIDENOTE_HIDE_BELOW) /
					(SIDENOTE_FULL_ABOVE - SIDENOTE_HIDE_BELOW),
			);
		}
		cmRoot.style.setProperty("--sidenote-scale", scaleFactor.toFixed(3));

		// Find all sidenote spans that are NOT already wrapped
		const spans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) =>
				!span.parentElement?.classList.contains("sidenote-number"),
		);

		if (spans.length === 0) {
			const existingMargins = Array.from(
				cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			);
			if (existingMargins.length > 0 && mode !== "hidden") {
				this.avoidCollisions(existingMargins, 8);
			}
			return;
		}

		// Don't create sidenotes if hidden
		if (mode === "hidden") {
			return;
		}

		// Sort by visual position
		const ordered = spans
			.map((el) => ({ el, rect: el.getBoundingClientRect() }))
			.sort((a, b) => a.rect.top - b.rect.top);

		const existingWrappers = cmRoot.querySelectorAll(".sidenote-number");
		let n = existingWrappers.length + 1;

		const marginNotes: HTMLElement[] = [];

		this.isMutating = true;
		try {
			for (const { el: span } of ordered) {
				const num = String(n++);

				const wrapper = document.createElement("span");
				wrapper.className = "sidenote-number";
				wrapper.dataset.sidenoteNum = num;

				const margin = document.createElement("small");
				margin.className = "sidenote-margin";
				margin.dataset.sidenoteNum = num;

				const raw = this.normalizeText(span.textContent ?? "");
				margin.appendChild(this.renderMarkdownLinksToFragment(raw));

				span.parentNode?.insertBefore(wrapper, span);
				wrapper.appendChild(span);
				wrapper.appendChild(margin);

				marginNotes.push(margin);
			}
		} finally {
			this.isMutating = false;
		}

		const allMargins = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);
		if (allMargins.length > 0) {
			this.avoidCollisions(allMargins, 8);
		}
	}

	private normalizeText(s: string): string {
		return (s ?? "").replace(/\s+/g, " ").trim();
	}

	private renderMarkdownLinksToFragment(text: string): DocumentFragment {
		const frag = document.createDocumentFragment();
		const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;

		let last = 0;
		let m: RegExpExecArray | null;

		while ((m = re.exec(text)) !== null) {
			const [full, label, urlRaw] = m;
			const start = m.index;

			if (start > last)
				frag.appendChild(
					document.createTextNode(text.slice(last, start)),
				);

			const url = urlRaw.trim();
			const isSafe =
				url.startsWith("http://") ||
				url.startsWith("https://") ||
				url.startsWith("mailto:");

			if (isSafe) {
				const a = document.createElement("a");
				a.textContent = label;
				a.href = url;
				a.rel = "noopener noreferrer";
				a.target = "_blank";
				frag.appendChild(a);
			} else {
				frag.appendChild(document.createTextNode(full));
			}

			last = start + full.length;
		}

		if (last < text.length)
			frag.appendChild(document.createTextNode(text.slice(last)));

		return frag;
	}

	private avoidCollisions(nodes: HTMLElement[], spacing: number) {
		for (const sn of nodes) sn.style.setProperty("--sidenote-shift", "0px");

		const measured = nodes
			.map((el) => ({ el, rect: el.getBoundingClientRect() }))
			.sort((a, b) => a.rect.top - b.rect.top);

		let bottom = -Infinity;

		for (const { el, rect } of measured) {
			const desiredTop = rect.top;
			const minTop = bottom === -Infinity ? desiredTop : bottom + spacing;
			const actualTop = Math.max(desiredTop, minTop);

			const shift = actualTop - desiredTop;
			if (shift > 0.5)
				el.style.setProperty("--sidenote-shift", `${shift}px`);

			bottom = actualTop + rect.height;
		}
	}
}
