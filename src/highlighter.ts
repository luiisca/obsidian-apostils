import {
	MarkdownView,
	TFile,
	Editor,
	Notice,
	Vault,
	normalizePath
} from "obsidian";

import type { Highlight } from "types";
import { InlineFootnoteManager } from "inline-footnote-manager";
import { STANDARD_FOOTNOTE_REGEX, FOOTNOTE_VALIDATION_REGEX } from "regex-patterns";
import type SidenotePlugin from "main";
import { ensureFolderExists, join } from "utils";

export default class Highlighter {
	public highlights: Map<string, Highlight[]> = new Map();
	inlineFootnoteManager: InlineFootnoteManager;
	private detectHighlightsTimeout: number | null = null;
	private plugin: SidenotePlugin;

	constructor(plugin: SidenotePlugin) {
		this.plugin = plugin
	}

	async onload() {
		this.highlights = new Map(Object.entries(this.plugin.settings.highlights || {}));
		this.inlineFootnoteManager = new InlineFootnoteManager();


		this.plugin.addCommand({
			id: 'create-highlight',
			name: 'Create highlight from selection',
			editorCallback: (editor: Editor) => {
				this.createHighlight(editor).catch(console.error);
			}
		});
		this.plugin.addCommand({
			id: "copy-highlights-to-clipboard",
			name: "Copy highlights to clipboard",
			editorCallback: () => {
				(async () => {
					const textToCopy = this.extractHighlights()
					if (textToCopy) {
						try {
							await navigator.clipboard.writeText(textToCopy);
							new Notice('Copied to clipboard');
						} catch (err) {
							// Fallback for browsers that don't support clipboard API
							const textArea = document.createElement('textarea');
							textArea.value = textToCopy;
							textArea.style.position = 'fixed';
							textArea.style.left = '-999999px';
							document.body.appendChild(textArea);
							textArea.select();
							try {
								document.execCommand('copy');
								new Notice('Copied to clipboard');
							} catch (e) {
								new Notice('Failed to copy to clipboard');
							}
							document.body.removeChild(textArea);
						}
					}
				})()
			}
		});
		this.plugin.addCommand({
			id: "export-active-file-highlights",
			name: "Export highlights from active file",
			editorCallback: () => {
				(async () => {
					const file = this.plugin.app.workspace.getActiveFile();
					if (!file) {
						new Notice('Please open a file first');
						return;
					}

					try {
						const textToExport = this.extractHighlights()
						if (textToExport) {
							const exportPath = this.plugin.settings.exportPath
							const filename = `${file.basename} - notes ${window.moment().format("YYYYMMDDHHmmss")}.md`
							const normalizedPath = normalizePath(join(exportPath, filename))
							ensureFolderExists(normalizedPath)

							const newFile = await this.plugin.app.vault.create(
								normalizedPath,
								textToExport
							)

							if (newFile) {
								new Notice("Successfully exported highlights to: " + newFile.path);
								const leaf = this.plugin.app.workspace.getLeaf(true);
								await leaf.openFile(newFile);
							}
						}
					} catch (error) {
						if (error instanceof Error) {
							if (error.message.includes("already exists")) {
								new Notice("Export file already exists. Please try again in a moment.");
							} else {
								new Notice("Failed to export highlights: " + error.message);
							}
						} else {
							new Notice("Failed to export highlights");
						}
					}
				})()
			}
		})

		this.plugin.registerEvent(
			this.plugin.app.workspace.on('editor-menu', (menu, editor, view) => {
				if (editor.getSelection()) {
					menu.addItem((item) => {
						item
							.setTitle('Create highlight')
							.setIcon('highlighter')
							.onClick(() => {
								this.createHighlight(editor).catch(console.error);
							});
					});
				}
			})
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', (file) => {
				if (file) {
					this.loadHighlightsFromFile(file).catch(console.error);
				}
			})
		);

		this.plugin.registerEvent(
			this.plugin.app.workspace.on('editor-change', (editor, view) => {
				if (view instanceof MarkdownView) {
					this.debounceDetectMarkdownHighlights(editor, view);
				}
			})
		);
		// Register all vault events after workspace is ready to avoid processing during initialization
		this.plugin.app.workspace.onLayoutReady(async () => {
			// Fix any duplicate timestamps from previous versions
			await this.fixDuplicateTimestamps();

			// Register vault events after layout is ready
			this.plugin.registerEvent(
				this.plugin.app.vault.on('create', (file) => {
					if (file instanceof TFile && this.shouldProcessFile(file)) {
						this.handleFileCreate(file).catch(console.error);
					}
				})
			);

			this.plugin.registerEvent(
				this.plugin.app.vault.on('rename', (file, oldPath) => {
					if (file instanceof TFile && this.shouldProcessFile(file)) {
						this.handleFileRename(file, oldPath).catch(console.error);
					}
				})
			);

			this.plugin.registerEvent(
				this.plugin.app.vault.on('delete', (file) => {
					if (file instanceof TFile && this.shouldProcessFile(file)) {
						this.handleFileDelete(file);
					}
				})
			);
		});
	}


	async createHighlight(editor: Editor) {
		const selection = editor.getSelection();
		if (!selection) {
			new Notice('Please select some text first');
			return;
		}
		const file = this.plugin.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active file');
			return;
		}

		const fromCursor = editor.getCursor('from');
		const toCursor = editor.getCursor('to');
		const fromOffset = editor.posToOffset(fromCursor);
		const toOffset = editor.posToOffset(toCursor);
		const highlightId = this.generateId();

		const highlight: Highlight = {
			id: highlightId,
			text: selection,
			tags: [],
			line: fromCursor.line,
			startOffset: fromOffset,
			endOffset: toOffset,
			filePath: file.path,
			createdAt: Date.now(),
		};

		const fileHighlights = this.highlights.get(file.path) || [];
		fileHighlights.push(highlight);
		this.highlights.set(file.path, fileHighlights);

		const highlightedText = `==${selection}==`;
		editor.replaceSelection(highlightedText);
		new Notice('Highlight created');
	}

	extractHighlights() {
		const file = this.plugin.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active file');
			return;
		}

		let textToCopy = '';
		this.highlights.get(file.path)?.forEach((highlight) => {
			let prefix: string | undefined = '';
			let suffix: string | undefined = '';

			if (highlight.isNativeComment) {
				// Native comment: %%text%%
				// For native comments, the text itself IS the comment, so don't add footnotes
				[prefix, suffix] = this.plugin.settings.nativeCommentFormat.split(' ')
			} else if (highlight.type === 'html') {
				// const [prefix, suffix] = this.plugin.settings.regularHighlightFormat.split(' ')
				// HTML highlights - just copy the text content (can't reconstruct exact HTML)
			} else {
				[prefix, suffix] = this.plugin.settings.regularHighlightFormat.split(' ')
			}

			textToCopy += `${this.plugin.settings.exportAsBulletPoints ? '- ' : ''}${prefix ?? ''}${highlight.text}${suffix ?? ''}\n`;

			// Add footnotes/comments if they exist (but not for native comments)
			if (!highlight.isNativeComment && highlight.footnoteContents && highlight.footnoteContents.length > 0) {
				const [prefix, suffix] = this.plugin.settings.footnoteFormat.split(' ')
				const tabSize = (this.plugin.app.vault as Vault & { getConfig: (c: string) => number }).getConfig('tabSize')
				highlight.footnoteContents.forEach((content, i) => {
					textToCopy += `${this.plugin.settings.exportAsBulletPoints ? ' '.repeat(tabSize) + '- ' : ''}${prefix ?? ''}${content}${suffix ?? ''}\n`;
				});
			}
			textToCopy += '\n';
		})

		return textToCopy
	}

	escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}


	async loadHighlightsFromFile(file: TFile) {
		// Skip parsing files that shouldn't be processed
		if (!this.shouldProcessFile(file)) {
			// Clear any existing highlights for this file and update content
			this.highlights.delete(file.path);
			return;
		}

		// Check if this is an Excalidraw file (deeper check)
		if (await this.isExcalidrawFile(file)) {
			// Clear any existing highlights for this file and update content
			this.highlights.delete(file.path);
			return;
		}

		const content = await this.plugin.app.vault.read(file);
		this.detectAndStoreMarkdownHighlights(content, file);
	}

	debounceDetectMarkdownHighlights(editor: Editor, view: MarkdownView) {
		if (this.detectHighlightsTimeout) {
			window.clearTimeout(this.detectHighlightsTimeout);
		}
		this.detectHighlightsTimeout = window.setTimeout(() => {
			this.detectMarkdownHighlights(editor, view).catch(console.error);
		}, 1000); // 1 second
	}

	async detectMarkdownHighlights(editor: Editor, view: MarkdownView) {
		const file = view.file;
		if (!file) return;
		const content = editor.getValue();
		this.detectAndStoreMarkdownHighlights(content, file);
	}

	detectAndStoreMarkdownHighlights(content: string, file: TFile) {
		// Support multi-paragraph highlights by allowing newlines
		const markdownHighlightRegex = /==((?:[^=]|=[^=])+?)==/g;
		const commentHighlightRegex = /%%([^%](?:[^%]|%[^%])*?)%%/g;

		const newHighlights: Highlight[] = [];
		const existingHighlightsForFile = this.highlights.get(file.path) || [];
		const usedExistingHighlights = new Set<string>(); // Track which highlights we've already matched

		// Create a more robust matching system that considers text, position, and type
		const findExistingHighlight = (text: string, startOffset: number, endOffset: number, isComment: boolean): Highlight | undefined => {
			// First, try exact position match
			let exactMatch = existingHighlightsForFile.find(h =>
				!usedExistingHighlights.has(h.id) &&
				h.text === text &&
				h.startOffset === startOffset &&
				h.endOffset === endOffset &&
				h.isNativeComment === isComment
			);
			if (exactMatch) {
				usedExistingHighlights.add(exactMatch.id);
				return exactMatch;
			}

			// If no exact match, try fuzzy position match (within 50 characters)
			let fuzzyMatch = existingHighlightsForFile.find(h =>
				!usedExistingHighlights.has(h.id) &&
				h.text === text &&
				Math.abs(h.startOffset - startOffset) <= 50 &&
				h.isNativeComment === isComment
			);
			if (fuzzyMatch) {
				usedExistingHighlights.add(fuzzyMatch.id);
				return fuzzyMatch;
			}

			// If still no match, try text-only match for highlights that might have moved significantly
			let textMatch = existingHighlightsForFile.find(h =>
				!usedExistingHighlights.has(h.id) &&
				h.text === text &&
				h.isNativeComment === isComment &&
				!existingHighlightsForFile.some(other =>
					other !== h && other.text === text && other.isNativeComment === isComment
				) // Only if it's the only highlight with this text
			);
			if (textMatch) {
				usedExistingHighlights.add(textMatch.id);
				return textMatch;
			}

			return undefined;
		};

		// Extract all footnotes from the content
		const footnoteMap = this.extractFootnotes(content);

		// Get code block ranges to exclude highlights within them
		const codeBlockRanges = this.getCodeBlockRanges(content);

		// Get markdown link ranges to exclude highlights within URLs
		const markdownLinkRanges = this.getMarkdownLinkRanges(content);

		// Process all highlight types
		const allMatches: Array<{ match: RegExpExecArray, type: 'highlight' | 'comment' | 'html', color?: string, skip?: boolean, isCustomPattern?: boolean }> = [];

		// Find all highlight matches
		let match;
		while ((match = markdownHighlightRegex.exec(content)) !== null) {
			// Skip if match is inside a code block
			if (this.isInsideCodeBlock(match.index, match.index + match[0].length, codeBlockRanges)) {
				continue;
			}

			// Skip if highlight delimiters are inside a markdown link URL
			if (this.isHighlightDelimiterInLink(match.index, match.index + match[0].length, content, markdownLinkRanges)) {
				continue;
			}

			// Skip if this highlight is surrounded by additional equals signs (e.g., =====text===== )
			const beforeMatch = content.charAt(match.index - 1);
			const afterMatch = content.charAt(match.index + match[0].length);
			if (beforeMatch === '=' || afterMatch === '=') {
				continue;
			}

			allMatches.push({ match, type: 'highlight' });
		}

		// Find all comment matches
		while ((match = commentHighlightRegex.exec(content)) !== null) {
			// Skip if match is inside a code block
			if (this.isInsideCodeBlock(match.index, match.index + match[0].length, codeBlockRanges)) {
				continue;
			}

			// Skip if comment delimiters are inside a markdown link URL
			if (this.isHighlightDelimiterInLink(match.index, match.index + match[0].length, content, markdownLinkRanges)) {
				continue;
			}

			// Skip if this comment is surrounded by additional percent signs (e.g., %%%%%text%%%%% )
			const beforeMatch = content.charAt(match.index - 1);
			const afterMatch = content.charAt(match.index + match[0].length);
			if (beforeMatch === '%' || afterMatch === '%') {
				continue;
			}

			allMatches.push({ match, type: 'comment' });
		}

		// Sort matches by position in content
		allMatches.sort((a, b) => a.match.index - b.match.index);

		// Pre-process to handle adjacent highlight + comment patterns
		// When a comment follows a highlight with only footnotes/whitespace between
		// (e.g., ==text==^[note]<!-- comment --> or ==text==%% comment %%),
		// store the comment to be added as a footnote to the highlight
		const adjacentComments = new Map<number, { text: string, position: number }>(); // Maps highlight index to comment info

		for (let i = 0; i < allMatches.length - 1; i++) {
			const current = allMatches[i];
			const next = allMatches[i + 1];

			// Check if current is a highlight (not a comment) and next is any type of comment
			if ((current?.type === 'highlight' || current?.type === 'html') && next?.type === 'comment') {
				const highlightEnd = current.match.index + current.match[0].length;
				const commentStart = next.match.index;

				// Check if comment follows highlight with only footnotes/whitespace between
				const betweenText = content.substring(highlightEnd, commentStart);

				// Calculate footnote length - if the between text is ONLY footnotes and whitespace,
				// calculateFootnoteLength should return the full length
				const footnoteLength = InlineFootnoteManager.calculateFootnoteLength(betweenText);
				const afterFootnotes = betweenText.substring(footnoteLength);

				// If after removing footnotes, we only have whitespace AND no blank lines, this is adjacent
				// A blank line (two or more newlines with optional whitespace between) breaks adjacency
				const hasBlankLine = /\n\s*\n/.test(afterFootnotes);
				if (/^\s*$/.test(afterFootnotes) && !hasBlankLine) {
					// Check if this is a native comment (%% %%)
					const isNativeComment = next.match[0].startsWith('%%') && next.match[0].endsWith('%%');

					// Apply adjacency logic for both native and HTML comments based on the setting
					// const shouldApplyAdjacency = this.plugin.settings.detectAdjacentNativeComments;
					const shouldApplyAdjacency = true;

					if (shouldApplyAdjacency && next.match[1]) {
						// This is a comment adjacent to a highlight (HTML, native, or custom)
						// It may be after inline footnotes like ==text==^[note]<!-- comment -->
						// Store both the text and the actual position of the comment
						adjacentComments.set(i, {
							text: next.match[1].trim(),
							position: commentStart // Use the comment's actual position for sorting
						});
						// Mark the comment for skipping in main loop
						allMatches[i + 1] = { ...next, type: 'comment', skip: true };
					}
				}
			}
		}

		allMatches.forEach(({ match, type, color, skip, isCustomPattern }, index) => {
			// Skip matches that were merged as adjacent comments
			if (skip) return;
			const [, highlightText] = match;

			// Skip empty or whitespace-only highlights
			if (!highlightText || highlightText.trim() === '') {
				return;
			}

			// Find existing highlight using improved matching
			const existingHighlight = findExistingHighlight(
				highlightText,
				match.index,
				match.index + match[0].length,
				type === 'comment'
			);

			// Calculate line number from offset
			const lineNumber = content.substring(0, match.index).split('\n').length - 1;

			let footnoteContents: string[] = [];
			let footnoteCount = 0;

			if (type === 'highlight' || type === 'html') {
				// For regular and HTML highlights, extract footnotes in the order they appear in the text
				const afterHighlight = content.substring(match.index + match[0].length);

				// Find all footnotes (both standard and inline) in order
				const allFootnotes: Array<{ type: 'standard' | 'inline', index: number, content: string }> = [];

				// First, get all inline footnotes with their positions
				const inlineFootnotes = this.inlineFootnoteManager.extractInlineFootnotes(content, match.index + match[0].length);
				inlineFootnotes.forEach(footnote => {
					if (footnote.content.trim()) {
						allFootnotes.push({
							type: 'inline',
							index: footnote.startIndex,
							content: footnote.content.trim()
						});
					}
				});

				// Then, get all standard footnotes with their positions (using same validation logic)
				// Use negative lookahead to avoid matching footnote definitions [^key]: content
				const standardFootnoteRegex = new RegExp(STANDARD_FOOTNOTE_REGEX);
				let match_sf;
				let lastValidPosition = 0;

				while ((match_sf = standardFootnoteRegex.exec(afterHighlight)) !== null) {
					// Check if this standard footnote is in a valid position
					const precedingText = afterHighlight.substring(lastValidPosition, match_sf.index);
					const isValid = FOOTNOTE_VALIDATION_REGEX.test(precedingText);

					if (match_sf.index === lastValidPosition || isValid) {
						const key = match_sf[2]; // The key inside [^key]
						if (key && footnoteMap.has(key)) {
							const fnContent = footnoteMap.get(key)!.trim();
							if (fnContent) { // Only add non-empty content
								allFootnotes.push({
									type: 'standard',
									index: match.index + match[0].length + match_sf.index,
									content: fnContent
								});
							}
						}
						lastValidPosition = match_sf.index + match_sf[0].length;
					} else {
						// Stop if we encounter a footnote that's not in the valid sequence
						break;
					}
				}

				// Add adjacent comment if present
				if (adjacentComments.has(index)) {
					const adjacentComment = adjacentComments.get(index)!;
					allFootnotes.push({
						type: 'inline' as const,
						index: adjacentComment.position, // Use the actual position for correct sorting
						content: adjacentComment.text
					});
				}

				// Sort footnotes by their position in the text
				allFootnotes.sort((a, b) => a.index - b.index);

				// Extract content in the correct order
				footnoteContents = allFootnotes.map(f => f.content);
				footnoteCount = footnoteContents.length;

			} else if (type === 'comment') {
				// For comments, the text itself IS the comment content
				footnoteContents = [highlightText];
				footnoteCount = 1;
			}

			if (existingHighlight) {
				newHighlights.push({
					...existingHighlight,
					line: lineNumber,
					startOffset: match.index,
					endOffset: match.index + match[0].length,
					filePath: file.path, // ensure filePath is current
					footnoteCount: footnoteCount,
					footnoteContents: footnoteContents,
					isNativeComment: type === 'comment',
					// Update color for HTML highlights, preserve existing for others
					color: type === 'html' ? color : existingHighlight.color,
					// Preserve existing createdAt timestamp if it exists
					createdAt: existingHighlight.createdAt || Date.now(),
					// Store the type for proper identification
					type: isCustomPattern ? 'custom' : type,
					// Store full match for custom patterns
					fullMatch: isCustomPattern ? match[0] : undefined
				});
			} else {
				// For new highlights, use file modification time to preserve historical context
				// Add a small offset based on the match index to ensure uniqueness
				const uniqueTimestamp = file.stat.mtime + (match.index % 1000);
				newHighlights.push({
					id: this.generateId(),
					text: highlightText,
					tags: [],
					line: lineNumber,
					startOffset: match.index,
					endOffset: match.index + match[0].length,
					filePath: file.path,
					footnoteCount: footnoteCount,
					footnoteContents: footnoteContents,
					createdAt: uniqueTimestamp,
					isNativeComment: type === 'comment',
					// Set color for HTML highlights
					color: type === 'html' ? color : undefined,
					// Store the type for proper identification
					type: isCustomPattern ? 'custom' : type,
					// Store full match for custom patterns
					fullMatch: isCustomPattern ? match[0] : undefined
				});
			}
		});

		// Check for actual changes before updating and refreshing
		const oldHighlightsJSON = JSON.stringify(existingHighlightsForFile.map(h => ({ id: h.id, start: h.startOffset, end: h.endOffset, text: h.text, footnotes: h.footnoteCount, contents: h.footnoteContents?.filter(c => c.trim() !== ''), color: h.color, isNativeComment: h.isNativeComment })));
		const newHighlightsJSON = JSON.stringify(newHighlights.map(h => ({ id: h.id, start: h.startOffset, end: h.endOffset, text: h.text, footnotes: h.footnoteCount, contents: h.footnoteContents?.filter(c => c.trim() !== ''), color: h.color, isNativeComment: h.isNativeComment })));

		if (oldHighlightsJSON !== newHighlightsJSON) {
			this.highlights.set(file.path, newHighlights);
			this.plugin.saveSettings().catch(console.error); // Save to disk after detecting changes
		}
	}

	extractFootnotes(content: string): Map<string, string> {
		const footnoteMap = new Map<string, string>();
		const footnoteRegex = /^\[\^(\w+)\]:\s*(.+)$/gm;
		let match;

		while ((match = footnoteRegex.exec(content)) !== null) {
			const [, key, footnoteContent] = match;
			if (key && footnoteContent) {
				footnoteMap.set(key, footnoteContent.trim());
			}
		}

		return footnoteMap;
	}

	private async handleFileCreate(file: TFile) {
		try {
			const content = await this.plugin.app.vault.read(file);
			this.detectAndStoreMarkdownHighlights(content, file);
		} catch (error) {
			// Continue on error
		}
	}

	async handleFileRename(file: TFile, oldPath: string) {
		const oldHighlights = this.highlights.get(oldPath);
		if (oldHighlights && oldHighlights.length > 0) {
			// Update file paths in highlights
			const updatedHighlights = oldHighlights.map(highlight => ({
				...highlight,
				filePath: file.path
			}));

			// Remove old path and add new path
			this.highlights.delete(oldPath);
			this.highlights.set(file.path, updatedHighlights);

			// Save settings and refresh sidebar
			await this.plugin.saveSettings();
		}
	}

	private handleFileDelete(file: TFile) {
		// Remove highlights for the deleted file
		if (this.highlights.has(file.path)) {
			this.highlights.delete(file.path);
			this.plugin.saveSettings().catch(console.error);
		}
	}

	generateId(): string {
		return Math.random().toString(36).substr(2, 9);
	}

	shouldProcessFile(file: TFile): boolean {
		if (file.extension !== 'md') {
			return false;
		}

		// if (this.plugin.settings.excludeExcalidraw) {
		// Check for .excalidraw extension in the filename
		if (file.name.endsWith('.excalidraw.md')) {
			return false;
		}

		return true;
	}

	private async isExcalidrawFile(file: TFile): Promise<boolean> {
		// Check filename first (fast check)
		if (file.name.endsWith('.excalidraw.md')) {
			return true;
		}

		// Check frontmatter for Excalidraw indicators
		try {
			const content = await this.plugin.app.vault.read(file);
			const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
			if (frontmatterMatch) {
				const frontmatter = frontmatterMatch[1];
				// Check for excalidraw-plugin: parsed
				if (frontmatter && /excalidraw-plugin:\s*parsed/i.test(frontmatter)) {
					return true;
				}
				// Check for tags containing excalidraw
				if (frontmatter && /tags:\s*\[.*excalidraw.*\]/i.test(frontmatter)) {
					return true;
				}
			}
		} catch (error) {
			// If we can't read the file, don't exclude it
		}

		return false;
	}

	/**
	 * Fix duplicate timestamps in existing highlights by assigning unique timestamps
	 * while preserving the relative order within each file
	 */
	async fixDuplicateTimestamps(): Promise<void> {
		let hasChanges = false;

		for (const [filePath, highlights] of this.highlights) {
			const timestampCounts = new Map<number, Highlight[]>();

			// Group highlights by timestamp to find duplicates
			highlights.forEach(highlight => {
				if (highlight.createdAt) {
					if (!timestampCounts.has(highlight.createdAt)) {
						timestampCounts.set(highlight.createdAt, []);
					}
					timestampCounts.get(highlight.createdAt)!.push(highlight);
				}
			});

			// Fix duplicates
			for (const [timestamp, duplicates] of timestampCounts) {
				if (duplicates.length > 1) {
					// Sort by start offset to maintain document order
					duplicates.sort((a, b) => a.startOffset - b.startOffset);

					// Assign unique timestamps, keeping the first one and incrementing others
					duplicates.forEach((highlight, index) => {
						if (index > 0) {
							// Add milliseconds based on position to ensure uniqueness
							highlight.createdAt = timestamp + index;
							hasChanges = true;
						}
					});
				}
			}
		}

		if (hasChanges) {
			await this.plugin.saveSettings();
		}
	}

	/**
	 * Get ranges of code blocks (both inline and fenced) in the content
	 */
	public getCodeBlockRanges(content: string): Array<{ start: number, end: number }> {
		const ranges: Array<{ start: number, end: number }> = [];

		// Find fenced code blocks (``` and ~~~ with optional language)
		// Track all opening markers and their types
		const lines = content.split('\n');
		let currentBlockStart: number | null = null;
		let currentBlockType: 'backtick' | 'wave' | null = null;
		let currentPos = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineStart = currentPos;
			const lineEnd = currentPos + (line?.length ?? 0);

			// Check for code block markers at start of line
			if (line?.match(/^```/)) {
				if (currentBlockType === 'backtick') {
					// Closing marker - end the block
					ranges.push({
						start: currentBlockStart!,
						end: lineEnd
					});
					currentBlockStart = null;
					currentBlockType = null;
				} else if (currentBlockStart === null) {
					// Opening marker
					currentBlockStart = lineStart;
					currentBlockType = 'backtick';
				}
			} else if (line?.match(/^~~~/)) {
				if (currentBlockType === 'wave') {
					// Closing marker - end the block
					ranges.push({
						start: currentBlockStart!,
						end: lineEnd
					});
					currentBlockStart = null;
					currentBlockType = null;
				} else if (currentBlockStart === null) {
					// Opening marker
					currentBlockStart = lineStart;
					currentBlockType = 'wave';
				}
			}

			currentPos = lineEnd + 1; // +1 for the newline character
		}

		// Handle unclosed code blocks - extend to end of file
		if (currentBlockStart !== null) {
			ranges.push({
				start: currentBlockStart,
				end: content.length
			});
		}

		// Find inline code blocks (`code`)
		const inlineCodeRegex = /`([^`\n]+?)`/g;
		let inlineMatch;
		while ((inlineMatch = inlineCodeRegex.exec(content)) !== null) {
			ranges.push({
				start: inlineMatch.index,
				end: inlineMatch.index + inlineMatch[0].length
			});
		}

		return ranges;
	}

	/**
	 * Get ranges of markdown links [text](url) to exclude highlights within URLs
	 */
	private getMarkdownLinkRanges(content: string): Array<{ start: number, end: number }> {
		const ranges: Array<{ start: number, end: number }> = [];

		// Match markdown links: [text](url)
		const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
		let match;

		while ((match = linkRegex.exec(content)) !== null) {
			ranges.push({
				start: match.index,
				end: match.index + match[0].length
			});
		}

		return ranges;
	}

	/**
	 * Check if a range overlaps with any of the provided code block ranges
	 * Returns true if the range is fully inside, partially overlaps, or spans across a code block
	 */
	private isInsideCodeBlock(start: number, end: number, codeBlockRanges: Array<{ start: number, end: number }>): boolean {
		return codeBlockRanges.some(range => {
			// Check for any overlap: ranges overlap if start < range.end AND end > range.start
			return start < range.end && end > range.start;
		});
	}

	/**
	 * Check if a highlight's delimiters (== or %%) are inside a markdown link
	 * This prevents matching highlights whose markers are in URLs, but allows highlights that contain links
	 * Returns true only if the START or END delimiters are inside a link's URL portion
	 */
	private isHighlightDelimiterInLink(highlightStart: number, highlightEnd: number, content: string, linkRanges: Array<{ start: number, end: number }>): boolean {
		// Check if the opening delimiter (first 2 chars) or closing delimiter (last 2 chars)
		// are inside a markdown link's URL portion
		for (const linkRange of linkRanges) {
			// Get the link text to find where the URL starts: [text](url)
			const linkText = content.substring(linkRange.start, linkRange.end);
			const urlStartOffset = linkText.indexOf('](') + 2; // +2 to skip "]("
			const urlStart = linkRange.start + urlStartOffset;
			const urlEnd = linkRange.end - 1; // -1 to exclude the closing ")"

			// Check if opening delimiter is in URL
			const openDelimEnd = highlightStart + 2;
			if (highlightStart >= urlStart && openDelimEnd <= urlEnd) {
				return true;
			}

			// Check if closing delimiter is in URL
			const closeDelimStart = highlightEnd - 2;
			if (closeDelimStart >= urlStart && highlightEnd <= urlEnd) {
				return true;
			}
		}

		return false;
	}
}
