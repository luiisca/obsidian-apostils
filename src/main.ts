import {
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	App,
} from "obsidian";

type CleanupFn = () => void;

// Settings interface
interface SidenoteSettings {
	// Display
	sidenotePosition: "left" | "right";
	showSidenoteNumbers: boolean;
	numberStyle: "arabic" | "roman" | "letters";

	// Width & Spacing
	minSidenoteWidth: number;
	maxSidenoteWidth: number;
	sidenoteGap: number;

	// Breakpoints
	hideBelow: number;
	compactBelow: number;
	fullAbove: number;

	// Typography
	fontSize: number;
	fontSizeCompact: number;
	lineHeight: number;
	textAlignment: "left" | "right" | "justify";

	// Behavior
	collisionSpacing: number;
	enableTransitions: boolean;
	resetNumberingPerHeading: boolean;
}

const DEFAULT_SETTINGS: SidenoteSettings = {
	// Display
	sidenotePosition: "left",
	showSidenoteNumbers: true,
	numberStyle: "arabic",

	// Width & Spacing
	minSidenoteWidth: 10,
	maxSidenoteWidth: 18,
	sidenoteGap: 2,

	// Breakpoints
	hideBelow: 700,
	compactBelow: 900,
	fullAbove: 1400,

	// Typography
	fontSize: 80,
	fontSizeCompact: 70,
	lineHeight: 1.35,
	textAlignment: "right",

	// Behavior
	collisionSpacing: 8,
	enableTransitions: true,
	resetNumberingPerHeading: false,
};

// Regex to detect sidenote spans in source text
const SIDENOTE_PATTERN = /<span\s+class\s*=\s*["']sidenote["'][^>]*>/gi;

export default class SidenotePlugin extends Plugin {
	settings: SidenoteSettings;

	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];
	private cmRoot: HTMLElement | null = null;
	private isMutating = false;
	private resizeObserver: ResizeObserver | null = null;
	private styleEl: HTMLStyleElement | null = null;

	// Map from sidenote text content (or position) to assigned number
	private sidenoteRegistry: Map<string, number> = new Map();
	private nextSidenoteNumber = 1;
	private headingSidenoteNumbers: Map<string, number> = new Map();

	// Track whether current document has any sidenotes
	private documentHasSidenotes = false;

	async onload() {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new SidenoteSettingTab(this.app, this));

		// Inject dynamic styles
		this.injectStyles();

		// Register post-processor for reading mode
		this.registerMarkdownPostProcessor((element, context) => {
			const sidenoteSpans =
				element.querySelectorAll<HTMLElement>("span.sidenote");
			if (sidenoteSpans.length > 0) {
				requestAnimationFrame(() => {
					this.processReadingModeSidenotes(element);
				});
			}
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.resetRegistry();
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () =>
				this.rebindAndSchedule(),
			),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (_file: TFile | null) => {
				this.resetRegistry();
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				this.scanDocumentForSidenotes();
				this.scheduleLayout();
			}),
		);
		this.registerDomEvent(window, "resize", () => {
			this.scheduleLayout();
			this.scheduleReadingModeLayout();
		});

		this.scanDocumentForSidenotes();
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

		// Remove injected styles
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
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
			cmRoot.style.removeProperty("--sidenote-scale");
			cmRoot.dataset.sidenoteMode = "";
			cmRoot.dataset.hasSidenotes = "";
			cmRoot.dataset.sidenotePosition = "";
		}

		const readingRoot = view?.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((n) => n.remove());
			readingRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			readingRoot.style.removeProperty("--editor-width");
			readingRoot.style.removeProperty("--sidenote-scale");
			readingRoot.dataset.sidenoteMode = "";
			readingRoot.dataset.hasSidenotes = "";
			readingRoot.dataset.sidenotePosition = "";
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.injectStyles();
		// Update position data attributes on existing roots
		this.updatePositionDataAttributes();
		this.scheduleLayout();
		this.scheduleReadingModeLayout();
	}

	/**
	 * Update the position data attribute on view roots
	 */
	private updatePositionDataAttributes() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
		}
	}

	/**
	 * Inject dynamic CSS based on settings
	 */
	private injectStyles() {
		if (this.styleEl) {
			this.styleEl.remove();
		}

		this.styleEl = document.createElement("style");
		this.styleEl.id = "sidenote-plugin-styles";

		const s = this.settings;
		const transitionRule = s.enableTransitions
			? "transition: width 0.15s ease-out, left 0.15s ease-out, right 0.15s ease-out, opacity 0.15s ease-out;"
			: "";

		// Default text alignment based on position
		const defaultAlignment =
			s.sidenotePosition === "left" ? "right" : "left";
		const textAlign =
			s.textAlignment === "justify"
				? "justify"
				: s.textAlignment === "left" || s.textAlignment === "right"
					? s.textAlignment
					: defaultAlignment;

		this.styleEl.textContent = `
			/* === Sidenote layout variables === */
			.markdown-source-view.mod-cm6,
			.markdown-reading-view {
				--sidenote-base-width: ${s.minSidenoteWidth}rem;
				--sidenote-max-extra: ${s.maxSidenoteWidth - s.minSidenoteWidth}rem;
				
				--sidenote-width: calc(
					var(--sidenote-base-width) + 
					(var(--sidenote-max-extra) * var(--sidenote-scale, 0.5))
				);
				
				--sidenote-gap: ${s.sidenoteGap}rem;
				--page-offset: calc(var(--sidenote-width) + var(--sidenote-gap) + 0.5rem);
			}
			
			/* Mode-specific overrides */
			.markdown-source-view.mod-cm6[data-sidenote-mode="compact"],
			.markdown-reading-view[data-sidenote-mode="compact"] {
				--sidenote-base-width: ${Math.max(s.minSidenoteWidth - 2, 6)}rem;
				--sidenote-max-extra: ${Math.max((s.maxSidenoteWidth - s.minSidenoteWidth) / 2, 2)}rem;
				--sidenote-gap: ${Math.max(s.sidenoteGap - 1, 0.5)}rem;
			}
			
			.markdown-source-view.mod-cm6[data-sidenote-mode="full"],
			.markdown-reading-view[data-sidenote-mode="full"] {
				--sidenote-base-width: ${s.maxSidenoteWidth}rem;
				--sidenote-max-extra: 2rem;
				--sidenote-gap: ${s.sidenoteGap + 1}rem;
			}
			
			/* Allow margin overflow but keep vertical scrolling */
			.markdown-source-view.mod-cm6 .cm-scroller {
				overflow-y: auto !important;
				overflow-x: visible !important;
			}
			
			/* === LEFT POSITION: Sidenotes on left, text offset to the right === */
			
			/* Source view - left position */
			.markdown-source-view.mod-cm6[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="compact"] .cm-scroller,
			.markdown-source-view.mod-cm6[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="normal"] .cm-scroller,
			.markdown-source-view.mod-cm6[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="full"] .cm-scroller {
				padding-left: var(--page-offset) !important;
				padding-right: 0 !important;
			}
			
			/* Reading view - left position */
			.markdown-reading-view[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="compact"] .markdown-preview-sizer,
			.markdown-reading-view[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="normal"] .markdown-preview-sizer,
			.markdown-reading-view[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="full"] .markdown-preview-sizer {
				padding-left: var(--page-offset) !important;
				padding-right: 0 !important;
			}
			
			/* Sidenote margin positioning - left */
			.markdown-source-view.mod-cm6[data-sidenote-position="left"] .sidenote-margin,
			.markdown-reading-view[data-sidenote-position="left"] .sidenote-margin {
				left: calc(-1 * (var(--sidenote-width) + var(--sidenote-gap)));
				right: auto;
				text-align: ${textAlign};
			}
			
			/* === RIGHT POSITION: Sidenotes on right, text offset to the left === */
			
			/* Source view - right position */
			.markdown-source-view.mod-cm6[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="compact"] .cm-scroller,
			.markdown-source-view.mod-cm6[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="normal"] .cm-scroller,
			.markdown-source-view.mod-cm6[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="full"] .cm-scroller {
				padding-right: var(--page-offset) !important;
				padding-left: 0 !important;
			}
			
			/* Reading view - right position */
			.markdown-reading-view[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="compact"] .markdown-preview-sizer,
			.markdown-reading-view[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="normal"] .markdown-preview-sizer,
			.markdown-reading-view[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="full"] .markdown-preview-sizer {
				padding-right: var(--page-offset) !important;
				padding-left: 0 !important;
			}
			
			/* Sidenote margin positioning - right */
			.markdown-source-view.mod-cm6[data-sidenote-position="right"] .sidenote-margin,
			.markdown-reading-view[data-sidenote-position="right"] .sidenote-margin {
				right: calc(-1 * (var(--sidenote-width) + var(--sidenote-gap)));
				left: auto;
				text-align: ${textAlign};
			}
			
			/* Prevent clipping by CM layers */
			.markdown-source-view.mod-cm6 .cm-editor,
			.markdown-source-view.mod-cm6 .cm-content,
			.markdown-source-view.mod-cm6 .cm-sizer,
			.markdown-source-view.mod-cm6 .cm-contentContainer {
				overflow: visible !important;
			}
			
			/* Each line is the positioning context */
			.markdown-source-view.mod-cm6 .cm-line {
				position: relative;
			}
			
			/* Positioning context for reading mode */
			.markdown-reading-view p,
			.markdown-reading-view li,
			.markdown-reading-view h1,
			.markdown-reading-view h2,
			.markdown-reading-view h3,
			.markdown-reading-view h4,
			.markdown-reading-view h5,
			.markdown-reading-view h6,
			.markdown-reading-view blockquote,
			.markdown-reading-view .callout {
				position: relative;
			}
			
			/* Superscript number in the main text */
			.sidenote-number::after {
				content: ${s.showSidenoteNumbers ? "attr(data-sidenote-num)" : "none"};
				vertical-align: super;
				font-size: 0.7em;
				font-weight: bold;
				margin-right: 0.4rem;
			}
			
			/* Hide the original span content */
			.sidenote-number > span.sidenote {
				display: inline-block;
				width: 0;
				max-width: 0;
				overflow: hidden;
				white-space: nowrap;
				vertical-align: baseline;
			}
			
			/* Sidenote block in the margin - base styles */
			.sidenote-margin {
				position: absolute;
				top: 0.2em;
				width: var(--sidenote-width);
				font-size: ${s.fontSize}%;
				line-height: ${s.lineHeight};
				overflow-wrap: break-word;
				transform: translateY(var(--sidenote-shift, 0px));
				will-change: transform;
				z-index: 10;
				pointer-events: auto;
				${transitionRule}
			}
			
			/* Compact mode: smaller font */
			.markdown-source-view.mod-cm6[data-sidenote-mode="compact"] .sidenote-margin,
			.markdown-reading-view[data-sidenote-mode="compact"] .sidenote-margin {
				font-size: ${s.fontSizeCompact}%;
				line-height: ${Math.max(s.lineHeight - 0.1, 1.1)};
			}
			
			/* Number prefix inside the sidenote */
			.sidenote-margin[data-sidenote-num]::before {
				content: ${s.showSidenoteNumbers ? 'attr(data-sidenote-num) ". "' : "none"};
				font-weight: bold;
			}
			
			/* Hide sidenotes when mode is hidden */
			.markdown-source-view.mod-cm6[data-sidenote-mode="hidden"] .sidenote-margin,
			.markdown-reading-view[data-sidenote-mode="hidden"] .sidenote-margin {
				display: none;
			}
			
			/* Hide with opacity for smoother transitions */
			.markdown-source-view.mod-cm6[data-sidenote-mode=""] .sidenote-margin,
			.markdown-reading-view[data-sidenote-mode=""] .sidenote-margin {
				opacity: 0;
				pointer-events: none;
			}
		`;

		document.head.appendChild(this.styleEl);
	}

	/**
	 * Format a number according to the selected style
	 */
	private formatNumber(num: number): string {
		switch (this.settings.numberStyle) {
			case "roman":
				return this.toRoman(num);
			case "letters":
				return this.toLetters(num);
			case "arabic":
			default:
				return String(num);
		}
	}

	private toRoman(num: number): string {
		const romanNumerals: [number, string][] = [
			[1000, "m"],
			[900, "cm"],
			[500, "d"],
			[400, "cd"],
			[100, "c"],
			[90, "xc"],
			[50, "l"],
			[40, "xl"],
			[10, "x"],
			[9, "ix"],
			[5, "v"],
			[4, "iv"],
			[1, "i"],
		];
		let result = "";
		for (const [value, numeral] of romanNumerals) {
			while (num >= value) {
				result += numeral;
				num -= value;
			}
		}
		return result;
	}

	private toLetters(num: number): string {
		let result = "";
		while (num > 0) {
			num--;
			result = String.fromCharCode(97 + (num % 26)) + result;
			num = Math.floor(num / 26);
		}
		return result;
	}

	/**
	 * Process sidenotes in reading mode
	 */
	private processReadingModeSidenotes(element: HTMLElement) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		const rect = readingRoot.getBoundingClientRect();
		const width = rect.width;

		readingRoot.style.setProperty("--editor-width", `${width}px`);

		const mode = this.calculateMode(width);
		readingRoot.dataset.sidenoteMode = mode;
		readingRoot.dataset.hasSidenotes = "true";
		readingRoot.dataset.sidenotePosition = this.settings.sidenotePosition;

		const scaleFactor = this.calculateScaleFactor(width);
		readingRoot.style.setProperty(
			"--sidenote-scale",
			scaleFactor.toFixed(3),
		);

		if (mode === "hidden") return;

		const unwrappedSpans = Array.from(
			element.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) =>
				!span.parentElement?.classList.contains("sidenote-number"),
		);

		if (unwrappedSpans.length === 0) return;

		const ordered = unwrappedSpans
			.map((el) => ({
				el,
				rect: el.getBoundingClientRect(),
			}))
			.sort((a, b) => a.rect.top - b.rect.top);

		const existingCount =
			readingRoot.querySelectorAll(".sidenote-number").length;
		let num = existingCount + 1;

		const marginNotes: HTMLElement[] = [];

		for (const { el: span } of ordered) {
			// Handle reset per heading if enabled
			if (this.settings.resetNumberingPerHeading) {
				const heading = this.findPrecedingHeading(span);
				if (heading) {
					const headingId = this.getHeadingId(heading);
					if (!this.headingSidenoteNumbers.has(headingId)) {
						this.headingSidenoteNumbers.set(headingId, 1);
					}
					num = this.headingSidenoteNumbers.get(headingId)!;
					this.headingSidenoteNumbers.set(headingId, num + 1);
				}
			}

			const numStr = this.formatNumber(num++);

			const wrapper = document.createElement("span");
			wrapper.className = "sidenote-number";
			wrapper.dataset.sidenoteNum = numStr;

			const margin = document.createElement("small");
			margin.className = "sidenote-margin";
			margin.dataset.sidenoteNum = numStr;

			this.cloneContentToMargin(span, margin);

			span.parentNode?.insertBefore(wrapper, span);
			wrapper.appendChild(span);
			wrapper.appendChild(margin);

			marginNotes.push(margin);
		}

		requestAnimationFrame(() => {
			const allMargins = Array.from(
				readingRoot.querySelectorAll<HTMLElement>(
					"small.sidenote-margin",
				),
			);
			if (allMargins.length > 0) {
				this.avoidCollisions(
					allMargins,
					this.settings.collisionSpacing,
				);
			}
		});
	}

	/**
	 * Find the preceding heading element for a sidenote
	 */
	private findPrecedingHeading(el: HTMLElement): HTMLElement | null {
		let current: Element | null = el;
		while (current) {
			let sibling = current.previousElementSibling;
			while (sibling) {
				if (/^H[1-6]$/.test(sibling.tagName)) {
					return sibling as HTMLElement;
				}
				const heading = sibling.querySelector("h1, h2, h3, h4, h5, h6");
				if (heading) {
					return heading as HTMLElement;
				}
				sibling = sibling.previousElementSibling;
			}
			current = current.parentElement;
		}
		return null;
	}

	/**
	 * Get a unique ID for a heading
	 */
	private getHeadingId(heading: HTMLElement): string {
		return (
			heading.textContent?.trim() ||
			heading.id ||
			Math.random().toString()
		);
	}

	/**
	 * Clone content from a sidenote span to a margin element,
	 * preserving links and other HTML elements.
	 */
	private cloneContentToMargin(source: HTMLElement, target: HTMLElement) {
		for (const child of Array.from(source.childNodes)) {
			const cloned = child.cloneNode(true);

			if (cloned instanceof HTMLAnchorElement) {
				cloned.rel = "noopener noreferrer";
				if (
					cloned.href.startsWith("http://") ||
					cloned.href.startsWith("https://")
				) {
					cloned.target = "_blank";
				}
			}

			if (cloned instanceof HTMLElement) {
				const links = cloned.querySelectorAll("a");
				links.forEach((link) => {
					link.rel = "noopener noreferrer";
					if (
						link.href.startsWith("http://") ||
						link.href.startsWith("https://")
					) {
						link.target = "_blank";
					}
				});
			}

			target.appendChild(cloned);
		}
	}

	/**
	 * Calculate the sidenote mode based on width
	 */
	private calculateMode(
		width: number,
	): "hidden" | "compact" | "normal" | "full" {
		const s = this.settings;
		if (width < s.hideBelow) {
			return "hidden";
		} else if (width < s.compactBelow) {
			return "compact";
		} else if (width < s.fullAbove) {
			return "normal";
		} else {
			return "full";
		}
	}

	/**
	 * Calculate the scale factor based on width
	 */
	private calculateScaleFactor(width: number): number {
		const s = this.settings;
		if (width < s.hideBelow) {
			return 0;
		}
		return Math.min(1, (width - s.hideBelow) / (s.fullAbove - s.hideBelow));
	}

	/**
	 * Schedule a layout update for reading mode
	 */
	private scheduleReadingModeLayout() {
		requestAnimationFrame(() => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;

			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (!readingRoot) return;

			const rect = readingRoot.getBoundingClientRect();
			const width = rect.width;

			readingRoot.style.setProperty("--editor-width", `${width}px`);

			const mode = this.calculateMode(width);
			readingRoot.dataset.sidenoteMode = mode;
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;

			const scaleFactor = this.calculateScaleFactor(width);
			readingRoot.style.setProperty(
				"--sidenote-scale",
				scaleFactor.toFixed(3),
			);

			const allMargins = Array.from(
				readingRoot.querySelectorAll<HTMLElement>(
					"small.sidenote-margin",
				),
			);
			if (allMargins.length > 0) {
				this.avoidCollisions(
					allMargins,
					this.settings.collisionSpacing,
				);
			}
		});
	}

	/**
	 * Scan the current document's source text to determine if it contains any sidenotes.
	 */
	private scanDocumentForSidenotes() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.documentHasSidenotes = false;
			return;
		}

		const editor = view.editor;
		if (!editor) {
			this.documentHasSidenotes = false;
			return;
		}

		const content = editor.getValue();
		this.documentHasSidenotes = SIDENOTE_PATTERN.test(content);
		SIDENOTE_PATTERN.lastIndex = 0;

		if (this.cmRoot) {
			this.cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}
	}

	private resetRegistry() {
		this.sidenoteRegistry.clear();
		this.nextSidenoteNumber = 1;
		this.headingSidenoteNumbers.clear();
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

		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";
		cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;

		this.resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target === cmRoot) {
					this.scheduleLayout();
				}
			}
		});
		this.resizeObserver.observe(cmRoot);

		const readingRoot = root.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			this.resizeObserver.observe(readingRoot);
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
		}

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

	private getDocumentPosition(el: HTMLElement): number | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;

		const editor = (view.editor as any)?.cm as any;
		if (!editor?.state || !editor?.lineBlockAt) return null;

		const lineEl = el.closest(".cm-line");
		if (!lineEl) return null;

		const rect = lineEl.getBoundingClientRect();

		const pos = editor.posAtCoords({
			x: rect.left,
			y: rect.top + rect.height / 2,
		});
		if (pos === null) return null;

		const spanRect = el.getBoundingClientRect();
		const offsetInLine = spanRect.left - rect.left;

		return pos * 10000 + Math.floor(offsetInLine);
	}

	private getSidenoteKey(el: HTMLElement, docPos: number | null): string {
		const content = this.normalizeText(el.textContent ?? "");
		const posKey = docPos !== null ? docPos.toString() : "unknown";
		return `${posKey}:${content}`;
	}

	private assignSidenoteNumbers(
		spans: { el: HTMLElement; docPos: number | null }[],
	): Map<HTMLElement, number> {
		const assignments = new Map<HTMLElement, number>();

		const sorted = [...spans].sort((a, b) => {
			if (a.docPos === null && b.docPos === null) return 0;
			if (a.docPos === null) return 1;
			if (b.docPos === null) return -1;
			return a.docPos - b.docPos;
		});

		const keysInOrder: {
			el: HTMLElement;
			key: string;
			docPos: number | null;
		}[] = [];
		for (const { el, docPos } of sorted) {
			const key = this.getSidenoteKey(el, docPos);
			keysInOrder.push({ el, key, docPos });
		}

		for (const { el, key, docPos } of keysInOrder) {
			if (this.sidenoteRegistry.has(key)) {
				assignments.set(el, this.sidenoteRegistry.get(key)!);
			} else {
				const num = this.findCorrectNumber(docPos);
				this.sidenoteRegistry.set(key, num);
				assignments.set(el, num);
			}
		}

		return assignments;
	}

	private findCorrectNumber(docPos: number | null): number {
		if (docPos === null) {
			return this.nextSidenoteNumber++;
		}

		const knownPositions: { pos: number; num: number }[] = [];
		for (const [key, num] of this.sidenoteRegistry) {
			const posStr = key.split(":")[0];
			const pos = parseInt(posStr, 10);
			if (!isNaN(pos)) {
				knownPositions.push({ pos, num });
			}
		}

		if (knownPositions.length === 0) {
			return this.nextSidenoteNumber++;
		}

		knownPositions.sort((a, b) => a.pos - b.pos);

		let insertIndex = knownPositions.findIndex((kp) => kp.pos > docPos);
		if (insertIndex === -1) {
			return this.nextSidenoteNumber++;
		}

		const numAtInsert = knownPositions[insertIndex].num;

		let prevNum = 0;
		if (insertIndex > 0) {
			prevNum = knownPositions[insertIndex - 1].num;
		}

		if (prevNum + 1 < numAtInsert) {
			return prevNum + 1;
		}

		return this.nextSidenoteNumber++;
	}

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) return;

		const cmRootRect = cmRoot.getBoundingClientRect();
		const editorWidth = cmRootRect.width;

		cmRoot.style.setProperty("--editor-width", `${editorWidth}px`);

		const mode = this.calculateMode(editorWidth);
		cmRoot.dataset.sidenoteMode = mode;
		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";
		cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;

		const scaleFactor = this.calculateScaleFactor(editorWidth);
		cmRoot.style.setProperty("--sidenote-scale", scaleFactor.toFixed(3));

		const unwrappedSpans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) =>
				!span.parentElement?.classList.contains("sidenote-number"),
		);

		if (unwrappedSpans.length === 0) {
			const existingMargins = Array.from(
				cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			);
			if (existingMargins.length > 0 && mode !== "hidden") {
				this.avoidCollisions(
					existingMargins,
					this.settings.collisionSpacing,
				);
			}
			return;
		}

		if (mode === "hidden") {
			return;
		}

		const spansWithPos = unwrappedSpans.map((el) => ({
			el,
			docPos: this.getDocumentPosition(el),
		}));

		const numberAssignments = this.assignSidenoteNumbers(spansWithPos);

		const ordered = spansWithPos
			.map(({ el, docPos }) => ({
				el,
				rect: el.getBoundingClientRect(),
				num: numberAssignments.get(el) ?? 0,
			}))
			.sort((a, b) => a.rect.top - b.rect.top);

		this.isMutating = true;
		try {
			for (const { el: span, num } of ordered) {
				const numStr = this.formatNumber(num);

				const wrapper = document.createElement("span");
				wrapper.className = "sidenote-number";
				wrapper.dataset.sidenoteNum = numStr;

				const margin = document.createElement("small");
				margin.className = "sidenote-margin";
				margin.dataset.sidenoteNum = numStr;

				const raw = this.normalizeText(span.textContent ?? "");
				margin.appendChild(this.renderMarkdownLinksToFragment(raw));

				span.parentNode?.insertBefore(wrapper, span);
				wrapper.appendChild(span);
				wrapper.appendChild(margin);
			}
		} finally {
			this.isMutating = false;
		}

		const allMargins = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);
		if (allMargins.length > 0) {
			this.avoidCollisions(allMargins, this.settings.collisionSpacing);
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

/**
 * Settings tab for the sidenote plugin
 */
class SidenoteSettingTab extends PluginSettingTab {
	plugin: SidenotePlugin;

	constructor(app: App, plugin: SidenotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Display Settings
		containerEl.createEl("h2", { text: "Display" });

		new Setting(containerEl)
			.setName("Sidenote position")
			.setDesc(
				"Which margin to display sidenotes in (text will be offset to the opposite side)",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("left", "Left margin")
					.addOption("right", "Right margin")
					.setValue(this.plugin.settings.sidenotePosition)
					.onChange(async (value: "left" | "right") => {
						this.plugin.settings.sidenotePosition = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show sidenote numbers")
			.setDesc("Display reference numbers in text and sidenotes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSidenoteNumbers)
					.onChange(async (value) => {
						this.plugin.settings.showSidenoteNumbers = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Number style")
			.setDesc("How to format sidenote numbers")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("arabic", "Arabic (1, 2, 3)")
					.addOption("roman", "Roman (i, ii, iii)")
					.addOption("letters", "Letters (a, b, c)")
					.setValue(this.plugin.settings.numberStyle)
					.onChange(async (value: "arabic" | "roman" | "letters") => {
						this.plugin.settings.numberStyle = value;
						await this.plugin.saveSettings();
					}),
			);

		// Width & Spacing
		containerEl.createEl("h2", { text: "Width & Spacing" });

		new Setting(containerEl)
			.setName("Minimum sidenote width")
			.setDesc("Base width of sidenotes in rem (default: 10)")
			.addSlider((slider) =>
				slider
					.setLimits(5, 25, 1)
					.setValue(this.plugin.settings.minSidenoteWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.minSidenoteWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Maximum sidenote width")
			.setDesc("Maximum width of sidenotes in rem (default: 18)")
			.addSlider((slider) =>
				slider
					.setLimits(10, 40, 1)
					.setValue(this.plugin.settings.maxSidenoteWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxSidenoteWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Gap between sidenote and text")
			.setDesc(
				"Space between the margin and body text in rem (default: 2)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 5, 0.5)
					.setValue(this.plugin.settings.sidenoteGap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap = value;
						await this.plugin.saveSettings();
					}),
			);

		// Breakpoints
		containerEl.createEl("h2", { text: "Breakpoints" });

		new Setting(containerEl)
			.setName("Hide below width")
			.setDesc("Hide sidenotes when editor width is below this (px)")
			.addText((text) =>
				text
					.setPlaceholder("700")
					.setValue(String(this.plugin.settings.hideBelow))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.hideBelow = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Compact below width")
			.setDesc("Use compact mode when editor width is below this (px)")
			.addText((text) =>
				text
					.setPlaceholder("900")
					.setValue(String(this.plugin.settings.compactBelow))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.compactBelow = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Full width above")
			.setDesc(
				"Use full-width sidenotes when editor width is above this (px)",
			)
			.addText((text) =>
				text
					.setPlaceholder("1400")
					.setValue(String(this.plugin.settings.fullAbove))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.fullAbove = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		// Typography
		containerEl.createEl("h2", { text: "Typography" });

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Font size as percentage of body text (default: 80)")
			.addSlider((slider) =>
				slider
					.setLimits(50, 100, 5)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Font size (compact mode)")
			.setDesc("Font size in compact mode as percentage (default: 70)")
			.addSlider((slider) =>
				slider
					.setLimits(50, 100, 5)
					.setValue(this.plugin.settings.fontSizeCompact)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSizeCompact = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Line height")
			.setDesc("Line height for sidenote text (default: 1.35)")
			.addSlider((slider) =>
				slider
					.setLimits(1, 2, 0.05)
					.setValue(this.plugin.settings.lineHeight)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.lineHeight = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Text alignment")
			.setDesc("How to align text in sidenotes")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("left", "Left")
					.addOption("right", "Right")
					.addOption("justify", "Justified")
					.setValue(this.plugin.settings.textAlignment)
					.onChange(async (value: "left" | "right" | "justify") => {
						this.plugin.settings.textAlignment = value;
						await this.plugin.saveSettings();
					}),
			);

		// Behavior
		containerEl.createEl("h2", { text: "Behavior" });

		new Setting(containerEl)
			.setName("Collision spacing")
			.setDesc("Minimum pixels between stacked sidenotes (default: 8)")
			.addSlider((slider) =>
				slider
					.setLimits(0, 20, 1)
					.setValue(this.plugin.settings.collisionSpacing)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.collisionSpacing = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Enable smooth transitions")
			.setDesc("Animate width and position changes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableTransitions)
					.onChange(async (value) => {
						this.plugin.settings.enableTransitions = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Reset numbering per heading")
			.setDesc("Restart sidenote numbering after each heading")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.resetNumberingPerHeading)
					.onChange(async (value) => {
						this.plugin.settings.resetNumberingPerHeading = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
