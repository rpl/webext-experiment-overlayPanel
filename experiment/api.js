const {utils: Cu} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.importGlobalProperties(["URL"]);

XPCOMUtils.defineLazyModuleGetter(this, "ExtensionParent",
                                  "resource://gre/modules/ExtensionParent.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "EventEmitter",
                                  "resource://gre/modules/EventEmitter.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "CustomizableUI",
                                  "resource:///modules/CustomizableUI.jsm");

const {Management} = Cu.import("resource://gre/modules/Extension.jsm", {});
const {ExtensionUtils} = Cu.import("resource://gre/modules/ExtensionUtils.jsm", {});
const {ConsoleAPI} = Cu.import("resource://gre/modules/Console.jsm", {});

const console = new ConsoleAPI({
  prefix: "webext-experiment-overlayPanels",
});

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

const {
  SingletonEventManager,
  SpreadArgs,
  IconDetails,
} = ExtensionUtils;

const {
  makeWidgetId,
  TabContext,
  windowTracker,
} = Management.global;

class API extends ExtensionAPI {
  getAPI(context) {
    return {
      overlayPanels: {
      }
    };
  }
}

const openedOverlayPanelWindows = new WeakSet();

class OverlayPanel {
  constructor(extension, defaults) {
    const widgetId = makeWidgetId(extension.id);

    this.extension = extension;
    this.id = `${widgetId}-webext-overlay-panel`;
    this.defaults = defaults;
    this.keysetId = `ext-keyset-id-${widgetId}`;
    this.browserActionId = `${widgetId}-browser-action`;

    this.onTabSelect = this.onTabSelect.bind(this);
    this.onWindowOpen = this.onWindowOpen.bind(this);
    this.tabContext = new TabContext(tab => Object.create(this.defaults),
                                     extension);
  }

  build() {
    console.log("BUILD OVERLAY PANEL", this.id);

    this.tabContext.on("tab-select", this.onTabSelect);
    for (let window of windowTracker.browserWindows()) {
      this._updateForWindow(window);
    }

    windowTracker.addOpenListener(this.onWindowOpen);
  }

  shutdown() {
    console.log("DESTROY OVERLAY PANEL", this.id);

    this.tabContext.shutdown();
    windowTracker.removeOpenListener(this.onWindowOpen);
    for (let window of windowTracker.browserWindows()) {
      let {document} = window;
      let panelEl = document.getElementById(this.id);

      if (panelEl) {
        panelEl.remove();
      }
    }
  }

  onWindowOpen(window) {
    this._updateForWindow(window);
  }

  onTabSelect(evt, tab) {
    this._updateForWindow(tab.ownerGlobal);
  }

  toggleOverlayPanel(window) {
    let {document} = window;
    let panelEl = document.getElementById(this.id);

    if (openedOverlayPanelWindows.has(window)) {
      // Filter out the call if the popup is already opened.
      panelEl.hidePopup();
      return;
    }

    openedOverlayPanelWindows.add(window);

    const tab = window.gBrowser.selectedTab;
    const tabData = this.tabContext.get(tab) || this.defaults;
    const anchor = document.getElementById("content").selectedBrowser;
    const {width, height} = anchor.getBoundingClientRect();

    panelEl.addEventListener("popuphidden", () => {
      console.log("POPUP hidden");
      browser.loadURI("about:blank");
      browser.remove();
      openedOverlayPanelWindows.delete(window);
    }, {once: true});

    panelEl.appendChild(this._createPanelBrowser(document, tabData));
    panelEl.openPopup(anchor, "overlap", 32, 32, false, true);
    panelEl.sizeTo(width - 64, height - 64);

    let browser = document.getElementById("inner-" + this.id);
    browser.loadURI(this.extension.baseURI.resolve(this.defaults.default_panel));
    browser.frameLoader.messageManager.loadFrameScript("chrome://browser/content/content.js", true);
    ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
  }

  _updateForWindow(window) {
    let tab = window.gBrowser.selectedTab;
    this._updateOverlayPanel(window, this.tabContext.get(tab));
  }

  _updateOverlayPanel(window, tabData) {
    let {document} = window;
    let title = tabData.title || this.extension.name;
    let panelEl = document.getElementById(this.id);
    if (!panelEl) {
      panelEl = this._createOverlayPanel(window, tabData);

      // HACK: simulate hook overlay panel show to command.
      const extensionKeyset = document.getElementById(this.keysetId);
      extensionKeyset.addEventListener("command", (evt) => {
        console.log("KEYSET COMMAND RECEIVED", evt.target);
        this.toggleOverlayPanel(window);
      });

      // HACK: simulate hook overlay panel show to browser action.
      const {anchor} = CustomizableUI.getWidget(this.browserActionId).forWindow(window);
      anchor.addEventListener("command", (evt) => {
        console.log("BROWSER ACTION CLICKED", evt.target);
        this.toggleOverlayPanel(window);
      });
    }
  }

  _createPanelTitlebox(document, details, onCloseButton) {
    const {
      icon, size
    } = IconDetails.getPreferredIcon(this.extension.manifest.icons || {
      "16": "chrome://mozapps/skin/extensions/extensionGeneric.svg",
    }, this.extension, 16);

    const titleBox = document.createElementNS(XUL_NS, "hbox");
    titleBox.setAttribute("style", "border: 1px solid black; height: 24px; background: red;");

    const iconEl = document.createElementNS(XUL_NS, "image");
    iconEl.setAttribute("style", `list-style-image: url(${icon}); padding: 2px; margin-left: -2px;`);

    const labelEl = document.createElementNS(XUL_NS, "label");
    labelEl.setAttribute("style", "text-align: center;");
    labelEl.setAttribute("flex", 1);
    labelEl.textContent = details.default_title || this.extension.name;

    titleBox.appendChild(iconEl);
    titleBox.appendChild(labelEl);

    if (details.no_autohide) {
      const closeEl = document.createElementNS(XUL_NS, "toolbarbutton");
      closeEl.setAttribute("class", "close-icon");
      closeEl.setAttribute("style", "margin-right: 2px;");
      closeEl.addEventListener("click", onCloseButton);
      titleBox.appendChild(closeEl);
    }

    return titleBox;
  }

  _createPanelBrowser(document, details) {
    // TODO: set remote and remoteType attributes
    const browser = document.createElementNS(XUL_NS, "browser");
    browser.setAttribute("id", "inner-" + this.id);
    browser.setAttribute("type", "content");
    //browser.setAttribute("transparent", "true");
    browser.setAttribute("webextension-view-type", "panel");
    browser.setAttribute("context", "contentAreaContextMenu");
    browser.setAttribute("tooltip", "aHTMLTooltip");
    browser.setAttribute("flex", "1");
    browser.setAttribute("style", "border: none !important; -moz-appearance: none !important; overflow: hidden; background: transparent;");

    return browser;
  }

  _createOverlayPanel(window, details) {
    const {document} = window;
    if (!details || !details.panel) {
      details = this.defaults;
    }

    const panel = document.createElementNS(XUL_NS, "panel");
    panel.setAttribute("id", this.id);
    // NOTE: "-moz-appearance: none !important;" would hide the border, but it seems to break
    // the panel  transparency and its positioning on some Linux windows manager,
    // and transparency doesn't seem to work with noautohide disabled.
    panel.setAttribute("transparent", "false");
    //panel.setAttribute("style", "border: none; padding: 0px; border: none !important; -moz-appearance: none !important");

    if (details.no_autohide) {
      panel.setAttribute("noautohide", "true");
    }

    panel.appendChild(this._createPanelTitlebox(document, details, () => {
      panel.hidePopup();
    }));

    // Append the new panel into the window mainPopupSet.
    const mainPopupSet = document.getElementById("mainPopupSet");
    mainPopupSet.appendChild(panel);

    return panel;
  }
}

const overlayPanels = new WeakMap();

const manifestListener = (type, directive, extension, manifest) => {
  console.log(`CREATED OVERLAY PANEL`, type, directive, extension.name, manifest.overlay_panel);

  const panel = new OverlayPanel(extension, manifest.overlay_panel);
  overlayPanels.set(extension, panel);

  panel.build();
};

const shutdownListener = (type, extension) => {
  console.log(`DESTROY OVERLAY PANEL on shutdown`, extension.name);
  const panel = overlayPanels.get(extension);

  if (panel) {
    overlayPanels.delete(extension);
    panel.shutdown();
  }
};

const cleanupOnExperimentReload = () => {
  ExtensionParent.apiManager.off("manifest_overlay_panel", manifestListener);
  ExtensionParent.apiManager.off("shutdown", shutdownListener);
}

ExtensionParent.apiManager.on("manifest_overlay_panel", manifestListener);
ExtensionParent.apiManager.on("shutdown", shutdownListener);

// WORKAROUND: the listeners subscribed to the ExtensionParent.apiManager seem to be
// still executed when the experiments addon is reloaded, even if the API sandbox should have been
// nuked, the following workaround ensures that the listeners are cleaned up when the experiments
// is reloaded.
const {AddonManager} = Cu.import("resource://gre/modules/AddonManager.jsm");
const sandbox = this;
const addonListener = {
  onInstalled(addon) {
    if (addon.id === "overlay_panels@experiments.addons.mozilla.org") {
      console.log("EXPERIMENT RE-INSTALLED... cleaning up the listener from the previous instance",
                  addon.id);
      AddonManager.removeAddonListener(addonListener);
      cleanupOnExperimentReload();
    }
  },
};
AddonManager.addAddonListener(addonListener);
