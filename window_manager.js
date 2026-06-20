/**
 * Window Manager for Floating UI
 * Handles dragging, resizing, z-indexing, minimizing, maximizing, and closing floating windows.
 */

class FloatingWindowManager {
  constructor() {
    this.windows = [];
    this.highestZIndex = 1000;
    this.dockContainer = null;
    this.initDock();
  }

  initDock() {
    this.dockContainer = document.createElement("div");
    this.dockContainer.className = "window-dock";
    document.body.appendChild(this.dockContainer);
  }

  bringToFront(winElement) {
    if (parseInt(winElement.style.zIndex, 10) === this.highestZIndex) return;
    this.highestZIndex++;
    winElement.style.zIndex = this.highestZIndex;
  }

  makeFloating(element, title, options = {}) {
    // Wrap element in floating window container
    const win = document.createElement("div");
    win.className = "floating-window";
    win.id = "win-" + (element.id || Math.random().toString(36).substr(2, 9));

    // Initial positioning
    win.style.left = options.x !== undefined ? options.x + "px" : "50px";
    win.style.top = options.y !== undefined ? options.y + "px" : "50px";
    win.style.width =
      options.width !== undefined ? options.width + "px" : "400px";
    win.style.height =
      options.height !== undefined ? options.height + "px" : "300px";

    if (options.maximize) {
      win.classList.add("maximized");
      win.style.left = "0";
      win.style.top = "0";
      win.style.width = "100%";
      win.style.height = "100%";
    }

    // Header
    const header = document.createElement("div");
    header.className = "window-header";

    const titleSpan = document.createElement("span");
    titleSpan.className = "window-title";
    titleSpan.textContent = title;
    header.appendChild(titleSpan);

    const controls = document.createElement("div");
    controls.className = "window-controls";

    const minBtn = document.createElement("button");
    minBtn.innerHTML = "&#8211;"; // en-dash
    minBtn.className = "win-btn min-btn";
    minBtn.title = "Minimize";

    const maxBtn = document.createElement("button");
    maxBtn.innerHTML = "&#9633;"; // square
    maxBtn.className = "win-btn max-btn";
    maxBtn.title = "Maximize";

    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "&times;";
    closeBtn.className = "win-btn close-btn";
    closeBtn.title = "Close";

    controls.appendChild(minBtn);
    controls.appendChild(maxBtn);
    controls.appendChild(closeBtn);
    header.appendChild(controls);
    win.appendChild(header);

    // Content container
    const content = document.createElement("div");
    content.className = "window-content";

    // Move the original element into the content
    // If element is already in the DOM, replace it
    if (element.parentNode) {
      element.parentNode.insertBefore(win, element);
    } else {
      document.querySelector("main").appendChild(win);
    }
    content.appendChild(element);
    // We don't force element.style.display = 'block', let CSS or app.js handle inner visibility
    element.style.width = "100%";
    element.style.height = "100%";
    element.style.boxSizing = "border-box";
    win.appendChild(content);

    // Add Resize Handles
    const directions = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];
    directions.forEach((dir) => {
      const handle = document.createElement("div");
      handle.className = `window-resize-handle resize-${dir}`;
      handle.dataset.dir = dir;
      win.appendChild(handle);
    });

    // Watch for internal element display changes to automatically show the window
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.attributeName === "class" &&
          element.classList.contains("is-open")
        ) {
          if (win.style.display === "none") {
            win.style.display = "flex";
            this.bringToFront(win);
          }
        } else if (mutation.attributeName === "style") {
          const elDisp = element.style.display;
          if (
            (elDisp === "flex" || elDisp === "block") &&
            win.style.display === "none"
          ) {
            win.style.display = "flex";
            this.bringToFront(win);
          }
        }
      });
    });
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    this.setupDragging(win, header);
    this.setupResizing(win);
    this.setupControls(win, element, title, minBtn, maxBtn, closeBtn);

    win.addEventListener("mousedown", () => this.bringToFront(win), {
      capture: true,
    });
    this.bringToFront(win);

    this.windows.push({
      id: win.id,
      element: win,
      content: element,
      originalTitle: title,
    });

    if (options.hidden) {
      win.style.display = "none";
    }

    // Setup Resize Observer to invalidate maps or charts
    const ro = new ResizeObserver(() => {
      const leafletMap =
        window.mapRenderer && window.mapRenderer.map
          ? window.mapRenderer.map
          : window.map || null;
      if (leafletMap && element.contains(leafletMap.getContainer())) {
        leafletMap.invalidateSize();
      }
      // Trigger a general window resize event for charts
      window.dispatchEvent(new Event("resize"));
    });
    ro.observe(content);

    return win;
  }

  setupDragging(win, header) {
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".window-controls")) return;
      if (win.classList.contains("maximized")) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = parseInt(win.style.left || 0, 10);
      initialTop = parseInt(win.style.top || 0, 10);

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newL = initialLeft + dx;
      let newT = initialTop + dy;

      const winW = win.offsetWidth;
      const winH = win.offsetHeight;

      const parentW = win.offsetParent ? win.offsetParent.clientWidth : window.innerWidth;
      const parentH = win.offsetParent ? win.offsetParent.clientHeight : window.innerHeight;

      // Clamp to bounds
      if (newL < 0) newL = 0;
      if (newT < 0) newT = 0;
      if (newL + winW > parentW)
        newL = Math.max(0, parentW - winW);
      if (newT + winH > parentH)
        newT = Math.max(0, parentH - winH);

      win.style.left = newL + "px";
      win.style.top = newT + "px";
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }

  setupResizing(win) {
    let isResizing = false;
    let startX, startY, startW, startH, startL, startT;
    let currentDir = "";

    const handles = win.querySelectorAll(".window-resize-handle");
    handles.forEach((handle) => {
      handle.addEventListener("mousedown", (e) => {
        if (win.classList.contains("maximized")) return;
        isResizing = true;
        currentDir = handle.dataset.dir;
        startX = e.clientX;
        startY = e.clientY;
        startW = parseInt(document.defaultView.getComputedStyle(win).width, 10);
        startH = parseInt(
          document.defaultView.getComputedStyle(win).height,
          10,
        );
        startL = parseInt(win.style.left || 0, 10);
        startT = parseInt(win.style.top || 0, 10);

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        e.preventDefault();
      });
    });

    const onMouseMove = (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newW = startW;
      let newH = startH;
      let newL = startL;
      let newT = startT;

      if (currentDir.includes("e")) newW = startW + dx;
      if (currentDir.includes("s")) newH = startH + dy;
      if (currentDir.includes("w")) {
        newW = startW - dx;
        newL = startL + dx;
      }
      if (currentDir.includes("n")) {
        newH = startH - dy;
        newT = startT + dy;
      }

      // Min size constraints
      if (newW < 200) {
        if (currentDir.includes("w")) newL -= 200 - newW;
        newW = 200;
      }
      if (newH < 100) {
        if (currentDir.includes("n")) newT -= 100 - newH;
        newH = 100;
      }

      const parentW = win.offsetParent ? win.offsetParent.clientWidth : window.innerWidth;
      const parentH = win.offsetParent ? win.offsetParent.clientHeight : window.innerHeight;

      // Clamp to bounds
      if (newL < 0) {
        newW += newL;
        newL = 0;
      }
      if (newT < 0) {
        newH += newT;
        newT = 0;
      }
      if (newL + newW > parentW) {
        newW = parentW - newL;
      }
      if (newT + newH > parentH) {
        newH = parentH - newT;
      }

      win.style.width = newW + "px";
      win.style.height = newH + "px";
      win.style.left = newL + "px";
      win.style.top = newT + "px";
    };

    const onMouseUp = () => {
      isResizing = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }

  setupControls(win, element, title, minBtn, maxBtn, closeBtn) {
    // Maximize
    maxBtn.addEventListener("click", () => {
      if (win.classList.contains("maximized")) {
        win.classList.remove("maximized");
        win.style.left = win.dataset.prevLeft;
        win.style.top = win.dataset.prevTop;
        win.style.width = win.dataset.prevWidth;
        win.style.height = win.dataset.prevHeight;
      } else {
        win.dataset.prevLeft = win.style.left;
        win.dataset.prevTop = win.style.top;
        win.dataset.prevWidth = win.style.width;
        win.dataset.prevHeight = win.style.height;
        win.classList.add("maximized");
        win.style.left = "0px";
        win.style.top = "0px";
        win.style.width = "100%";
        win.style.height = "100%";
      }
    });

    // Minimize
    minBtn.addEventListener("click", () => {
      win.style.display = "none";
      this.createDockItem(win, title);
    });

    // Close
    closeBtn.addEventListener("click", () => {
      win.style.display = "none";
      if (element.classList && element.classList.contains("is-open")) {
        element.classList.remove("is-open");
      }
    });
  }

  createDockItem(win, title) {
    const item = document.createElement("div");
    item.className = "dock-item";
    item.textContent = title;
    item.onclick = () => {
      win.style.display = "flex";
      this.bringToFront(win);
      win.classList.remove("minimized");
      item.remove();
    };
    item.__winRef = win;
    this.dockContainer.appendChild(item);
  }
}

// Global instance
window.WM = new FloatingWindowManager();

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    const sidebar = document.getElementById("logs-sidebar");
    if (sidebar) {
      // Remove existing resize handle since we have our own now
      const resizer = sidebar.querySelector(".sidebar-resizer");
      if (resizer) resizer.remove();

      window.WM.makeFloating(sidebar, "Logs & Data", {
        x: 10,
        y: 10,
        width: 280,
        height: window.innerHeight - 120,
      });
    }

    const mapContainer = document.getElementById("map");
    if (mapContainer) {
      window.WM.makeFloating(mapContainer, "Map View", {
        x: 300,
        y: 10,
        width: window.innerWidth - 650,
        height: window.innerHeight - 150,
      });
      mapContainer.style.height = "100%";
    }

    const benchmarkPanel = document.getElementById("benchmarkPanel");
    if (benchmarkPanel) {
      // Remove old resize handles and header controls
      const oldHandles = benchmarkPanel.querySelectorAll(
        ".benchmark-resize-handle",
      );
      oldHandles.forEach((h) => h.remove());

      const oldControls = benchmarkPanel.querySelectorAll(
        ".benchmark-minimize-btn, .benchmark-close-btn",
      );
      oldControls.forEach((c) => c.remove());

      // Hide old titles since we have a window header now
      const oldTitles = benchmarkPanel.querySelectorAll(
        "#benchmarkPanelHeader h3, #benchmarkPanelHeader p",
      );
      oldTitles.forEach((t) => (t.style.display = "none"));

      const benchmarkWidth = Math.min(1180, Math.round(window.innerWidth * 0.92));
      const benchmarkHeight = Math.min(840, Math.round(window.innerHeight * 0.9));
      const benchmarkWindow = window.WM.makeFloating(
        benchmarkPanel,
        "5G Benchmark Analysis",
        {
          x: Math.max(8, Math.round((window.innerWidth - benchmarkWidth) / 2)),
          y: Math.max(8, Math.round((window.innerHeight - benchmarkHeight) / 2)),
          width: benchmarkWidth,
          height: benchmarkHeight,
          hidden: true,
        },
      );

      if (benchmarkWindow) {
        const raisedZ = Math.max(window.WM.highestZIndex + 1, 1605);
        benchmarkWindow.style.zIndex = String(raisedZ);
        window.WM.highestZIndex = raisedZ;
      }

      benchmarkPanel.style.position = "static";
      benchmarkPanel.style.height = "100%";
      benchmarkPanel.style.minHeight = "0";
      benchmarkPanel.style.flexDirection = "column";

      const benchmarkBody = benchmarkPanel.querySelector(".benchmark-panel-body");
      if (benchmarkBody) {
        benchmarkBody.style.flex = "1 1 auto";
        benchmarkBody.style.minHeight = "0";
        benchmarkBody.style.overflowY = "auto";
      }
    }

    const rightSidebar = document.getElementById("smartcare-sidebar");
    if (rightSidebar) {
      // Remove old resize handle and header
      const resizer = rightSidebar.querySelector(".sidebar-resizer");
      if (resizer) resizer.remove();

      const oldHeader = document.getElementById("smartcareFloatingHeader");
      if (oldHeader) oldHeader.remove();

      // Remove fixed positioning from css by overriding inline
      rightSidebar.style.position = "static";
      rightSidebar.style.height = "100%";

      window.WM.makeFloating(rightSidebar, "SmartCare Layers", {
        x: window.innerWidth - 320,
        y: 10,
        width: 300,
        height: window.innerHeight - 120,
      });
    }
  }, 100); // Slight delay to ensure app.js initialized the elements if needed
});
