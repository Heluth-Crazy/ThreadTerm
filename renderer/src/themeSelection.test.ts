import assert from "node:assert/strict";
import test from "node:test";
import { appearanceModeForSelection, familyForSelection, isPresetSelected, selectionForFamilyMode, selectionForPreset } from "./themeSelection";
import { presetById } from "./themePresets";

test("paired families retain their family for each quick appearance mode", () => {
  assert.equal(selectionForFamilyMode("github", "system"), "system:github");
  assert.equal(selectionForFamilyMode("github", "light"), "preset:github-light");
  assert.equal(selectionForFamilyMode("github", "dark"), "preset:github-dark");
  assert.equal(selectionForFamilyMode("threadterm", "system"), "system");
});

test("dark-only families stay dark in System and Dark and use ThreadTerm Light in Light", () => {
  assert.equal(selectionForFamilyMode("nord", "system"), "preset:nord");
  assert.equal(selectionForFamilyMode("nord", "dark"), "preset:nord");
  assert.equal(selectionForFamilyMode("nord", "light"), "preset:threadterm-light");
});

test("card selection follows System for paired families and otherwise selects the card", () => {
  assert.equal(selectionForPreset(presetById("solarized-light")!, "system"), "system:solarized");
  assert.equal(selectionForPreset(presetById("dracula")!, "system"), "preset:dracula");
  assert.equal(selectionForPreset(presetById("github-dark")!, "light"), "preset:github-dark");
});

test("selection helpers identify modes, bases and the active OS card", () => {
  assert.equal(appearanceModeForSelection("preset:github-dark"), "dark");
  assert.equal(appearanceModeForSelection("system:github"), "system");
  assert.equal(appearanceModeForSelection("custom:night"), undefined);
  assert.equal(familyForSelection("custom:night", { night: { background: "#111111", surface: "#222222", text: "#eeeeee", muted: "#bbbbbb", accent: "#777777", border: "#444444", base: "dracula" } })?.id, "dracula");
  assert.equal(isPresetSelected("system:github", presetById("github-dark")!, true), true);
  assert.equal(isPresetSelected("system:github", presetById("github-light")!, true), false);
});
