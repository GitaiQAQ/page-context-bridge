/**
 * Vite build entry: outputs agentation-main.js
 *
 * This file is referenced by vite.config.ts's rollup input,
 * Vite will bundle React + Agentation vendor code into a self-contained agentation-main.js.
 * This JS is injected into the page main world via chrome.scripting.executeScript({ world: "MAIN", files: ["agentation-main.js"] }),
 * allowing react-detection.ts's Object.keys(element) to directly see __reactFiber$xxx properties.
 */
import "./agentation-main";
