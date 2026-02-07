import {
	PluginSettingTab,
	Setting,
	App,
} from "obsidian";
import type SidenotePlugin from "./main";

export default class SidenoteSettingTab extends PluginSettingTab {
	plugin: SidenotePlugin;

	constructor(app: App, plugin: SidenotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Display").setHeading();

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

		new Setting(containerEl)
			.setName("Number badge style")
			.setDesc("Visual style for sidenote numbers")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("plain", "Plain (superscript)")
					.addOption("neumorphic", "Neumorphic (subtle badge)")
					.addOption("pill", "Pill (colored capsule)")
					.setValue(this.plugin.settings.numberBadgeStyle)
					.onChange(async (value: "plain" | "neumorphic" | "pill") => {
						this.plugin.settings.numberBadgeStyle = value;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Number color")
			.setDesc(
				"Custom color for sidenote numbers (leave empty for theme default)",
			)
			.addText((text) =>
				text
					.setPlaceholder("#666666 or rgb(100,100,100)")
					.setValue(this.plugin.settings.numberColor)
					.onChange(async (value) => {
						this.plugin.settings.numberColor = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sidenote format")
			.setDesc("Choose how sidenotes are written in your documents")
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						"html",
						'HTML spans: <span class="sidenote">text</span>',
					)
					.addOption("footnote", "Footnotes (reading mode only)")
					.addOption(
						"footnote-edit",
						"Footnotes (reading + editing mode) [experimental]",
					)
					.setValue(this.plugin.settings.sidenoteFormat)
					.onChange(
						async (value: "html" | "footnote" | "footnote-edit") => {
							this.plugin.settings.sidenoteFormat = value;
							await this.plugin.saveSettings();
						},
					),
			);

		new Setting(containerEl).setName("Width & Spacing").setHeading();

		new Setting(containerEl)
			.setName("Sidenote anchor")
			.setDesc(
				"Whether sidenotes are positioned relative to the text body or the editor edge",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("text", "Anchor to text (traditional)")
					.addOption("edge", "Anchor to editor edge")
					.setValue(this.plugin.settings.sidenoteAnchor)
					.onChange(async (value: "text" | "edge") => {
						this.plugin.settings.sidenoteAnchor = value;
						await this.plugin.saveSettings();
					}),
			);

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
			.setName("Minimum Gap between sidenote and text")
			.setDesc(
				"Space between the margin and body text in rem (default: 2)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 30, 0.5)
					.setValue(this.plugin.settings.sidenoteGap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum gap between sidenote and editor edge")
			.setDesc(
				"When anchored to text: minimum distance from editor edge. When anchored to edge: minimum distance from text body. (rem, default: 1)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 10, 0.5)
					.setValue(this.plugin.settings.sidenoteGap2)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap2 = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Page Offset Factor")
			.setDesc(
				"Adjusts how much body text gets nudged over - only affects notes with sidenotes (default: 0.5)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 1, 0.1)
					.setValue(this.plugin.settings.pageOffsetFactor)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.pageOffsetFactor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Breakpoints").setHeading();

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

		new Setting(containerEl).setName("Typography").setHeading();

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

		new Setting(containerEl).setName("Behavior").setHeading();

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

		new Setting(containerEl).setName("Export").setHeading();

		new Setting(containerEl)
			.setName("Format as list")
			.setDesc("Organize exports into a bulleted list. Comments are nested under highlights.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.exportAsBulletPoints)
					.onChange(async (value) => {
						this.plugin.settings.exportAsBulletPoints = value;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Export folder")
			.setDesc(
				"Target folder for exports (relative to vault root).",
			)
			.addText((text) =>
				text
					.setPlaceholder('')
					.setValue(this.plugin.settings.exportPath)
					.onChange(async (value) => {
						this.plugin.settings.exportPath = value.trim().split(' ').filter((s) => s.trim()).join(' ');
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Exported comment formatting")
			.setDesc(
				"Sorround comments (%%those using this format%%) with these space-separated symbols when exporting or copying.",
			)
			.addText((text) =>
				text
					.setPlaceholder('%% %%')
					.setValue(this.plugin.settings.nativeCommentFormat)
					.onChange(async (value) => {
						this.plugin.settings.nativeCommentFormat = value.trim().split(' ').filter((s) => s.trim()).join(' ');
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Exported highlights formatting")
			.setDesc(
				"Sorround highlights (==those using this format==) with these space-separated symbols when exporting or copying.",
			)
			.addText((text) =>
				text
					.setPlaceholder('== ==')
					.setValue(this.plugin.settings.regularHighlightFormat)
					.onChange(async (value) => {
						this.plugin.settings.regularHighlightFormat = value.trim().split(' ').filter((s) => s.trim()).join(' ');
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Exported footnote formatting")
			.setDesc(
				"Sorround footnotes ([^those using this format]) with these space-separated symbols when exporting or copying.",
			)
			.addText((text) =>
				text
					.setPlaceholder('')
					.setValue(this.plugin.settings.footnoteFormat)
					.onChange(async (value) => {
						this.plugin.settings.footnoteFormat = value.trim().split(' ').filter((s) => s.trim()).join(' ');
						await this.plugin.saveSettings();
					}),
			);

		// Help section
		new Setting(containerEl).setName("Formatting Help").setHeading();

		const helpDiv = containerEl.createDiv({ cls: "sidenote-help" });
		helpDiv.innerHTML = `
            <p>Sidenotes support basic Markdown formatting:</p>
            <ul>
                <li><code>**bold**</code> or <code>__bold__</code> → <strong>bold</strong></li>
                <li><code>*italic*</code> or <code>_italic_</code> → <em>italic</em></li>
                <li><code>\`code\`</code> → <code>code</code></li>
                <li><code>[link](url)</code> → clickable link</li>
                <li><code>[[Note]]</code> or <code>[[Note|display]]</code> → internal link</li>
            </ul>
            <p>Use the command palette to insert sidenotes quickly.</p>
        `;
	}
}
