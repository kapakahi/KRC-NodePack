import { mkEl } from "./dom_helpers.js";

function buildMaskNumberGroup({ label, input, button }) {
    const group = mkEl("div", "");
    group.className = "krc-rz-mask-adjust-group";
    const control = mkEl("div", "");
    control.className = "krc-rz-mask-number-control";
    control.append(input, button);
    group.append(label, control);
    return group;
}

export function buildMaskUI({ toggleCss, inputCss }) {
    const maskModeRow = mkEl("div", "");
    maskModeRow.className = "krc-rz-chip-row krc-rz-mask-mode-row";
    const maskInputBtn = mkEl("button", toggleCss, { type: "button" });
    maskInputBtn.className = "krc-rz-chip krc-rz-toggle krc-rz-mask-control";
    maskInputBtn.textContent = "Input";
    maskInputBtn.title = "Output input mask only";
    const maskEmptyBtn = mkEl("button", toggleCss, { type: "button" });
    maskEmptyBtn.className = "krc-rz-chip krc-rz-toggle krc-rz-mask-control";
    maskEmptyBtn.textContent = "Empty";
    maskEmptyBtn.title = "Output Resizer-created empty areas only.";
    const maskInvertBtn = mkEl("button", toggleCss, { type: "button" });
    maskInvertBtn.className = "krc-rz-chip krc-rz-toggle krc-rz-mask-control";
    maskInvertBtn.textContent = "Invert";
    maskInvertBtn.title = "Invert mask output";
    maskModeRow.append(maskInputBtn, maskEmptyBtn, maskInvertBtn);

    const maskAdjustRow = mkEl("div", "");
    maskAdjustRow.className = "krc-rz-row krc-rz-mask-adjust-row";
    const featherLabel = mkEl("span", "");
    featherLabel.className = "krc-rz-mask-label";
    featherLabel.textContent = "FEATHER";
    const featherInput = mkEl("input", inputCss, { type: "number", min: 0, max: 99, step: 1, value: 0 });
    featherInput.className = "krc-rz-input krc-rz-mask-input";
    featherInput.title = "Feather output_mask edges. Range: 0-99.";
    const featherMenuBtn = mkEl("button", "", { type: "button" });
    featherMenuBtn.className = "krc-rz-button krc-rz-mask-menu-button";
    featherMenuBtn.textContent = "▾";
    featherMenuBtn.title = "Adjust feather with slider";

    const growLabel = mkEl("span", "");
    growLabel.className = "krc-rz-mask-label";
    growLabel.textContent = "GROW";
    const growInput = mkEl("input", inputCss, { type: "number", min: -99, max: 99, step: 1, value: 0 });
    growInput.className = "krc-rz-input krc-rz-mask-input";
    growInput.title = "Grow positive or shrink negative active mask areas. Range: -99 to 99.";
    const growMenuBtn = mkEl("button", "", { type: "button" });
    growMenuBtn.className = "krc-rz-button krc-rz-mask-menu-button";
    growMenuBtn.textContent = "▾";
    growMenuBtn.title = "Adjust grow/shrink with slider";

    const thresholdLabel = mkEl("span", "");
    thresholdLabel.className = "krc-rz-mask-label";
    thresholdLabel.textContent = "THRESHOLD";
    const thresholdInput = mkEl("input", inputCss, { type: "number", min: 0, max: 1, step: 0.01, value: 0 });
    thresholdInput.className = "krc-rz-input krc-rz-mask-input";
    thresholdInput.title = "Harden soft masks at this threshold. Range: 0-1; 0 disables thresholding.";
    const thresholdMenuBtn = mkEl("button", "", { type: "button" });
    thresholdMenuBtn.className = "krc-rz-button krc-rz-mask-menu-button";
    thresholdMenuBtn.textContent = "▾";
    thresholdMenuBtn.title = "Adjust threshold with slider";

    maskAdjustRow.append(
        buildMaskNumberGroup({ label: featherLabel, input: featherInput, button: featherMenuBtn }),
        buildMaskNumberGroup({ label: growLabel, input: growInput, button: growMenuBtn }),
        buildMaskNumberGroup({ label: thresholdLabel, input: thresholdInput, button: thresholdMenuBtn }),
    );

    return {
        maskModeRow,
        maskAdjustRow,
        maskInputBtn,
        maskEmptyBtn,
        maskInvertBtn,
        featherInput,
        featherMenuBtn,
        growInput,
        growMenuBtn,
        thresholdInput,
        thresholdMenuBtn,
    };
}
