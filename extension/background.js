console.log("Loading 'test experiments.overlayPanels extension' background script");

browser.overlayPanels.create(browser.runtime.getURL("overlay_panel.html"));
