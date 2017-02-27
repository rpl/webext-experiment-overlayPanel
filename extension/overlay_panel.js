console.log("OVERLAY_PANEL APIs", browser);

(async function() {
  const tabs = await browser.tabs.query({currentWindow: true});
  document.querySelector("pre").textContent = JSON.stringify(tabs.map(({title, url}) => {
    return {title, url};
  }), null, 2);
})();
