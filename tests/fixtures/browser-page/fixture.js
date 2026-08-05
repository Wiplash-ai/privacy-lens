"use strict";

document.getElementById("addContact").addEventListener("click", () => {
  const update = document.createElement("p");
  update.dataset.demoUpdate = "1";
  update.textContent = "Dynamic contact: new.person@example.com · +1 (214) 555-0177";
  document.getElementById("liveUpdates").appendChild(update);
});
