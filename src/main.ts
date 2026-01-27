import { MarkdownView, Plugin, TFile } from "obsidian";

type CleanupFn = () => void;

export default class SidenoteCollisionAvoider extends Plugin {
	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];

	private cmRoot: HTMLElement | null = null;
	private isMutating = false;

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
		this.registerDomEvent(window, "resize", () => this.scheduleLayout());

		this.rebindAndSchedule();
	}

	onunload() {
		this.cancelScheduled();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];
		this.deactivateCssGate();
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		view?.containerEl
			.querySelectorAll(".sidenote-overlay")
			.forEach((n) => n.remove());
		view?.containerEl
			.querySelectorAll("sup.sidenote-ref")
			.forEach((n) => n.remove());
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

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const root = view.containerEl;
		const cmRoot = root.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (!cmRoot) return;

		this.cmRoot = cmRoot;

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

	private activateCssGate(cmRoot: HTMLElement) {
		cmRoot.classList.add("sidenotes-active");
		console.log("✓ Sidenotes activated");
	}

	private deactivateCssGate() {
		this.cmRoot?.classList.remove("sidenotes-active");
		console.log("✗ Sidenotes deactivated");
	}

	private getScrollerAndOverlay(
		cmRoot: HTMLElement,
	): { scroller: HTMLElement; overlay: HTMLElement } | null {
		const scroller = cmRoot.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return null;

		let overlay = scroller.querySelector<HTMLElement>(".sidenote-overlay");
		if (!overlay) {
			overlay = document.createElement("div");
			overlay.className = "sidenote-overlay";
			overlay.setAttribute("contenteditable", "false");
			overlay.setAttribute("aria-hidden", "true");
			scroller.appendChild(overlay);
		}

		return { scroller, overlay };
	}

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) return;

		const so = this.getScrollerAndOverlay(cmRoot);
		if (!so) return;

		const { scroller, overlay } = so;

		// Keep overlay sized to full scroll height
		overlay.style.position = "absolute";
		overlay.style.top = "0";
		overlay.style.left = "0";
		overlay.style.width = "100%";
		overlay.style.height = `${scroller.scrollHeight}px`;
		overlay.style.pointerEvents = "none";
		overlay.style.zIndex = "1000";

		scroller.style.position = "relative";

		// Clear overlay + markers
		this.isMutating = true;
		try {
			overlay.replaceChildren();
			cmRoot
				.querySelectorAll("sup.sidenote-ref")
				.forEach((n) => n.remove());
		} finally {
			this.isMutating = false;
		}

		const spans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		);

		console.log(`Found ${spans.length} sidenote spans`);

		if (spans.length === 0) {
			this.deactivateCssGate();
			return;
		}

		// Respect breakpoint
		const mediaQuery = window.matchMedia("(min-width: 1300px)");
		console.log(
			`Media query (min-width: 1300px): ${mediaQuery.matches}, window width: ${window.innerWidth}px`,
		);

		if (!mediaQuery.matches) {
			this.deactivateCssGate();
			return;
		}

		const ordered = spans
			.map((el) => ({ el, rect: el.getBoundingClientRect() }))
			.sort((a, b) => a.rect.top - b.rect.top);

		const scrollerRect = scroller.getBoundingClientRect();

		// Find body text left edge
		const sizer =
			cmRoot.querySelector<HTMLElement>(".cm-sizer") ??
			cmRoot.querySelector<HTMLElement>(".cm-contentContainer");

		if (!sizer) {
			console.log("✗ No sizer found");
			this.deactivateCssGate();
			return;
		}

		const sizerRect = sizer.getBoundingClientRect();

		// Body left edge relative to scroller
		const bodyLeftRelativeToScroller = sizerRect.left - scrollerRect.left;

		// Body left edge relative to viewport (where it actually is on screen)
		const bodyLeftAbsolute = sizerRect.left;

		// Scroller left edge relative to viewport
		const scrollerLeftAbsolute = scrollerRect.left;

		console.log(`Scroller left (absolute): ${scrollerLeftAbsolute}px`);
		console.log(`Body left (absolute): ${bodyLeftAbsolute}px`);
		console.log(
			`Body left (relative to scroller): ${bodyLeftRelativeToScroller}px`,
		);

		// Read CSS variables
		const gapPx = this.readCssVarPx(cmRoot, "--sidenote-gap", 2.25 * 16);
		const preferredWidthPx = this.readCssVarPx(
			cmRoot,
			"--sidenote-width",
			18 * 16,
		);
		const minWidthPx = this.readCssVarPx(
			cmRoot,
			"--sidenote-min-width",
			12 * 16,
		);
		const maxWidthPx = this.readCssVarPx(
			cmRoot,
			"--sidenote-max-width",
			24 * 16,
		);

		console.log(
			`CSS vars - Gap: ${gapPx}px, Preferred: ${preferredWidthPx}px, Min: ${minWidthPx}px, Max: ${maxWidthPx}px`,
		);

		// Calculate space available to the LEFT of the body text
		// This is from the left edge of the scroller to where the body starts
		const spaceLeftOfBody = bodyLeftAbsolute - scrollerLeftAbsolute;

		console.log(`Space left of body: ${spaceLeftOfBody}px`);

		// Available space for sidenotes (excluding the gap)
		const minLeftMargin = 8;
		const availableSpace = spaceLeftOfBody - gapPx - minLeftMargin;

		console.log(
			`Available space for sidenotes: ${availableSpace}px (need minimum ${minWidthPx}px)`,
		);

		// If not enough space for minimum width, don't show sidenotes
		if (availableSpace < minWidthPx) {
			console.log(
				`✗ Not enough space: need ${minWidthPx}px, have ${availableSpace}px`,
			);
			this.deactivateCssGate();
			return;
		}

		// Calculate actual width: start with preferred, but constrain by available space
		let sidenoteWidth = preferredWidthPx;

		// Constrain to available space
		if (sidenoteWidth > availableSpace) {
			sidenoteWidth = availableSpace;
		}

		// Allow growing to max if space permits
		if (availableSpace > preferredWidthPx && availableSpace <= maxWidthPx) {
			sidenoteWidth = availableSpace;
		} else if (availableSpace > maxWidthPx) {
			sidenoteWidth = maxWidthPx;
		}

		// Enforce minimum
		sidenoteWidth = Math.max(minWidthPx, sidenoteWidth);

		// Position sidenotes: right-align them to maintain fixed gap from body
		const sidenoteLeft = bodyLeftRelativeToScroller - gapPx - sidenoteWidth;

		console.log(
			`Calculated sidenote width: ${sidenoteWidth}px, left position: ${sidenoteLeft}px`,
		);

		let n = 1;
		const marginNodes: HTMLElement[] = [];

		this.isMutating = true;
		try {
			for (const { el: sn, rect } of ordered) {
				const num = String(n++);

				// Sup marker
				const sup = document.createElement("sup");
				sup.className = "sidenote-ref";
				sup.textContent = num;
				sn.insertAdjacentElement("afterend", sup);

				// Margin note
				const margin = document.createElement("small");
				margin.className = "sidenote-margin";
				margin.dataset.sidenoteNum = num;
				margin.setAttribute("contenteditable", "false");

				const y = rect.top - scrollerRect.top + scroller.scrollTop + 2;

				margin.style.left = `${sidenoteLeft}px`;
				margin.style.top = `${y}px`;
				margin.style.position = "absolute";
				margin.style.width = `${sidenoteWidth}px`;
				margin.style.pointerEvents = "auto";
				margin.style.zIndex = "1001";

				const raw = this.normalizeText(sn.textContent ?? "");
				margin.appendChild(this.renderMarkdownLinksToFragment(raw));

				overlay.appendChild(margin);
				marginNodes.push(margin);

				sn.dataset.sidenoteNum = num;
			}
			console.log(`✓ Created ${marginNodes.length} margin notes`);
		} finally {
			this.isMutating = false;
		}

		// Activate CSS gate and avoid collisions
		this.activateCssGate(cmRoot);
		this.avoidCollisions(marginNodes, 8);
	}

	private readCssVarPx(
		cmRoot: HTMLElement,
		name: string,
		fallbackPx: number,
	): number {
		const read = (n: string): string => {
			const v1 = getComputedStyle(cmRoot).getPropertyValue(n).trim();
			if (v1) return v1;
			return getComputedStyle(document.documentElement)
				.getPropertyValue(n)
				.trim();
		};

		const toPx = (raw: string, fallback: number): number => {
			const px = /^(\d+(?:\.\d+)?)px$/.exec(raw);
			if (px) return Number(px[1]);

			const rem = /^(\d+(?:\.\d+)?)rem$/.exec(raw);
			if (rem) {
				const rootFont =
					parseFloat(
						getComputedStyle(document.documentElement).fontSize,
					) || 16;
				return Number(rem[1]) * rootFont;
			}

			return fallback;
		};

		const raw = read(name);
		if (!raw) return fallbackPx;
		return toPx(raw, fallbackPx);
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
