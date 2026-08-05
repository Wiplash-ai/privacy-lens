"use strict";

(() => {
  if (globalThis.__privacyLensContentLoaded) return;
  globalThis.__privacyLensContentLoaded = true;

  const IS_TOP_FRAME = window.top === window;
  const HOST_ID = "privacy-lens-widget-host";
  const settingsStore = PrivacyLens.Settings.createBrowserStore();
  const hostname = location.hostname.toLowerCase();
  let settings = PrivacyLens.Settings.sanitizeSettings();
  let state = PrivacyLens.Settings.defaultPageState(settings);
  let engine = null;
  let widgetHost = null;
  let widgetRoot = null;
  let widgetVisible = false;
  let widgetExpanded = false;
  let rememberSite = false;
  let titleTabs = { allTabsProtected: false, tabs: [] };
  let tabPickerOpen = false;
  let dragState = null;
  let toastTimer = 0;

  const ready = initialize();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error && error.message ? error.message : "Privacy Lens could not update this page."
      }));
    return true;
  });

  async function initialize() {
    settings = await settingsStore.get();
    rememberSite = Boolean(hostname && settings.savedSites[hostname]);
    state = rememberSite
      ? PrivacyLens.Settings.sanitizePageState(settings.savedSites[hostname], settings)
      : PrivacyLens.Settings.defaultPageState(settings);
    engine = new PrivacyLens.PrivacyEngine(document, {
      isTopFrame: IS_TOP_FRAME,
      neutralTitle: settings.neutralTitle,
      redactionOptions: getRedactionOptions(settings),
      classifyImage: (_image, sourceUrl) => classifyImageRemotely(sourceUrl),
      onMaskCountChange: () => {
        if (IS_TOP_FRAME && widgetRoot) renderWidget();
      }
    });
    engine.applyState(state);

    if (IS_TOP_FRAME) {
      buildWidget();
      chrome.storage.onChanged.addListener(handleStorageChange);
      window.addEventListener("resize", positionWidget, { passive: true });
      window.setTimeout(() => {
        callRuntime({ type: "PRIVACY_LENS_APPLY_TO_TAB", state }).catch(() => undefined);
      }, 0);
    }

    return engine;
  }

  async function handleMessage(message) {
    await ready;
    const type = message && message.type;

    switch (type) {
      case "PRIVACY_LENS_TOGGLE_WIDGET":
        if (!IS_TOP_FRAME) return { ok: false, ignored: true };
        toggleWidget();
        return { ok: true, visible: widgetVisible };
      case "PRIVACY_LENS_SHOW_WIDGET":
        if (!IS_TOP_FRAME) return { ok: false, ignored: true };
        showWidget();
        return { ok: true, visible: true };
      case "PRIVACY_LENS_HIDE_WIDGET":
        if (!IS_TOP_FRAME) return { ok: false, ignored: true };
        hideWidget();
        return { ok: true, visible: false };
      case "PRIVACY_LENS_SET_WIDGET_EXPANDED":
        if (!IS_TOP_FRAME) return { ok: false, ignored: true };
        setWidgetExpanded(message.expanded === true);
        return { ok: true, expanded: widgetExpanded };
      case "PRIVACY_LENS_SET_TAB_PICKER_EXPANDED":
        if (!IS_TOP_FRAME) return { ok: false, ignored: true };
        setWidgetExpanded(true);
        await setTabPickerOpen(message.expanded === true);
        return {
          ok: true,
          expanded: tabPickerOpen,
          tabCount: titleTabs.tabs.length,
          allTabsProtected: titleTabs.allTabsProtected
        };
      case "PRIVACY_LENS_APPLY_STATE":
        if (typeof message.neutralTitle === "string") engine.setNeutralTitle(message.neutralTitle);
        state = PrivacyLens.Settings.sanitizePageState(message.state, settings);
        engine.applyState(state);
        if (IS_TOP_FRAME) renderWidget();
        return { ok: true, ...engine.getState() };
      case "PRIVACY_LENS_RESET":
        if (typeof message.neutralTitle === "string") engine.setNeutralTitle(message.neutralTitle);
        state = engine.reset(message.state);
        if (IS_TOP_FRAME) renderWidget();
        return { ok: true, ...engine.getState() };
      case "PRIVACY_LENS_GET_STATE":
        return { ok: true, ...engine.getState(), widgetVisible, widgetExpanded, rememberSite };
      case "PRIVACY_LENS_GET_TITLE_INFO":
        if (!IS_TOP_FRAME) return { ok: false, ignored: true };
        return { ok: true, ...engine.getTitleInfo() };
      case "PRIVACY_LENS_SET_TITLE_PROTECTION":
        if (!IS_TOP_FRAME) return { ok: false, ignored: true };
        state = PrivacyLens.Settings.sanitizePageState({
          ...state,
          titleProtected: message.enabled === true
        }, settings);
        if (typeof message.neutralTitle === "string") engine.setNeutralTitle(message.neutralTitle);
        engine.applyState(state);
        renderWidget();
        if (tabPickerOpen) loadTitleTabs().catch(() => undefined);
        return { ok: true, ...engine.getState() };
      default:
        return { ok: false, error: "Unknown Privacy Lens page message." };
    }
  }

  function buildWidget() {
    widgetHost = document.createElement("div");
    widgetHost.id = HOST_ID;
    widgetHost.hidden = true;
    widgetHost.style.position = "fixed";
    widgetHost.style.zIndex = "2147483647";
    widgetHost.style.width = "400px";
    widgetHost.style.maxWidth = "calc(100vw - 48px)";
    widgetHost.style.colorScheme = "light";
    widgetHost.style.contain = "layout style";
    document.documentElement.appendChild(widgetHost);
    widgetRoot = widgetHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = widgetStyles();
    widgetRoot.appendChild(style);

    const template = document.createElement("template");
    template.innerHTML = `
      <section class="lens" aria-label="Privacy Lens page controls">
        <header class="lens-header" id="dragHandle">
          <div class="brand">
            <img src="${assetUrl("assets/brand-mark.svg")}" alt="">
            <span><strong>Privacy Lens</strong><small>${escapeText(hostname || "this page")}</small></span>
          </div>
          <div class="header-tools">
            <span class="classification">TOP SECRET</span>
            <button class="icon-button" id="settingsButton" type="button" aria-label="Open Privacy Lens settings"><img src="${assetUrl("assets/ui/settings.svg")}" alt=""></button>
            <button class="icon-button" id="closeButton" type="button" aria-label="Close Privacy Lens"><img src="${assetUrl("assets/ui/close.svg")}" alt=""></button>
          </div>
        </header>

        <div class="status-band">
          <div class="status-stamp" aria-hidden="true">TS</div>
          <div class="status-copy">
            <strong id="statusLabel">Page is clear</strong>
            <span id="statusDetail">No privacy layers active</span>
          </div>
          <button class="shield-button" id="protectAllButton" type="button"><img src="${assetUrl("assets/ui/shield.svg")}" alt=""><span>Shield all</span></button>
        </div>

        <div class="quick-grid" aria-label="Page privacy layers">
          <button class="quick-control" id="imagesButton" type="button" aria-pressed="false">
            <img src="${assetUrl("assets/ui/image.svg")}" alt=""><span>Images</span><small id="imagesState">Shown</small>
          </button>
          <button class="quick-control" id="blurButton" type="button" aria-pressed="false">
            <img src="${assetUrl("assets/ui/blur.svg")}" alt=""><span>Page blur</span><small id="blurState">Off</small>
          </button>
          <button class="quick-control" id="maskButton" type="button" aria-pressed="false">
            <img src="${assetUrl("assets/ui/mask.svg")}" alt=""><span>Secrets</span><small id="maskState">Visible</small>
          </button>
          <button class="quick-control" id="titleButton" type="button" aria-pressed="false">
            <img src="${assetUrl("assets/ui/title.svg")}" alt=""><span>Tab title</span><small id="titleState">Original</small>
          </button>
        </div>

        <button class="details-toggle" id="detailsToggle" type="button" aria-expanded="false" aria-controls="detailsPanel">
          <span>Dossier controls</span><small id="detailsSummary">12px / redact</small><img src="${assetUrl("assets/ui/chevron.svg")}" alt="">
        </button>

        <div class="details-panel" id="detailsPanel" hidden>
          <div class="detail-row blur-detail">
            <div class="detail-heading"><label for="blurStrength">Blur strength</label><output id="blurStrengthValue" for="blurStrength">12px</output></div>
            <input id="blurStrength" type="range" min="2" max="28" step="1" value="12">
          </div>

          <div class="detail-row">
            <span class="detail-label">Page blur treatment</span>
            <div class="treatment-selector" role="group" aria-label="Blur treatment">
              <button type="button" data-treatment="soft">Soft focus</button>
              <button type="button" data-treatment="frosted">Frosted</button>
            </div>
          </div>

          <div class="detail-row">
            <span class="detail-label">Image privacy</span>
            <div class="treatment-selector" role="group" aria-label="Image privacy treatment">
              <button type="button" data-image-treatment="hidden">Hidden</button>
              <button type="button" data-image-treatment="blur">Blur</button>
              <button type="button" data-image-treatment="stamp">Black + stamp</button>
              <button type="button" data-image-treatment="nsfw">NSFW check</button>
            </div>
          </div>

          <div class="detail-row">
            <span class="detail-label">Secret text treatment</span>
            <div class="treatment-selector" role="group" aria-label="Secret text treatment">
              <button type="button" data-text-treatment="redact">Redacted</button>
              <button type="button" data-text-treatment="blur">Blur</button>
            </div>
          </div>

          <div class="detail-row tab-picker">
            <button class="tab-picker-toggle" id="tabPickerToggle" type="button" aria-expanded="false" aria-controls="tabPickerMenu">
              <span><strong>Classified tab titles</strong><small id="tabPickerSummary">Choose tabs</small></span>
              <img src="${assetUrl("assets/ui/chevron.svg")}" alt="">
            </button>
            <div class="tab-picker-menu" id="tabPickerMenu" hidden>
              <label class="widget-all-tabs" for="widgetAllTabsTitle">
                <span><strong>Protect every tab</strong><small>Replace every accessible title.</small></span>
                <span class="switch"><input id="widgetAllTabsTitle" type="checkbox"><i></i></span>
              </label>
              <div class="widget-tab-list" id="widgetTabList" aria-live="polite"></div>
            </div>
          </div>

          <label class="remember-row" for="rememberSite">
            <span><strong>Remember on this site</strong><small>Reapply this setup when the site loads.</small></span>
            <span class="switch"><input id="rememberSite" type="checkbox"><i></i></span>
          </label>

          <div class="detection-row"><span>Deterministic matches</span><strong id="matchCount">0 masked</strong></div>
        </div>

        <footer class="lens-footer">
          <button id="resetButton" type="button"><img src="${assetUrl("assets/ui/reset.svg")}" alt="">Restore page</button>
          <nav class="footer-links" aria-label="Privacy Lens links">
            <a class="producer-link" href="https://wiplash.ai/" target="_blank" rel="noreferrer">Produced by Wiplash.ai</a>
            <span class="footer-resource-links">
              <a href="https://labs.wiplash.ai/privacy-lens/" target="_blank" rel="noreferrer">Wiplash Labs</a>
              <i aria-hidden="true">·</i>
              <a href="https://github.com/Wiplash-ai/privacy-lens" target="_blank" rel="noreferrer">Source code</a>
            </span>
          </nav>
        </footer>
        <div class="toast" id="toast" role="status" aria-live="polite"></div>
      </section>
    `;
    widgetRoot.appendChild(template.content.cloneNode(true));
    bindWidgetEvents();
    setWidgetExpanded(false);
    positionWidget();
    renderWidget();
  }

  function bindWidgetEvents() {
    getWidgetElement("imagesButton").addEventListener("click", () => updateState(
      { imagesProtected: !state.imagesProtected },
      state.imagesProtected
        ? "Images and video revealed"
        : `Visual media ${{ hidden: "hidden", stamp: "blacked out and stamped", blur: "blurred", nsfw: "checking remotely" }[state.imageTreatment]}`
    ));
    getWidgetElement("blurButton").addEventListener("click", () => updateState({ blurEnabled: !state.blurEnabled }, state.blurEnabled ? "Page blur removed" : "Page blurred"));
    getWidgetElement("maskButton").addEventListener("click", () => updateState(
      { sensitiveMasked: !state.sensitiveMasked },
      state.sensitiveMasked
        ? "Sensitive text revealed"
        : state.textTreatment === "blur"
          ? "Sensitive text blurred"
          : "Sensitive text redacted"
    ));
    getWidgetElement("titleButton").addEventListener("click", () => updateState({ titleProtected: !state.titleProtected }, state.titleProtected ? "Original title restored" : "Tab title protected"));
    getWidgetElement("protectAllButton").addEventListener("click", toggleAllLayers);
    getWidgetElement("resetButton").addEventListener("click", resetPage);
    getWidgetElement("detailsToggle").addEventListener("click", () => setWidgetExpanded(!widgetExpanded));
    getWidgetElement("settingsButton").addEventListener("click", () => callRuntime({ type: "PRIVACY_LENS_OPEN_OPTIONS" }));
    getWidgetElement("closeButton").addEventListener("click", closeWidget);
    getWidgetElement("rememberSite").addEventListener("change", (event) => setRememberSite(event.target.checked));
    getWidgetElement("blurStrength").addEventListener("input", (event) => {
      updateState({ blurStrength: Number(event.target.value) }, "", { quiet: true });
    });
    widgetRoot.querySelectorAll("[data-treatment]").forEach((button) => {
      button.addEventListener("click", () => updateState({ blurTreatment: button.dataset.treatment }, `${button.textContent} selected`));
    });
    widgetRoot.querySelectorAll("[data-image-treatment]").forEach((button) => {
      button.addEventListener("click", () => updateState(
        { imageTreatment: button.dataset.imageTreatment },
        `Image privacy set to ${button.textContent.toLowerCase()}`
      ));
    });
    widgetRoot.querySelectorAll("[data-text-treatment]").forEach((button) => {
      button.addEventListener("click", () => updateState(
        { textTreatment: button.dataset.textTreatment },
        `Secret text set to ${button.textContent.toLowerCase()}`
      ));
    });
    getWidgetElement("tabPickerToggle").addEventListener("click", toggleTabPicker);
    getWidgetElement("widgetAllTabsTitle").addEventListener("change", handleWidgetAllTabsChange);
    getWidgetElement("widgetTabList").addEventListener("change", handleWidgetTabChange);
    getWidgetElement("dragHandle").addEventListener("pointerdown", startDragging);
  }

  async function loadTitleTabs() {
    const response = await callRuntime({ type: "PRIVACY_LENS_GET_TITLE_TABS" });
    if (!response || !response.ok) return;
    titleTabs = response;
    renderWidgetTitleTabs();
  }

  function toggleTabPicker() {
    return setTabPickerOpen(!tabPickerOpen);
  }

  async function setTabPickerOpen(value) {
    tabPickerOpen = value === true;
    getWidgetElement("tabPickerToggle").setAttribute("aria-expanded", String(tabPickerOpen));
    getWidgetElement("tabPickerMenu").hidden = !tabPickerOpen;
    if (tabPickerOpen) await loadTitleTabs();
    positionWidget();
  }

  async function handleWidgetAllTabsChange(event) {
    const enabled = event.target.checked === true;
    const response = await callRuntime({
      type: "PRIVACY_LENS_SET_ALL_TABS_TITLE_PRIVACY",
      enabled
    });
    if (!response || !response.ok) return;
    titleTabs = response;
    renderWidgetTitleTabs();
    showStatus(enabled ? "Every accessible tab is Top Secret" : "All tab titles restored");
  }

  async function handleWidgetTabChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-widget-tab-id]")) return;
    const response = await callRuntime({
      type: "PRIVACY_LENS_SET_TAB_TITLE_PRIVACY",
      tabId: Number(input.dataset.widgetTabId),
      enabled: input.checked
    });
    if (!response || !response.ok) {
      await loadTitleTabs();
      return;
    }
    titleTabs = response;
    renderWidgetTitleTabs();
    showStatus(input.checked ? "Selected tab marked Top Secret" : "Selected tab title restored");
  }

  async function updateState(patch, statusMessage, options = {}) {
    state = PrivacyLens.Settings.sanitizePageState({ ...state, ...patch }, settings);
    engine.applyState(state);
    renderWidget();
    await callRuntime({ type: "PRIVACY_LENS_APPLY_TO_TAB", state, syncTitleSelection: true });
    if (Object.prototype.hasOwnProperty.call(patch, "titleProtected") && tabPickerOpen) {
      await loadTitleTabs();
    }
    if (rememberSite) await persistCurrentSiteRule();
    if (statusMessage && !options.quiet) showStatus(statusMessage);
  }

  async function toggleAllLayers() {
    const allEnabled = state.imagesProtected && state.blurEnabled && state.sensitiveMasked && state.titleProtected;
    await updateState({
      imagesProtected: !allEnabled,
      blurEnabled: !allEnabled,
      sensitiveMasked: !allEnabled,
      titleProtected: !allEnabled
    }, allEnabled ? "Every privacy layer removed" : "Full page shield engaged");
  }

  async function resetPage() {
    state = PrivacyLens.Settings.defaultPageState(settings);
    engine.reset(state);
    renderWidget();
    await callRuntime({ type: "PRIVACY_LENS_RESET_TAB", syncTitleSelection: true });
    if (tabPickerOpen) await loadTitleTabs();
    if (rememberSite) await persistCurrentSiteRule();
    showStatus("Page restored");
  }

  async function setRememberSite(value) {
    rememberSite = value === true;
    const savedSites = { ...settings.savedSites };
    if (rememberSite && hostname) savedSites[hostname] = PrivacyLens.Settings.sanitizePageState(state, settings);
    else delete savedSites[hostname];
    settings = await settingsStore.save({ savedSites });
    renderWidget();
    showStatus(rememberSite ? "This site rule is saved locally" : "Saved site rule removed");
  }

  async function persistCurrentSiteRule() {
    if (!hostname) return;
    settings = await settingsStore.save({
      savedSites: {
        ...settings.savedSites,
        [hostname]: PrivacyLens.Settings.sanitizePageState(state, settings)
      }
    });
  }

  function renderWidget() {
    if (!widgetRoot || !engine) return;
    const engineState = engine.getState();
    const activeCount = [state.imagesProtected, state.blurEnabled, state.sensitiveMasked, state.titleProtected].filter(Boolean).length;
    const allEnabled = activeCount === 4;

    getWidgetElement("statusLabel").textContent = activeCount ? "Privacy layer active" : "Page is clear";
    getWidgetElement("statusDetail").textContent = activeCount
      ? `${activeCount} of 4 shields engaged`
      : "No privacy layers active";
    getWidgetElement("protectAllButton").classList.toggle("is-active", allEnabled);
    getWidgetElement("protectAllButton").querySelector("span").textContent = allEnabled ? "Reveal all" : "Shield all";
    widgetRoot.querySelector(".lens").classList.toggle("has-protection", activeCount > 0);

    renderToggle(
      "imagesButton",
      state.imagesProtected,
      "imagesState",
      state.imagesProtected
        ? ({ hidden: "Hidden", stamp: "Black + stamp", blur: `${state.blurStrength}px`, nsfw: "NSFW check" })[state.imageTreatment]
        : "Shown"
    );
    renderToggle("blurButton", state.blurEnabled, "blurState", state.blurEnabled ? `${state.blurStrength}px` : "Off");
    renderToggle(
      "maskButton",
      state.sensitiveMasked,
      "maskState",
      state.sensitiveMasked ? (state.textTreatment === "blur" ? "Blurred" : "Redacted") : "Visible"
    );
    renderToggle("titleButton", state.titleProtected, "titleState", state.titleProtected ? "Neutral" : "Original");

    const blurStrength = getWidgetElement("blurStrength");
    blurStrength.value = String(state.blurStrength);
    getWidgetElement("blurStrengthValue").textContent = `${state.blurStrength}px`;
    getWidgetElement("detailsSummary").textContent = `${state.blurStrength}px / ${state.textTreatment}`;
    getWidgetElement("rememberSite").checked = rememberSite;
    getWidgetElement("matchCount").textContent = `${engineState.maskCount} masked`;
    widgetRoot.querySelectorAll("[data-treatment]").forEach((button) => {
      const active = button.dataset.treatment === state.blurTreatment;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    widgetRoot.querySelectorAll("[data-image-treatment]").forEach((button) => {
      const active = button.dataset.imageTreatment === state.imageTreatment;
      const requiresApi = button.dataset.imageTreatment === "nsfw";
      button.disabled = requiresApi && !settings.nsfwFilterEnabled;
      button.title = button.disabled ? "Enable the optional NSFW API in Settings first." : "";
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    widgetRoot.querySelectorAll("[data-text-treatment]").forEach((button) => {
      const active = button.dataset.textTreatment === state.textTreatment;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderWidgetTitleTabs();
  }

  function renderWidgetTitleTabs() {
    if (!widgetRoot) return;
    const list = getWidgetElement("widgetTabList");
    const allToggle = getWidgetElement("widgetAllTabsTitle");
    if (!list || !allToggle) return;
    allToggle.checked = titleTabs.allTabsProtected === true;
    const protectedCount = titleTabs.tabs.filter((tab) => tab.protected).length;
    getWidgetElement("tabPickerSummary").textContent = titleTabs.allTabsProtected
      ? "All accessible tabs"
      : protectedCount
        ? `${protectedCount} selected`
        : "Choose tabs";
    list.replaceChildren();

    const accessibleTabs = titleTabs.tabs.filter((tab) => tab.accessible);
    if (!accessibleTabs.length) {
      const empty = document.createElement("p");
      empty.className = "widget-tab-empty";
      empty.textContent = "No ordinary webpage tabs are available.";
      list.appendChild(empty);
      return;
    }

    accessibleTabs.forEach((tab) => {
      const row = document.createElement("label");
      row.className = "widget-tab-row";
      row.classList.toggle("is-active", tab.protected === true);
      const copy = document.createElement("span");
      copy.className = "widget-tab-copy";
      const title = document.createElement("strong");
      title.textContent = tab.title || "Untitled tab";
      const host = document.createElement("small");
      host.textContent = tab.hostname || "This page";
      copy.append(title, host);
      const check = document.createElement("span");
      check.className = "widget-tab-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.widgetTabId = String(tab.id);
      input.checked = tab.protected === true;
      input.disabled = titleTabs.allTabsProtected === true;
      const control = document.createElement("i");
      check.append(input, control);
      row.append(copy, check);
      list.appendChild(row);
    });
  }

  function renderToggle(buttonId, active, stateId, label) {
    const button = getWidgetElement(buttonId);
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    getWidgetElement(stateId).textContent = label;
  }

  function toggleWidget() {
    if (widgetVisible) hideWidget();
    else showWidget();
  }

  function showWidget() {
    widgetVisible = true;
    widgetHost.hidden = false;
    widgetHost.style.display = "block";
    positionWidget();
    renderWidget();
    loadTitleTabs().catch(() => undefined);
  }

  function hideWidget() {
    widgetVisible = false;
    widgetHost.hidden = true;
    widgetHost.style.display = "none";
  }

  async function closeWidget() {
    if (settings.resetOnClose) await resetPage();
    hideWidget();
  }

  function setWidgetExpanded(value) {
    widgetExpanded = value === true;
    const toggle = getWidgetElement("detailsToggle");
    const panel = getWidgetElement("detailsPanel");
    toggle.setAttribute("aria-expanded", String(widgetExpanded));
    panel.hidden = !widgetExpanded;
    if (!widgetExpanded) {
      tabPickerOpen = false;
      getWidgetElement("tabPickerToggle").setAttribute("aria-expanded", "false");
      getWidgetElement("tabPickerMenu").hidden = true;
    }
    positionWidget();
  }

  function positionWidget() {
    if (!widgetHost || !widgetVisible && widgetHost.hidden) return;
    const width = Math.min(400, Math.max(0, window.innerWidth - 48));
    const height = widgetHost.offsetHeight || (widgetExpanded ? 720 : 350);
    const saved = settings.widgetPosition;

    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      widgetHost.style.left = `${clamp(saved.left, 12, Math.max(12, window.innerWidth - width - 12))}px`;
      widgetHost.style.top = `${clamp(saved.top, 12, Math.max(12, window.innerHeight - height - 12))}px`;
      widgetHost.style.right = "auto";
      widgetHost.style.bottom = "auto";
      return;
    }

    if (window.innerWidth <= 480 || height >= window.innerHeight - 36) {
      widgetHost.style.top = "12px";
      widgetHost.style.bottom = "auto";
      widgetHost.style.left = settings.widgetSide === "left" ? "14px" : "auto";
      widgetHost.style.right = settings.widgetSide === "right" ? "14px" : "auto";
      return;
    }

    widgetHost.style.top = "auto";
    widgetHost.style.bottom = "18px";
    widgetHost.style.left = settings.widgetSide === "left" ? "18px" : "auto";
    widgetHost.style.right = settings.widgetSide === "right" ? "18px" : "auto";
  }

  function startDragging(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = widgetHost.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.addEventListener("pointermove", dragWidget);
    event.currentTarget.addEventListener("pointerup", stopDragging, { once: true });
    event.currentTarget.addEventListener("pointercancel", stopDragging, { once: true });
  }

  function dragWidget(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const rect = widgetHost.getBoundingClientRect();
    const left = clamp(dragState.left + event.clientX - dragState.startX, 12, Math.max(12, innerWidth - rect.width - 12));
    const top = clamp(dragState.top + event.clientY - dragState.startY, 12, Math.max(12, innerHeight - rect.height - 12));
    widgetHost.style.left = `${left}px`;
    widgetHost.style.top = `${top}px`;
    widgetHost.style.right = "auto";
    widgetHost.style.bottom = "auto";
  }

  async function stopDragging(event) {
    event.currentTarget.removeEventListener("pointermove", dragWidget);
    dragState = null;
    const rect = widgetHost.getBoundingClientRect();
    settings = await settingsStore.save({ widgetPosition: { left: rect.left, top: rect.top } });
  }

  async function handleStorageChange(changes, areaName) {
    if (areaName !== "local" || !changes[PrivacyLens.Settings.SETTINGS_KEY]) return;
    const previousApiSignature = `${settings.nsfwFilterEnabled}:${settings.nsfwApiUrl}:${settings.nsfwApiToken}`;
    settings = PrivacyLens.Settings.sanitizeSettings(changes[PrivacyLens.Settings.SETTINGS_KEY].newValue);
    const nextApiSignature = `${settings.nsfwFilterEnabled}:${settings.nsfwApiUrl}:${settings.nsfwApiToken}`;
    engine.setNeutralTitle(settings.neutralTitle);
    engine.setRedactionOptions(getRedactionOptions(settings));
    if (state.imagesProtected && state.imageTreatment === "nsfw") {
      if (!settings.nsfwFilterEnabled) {
        state = PrivacyLens.Settings.sanitizePageState({ ...state, imageTreatment: "blur" }, settings);
        engine.applyState(state);
      } else if (previousApiSignature !== nextApiSignature) {
        engine.applyState({ ...state, imagesProtected: false });
        engine.applyState(state);
      }
    }
    rememberSite = Boolean(hostname && settings.savedSites[hostname]);
    positionWidget();
    renderWidget();
  }

  function showStatus(message) {
    const toast = getWidgetElement("toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 1700);
  }

  function getWidgetElement(id) {
    return widgetRoot.getElementById(id);
  }

  function callRuntime(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function assetUrl(path) {
    return chrome.runtime.getURL(path);
  }

  function getRedactionOptions(value) {
    return {
      enabledTypes: value.redactionTypes,
      customTerms: value.customTerms,
      customRegexRules: value.customRegexRules
    };
  }

  async function classifyImageRemotely(sourceUrl) {
    const response = await callRuntime({
      type: "PRIVACY_LENS_CLASSIFY_IMAGE",
      sourceUrl
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Image classification failed.");
    }
    return response;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function widgetStyles() {
    return `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      button, input, output { font: inherit; }
      button { color: inherit; }
      .lens {
        --ink: #f2f0e8;
        --muted: #8e9a93;
        --line: #28332d;
        --surface: #0a0f0d;
        --surface-up: #101813;
        --acid: #a7ff83;
        --aqua: #63d7c7;
        position: relative;
        width: 100%;
        overflow: visible;
        color: var(--ink);
        border: 1px solid #34433a;
        border-radius: 12px;
        background:
          radial-gradient(circle at 78% 0%, rgba(99, 215, 199, .1), transparent 34%),
          linear-gradient(180deg, #0c120f, #080c0a);
        box-shadow: 0 24px 64px rgba(0, 0, 0, .48), 0 0 0 1px rgba(167, 255, 131, .04) inset;
        font-family: "Avenir Next", "Trebuchet MS", sans-serif;
        font-size: 12px;
        letter-spacing: 0;
      }
      .lens::before { position: absolute; inset: 0; content: ""; border-radius: inherit; background-image: radial-gradient(rgba(167,255,131,.08) .7px, transparent .7px); background-size: 9px 9px; opacity: .32; pointer-events: none; }
      .lens-header, .brand, .header-tools, .status-band, .detail-heading, .remember-row, .detection-row, .lens-footer { display: flex; align-items: center; }
      .lens-header { position: relative; z-index: 1; justify-content: space-between; min-height: 50px; padding: 7px 8px 7px 10px; border-bottom: 1px solid var(--line); cursor: grab; user-select: none; }
      .lens-header:active { cursor: grabbing; }
      .brand { min-width: 0; gap: 8px; }
      .brand > img { width: 31px; height: 31px; flex: 0 0 auto; }
      .brand > span { min-width: 0; display: grid; gap: 2px; }
      .brand strong { font-size: 12px; line-height: 1; font-weight: 800; }
      .brand small { max-width: 152px; overflow: hidden; color: #718078; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 8px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
      .header-tools { gap: 3px; }
      .local-dot { width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: var(--acid); box-shadow: 0 0 10px rgba(167,255,131,.55); }
      .icon-button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; color: #a8b2ac; border: 1px solid transparent; border-radius: 6px; background: transparent; cursor: pointer; }
      .icon-button:hover, .icon-button:focus-visible { color: var(--ink); border-color: #405047; background: #152019; outline: none; }
      .icon-button img { width: 14px; height: 14px; filter: invert(88%) sepia(7%) saturate(225%) hue-rotate(92deg); }
      .status-band { position: relative; z-index: 1; min-height: 68px; gap: 10px; padding: 10px 11px; border-bottom: 1px solid var(--line); }
      .lens-orbit { position: relative; width: 35px; height: 35px; flex: 0 0 auto; border: 1px solid #3a4941; border-radius: 50%; background: #0e1511; }
      .lens-orbit::before, .lens-orbit::after { position: absolute; inset: 6px; content: ""; border: 1px solid #3a4941; border-radius: 50%; }
      .lens-orbit::after { inset: 14px; border: 0; background: #5e6963; }
      .has-protection .lens-orbit { border-color: var(--acid); box-shadow: 0 0 16px rgba(167,255,131,.14); }
      .has-protection .lens-orbit::before { border-color: rgba(99,215,199,.72); }
      .has-protection .lens-orbit::after { background: var(--acid); box-shadow: 0 0 8px rgba(167,255,131,.6); }
      .status-copy { min-width: 0; display: grid; flex: 1; gap: 3px; }
      .status-copy strong { font-size: 12px; font-weight: 780; }
      .status-copy span { color: var(--muted); font-size: 9px; }
      .shield-button { display: inline-flex; align-items: center; gap: 5px; min-height: 29px; padding: 0 9px; color: #0a0f0d; border: 1px solid var(--acid); border-radius: 6px; background: var(--acid); font-size: 9px; font-weight: 800; cursor: pointer; }
      .shield-button.is-active { color: var(--acid); background: transparent; }
      .shield-button:hover { filter: brightness(.9); }
      .shield-button img { width: 13px; height: 13px; }
      .shield-button.is-active img { filter: invert(92%) sepia(42%) saturate(638%) hue-rotate(45deg); }
      .quick-grid { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; padding: 10px; }
      .quick-control { min-width: 0; min-height: 65px; padding: 7px 3px 6px; display: grid; place-items: center; align-content: center; gap: 4px; color: #a1aca6; border: 1px solid #29362f; border-radius: 7px; background: rgba(13, 20, 16, .86); cursor: pointer; }
      .quick-control:hover, .quick-control:focus-visible { border-color: #506158; background: #131e18; outline: none; }
      .quick-control.is-active { color: var(--ink); border-color: rgba(167,255,131,.62); background: linear-gradient(180deg, rgba(167,255,131,.12), rgba(99,215,199,.06)); box-shadow: 0 0 0 1px rgba(167,255,131,.05) inset; }
      .quick-control img { width: 17px; height: 17px; filter: invert(69%) sepia(8%) saturate(339%) hue-rotate(94deg); }
      .quick-control.is-active img { filter: invert(93%) sepia(34%) saturate(738%) hue-rotate(44deg); }
      .quick-control span { font-size: 9px; font-weight: 760; white-space: nowrap; }
      .quick-control small { color: #66736c; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 7px; text-transform: uppercase; }
      .quick-control.is-active small { color: var(--aqua); }
      .details-toggle { position: relative; z-index: 1; width: 100%; min-height: 34px; padding: 0 11px; display: grid; grid-template-columns: 1fr auto 14px; align-items: center; gap: 8px; color: #a5afa9; border: 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: rgba(10,15,13,.72); text-align: left; cursor: pointer; }
      .details-toggle:hover { color: var(--ink); background: #111a15; }
      .details-toggle > span { font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      .details-toggle small { color: #68756e; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 8px; }
      .details-toggle img { width: 13px; height: 13px; filter: invert(70%); transition: transform 130ms ease; }
      .details-toggle[aria-expanded="true"] img { transform: rotate(180deg); }
      .details-panel[hidden] { display: none; }
      .details-panel { position: relative; z-index: 1; padding: 1px 11px 3px; background: rgba(12,18,15,.94); }
      .detail-row { padding: 10px 0; border-bottom: 1px solid #202c25; }
      .detail-heading { justify-content: space-between; margin-bottom: 7px; }
      .detail-heading label, .detail-label { color: #bac2bd; font-size: 9px; font-weight: 750; }
      .detail-heading output { color: var(--acid); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 9px; }
      input[type="range"] { width: 100%; height: 16px; margin: 0; accent-color: var(--acid); cursor: pointer; }
      .treatment-selector { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 7px; }
      .treatment-selector button { min-height: 29px; color: #88958e; border: 1px solid #2c3a32; border-radius: 5px; background: #0d1410; font-size: 9px; font-weight: 700; cursor: pointer; }
      .treatment-selector button.is-active { color: #09100c; border-color: var(--aqua); background: var(--aqua); }
      .remember-row { justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid #202c25; cursor: pointer; }
      .remember-row > span:first-child { display: grid; gap: 3px; }
      .remember-row strong { font-size: 9px; }
      .remember-row small { color: #738078; font-size: 8px; }
      .switch { position: relative; width: 34px; height: 19px; flex: 0 0 auto; }
      .switch input { position: absolute; opacity: 0; }
      .switch i { position: absolute; inset: 0; border: 1px solid #49574f; border-radius: 11px; background: #151e19; }
      .switch i::after { position: absolute; top: 3px; left: 3px; width: 11px; height: 11px; content: ""; border-radius: 50%; background: #718078; transition: transform 130ms ease, background 130ms ease; }
      .switch input:checked + i { border-color: var(--acid); background: var(--acid); }
      .switch input:checked + i::after { background: #07100a; transform: translateX(15px); }
      .switch input:focus-visible + i { outline: 2px solid var(--aqua); outline-offset: 2px; }
      .detection-row { justify-content: space-between; min-height: 31px; color: #77837c; font-size: 8px; }
      .detection-row strong { color: var(--aqua); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-weight: 600; }
      .lens-footer { position: relative; z-index: 1; display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px; min-height: 39px; padding: 6px 10px; }
      .lens-footer button { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; padding: 0 9px; color: #b9c1bc; border: 1px solid #36443c; border-radius: 5px; background: #101713; font-size: 9px; font-weight: 740; cursor: pointer; }
      .lens-footer button:hover { color: #07100a; border-color: var(--ink); background: var(--ink); }
      .lens-footer button img { width: 12px; height: 12px; filter: invert(80%); }
      .lens-footer button:hover img { filter: none; }
      .footer-links { justify-self: end; display: grid; justify-items: end; gap: 2px; color: #7e8b84; font-size: 9px; font-weight: 760; line-height: 1.15; text-align: right; }
      .footer-links a { color: inherit; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
      .footer-links a:hover, .footer-links a:focus-visible { color: var(--ink); outline: none; }
      .footer-resource-links { display: inline-flex; align-items: center; justify-content: flex-end; gap: 5px; }
      .footer-resource-links i { font-style: normal; opacity: .7; }
      .toast { position: absolute; right: 0; bottom: calc(100% + 8px); left: 0; z-index: 4; padding: 8px 10px; color: #07100a; border: 1px solid var(--acid); border-radius: 7px; background: var(--acid); box-shadow: 0 12px 28px rgba(0,0,0,.34); font-size: 9px; font-weight: 800; text-align: center; opacity: 0; pointer-events: none; transform: translateY(5px); transition: opacity 130ms ease, transform 130ms ease; }
      .toast.is-visible { opacity: 1; transform: translateY(0); }
      /* Manila dossier theme */
      .lens {
        --ink: #221b12;
        --muted: #6e5c43;
        --line: #9d7d4e;
        --surface: #dbc397;
        --surface-up: #ead9b6;
        --acid: #a20f0f;
        --aqua: #a20f0f;
        max-height: calc(100vh - 24px);
        overflow-x: hidden;
        overflow-y: auto;
        color: var(--ink);
        border: 1px solid #76592f;
        border-radius: 4px;
        background:
          linear-gradient(94deg, transparent 0 48%, rgba(91,58,20,.05) 49%, transparent 50%),
          repeating-linear-gradient(0deg, rgba(87,59,27,.028) 0 1px, transparent 1px 5px),
          #d9bf8e;
        box-shadow: 0 22px 55px rgba(32,20,7,.42), inset 0 0 34px rgba(99,65,22,.08);
        font-family: Rockwell, "Roboto Slab", Georgia, serif;
      }
      .lens::before { border-radius: 0; background-image: radial-gradient(rgba(72,45,18,.15) .55px, transparent .7px); background-size: 7px 7px; opacity: .22; }
      .lens-header { min-height: 55px; padding: 7px 8px 7px 10px; border-bottom-color: var(--line); background: rgba(230,211,173,.4); }
      .brand > img { width: 35px; height: 35px; }
      .brand strong { color: #241a0e; font-size: 13px; letter-spacing: .01em; }
      .brand small { color: #745d3c; font-family: "Courier New", Courier, monospace; font-size: 7px; letter-spacing: .06em; }
      .classification { margin-right: 2px; padding: 3px 5px 2px; color: #a20f0f; border: 1.5px solid currentColor; font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif; font-size: 8px; letter-spacing: .08em; line-height: 1; transform: rotate(-4deg); }
      .icon-button { color: #49371f; border-radius: 2px; }
      .icon-button:hover, .icon-button:focus-visible { color: #8f0d0d; border-color: #8f0d0d; background: #ead7b0; }
      .icon-button img, .details-toggle img, .tab-picker-toggle img { filter: sepia(1) saturate(.8) brightness(.42); }
      .status-band { min-height: 70px; border-bottom-color: var(--line); background: rgba(205,177,124,.24); }
      .status-stamp { width: 38px; height: 38px; display: grid; place-items: center; flex: 0 0 auto; color: #7c6a4c; border: 2px solid currentColor; font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif; font-size: 16px; line-height: 1; transform: rotate(-7deg); }
      .has-protection .status-stamp { color: #a20f0f; box-shadow: inset 0 0 0 1px currentColor; }
      .status-copy strong { color: #2c2114; font-size: 12px; }
      .status-copy span { color: var(--muted); font-family: "Courier New", Courier, monospace; font-size: 8px; }
      .shield-button { color: #f7e9cc; border-color: #8e0c0c; border-radius: 2px; background: #9d0f0f; }
      .shield-button.is-active { color: #8e0c0c; border-color: #8e0c0c; background: transparent; }
      .shield-button img, .shield-button.is-active img { filter: none; }
      .quick-grid { gap: 6px; padding: 10px; }
      .quick-control { color: #58462e; border-color: #a7895d; border-radius: 2px; background: rgba(234,216,178,.56); }
      .quick-control:hover, .quick-control:focus-visible { border-color: #6f512b; background: #edddb9; }
      .quick-control.is-active { color: #301c0d; border-color: #a20f0f; background: rgba(162,15,15,.08); box-shadow: inset 0 -3px 0 rgba(162,15,15,.15); }
      .quick-control img, .quick-control.is-active img { filter: sepia(1) saturate(.8) brightness(.35); }
      .quick-control small, .quick-control.is-active small { color: #8f0d0d; font-family: "Courier New", Courier, monospace; }
      .details-toggle { color: #4d3c26; border-color: var(--line); background: rgba(183,145,88,.16); }
      .details-toggle:hover { color: #8f0d0d; background: rgba(239,222,187,.72); }
      .details-toggle small { color: #8a6c44; font-family: "Courier New", Courier, monospace; }
      .details-panel { padding: 1px 11px 3px; background: rgba(229,208,168,.72); }
      .detail-row { border-bottom-color: rgba(111,79,38,.26); }
      .detail-heading label, .detail-label { color: #4e3b24; }
      .detail-heading output, .detection-row strong { color: #9b0d0d; font-family: "Courier New", Courier, monospace; }
      input[type="range"] { accent-color: #a20f0f; }
      .treatment-selector button { color: #655036; border-color: #9e8056; border-radius: 2px; background: #e7d2aa; }
      .treatment-selector[aria-label="Image privacy treatment"] { grid-template-columns: repeat(2, 1fr); }
      .treatment-selector button.is-active { color: #f9eacc; border-color: #8e0c0c; background: #9d0f0f; }
      .treatment-selector button:disabled { color: #8b7557; border-color: #b29a74; background: rgba(198,168,115,.4); cursor: not-allowed; opacity: .72; }
      .remember-row, .widget-all-tabs { border-bottom-color: rgba(111,79,38,.25); }
      .remember-row strong, .widget-all-tabs strong { color: #392919; }
      .remember-row small, .widget-all-tabs small { color: #776043; }
      .switch i { border-color: #8d7049; background: #c6a873; }
      .switch i::after { background: #725734; }
      .switch input:checked + i { border-color: #8e0c0c; background: #9d0f0f; }
      .switch input:checked + i::after { background: #f6e7c8; }
      .switch input:focus-visible + i { outline-color: #a20f0f; }
      .detection-row { color: #735d40; }
      .lens-footer { background: rgba(190,154,99,.12); }
      .lens-footer button { color: #4c3821; border-color: #8e7049; border-radius: 2px; background: #e4cea4; }
      .lens-footer button:hover { color: #f8e8c8; border-color: #8e0c0c; background: #9d0f0f; }
      .lens-footer button img, .lens-footer button:hover img { filter: sepia(1) saturate(.8) brightness(.35); }
      .footer-links { color: #725938; }
      .footer-links a:hover, .footer-links a:focus-visible { color: #8f0d0d; }
      .tab-picker { padding-bottom: 7px; }
      .tab-picker-toggle { width: 100%; min-height: 35px; padding: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #302316; border: 0; background: transparent; text-align: left; cursor: pointer; }
      .tab-picker-toggle > span { min-width: 0; display: grid; gap: 2px; }
      .tab-picker-toggle strong { font-size: 9px; }
      .tab-picker-toggle small { color: #8d0d0d; font-family: "Courier New", Courier, monospace; font-size: 8px; }
      .tab-picker-toggle img { width: 13px; height: 13px; transition: transform 130ms ease; }
      .tab-picker-toggle[aria-expanded="true"] img { transform: rotate(180deg); }
      .tab-picker-menu[hidden] { display: none; }
      .tab-picker-menu { margin-top: 5px; border: 1px solid #967749; background: rgba(239,222,188,.72); }
      .widget-all-tabs { min-height: 48px; padding: 7px 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
      .widget-all-tabs > span:first-child { display: grid; gap: 2px; }
      .widget-all-tabs strong { font-size: 9px; }
      .widget-all-tabs small { font-size: 7px; }
      .widget-tab-list { max-height: 150px; overflow-y: auto; }
      .widget-tab-row { min-height: 44px; padding: 6px 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid rgba(121,89,47,.22); cursor: pointer; }
      .widget-tab-row:last-child { border-bottom: 0; }
      .widget-tab-row.is-active { background: rgba(162,15,15,.08); }
      .widget-tab-copy { min-width: 0; display: grid; gap: 2px; }
      .widget-tab-copy strong, .widget-tab-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .widget-tab-copy strong { color: #352719; font-size: 8px; }
      .widget-tab-copy small { color: #796044; font-family: "Courier New", Courier, monospace; font-size: 7px; }
      .widget-tab-check { position: relative; width: 18px; height: 18px; flex: 0 0 auto; }
      .widget-tab-check input { position: absolute; opacity: 0; }
      .widget-tab-check i { position: absolute; inset: 0; display: grid; place-items: center; border: 1px solid #80623c; background: #e7d2a9; }
      .widget-tab-check i::after { color: #f9e8c7; content: "✓"; font-size: 11px; font-style: normal; font-weight: 900; opacity: 0; }
      .widget-tab-check input:checked + i { border-color: #8e0c0c; background: #9d0f0f; }
      .widget-tab-check input:checked + i::after { opacity: 1; }
      .widget-tab-check input:disabled + i { opacity: .58; }
      .widget-tab-empty { margin: 0; padding: 11px; color: #765f40; font-size: 8px; text-align: center; }
      .toast { color: #f8e9c9; border-color: #7e0909; border-radius: 2px; background: #9d0f0f; }
      /* Readable dossier scale */
      .lens { font-size: 16px; }
      .brand strong { font-size: 18px; }
      .brand small { max-width: 186px; font-size: 12px; }
      .classification { font-size: 11px; }
      .status-copy strong { font-size: 17px; }
      .status-copy span { font-size: 13px; }
      .shield-button { min-height: 38px; font-size: 13px; }
      .quick-control { min-height: 78px; }
      .quick-control span { font-size: 13px; }
      .quick-control small { font-size: 10px; }
      .details-toggle { min-height: 44px; }
      .details-toggle > span { font-size: 13px; }
      .details-toggle small { font-size: 11px; }
      .detail-heading label, .detail-label, .detail-heading output { font-size: 13px; }
      .treatment-selector button { min-height: 38px; font-size: 13px; }
      .remember-row strong, .widget-all-tabs strong, .tab-picker-toggle strong { font-size: 13px; }
      .remember-row small, .widget-all-tabs small, .tab-picker-toggle small { font-size: 11px; }
      .detection-row { min-height: 40px; font-size: 12px; }
      .widget-tab-copy strong { font-size: 12px; }
      .widget-tab-copy small, .widget-tab-empty { font-size: 11px; }
      .lens-footer button { min-height: 36px; font-size: 13px; }
      .footer-links { font-size: 10px; }
      .toast { font-size: 13px; }
      @media (max-width: 480px), (max-height: 840px) {
        .lens { max-height: calc(100vh - 28px); overflow-x: hidden; overflow-y: auto; }
        .toast { position: sticky; right: auto; bottom: 0; left: auto; display: none; transform: none; }
        .toast.is-visible { display: block; }
      }
      @media (max-width: 350px) { .brand small { max-width: 120px; } .shield-button span { display: none; } .shield-button { width: 30px; justify-content: center; padding: 0; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
    `;
  }
})();
