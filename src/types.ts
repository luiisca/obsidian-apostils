import { App } from "obsidian";

declare global {
	interface Window {
		app: App
	}
}

export interface Highlight {
	id: string;
	text: string;
	tags: string[];
	line: number;
	startOffset: number;
	endOffset: number;
	filePath: string;
	footnoteCount?: number;
	footnoteContents?: string[];
	color?: string;
	collectionIds?: string[]; // Add collection support
	createdAt?: number; // Timestamp when highlight was created
	isNativeComment?: boolean; // True if this is a native comment (%% %) rather than highlight (== ==)
	type?: 'highlight' | 'comment' | 'html' | 'custom'; // Type of highlight for proper identification
	fullMatch?: string; // Full matched text with delimiters (for custom patterns)
}

export type CleanupFn = () => void;

// Settings interface
export interface SidenoteSettings {
	// Display
	sidenotePosition: "left" | "right";
	showSidenoteNumbers: boolean;
	numberStyle: "arabic" | "roman" | "letters";
	numberBadgeStyle: "plain" | "neumorphic" | "pill";
	numberColor: string;

	// Width & Spacing
	minSidenoteWidth: number;
	maxSidenoteWidth: number;
	sidenoteGap: number;
	sidenoteGap2: number;
	sidenoteAnchor: "text" | "edge";
	pageOffsetFactor: number;

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

	// Source format
	sidenoteFormat: "html" | "footnote" | "footnote-edit";

	// highlights
	highlights: { [filePath: string]: Highlight[] };
	exportAsBulletPoints: boolean;
	nativeCommentFormat: string;
	// htmlHighlightFormat: string;
	regularHighlightFormat: string;
	footnoteFormat: string;
	exportPath: string;
}
