// RescueEye — Frontend Entry Point
// Professional aviation/emergency-response command center UI.
// Built with vanilla HTML/CSS/JS for zero-dependency delivery.

import { RescueEyeApp } from "./app";

document.addEventListener("DOMContentLoaded", () => {
  const app = new RescueEyeApp();
  app.mount(document.getElementById("app")!);
});
